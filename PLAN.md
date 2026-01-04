# Capacitor APK Build Service Implementation Plan

A self-hosted service that builds Android APKs from web projects using Capacitor.

## Overview

```
Shakespeare (Browser)                    APK Build Service (Docker)
┌─────────────────────┐                 ┌─────────────────────────┐
│ 1. Build web app    │                 │ - Node.js + Express     │
│ 2. ZIP dist folder  │────POST────────▶│ - Android SDK 34        │
│ 3. Send config      │                 │ - Capacitor CLI         │
│                     │                 │ - Gradle                │
│ 4. Poll status      │◀───GET─────────│                         │
│ 5. Download APK     │◀───GET─────────│ Returns signed APK      │
└─────────────────────┘                 └─────────────────────────┘
```

---

## Part 1: Server Setup

### Directory Structure

```
apk-build-service/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── server.js
├── lib/
│   ├── builder.js
│   ├── queue.js
│   └── utils.js
├── templates/
│   └── capacitor.config.json
└── .env.example
```

### Prerequisites

- Docker & Docker Compose
- 4GB+ RAM (Gradle is memory-hungry)
- 10GB+ disk space (Android SDK + Gradle cache)

---

## Part 2: Docker Configuration

### Dockerfile

```dockerfile
FROM node:20-bookworm

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    openjdk-17-jdk \
    wget \
    unzip \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Java home
ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH=$PATH:$JAVA_HOME/bin

# Android SDK setup
ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=/opt/android-sdk
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

# Download and install Android command line tools
RUN mkdir -p $ANDROID_HOME/cmdline-tools && \
    cd $ANDROID_HOME/cmdline-tools && \
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O tools.zip && \
    unzip -q tools.zip && \
    rm tools.zip && \
    mv cmdline-tools latest

# Accept licenses and install SDK components
RUN yes | sdkmanager --licenses > /dev/null 2>&1 && \
    sdkmanager --install \
      "platform-tools" \
      "platforms;android-34" \
      "build-tools;34.0.0" \
      > /dev/null 2>&1

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

# Create directories for builds
RUN mkdir -p /tmp/builds /tmp/output

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start server
CMD ["node", "server.js"]
```

### docker-compose.yml

```yaml
version: '3.8'

services:
  apk-builder:
    build: .
    container_name: apk-build-service
    restart: unless-stopped
    ports:
      - "${PORT:-3000}:3000"
    volumes:
      # Persist Gradle cache for faster builds
      - gradle-cache:/root/.gradle
      # Persist npm cache
      - npm-cache:/root/.npm
    environment:
      - NODE_ENV=production
      - API_KEY=${API_KEY}
      - MAX_CONCURRENT_BUILDS=${MAX_CONCURRENT_BUILDS:-2}
      - BUILD_TIMEOUT_MS=${BUILD_TIMEOUT_MS:-600000}
    deploy:
      resources:
        limits:
          memory: 4G
        reservations:
          memory: 2G
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  gradle-cache:
  npm-cache:
```

### .env.example

```bash
# Server port
PORT=3000

# API key for authentication (generate with: openssl rand -hex 32)
API_KEY=your-secret-api-key-here

# Build settings
MAX_CONCURRENT_BUILDS=2
BUILD_TIMEOUT_MS=600000

# Optional: CORS origins (comma-separated)
CORS_ORIGINS=https://shakespeare.dev,http://localhost:5173
```

---

## Part 3: Server Code

### package.json

```json
{
  "name": "apk-build-service",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "adm-zip": "^0.5.10",
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1",
    "sharp": "^0.33.2",
    "uuid": "^9.0.1"
  }
}
```

### server.js

```javascript
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { BuildQueue } from './lib/queue.js';
import { buildAPK } from './lib/builder.js';

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const CORS_ORIGINS = process.env.CORS_ORIGINS?.split(',') || ['*'];
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BUILDS || '2');
const BUILD_TIMEOUT = parseInt(process.env.BUILD_TIMEOUT_MS || '600000');

// Build state
const builds = new Map();
const queue = new BuildQueue(MAX_CONCURRENT);

// Middleware
app.use(cors({ origin: CORS_ORIGINS }));
app.use(express.json());

// API Key authentication (optional but recommended)
const authenticate = (req, res, next) => {
  if (!API_KEY) return next(); // Skip if no API key configured

  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    queue: queue.getStatus(),
    activeBuilds: builds.size
  });
});

// Submit build
app.post('/api/build', authenticate, upload.single('project'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No project ZIP provided' });
    }

    let config;
    try {
      config = JSON.parse(req.body.config || '{}');
    } catch {
      return res.status(400).json({ error: 'Invalid config JSON' });
    }

    // Validate required fields
    if (!config.appName) {
      return res.status(400).json({ error: 'appName is required' });
    }
    if (!config.packageId || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(config.packageId)) {
      return res.status(400).json({
        error: 'Valid packageId required (e.g., com.example.myapp)'
      });
    }

    const buildId = randomUUID();
    const buildState = {
      id: buildId,
      status: 'queued',
      progress: 0,
      config,
      createdAt: new Date().toISOString(),
      logs: []
    };

    builds.set(buildId, buildState);

    // Add to queue
    queue.add(async () => {
      try {
        await buildAPK(buildId, req.file.buffer, config, builds, BUILD_TIMEOUT);
      } catch (error) {
        const build = builds.get(buildId);
        if (build && build.status !== 'failed') {
          build.status = 'failed';
          build.error = error.message;
          build.logs.push(`[ERROR] ${error.message}`);
        }
      }
    });

    res.json({
      buildId,
      status: 'queued',
      position: queue.getPosition(buildId)
    });

  } catch (error) {
    console.error('Build submission error:', error);
    res.status(500).json({ error: 'Failed to submit build' });
  }
});

// Get build status
app.get('/api/build/:buildId/status', authenticate, (req, res) => {
  const build = builds.get(req.params.buildId);

  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  res.json({
    id: build.id,
    status: build.status,
    progress: build.progress,
    error: build.error,
    createdAt: build.createdAt,
    completedAt: build.completedAt,
    logs: build.logs.slice(-20) // Last 20 log entries
  });
});

// Download APK
app.get('/api/build/:buildId/download', authenticate, (req, res) => {
  const build = builds.get(req.params.buildId);

  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  if (build.status !== 'complete') {
    return res.status(400).json({ error: 'Build not complete', status: build.status });
  }

  const filename = `${build.config.appName.replace(/[^a-zA-Z0-9]/g, '_')}.apk`;
  res.download(build.apkPath, filename);
});

// Get build logs (full)
app.get('/api/build/:buildId/logs', authenticate, (req, res) => {
  const build = builds.get(req.params.buildId);

  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  res.json({ logs: build.logs });
});

// Cancel build (if still queued)
app.delete('/api/build/:buildId', authenticate, (req, res) => {
  const build = builds.get(req.params.buildId);

  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  if (build.status === 'queued') {
    build.status = 'cancelled';
    builds.delete(req.params.buildId);
    res.json({ message: 'Build cancelled' });
  } else {
    res.status(400).json({ error: 'Cannot cancel build in progress' });
  }
});

// Cleanup old builds periodically (every hour)
setInterval(() => {
  const maxAge = 60 * 60 * 1000; // 1 hour
  const now = Date.now();

  for (const [id, build] of builds) {
    const age = now - new Date(build.createdAt).getTime();
    if (age > maxAge && ['complete', 'failed', 'cancelled'].includes(build.status)) {
      builds.delete(id);
      // APK files cleaned up by builder.js
    }
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`APK Build Service running on port ${PORT}`);
  console.log(`Max concurrent builds: ${MAX_CONCURRENT}`);
  console.log(`Build timeout: ${BUILD_TIMEOUT}ms`);
  console.log(`API key required: ${!!API_KEY}`);
});
```

### lib/queue.js

```javascript
export class BuildQueue {
  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    this.running++;
    const { task, resolve, reject } = this.queue.shift();

    try {
      const result = await task();
      resolve(result);
    } catch (error) {
      reject(error);
    } finally {
      this.running--;
      this.process();
    }
  }

  getStatus() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxConcurrent: this.maxConcurrent
    };
  }

  getPosition(buildId) {
    return this.queue.length;
  }
}
```

### lib/builder.js

```javascript
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import AdmZip from 'adm-zip';
import sharp from 'sharp';

const execAsync = promisify(exec);

const BUILDS_DIR = '/tmp/builds';
const OUTPUT_DIR = '/tmp/output';

export async function buildAPK(buildId, zipBuffer, config, builds, timeout) {
  const buildDir = path.join(BUILDS_DIR, buildId);
  const outputPath = path.join(OUTPUT_DIR, `${buildId}.apk`);
  const build = builds.get(buildId);

  const log = (message) => {
    console.log(`[${buildId.slice(0, 8)}] ${message}`);
    build.logs.push(`[${new Date().toISOString()}] ${message}`);
  };

  try {
    build.status = 'building';
    build.progress = 5;
    log('Starting build...');

    // Create directories
    await fs.mkdir(buildDir, { recursive: true });
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Extract ZIP
    build.progress = 10;
    log('Extracting project files...');
    const zip = new AdmZip(zipBuffer);
    zip.extractAllTo(buildDir, true);

    // Verify dist folder exists
    const distPath = path.join(buildDir, 'dist');
    try {
      await fs.access(path.join(distPath, 'index.html'));
    } catch {
      throw new Error('No index.html found in dist folder');
    }

    // Initialize npm project
    build.progress = 15;
    log('Initializing project...');
    await execAsync('npm init -y', { cwd: buildDir });

    // Install Capacitor
    build.progress = 20;
    log('Installing Capacitor dependencies...');
    await execAsync('npm install @capacitor/core @capacitor/android', {
      cwd: buildDir,
      timeout: 120000
    });

    // Create capacitor.config.json
    build.progress = 30;
    log('Creating Capacitor config...');
    const capConfig = {
      appId: config.packageId,
      appName: config.appName,
      webDir: 'dist',
      android: {
        allowMixedContent: true,
        buildOptions: {
          signingType: 'apksigner'
        }
      },
      server: {
        androidScheme: 'https'
      }
    };
    await fs.writeFile(
      path.join(buildDir, 'capacitor.config.json'),
      JSON.stringify(capConfig, null, 2)
    );

    // Add Android platform
    build.progress = 40;
    log('Adding Android platform...');
    await execAsync('npx cap add android', {
      cwd: buildDir,
      timeout: 180000
    });

    // Sync web assets
    build.progress = 50;
    log('Syncing web assets...');
    await execAsync('npx cap sync android', {
      cwd: buildDir,
      timeout: 60000
    });

    // Update app icon if provided
    if (config.iconBase64) {
      build.progress = 55;
      log('Processing app icon...');
      await updateAppIcon(buildDir, config.iconBase64);
    }

    // Update app colors if provided
    if (config.primaryColor) {
      await updateAppColors(buildDir, config.primaryColor);
    }

    // Make gradlew executable
    const gradlew = path.join(buildDir, 'android', 'gradlew');
    await execAsync(`chmod +x ${gradlew}`);

    // Build APK
    build.progress = 60;
    log('Building APK (this may take a few minutes)...');

    const buildType = config.buildType || 'debug';
    const gradleTask = buildType === 'release' ? 'assembleRelease' : 'assembleDebug';

    await execAsync(`./gradlew ${gradleTask} --no-daemon`, {
      cwd: path.join(buildDir, 'android'),
      timeout: timeout,
      env: {
        ...process.env,
        JAVA_HOME: '/usr/lib/jvm/java-17-openjdk-amd64',
        ANDROID_HOME: '/opt/android-sdk',
        ANDROID_SDK_ROOT: '/opt/android-sdk'
      }
    });

    build.progress = 90;
    log('Build complete, copying APK...');

    // Find and copy APK
    const apkDir = path.join(buildDir, 'android/app/build/outputs/apk', buildType);
    const apkFiles = await fs.readdir(apkDir);
    const apkFile = apkFiles.find(f => f.endsWith('.apk'));

    if (!apkFile) {
      throw new Error('APK file not found after build');
    }

    await fs.copyFile(path.join(apkDir, apkFile), outputPath);

    // Get APK size
    const stats = await fs.stat(outputPath);

    // Cleanup build directory
    build.progress = 95;
    log('Cleaning up...');
    await fs.rm(buildDir, { recursive: true, force: true });

    // Update build state
    build.status = 'complete';
    build.progress = 100;
    build.apkPath = outputPath;
    build.apkSize = stats.size;
    build.completedAt = new Date().toISOString();
    log(`Build complete! APK size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    // Schedule APK cleanup after 1 hour
    setTimeout(async () => {
      try {
        await fs.unlink(outputPath);
      } catch {}
    }, 60 * 60 * 1000);

  } catch (error) {
    build.status = 'failed';
    build.error = error.message;
    log(`Build failed: ${error.message}`);

    // Cleanup on failure
    await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});

    throw error;
  }
}

async function updateAppIcon(buildDir, iconBase64) {
  const iconBuffer = Buffer.from(iconBase64, 'base64');
  const resDir = path.join(buildDir, 'android/app/src/main/res');

  const sizes = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192
  };

  for (const [folder, size] of Object.entries(sizes)) {
    const iconPath = path.join(resDir, folder, 'ic_launcher.png');
    const roundIconPath = path.join(resDir, folder, 'ic_launcher_round.png');

    // Resize icon
    const resized = await sharp(iconBuffer)
      .resize(size, size)
      .png()
      .toBuffer();

    await fs.writeFile(iconPath, resized);
    await fs.writeFile(roundIconPath, resized);
  }
}

async function updateAppColors(buildDir, primaryColor) {
  const colorsPath = path.join(
    buildDir,
    'android/app/src/main/res/values/colors.xml'
  );

  const colorsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="colorPrimary">${primaryColor}</color>
    <color name="colorPrimaryDark">${darkenColor(primaryColor)}</color>
    <color name="colorAccent">${primaryColor}</color>
</resources>`;

  await fs.writeFile(colorsPath, colorsXml);
}

function darkenColor(hex) {
  // Simple color darkening
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, (num >> 16) - 30);
  const g = Math.max(0, ((num >> 8) & 0x00FF) - 30);
  const b = Math.max(0, (num & 0x0000FF) - 30);
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}
```

### lib/utils.js

```javascript
export function sanitizePackageId(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^\./, '')
    .replace(/\.$/, '');
}

export function sanitizeAppName(input) {
  return input
    .replace(/[<>:"/\\|?*]/g, '')
    .slice(0, 50);
}
```

---

## Part 4: Deployment

### Quick Start

```bash
# 1. Clone/create the service directory
mkdir apk-build-service && cd apk-build-service

# 2. Create all the files above (or copy from repo)

# 3. Create .env file
cp .env.example .env
# Edit .env and set API_KEY

# 4. Build and start
docker-compose up -d --build

# 5. Check logs
docker-compose logs -f

# 6. Test health endpoint
curl http://localhost:3000/health
```

### Production Checklist

- [ ] Set strong `API_KEY` in `.env`
- [ ] Configure `CORS_ORIGINS` for your Shakespeare domain
- [ ] Set up reverse proxy (nginx/Caddy) with HTTPS
- [ ] Configure firewall to only allow HTTPS
- [ ] Set up log rotation
- [ ] Monitor disk space (APKs + Gradle cache)
- [ ] Set up health check monitoring

### Nginx Reverse Proxy Example

```nginx
server {
    listen 443 ssl http2;
    server_name apk-builder.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/apk-builder.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/apk-builder.yourdomain.com/privkey.pem;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Long timeout for builds
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

---

## Part 5: Shakespeare Integration

### Browser-Side Adapter

Add this to Shakespeare's codebase:

```typescript
// src/lib/deploy/CapacitorAPKAdapter.ts
import JSZip from 'jszip';
import type { JSRuntimeFS } from '../JSRuntime';

export interface APKBuildConfig {
  appName: string;
  packageId: string;
  iconBase64?: string;
  primaryColor?: string;
  buildType?: 'debug' | 'release';
}

export interface APKBuildStatus {
  id: string;
  status: 'queued' | 'building' | 'complete' | 'failed' | 'cancelled';
  progress: number;
  error?: string;
  logs?: string[];
}

export interface APKBuildResult {
  buildId: string;
  downloadUrl: string;
  apkSize?: number;
}

export class CapacitorAPKAdapter {
  private fs: JSRuntimeFS;
  private buildServiceUrl: string;
  private apiKey?: string;

  constructor(config: {
    fs: JSRuntimeFS;
    buildServiceUrl: string;
    apiKey?: string;
  }) {
    this.fs = config.fs;
    this.buildServiceUrl = config.buildServiceUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  private getHeaders(): HeadersInit {
    const headers: HeadersInit = {};
    if (this.apiKey) {
      headers['X-API-Key'] = this.apiKey;
    }
    return headers;
  }

  async buildAPK(
    projectPath: string,
    config: APKBuildConfig,
    onProgress?: (status: APKBuildStatus) => void
  ): Promise<APKBuildResult> {
    const distPath = `${projectPath}/dist`;

    // Verify dist exists
    try {
      await this.fs.readFile(`${distPath}/index.html`, 'utf8');
    } catch {
      throw new Error('No dist folder found. Build the web project first.');
    }

    // Create ZIP of dist folder
    const zip = new JSZip();
    const distFolder = zip.folder('dist');
    await this.addDirectoryToZip(distPath, distFolder!);
    const zipBlob = await zip.generateAsync({ type: 'blob' });

    // Submit build
    const formData = new FormData();
    formData.append('project', zipBlob, 'project.zip');
    formData.append('config', JSON.stringify(config));

    const submitResponse = await fetch(`${this.buildServiceUrl}/api/build`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: formData
    });

    if (!submitResponse.ok) {
      const error = await submitResponse.json().catch(() => ({}));
      throw new Error(error.error || `Build submission failed: ${submitResponse.status}`);
    }

    const { buildId } = await submitResponse.json();

    // Poll for completion
    return this.waitForBuild(buildId, onProgress);
  }

  async getStatus(buildId: string): Promise<APKBuildStatus> {
    const response = await fetch(
      `${this.buildServiceUrl}/api/build/${buildId}/status`,
      { headers: this.getHeaders() }
    );

    if (!response.ok) {
      throw new Error('Failed to get build status');
    }

    return response.json();
  }

  private async waitForBuild(
    buildId: string,
    onProgress?: (status: APKBuildStatus) => void
  ): Promise<APKBuildResult> {
    const maxWait = 10 * 60 * 1000; // 10 minutes
    const pollInterval = 3000; // 3 seconds
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      const status = await this.getStatus(buildId);

      if (onProgress) {
        onProgress(status);
      }

      if (status.status === 'complete') {
        return {
          buildId,
          downloadUrl: `${this.buildServiceUrl}/api/build/${buildId}/download`
        };
      }

      if (status.status === 'failed') {
        throw new Error(status.error || 'Build failed');
      }

      if (status.status === 'cancelled') {
        throw new Error('Build was cancelled');
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    throw new Error('Build timed out');
  }

  private async addDirectoryToZip(dirPath: string, zip: JSZip): Promise<void> {
    const entries = await this.fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = `${dirPath}/${entry.name}`;

      if (entry.isDirectory()) {
        const folder = zip.folder(entry.name);
        if (folder) {
          await this.addDirectoryToZip(fullPath, folder);
        }
      } else if (entry.isFile()) {
        const content = await this.fs.readFile(fullPath);
        zip.file(entry.name, content);
      }
    }
  }
}
```

### AI Tool Integration

```typescript
// src/lib/tools/BuildAPKTool.ts
import { Tool, type ToolResult } from './Tool';
import { CapacitorAPKAdapter, type APKBuildConfig } from '../deploy/CapacitorAPKAdapter';

interface BuildAPKParams {
  appName: string;
  packageId: string;
  iconPath?: string;
  primaryColor?: string;
}

export class BuildAPKTool extends Tool<BuildAPKParams> {
  name = 'build_apk';
  description = 'Build an Android APK from the current web project using Capacitor';

  parameters = {
    type: 'object' as const,
    properties: {
      appName: {
        type: 'string',
        description: 'Display name of the Android app'
      },
      packageId: {
        type: 'string',
        description: 'Android package ID (e.g., com.example.myapp)'
      },
      iconPath: {
        type: 'string',
        description: 'Path to app icon image (optional)'
      },
      primaryColor: {
        type: 'string',
        description: 'Primary color hex code (optional, e.g., #3B82F6)'
      }
    },
    required: ['appName', 'packageId']
  };

  async execute(params: BuildAPKParams): Promise<ToolResult> {
    const { fs, projectPath, apkBuildServiceUrl, apkBuildApiKey } = this.context;

    if (!apkBuildServiceUrl) {
      return {
        success: false,
        error: 'APK build service not configured'
      };
    }

    const adapter = new CapacitorAPKAdapter({
      fs,
      buildServiceUrl: apkBuildServiceUrl,
      apiKey: apkBuildApiKey
    });

    const config: APKBuildConfig = {
      appName: params.appName,
      packageId: params.packageId,
      primaryColor: params.primaryColor
    };

    // Load icon if specified
    if (params.iconPath) {
      try {
        const iconData = await fs.readFile(`${projectPath}/${params.iconPath}`);
        config.iconBase64 = Buffer.from(iconData).toString('base64');
      } catch {
        return {
          success: false,
          error: `Icon file not found: ${params.iconPath}`
        };
      }
    }

    try {
      const result = await adapter.buildAPK(projectPath, config, (status) => {
        // Could emit progress events here
        console.log(`Build progress: ${status.progress}%`);
      });

      return {
        success: true,
        data: {
          message: `APK built successfully!`,
          downloadUrl: result.downloadUrl
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Build failed'
      };
    }
  }
}
```

---

## Part 6: API Reference

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Service health check |
| POST | `/api/build` | Submit new build |
| GET | `/api/build/:id/status` | Get build status |
| GET | `/api/build/:id/download` | Download APK |
| GET | `/api/build/:id/logs` | Get full build logs |
| DELETE | `/api/build/:id` | Cancel queued build |

### Submit Build Request

```bash
curl -X POST http://localhost:3000/api/build \
  -H "X-API-Key: your-api-key" \
  -F "project=@project.zip" \
  -F 'config={"appName":"My App","packageId":"com.example.myapp"}'
```

### Config Options

```json
{
  "appName": "My App",           // Required: Display name
  "packageId": "com.example.app", // Required: Android package ID
  "iconBase64": "iVBORw0K...",   // Optional: Base64 PNG icon
  "primaryColor": "#3B82F6",     // Optional: Theme color
  "buildType": "debug"           // Optional: "debug" or "release"
}
```

### Status Response

```json
{
  "id": "uuid",
  "status": "building",
  "progress": 60,
  "logs": ["[timestamp] Building APK..."],
  "createdAt": "2024-01-01T00:00:00Z"
}
```

---

## Part 7: Troubleshooting

### Common Issues

**Build fails with "SDK not found"**
```bash
# Check SDK installation in container
docker exec apk-build-service sdkmanager --list
```

**Out of memory during Gradle build**
```yaml
# Increase memory in docker-compose.yml
deploy:
  resources:
    limits:
      memory: 6G
```

**Slow first build**
- First build downloads Gradle + dependencies (~2-3 min)
- Subsequent builds use cache (~1 min)

**CORS errors from Shakespeare**
- Add Shakespeare's domain to `CORS_ORIGINS` in `.env`

### Logs

```bash
# View service logs
docker-compose logs -f apk-builder

# View specific build logs
curl http://localhost:3000/api/build/{buildId}/logs
```

---

## Summary

This implementation provides:

1. **Docker container** with Android SDK, Capacitor, and Node.js
2. **REST API** for submitting builds and downloading APKs
3. **Build queue** for handling concurrent requests
4. **Progress tracking** with detailed logs
5. **Icon and theming** support
6. **Automatic cleanup** of old builds
7. **Shakespeare adapter** for browser-side integration

Total setup time: ~30 minutes for basic deployment.

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { BuildQueue } from './lib/queue.js';
import { buildAPK } from './lib/builder.js';
import {
  initAuth,
  validateNip98Auth,
  getOrCreateApiKey,
  validateApiKey,
  revokeApiKey,
  getAuthStats
} from './lib/auth.js';

const app = express();

// Trust reverse proxy (nginx, etc.) for correct protocol detection
app.set('trust proxy', true);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// Configuration
const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = process.env.API_KEY; // Admin/legacy API key
const CORS_ORIGINS = process.env.CORS_ORIGINS?.split(',').map(s => s.trim()) || ['*'];
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BUILDS || '2');
const BUILD_TIMEOUT = parseInt(process.env.BUILD_TIMEOUT_MS || '600000');

// Build state
const builds = new Map();
const queue = new BuildQueue(MAX_CONCURRENT);

// Middleware
app.use(cors({
  origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS,
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// API Key authentication - supports admin key and per-user keys
const authenticate = (req, res, next) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;

  // Check admin API key first
  if (ADMIN_API_KEY && providedKey === ADMIN_API_KEY) {
    req.isAdmin = true;
    return next();
  }

  // Check per-user API key
  if (providedKey) {
    const result = validateApiKey(providedKey);
    if (result.valid) {
      req.pubkey = result.pubkey;
      return next();
    }
  }

  // No valid auth
  return res.status(401).json({ error: 'Invalid or missing API key' });
};

// Health check (no auth required)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    queue: queue.getStatus(),
    activeBuilds: builds.size,
    uptime: process.uptime()
  });
});

// =============================================================================
// NIP-98 Authentication Endpoints
// =============================================================================

// Get API key using NIP-98 authentication
app.post('/api/auth', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;

    const result = validateNip98Auth(authHeader, fullUrl, 'POST');

    if (!result.valid) {
      return res.status(401).json({ error: result.error });
    }

    // Generate or retrieve API key for this pubkey
    const { apiKey, isNew } = await getOrCreateApiKey(result.pubkey);

    res.json({
      success: true,
      apiKey,
      pubkey: result.pubkey,
      isNew,
      message: isNew ? 'New API key created' : 'Existing API key retrieved'
    });

  } catch (error) {
    console.error('[Auth] Error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Revoke API key (requires current valid auth)
app.delete('/api/auth', authenticate, async (req, res) => {
  try {
    const pubkey = req.pubkey;

    if (!pubkey) {
      return res.status(400).json({ error: 'Cannot revoke admin API key' });
    }

    const revoked = await revokeApiKey(pubkey);

    if (revoked) {
      res.json({ success: true, message: 'API key revoked' });
    } else {
      res.status(404).json({ error: 'No API key found for this pubkey' });
    }
  } catch (error) {
    console.error('[Auth] Revoke error:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// Get auth stats (admin only)
app.get('/api/auth/stats', authenticate, (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  res.json(getAuthStats());
});

// =============================================================================
// Build Endpoints
// =============================================================================

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
    if (!config.appName || typeof config.appName !== 'string') {
      return res.status(400).json({ error: 'appName is required' });
    }

    if (!config.packageId || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(config.packageId)) {
      return res.status(400).json({
        error: 'Valid packageId required (e.g., com.example.myapp)'
      });
    }

    // Sanitize inputs
    config.appName = config.appName.slice(0, 50).replace(/[<>:"/\\|?*]/g, '');
    config.packageId = config.packageId.toLowerCase();

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

    console.log(`Build ${buildId} queued for ${config.appName} (${config.packageId})`);

    res.json({
      buildId,
      status: 'queued',
      message: 'Build queued successfully'
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
    config: {
      appName: build.config.appName,
      packageId: build.config.packageId
    },
    createdAt: build.createdAt,
    completedAt: build.completedAt,
    apkSize: build.apkSize,
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
    return res.status(400).json({
      error: 'Build not complete',
      status: build.status
    });
  }

  if (!build.apkPath) {
    return res.status(404).json({ error: 'APK file not found' });
  }

  const filename = `${build.config.appName.replace(/[^a-zA-Z0-9]/g, '_')}.apk`;
  res.download(build.apkPath, filename, (err) => {
    if (err) {
      console.error(`Download error for ${build.id}:`, err);
    }
  });
});

// Get build logs (full)
app.get('/api/build/:buildId/logs', authenticate, (req, res) => {
  const build = builds.get(req.params.buildId);

  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  res.json({
    id: build.id,
    status: build.status,
    logs: build.logs
  });
});

// Cancel build (if still queued)
app.delete('/api/build/:buildId', authenticate, (req, res) => {
  const build = builds.get(req.params.buildId);

  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  if (build.status === 'queued') {
    build.status = 'cancelled';
    console.log(`Build ${build.id} cancelled`);
    res.json({ message: 'Build cancelled' });
  } else {
    res.status(400).json({
      error: 'Cannot cancel build in progress',
      status: build.status
    });
  }
});

// List recent builds (admin endpoint)
app.get('/api/builds', authenticate, (req, res) => {
  const buildList = Array.from(builds.values())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50)
    .map(b => ({
      id: b.id,
      status: b.status,
      appName: b.config.appName,
      packageId: b.config.packageId,
      progress: b.progress,
      createdAt: b.createdAt,
      completedAt: b.completedAt
    }));

  res.json({ builds: buildList });
});

// Cleanup old builds periodically (every 30 minutes)
setInterval(() => {
  const maxAge = 60 * 60 * 1000; // 1 hour
  const now = Date.now();
  let cleaned = 0;

  for (const [id, build] of builds) {
    const age = now - new Date(build.createdAt).getTime();
    if (age > maxAge && ['complete', 'failed', 'cancelled'].includes(build.status)) {
      builds.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} old build records`);
  }
}, 30 * 60 * 1000);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Initialize and start server
async function start() {
  // Initialize auth module
  await initAuth();

  app.listen(PORT, () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         APK Build Service Started                         ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`  Port:              ${PORT}`);
    console.log(`  Max concurrent:    ${MAX_CONCURRENT}`);
    console.log(`  Build timeout:     ${BUILD_TIMEOUT}ms`);
    console.log(`  Admin API key:     ${ADMIN_API_KEY ? 'configured' : 'not set'}`);
    console.log(`  NIP-98 auth:       enabled`);
    console.log(`  CORS origins:      ${CORS_ORIGINS.join(', ')}`);
    console.log('');
    console.log(`  Health check:      http://localhost:${PORT}/health`);
    console.log(`  Get API key:       POST http://localhost:${PORT}/api/auth (NIP-98)`);
    console.log('');
  });
}

start().catch(console.error);

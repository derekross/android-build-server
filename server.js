import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
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
import {
  initStats,
  getStats,
  recordBuildSubmitted,
  recordBuildCancelled
} from './lib/stats.js';

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
const MAX_QUEUE_SIZE = parseInt(process.env.MAX_QUEUE_SIZE || '50');
const MAX_BUILDS_PER_USER = parseInt(process.env.MAX_BUILDS_PER_USER || '3');

// Build state
const builds = new Map();
const userBuildCounts = new Map(); // Track builds per user
const queue = new BuildQueue(MAX_CONCURRENT);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false, // Allow inline scripts for landing page
  crossOriginEmbedderPolicy: false
}));

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute (allows for status polling)
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 auth attempts per minute
  message: { error: 'Too many authentication attempts' },
  standardHeaders: true,
  legacyHeaders: false
});

const buildSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 build submissions per hour
  message: { error: 'Build rate limit exceeded. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

app.use('/api/', generalLimiter);
app.use('/api/auth', authLimiter);
// Note: buildSubmitLimiter applied only to POST /api/build in route definition

// CORS middleware
app.use(cors({
  origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS,
  credentials: true
}));
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// API Key authentication - header only (query string removed for security)
const authenticate = (req, res, next) => {
  const providedKey = req.headers['x-api-key'];

  if (!providedKey) {
    return res.status(401).json({ error: 'Missing API key. Use X-API-Key header.' });
  }

  // Check admin API key first
  if (ADMIN_API_KEY && providedKey === ADMIN_API_KEY) {
    req.isAdmin = true;
    req.userId = 'admin';
    return next();
  }

  // Check per-user API key
  const result = validateApiKey(providedKey);
  if (result.valid) {
    req.pubkey = result.pubkey;
    req.userId = result.pubkey;
    return next();
  }

  // No valid auth
  return res.status(401).json({ error: 'Invalid API key' });
};

// Build ownership check middleware
const checkBuildOwnership = (req, res, next) => {
  const build = builds.get(req.params.buildId);

  if (!build) {
    return res.status(404).json({ error: 'Build not found' });
  }

  // Admin can access any build
  if (req.isAdmin) {
    req.build = build;
    return next();
  }

  // Check if user owns this build
  if (build.userId !== req.userId) {
    return res.status(403).json({ error: 'Access denied. You do not own this build.' });
  }

  req.build = build;
  next();
};

// Health check (no auth required) - minimal info to avoid disclosure
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Detailed stats (auth required)
app.get('/api/stats', authenticate, (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const persistentStats = getStats();
  res.json({
    status: 'ok',
    version: '1.1.0',
    builds: {
      total: persistentStats.totalBuilds,
      successful: persistentStats.successfulBuilds,
      failed: persistentStats.failedBuilds,
      cancelled: persistentStats.cancelledBuilds,
      active: builds.size,
      lastBuildAt: persistentStats.lastBuildAt
    },
    queue: queue.getStatus(),
    uptime: process.uptime(),
    startedAt: persistentStats.startedAt
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

// Validate ZIP file magic bytes
function isValidZip(buffer) {
  if (!buffer || buffer.length < 4) return false;
  // ZIP magic bytes: PK\x03\x04 (local file header) or PK\x05\x06 (empty archive)
  return (buffer[0] === 0x50 && buffer[1] === 0x4B &&
          (buffer[2] === 0x03 || buffer[2] === 0x05) &&
          (buffer[3] === 0x04 || buffer[3] === 0x06));
}

// Submit build (with rate limiting for submissions only)
app.post('/api/build', buildSubmitLimiter, authenticate, upload.single('project'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No project ZIP provided' });
    }

    // Validate ZIP magic bytes
    if (!isValidZip(req.file.buffer)) {
      return res.status(400).json({ error: 'Invalid file format. Must be a ZIP file.' });
    }

    // Check queue size limit
    const queueStatus = queue.getStatus();
    if (queueStatus.queued >= MAX_QUEUE_SIZE) {
      return res.status(503).json({
        error: 'Build queue is full. Please try again later.',
        queueSize: queueStatus.queued
      });
    }

    // Check per-user build limit (active builds only)
    const userActiveBuilds = userBuildCounts.get(req.userId) || 0;
    if (userActiveBuilds >= MAX_BUILDS_PER_USER) {
      return res.status(429).json({
        error: `You have ${userActiveBuilds} active builds. Maximum is ${MAX_BUILDS_PER_USER}. Wait for builds to complete.`,
        activeBuilds: userActiveBuilds
      });
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

    // Validate buildType
    if (config.buildType && !['debug', 'release'].includes(config.buildType)) {
      return res.status(400).json({ error: 'buildType must be "debug" or "release"' });
    }

    // Validate primaryColor format if provided
    if (config.primaryColor && !/^#[0-9A-Fa-f]{6}$/.test(config.primaryColor)) {
      return res.status(400).json({ error: 'primaryColor must be hex format like #FF5733' });
    }

    // Sanitize appName - remove shell metacharacters and control chars
    config.appName = config.appName
      .slice(0, 50)
      .replace(/[<>:"/\\|?*`$();&\n\r\t]/g, '')
      .trim();

    if (!config.appName) {
      return res.status(400).json({ error: 'appName contains only invalid characters' });
    }

    config.packageId = config.packageId.toLowerCase();

    const buildId = randomUUID();
    const buildState = {
      id: buildId,
      userId: req.userId, // Track ownership
      status: 'queued',
      progress: 0,
      config,
      createdAt: new Date().toISOString(),
      logs: []
    };

    builds.set(buildId, buildState);

    // Increment user's active build count
    userBuildCounts.set(req.userId, userActiveBuilds + 1);

    // Record build in persistent stats
    await recordBuildSubmitted();

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
      } finally {
        // Decrement user's active build count when done
        const currentCount = userBuildCounts.get(req.userId) || 1;
        if (currentCount <= 1) {
          userBuildCounts.delete(req.userId);
        } else {
          userBuildCounts.set(req.userId, currentCount - 1);
        }
      }
    });

    console.log(`Build ${buildId} queued for ${config.appName} (${config.packageId}) by ${req.userId.slice(0, 8)}...`);

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

// Get build status (with ownership check)
app.get('/api/build/:buildId/status', authenticate, checkBuildOwnership, (req, res) => {
  const build = req.build;

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

// Download APK (with ownership check)
app.get('/api/build/:buildId/download', authenticate, checkBuildOwnership, (req, res) => {
  const build = req.build;

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

// Get build logs (with ownership check)
app.get('/api/build/:buildId/logs', authenticate, checkBuildOwnership, (req, res) => {
  const build = req.build;

  res.json({
    id: build.id,
    status: build.status,
    logs: build.logs
  });
});

// Cancel build (with ownership check)
app.delete('/api/build/:buildId', authenticate, checkBuildOwnership, async (req, res) => {
  const build = req.build;

  if (build.status === 'queued') {
    build.status = 'cancelled';
    // Decrement user's active build count
    const currentCount = userBuildCounts.get(build.userId) || 1;
    if (currentCount <= 1) {
      userBuildCounts.delete(build.userId);
    } else {
      userBuildCounts.set(build.userId, currentCount - 1);
    }
    // Record cancellation in persistent stats
    await recordBuildCancelled();
    console.log(`Build ${build.id} cancelled by ${req.userId.slice(0, 8)}...`);
    res.json({ message: 'Build cancelled' });
  } else {
    res.status(400).json({
      error: 'Cannot cancel build in progress',
      status: build.status
    });
  }
});

// List builds (admin sees all, users see their own)
app.get('/api/builds', authenticate, (req, res) => {
  let buildList = Array.from(builds.values());

  // Non-admin users only see their own builds
  if (!req.isAdmin) {
    buildList = buildList.filter(b => b.userId === req.userId);
  }

  buildList = buildList
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
  // Initialize auth and stats modules
  await initAuth();
  await initStats();

  // Cleanup orphaned APK files from previous runs
  try {
    const outputDir = '/tmp/output';
    const files = await fs.readdir(outputDir);
    const maxAge = 60 * 60 * 1000; // 1 hour
    const now = Date.now();
    let cleaned = 0;

    for (const file of files) {
      if (file.endsWith('.apk')) {
        const filePath = join(outputDir, file);
        const stats = await fs.stat(filePath);
        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      console.log(`Startup: Cleaned ${cleaned} orphaned APK files`);
    }
  } catch (err) {
    // Directory might not exist yet, that's fine
    if (err.code !== 'ENOENT') {
      console.error('Startup cleanup error:', err.message);
    }
  }

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

# Android Build Server

A self-hosted APK build service for generating signed Android APKs from web applications.

## Overview

This service provides a remote build server that can:
- Build Android APKs from WebView-wrapped web applications
- Sign APKs with provided keystores
- Authenticate users via Nostr NIP-98

## Quick Start

```bash
# Clone the repository
git clone https://github.com/user/android-build-server.git
cd android-build-server

# Run setup (generates API key, builds Docker image, starts service)
./setup.sh

# Check health
curl http://localhost:3000/health
```

## Configuration

The setup script creates a `.env` file with these settings:

- `PORT` - Service port (default: 3000)
- `API_KEY` - Admin authentication key
- `MAX_CONCURRENT_BUILDS` - Parallel builds (default: 2)
- `BUILD_TIMEOUT_MS` - Build timeout (default: 600000)
- `CORS_ORIGINS` - Allowed origins (comma-separated, or `*` for all)

## Authentication

The server supports two authentication methods:

1. **Admin API Key** - Set in `.env`, passed via `X-API-Key` header
2. **NIP-98 Nostr Auth** - Users can request personal API keys using their Nostr identity

### Getting a Personal API Key (NIP-98)

Users can authenticate with their Nostr identity to get a personal API key:

```bash
# POST /api/auth with NIP-98 Authorization header
curl -X POST http://localhost:3000/api/auth \
  -H "Authorization: Nostr <base64-encoded-kind-27235-event>"
```

## API Endpoints

### Health Check
```bash
curl http://localhost:3000/health
# Returns: { "status": "ok" }
```

### Server Stats (Admin Only)
```bash
curl http://localhost:3000/api/stats \
  -H "X-API-Key: YOUR_ADMIN_API_KEY"
```

Returns build statistics including:
```json
{
  "status": "ok",
  "version": "1.1.0",
  "builds": {
    "total": 42,
    "successful": 38,
    "failed": 3,
    "cancelled": 1,
    "active": 2,
    "lastBuildAt": "2025-01-04T12:34:56.789Z"
  },
  "queue": { "queued": 1, "processing": 1 },
  "uptime": 3600,
  "startedAt": "2025-01-01T00:00:00.000Z"
}
```

### Submit Build
```bash
curl -X POST http://localhost:3000/api/build \
  -H "X-API-Key: YOUR_API_KEY" \
  -F "project=@dist.zip" \
  -F 'config={"appName":"My App","packageId":"com.example.app"}'
```

### Check Status
```bash
curl http://localhost:3000/api/build/{buildId}/status \
  -H "X-API-Key: YOUR_API_KEY"
```

### Download APK
```bash
curl -o app.apk http://localhost:3000/api/build/{buildId}/download \
  -H "X-API-Key: YOUR_API_KEY"
```

### List Your Builds
```bash
curl http://localhost:3000/api/builds \
  -H "X-API-Key: YOUR_API_KEY"
```

### Cancel Build
```bash
curl -X DELETE http://localhost:3000/api/build/{buildId} \
  -H "X-API-Key: YOUR_API_KEY"
```

## Commands

```bash
# Start the service
docker compose up -d

# Stop the service
docker compose down

# View logs
docker compose logs -f

# Rebuild after updates
docker compose up -d --build

# Run test build
./test.sh
```

## Rate Limits

The server applies rate limiting to prevent abuse:

| Endpoint | Limit | Window |
|----------|-------|--------|
| General API (`/api/*`) | 120 requests | 1 minute |
| Authentication (`/api/auth`) | 10 requests | 1 minute |
| Build submission (`POST /api/build`) | 20 requests | 1 hour |

Additionally, each user is limited to **3 concurrent active builds**.

## Security

### Build Ownership
- Users can only access their own builds (status, download, cancel)
- Admin API key can access all builds
- Build records are automatically cleaned up after 1 hour

### Input Validation
- ZIP files are validated for magic bytes before processing
- Path traversal (ZIP Slip) attacks are blocked
- App names and package IDs are sanitized
- File size limits enforced (100MB upload, 50MB per file in ZIP)

### Isolation
- Builds run in Docker containers
- Non-root user execution (`apkbuild`)
- Environment variables filtered (secrets not passed to Gradle)
- npm lifecycle scripts disabled (`--ignore-scripts`)

### APK Cleanup
- Build directories cleaned immediately after completion
- APK files automatically deleted after 1 hour
- Orphaned APKs cleaned on server startup

## Project Structure

```
android-build-server/
├── Dockerfile          # Docker image with Android SDK
├── docker-compose.yml  # Container configuration
├── package.json        # Node.js dependencies
├── server.js           # Express API server
├── lib/
│   ├── auth.js         # NIP-98 authentication
│   ├── builder.js      # APK build logic
│   ├── queue.js        # Build queue management
│   └── stats.js        # Persistent build statistics
├── setup.sh            # Setup script
├── test.sh             # Test script
└── .env                # Configuration (generated)
```

## Documentation

See [PLAN.md](./PLAN.md) for the full architecture and implementation plan.

## License

MIT

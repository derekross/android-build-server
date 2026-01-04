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
│   └── queue.js        # Build queue management
├── setup.sh            # Setup script
├── test.sh             # Test script
└── .env                # Configuration (generated)
```

## Documentation

See [PLAN.md](./PLAN.md) for the full architecture and implementation plan.

## License

MIT

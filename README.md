# Android Build Server

A self-hosted APK build service for generating signed Android APKs from web applications.

## Overview

This service provides a remote build server that can:
- Build Android APKs from WebView-wrapped web applications
- Sign APKs with provided keystores
- Return signed APKs ready for distribution

## Setup

Run the setup script to install dependencies and configure the build environment:

```bash
./setup.sh
```

## Documentation

See [PLAN.md](./PLAN.md) for the full architecture and implementation plan.

## License

MIT

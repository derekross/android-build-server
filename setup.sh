#!/bin/bash
#
# APK Build Service Setup Script
# Sets up a self-hosted Capacitor APK build service
#
# Usage:
#   git clone https://github.com/user/android-build-server.git
#   cd android-build-server
#   ./setup.sh [options]
#
# Options:
#   --port PORT      Service port (default: 3000)
#   --no-start       Don't start the service after setup
#   --help           Show this help message
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
PORT=3000
START_SERVICE=true

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)
      PORT="$2"
      shift 2
      ;;
    --no-start)
      START_SERVICE=false
      shift
      ;;
    --help)
      head -15 "$0" | tail -13
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║         APK Build Service Setup Script                    ║"
echo "║         Capacitor + Android SDK + Docker                  ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v docker &> /dev/null; then
  echo -e "${RED}Error: Docker is not installed${NC}"
  echo "Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
  echo -e "${RED}Error: Docker Compose is not installed${NC}"
  echo "Install Docker Compose: https://docs.docker.com/compose/install/"
  exit 1
fi

# Use 'docker compose' if available, otherwise 'docker-compose'
if docker compose version &> /dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  COMPOSE_CMD="docker-compose"
fi

echo -e "${GREEN}Prerequisites OK${NC}"

# Check for existing .env file
EXISTING_API_KEY=""
UPGRADE_MODE=false

if [ -f ".env" ]; then
  EXISTING_API_KEY=$(grep "^API_KEY=" ".env" 2>/dev/null | cut -d= -f2)
  if [ -n "$EXISTING_API_KEY" ]; then
    UPGRADE_MODE=true
    echo -e "${YELLOW}Existing installation found. Preserving API key...${NC}"
  fi
fi

# Use existing API key or generate new one
if [ -n "$EXISTING_API_KEY" ]; then
  API_KEY="$EXISTING_API_KEY"
  echo -e "${GREEN}Using existing API key${NC}"
else
  API_KEY=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | xxd -p | tr -d '\n' | head -c 64)
  echo -e "${GREEN}Generated new API key${NC}"
fi

# Create .env file
echo -e "${YELLOW}Creating .env file...${NC}"
cat > .env << ENV_EOF
# APK Build Service Configuration

# Server port
PORT=${PORT}

# API key for authentication (keep this secret!)
API_KEY=${API_KEY}

# Build settings
MAX_CONCURRENT_BUILDS=2
BUILD_TIMEOUT_MS=600000

# CORS origins (comma-separated, or * for all)
# Example: https://shakespeare.dev,https://your-app.com
CORS_ORIGINS=*
ENV_EOF

echo -e "${GREEN}Configuration complete!${NC}"

# Build and optionally start
if [ "$START_SERVICE" = true ]; then
  echo ""
  echo -e "${YELLOW}Building Docker image (this may take 5-10 minutes on first run)...${NC}"
  $COMPOSE_CMD build

  echo -e "${YELLOW}Starting service...${NC}"
  $COMPOSE_CMD up -d

  echo ""
  echo -e "${GREEN}Service started!${NC}"
  echo ""

  # Wait for service to be ready
  echo -e "${YELLOW}Waiting for service to be ready...${NC}"
  for i in {1..30}; do
    if curl -s "http://localhost:${PORT}/health" > /dev/null 2>&1; then
      echo -e "${GREEN}Service is ready!${NC}"
      break
    fi
    sleep 2
  done
fi

# Print summary
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
if [ "$UPGRADE_MODE" = true ]; then
  echo -e "${GREEN}                   Upgrade Complete!                           ${NC}"
else
  echo -e "${GREEN}                    Setup Complete!                            ${NC}"
fi
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${YELLOW}Port:${NC}         ${PORT}"
if [ "$UPGRADE_MODE" = true ]; then
  echo -e "  ${YELLOW}API Key:${NC}      (preserved from previous installation)"
else
  echo -e "  ${YELLOW}API Key:${NC}      ${API_KEY}"
fi
echo ""
echo -e "  ${YELLOW}Health Check:${NC} curl http://localhost:${PORT}/health"
echo ""
echo -e "  ${YELLOW}Commands:${NC}"
echo "    Start:      $COMPOSE_CMD up -d"
echo "    Stop:       $COMPOSE_CMD down"
echo "    Logs:       $COMPOSE_CMD logs -f"
echo "    Rebuild:    $COMPOSE_CMD up -d --build"
echo "    Test:       ./test.sh"
echo ""
echo -e "  ${YELLOW}Shakespeare Integration:${NC}"
echo "    Build Service URL:  http://YOUR_SERVER_IP:${PORT}"
echo "    API Key:            ${API_KEY}"
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
echo ""

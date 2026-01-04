#!/bin/bash
# Quick test script for the APK build service

# Load API key from .env if it exists
if [ -f .env ]; then
  source .env
fi

API_KEY="${API_KEY:-your-api-key-here}"
PORT="${PORT:-3000}"
BASE_URL="http://localhost:${PORT}"

echo "Testing APK Build Service..."
echo ""

# Health check
echo "1. Health check..."
curl -s "$BASE_URL/health" | jq .
echo ""

# Create a minimal test project
echo "2. Creating test project..."
mkdir -p /tmp/test-apk-project/dist
cat > /tmp/test-apk-project/dist/index.html << 'HTML'
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Test App</title>
  <style>
    body { font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 10px 40px rgba(0,0,0,0.2); text-align: center; }
    h1 { margin: 0 0 0.5rem 0; color: #333; }
    p { color: #666; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Hello from Capacitor!</h1>
    <p>Built with Shakespeare APK Builder</p>
  </div>
</body>
</html>
HTML

# Create ZIP
cd /tmp/test-apk-project
zip -r /tmp/test-project.zip dist/
cd - > /dev/null

echo "3. Submitting build..."
RESPONSE=$(curl -s -X POST "$BASE_URL/api/build" \
  -H "X-API-Key: $API_KEY" \
  -F "project=@/tmp/test-project.zip" \
  -F 'config={"appName":"Test App","packageId":"com.shakespeare.test"}')

BUILD_ID=$(echo "$RESPONSE" | jq -r '.buildId')
echo "Build ID: $BUILD_ID"
echo ""

if [ "$BUILD_ID" == "null" ]; then
  echo "Error: $RESPONSE"
  exit 1
fi

# Poll for status
echo "4. Waiting for build to complete..."
while true; do
  STATUS=$(curl -s "$BASE_URL/api/build/$BUILD_ID/status" -H "X-API-Key: $API_KEY")
  BUILD_STATUS=$(echo "$STATUS" | jq -r '.status')
  PROGRESS=$(echo "$STATUS" | jq -r '.progress')

  echo "   Status: $BUILD_STATUS ($PROGRESS%)"

  if [ "$BUILD_STATUS" == "complete" ]; then
    echo ""
    echo "5. Build complete! Downloading APK..."
    curl -s -o /tmp/test-app.apk "$BASE_URL/api/build/$BUILD_ID/download" -H "X-API-Key: $API_KEY"
    ls -lh /tmp/test-app.apk
    echo ""
    echo "APK saved to: /tmp/test-app.apk"
    break
  elif [ "$BUILD_STATUS" == "failed" ]; then
    echo ""
    echo "Build failed!"
    echo "$STATUS" | jq .
    exit 1
  fi

  sleep 5
done

# Cleanup
rm -rf /tmp/test-apk-project /tmp/test-project.zip

echo ""
echo "Test complete!"

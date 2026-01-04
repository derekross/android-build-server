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
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${buildId.slice(0, 8)}] ${message}`);
    build.logs.push(`[${timestamp}] ${message}`);
  };

  try {
    build.status = 'building';
    build.progress = 5;
    log('Starting build...');

    // Create directories
    await fs.mkdir(buildDir, { recursive: true });
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Extract ZIP with path traversal protection (ZIP Slip prevention)
    build.progress = 10;
    log('Extracting project files...');
    const zip = new AdmZip(zipBuffer);

    // Validate all entries before extraction
    const entries = zip.getEntries();
    for (const entry of entries) {
      const entryPath = path.join(buildDir, entry.entryName);
      const normalizedPath = path.normalize(entryPath);

      // Prevent path traversal attacks
      if (!normalizedPath.startsWith(buildDir + path.sep) && normalizedPath !== buildDir) {
        throw new Error(`Path traversal detected in ZIP: ${entry.entryName}`);
      }

      // Prevent symbolic links
      if (entry.isDirectory === false && entry.header.attr & 0x4000) {
        throw new Error(`Symbolic links not allowed in ZIP: ${entry.entryName}`);
      }

      // Limit individual file size (50MB)
      if (entry.header.size > 50 * 1024 * 1024) {
        throw new Error(`File too large in ZIP: ${entry.entryName} (${Math.round(entry.header.size / 1024 / 1024)}MB)`);
      }
    }

    // Safe to extract after validation
    zip.extractAllTo(buildDir, true);

    // Verify dist folder exists
    const distPath = path.join(buildDir, 'dist');
    try {
      await fs.access(path.join(distPath, 'index.html'));
    } catch {
      throw new Error('No index.html found in dist folder. Build the web project first.');
    }

    // Count files
    const fileCount = await countFiles(distPath);
    log(`Found ${fileCount} files in dist folder`);

    // Initialize npm project
    build.progress = 15;
    log('Initializing Capacitor project...');
    await execAsync('npm init -y', { cwd: buildDir });

    // Install Capacitor
    build.progress = 20;
    log('Installing Capacitor dependencies (this may take a minute)...');
    // Use Capacitor 5.x for Java 17 compatibility (Capacitor 6+ requires Java 21)
    // Include secure-storage plugin for Android Keystore protection of sensitive data (nsec)
    // --ignore-scripts prevents malicious package.json from executing arbitrary code
    await execAsync('npm install @capacitor/cli@5 @capacitor/core@5 @capacitor/android@5 capacitor-secure-storage-plugin@0.9.0 --loglevel=error --ignore-scripts', {
      cwd: buildDir,
      timeout: 180000
    });

    // Create capacitor.config.json
    build.progress = 30;
    log('Creating Capacitor configuration...');
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
    log('Syncing web assets to Android project...');
    await execAsync('npx cap sync android', {
      cwd: buildDir,
      timeout: 120000
    });

    // Inject secure storage shim to protect Nostr keys (nsec) using Android Keystore
    build.progress = 52;
    await injectSecureStorageShim(buildDir, log);

    // Update app icon - use provided icon or auto-detect from project
    build.progress = 55;
    let iconSource = null;

    if (config.iconBase64) {
      log('Using provided app icon...');
      iconSource = { type: 'base64', data: config.iconBase64 };
    } else {
      log('Auto-detecting app icon from project...');
      iconSource = await autoDetectIcon(distPath, log);
    }

    if (iconSource) {
      try {
        if (iconSource.type === 'base64') {
          await updateAppIcon(buildDir, iconSource.data);
        } else {
          await updateAppIconFromFile(buildDir, iconSource.path);
        }
        log('App icon updated successfully');
      } catch (iconError) {
        log(`Warning: Failed to update icon: ${iconError.message}`);
      }
    } else {
      log('No app icon found, using default Capacitor icon');
    }

    // Update app colors if provided
    if (config.primaryColor) {
      build.progress = 57;
      log('Updating app theme colors...');
      await updateAppColors(buildDir, config.primaryColor);
    }

    // Make gradlew executable
    const gradlew = path.join(buildDir, 'android', 'gradlew');
    await execAsync(`chmod +x ${gradlew}`);

    // Build APK
    build.progress = 60;
    const buildType = config.buildType || 'debug';
    const gradleTask = buildType === 'release' ? 'assembleRelease' : 'assembleDebug';
    log(`Building APK (${buildType})... This may take several minutes on first run.`);

    // Build with sanitized environment (exclude secrets)
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        !['API_KEY', 'ADMIN_API_KEY', 'SECRET', 'PASSWORD', 'TOKEN', 'PRIVATE'].some(
          secret => key.toUpperCase().includes(secret)
        )
      )
    );

    const { stdout, stderr } = await execAsync(`./gradlew ${gradleTask} --no-daemon -q`, {
      cwd: path.join(buildDir, 'android'),
      timeout: timeout,
      env: {
        ...safeEnv,
        JAVA_HOME: '/usr/lib/jvm/java-17-openjdk-amd64',
        ANDROID_HOME: '/opt/android-sdk',
        ANDROID_SDK_ROOT: '/opt/android-sdk'
      }
    });

    if (stderr && !stderr.includes('BUILD SUCCESSFUL')) {
      log(`Gradle warnings: ${stderr.slice(0, 500)}`);
    }

    build.progress = 90;
    log('Gradle build complete, locating APK...');

    // Find and copy APK
    const apkDir = path.join(buildDir, 'android/app/build/outputs/apk', buildType);
    let apkFiles;
    try {
      apkFiles = await fs.readdir(apkDir);
    } catch {
      throw new Error(`APK output directory not found: ${apkDir}`);
    }

    const apkFile = apkFiles.find(f => f.endsWith('.apk'));
    if (!apkFile) {
      throw new Error('APK file not found after build');
    }

    await fs.copyFile(path.join(apkDir, apkFile), outputPath);

    // Get APK size
    const stats = await fs.stat(outputPath);
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

    // Cleanup build directory
    build.progress = 95;
    log('Cleaning up build files...');
    await fs.rm(buildDir, { recursive: true, force: true });

    // Update build state
    build.status = 'complete';
    build.progress = 100;
    build.apkPath = outputPath;
    build.apkSize = stats.size;
    build.completedAt = new Date().toISOString();
    log(`Build complete! APK size: ${sizeMB} MB`);

    // Schedule APK cleanup after 1 hour
    setTimeout(async () => {
      try {
        await fs.unlink(outputPath);
        console.log(`Cleaned up APK: ${buildId}`);
      } catch {}
    }, 60 * 60 * 1000);

  } catch (error) {
    build.status = 'failed';
    build.error = error.message;
    build.completedAt = new Date().toISOString();
    log(`Build failed: ${error.message}`);

    // Cleanup on failure
    await fs.rm(buildDir, { recursive: true, force: true }).catch(() => {});

    throw error;
  }
}

async function countFiles(dir) {
  let count = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += await countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
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
    const folderPath = path.join(resDir, folder);

    // Ensure folder exists
    await fs.mkdir(folderPath, { recursive: true });

    const iconPath = path.join(folderPath, 'ic_launcher.png');
    const roundIconPath = path.join(folderPath, 'ic_launcher_round.png');
    const foregroundPath = path.join(folderPath, 'ic_launcher_foreground.png');

    // Resize icon
    const resized = await sharp(iconBuffer)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toBuffer();

    await fs.writeFile(iconPath, resized);
    await fs.writeFile(roundIconPath, resized);
    await fs.writeFile(foregroundPath, resized);
  }
}

async function updateAppIconFromFile(buildDir, iconFilePath) {
  const iconBuffer = await fs.readFile(iconFilePath);
  const resDir = path.join(buildDir, 'android/app/src/main/res');

  const sizes = {
    'mipmap-mdpi': 48,
    'mipmap-hdpi': 72,
    'mipmap-xhdpi': 96,
    'mipmap-xxhdpi': 144,
    'mipmap-xxxhdpi': 192
  };

  for (const [folder, size] of Object.entries(sizes)) {
    const folderPath = path.join(resDir, folder);
    await fs.mkdir(folderPath, { recursive: true });

    const iconPath = path.join(folderPath, 'ic_launcher.png');
    const roundIconPath = path.join(folderPath, 'ic_launcher_round.png');
    const foregroundPath = path.join(folderPath, 'ic_launcher_foreground.png');

    const resized = await sharp(iconBuffer)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .png()
      .toBuffer();

    await fs.writeFile(iconPath, resized);
    await fs.writeFile(roundIconPath, resized);
    await fs.writeFile(foregroundPath, resized);
  }
}

/**
 * Inject secure storage shim into index.html to protect sensitive Nostr data (nsec).
 * This intercepts localStorage operations for 'nostr:*' keys and redirects them
 * to Capacitor's SecureStorage plugin, which uses Android Keystore for encryption.
 */
async function injectSecureStorageShim(buildDir, log) {
  const indexPath = path.join(buildDir, 'android/app/src/main/assets/public/index.html');

  try {
    let html = await fs.readFile(indexPath, 'utf8');

    // The shim script that intercepts localStorage for nostr:* keys
    const shimScript = `
<script>
(function() {
  // Cache for synchronous reads (SecureStorage is async)
  var secureCache = new Map();
  var plugin = null;
  var initialized = false;

  // Store original localStorage methods
  var originalGetItem = localStorage.getItem.bind(localStorage);
  var originalSetItem = localStorage.setItem.bind(localStorage);
  var originalRemoveItem = localStorage.removeItem.bind(localStorage);

  // Try to get the plugin (may not be available immediately)
  function getPlugin() {
    if (plugin) return plugin;
    if (typeof Capacitor !== 'undefined' && Capacitor.Plugins && Capacitor.Plugins.SecureStoragePlugin) {
      plugin = Capacitor.Plugins.SecureStoragePlugin;
    }
    return plugin;
  }

  // Initialize cache from SecureStorage on startup
  async function initCache() {
    if (initialized) return;
    var p = getPlugin();
    if (!p) return;

    try {
      var result = await p.keys();
      var keys = result.value || [];
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (key.startsWith('nostr:')) {
          var data = await p.get({ key: key });
          secureCache.set(key, data.value);
        }
      }
      initialized = true;
      console.log('[SecureStorage] Loaded ' + secureCache.size + ' keys from Android Keystore');
    } catch (e) {
      console.warn('[SecureStorage] Failed to initialize cache:', e);
    }
  }

  // Proxy localStorage.getItem
  localStorage.getItem = function(key) {
    if (typeof key === 'string' && key.startsWith('nostr:')) {
      return secureCache.get(key) || null;
    }
    return originalGetItem(key);
  };

  // Proxy localStorage.setItem
  localStorage.setItem = function(key, value) {
    if (typeof key === 'string' && key.startsWith('nostr:')) {
      secureCache.set(key, value);
      var p = getPlugin();
      if (p) {
        p.set({ key: key, value: value }).catch(function(e) {
          console.error('[SecureStorage] Failed to store:', key, e);
        });
      }
      return;
    }
    return originalSetItem(key, value);
  };

  // Proxy localStorage.removeItem
  localStorage.removeItem = function(key) {
    if (typeof key === 'string' && key.startsWith('nostr:')) {
      secureCache.delete(key);
      var p = getPlugin();
      if (p) {
        p.remove({ key: key }).catch(function(e) {
          console.error('[SecureStorage] Failed to remove:', key, e);
        });
      }
      return;
    }
    return originalRemoveItem(key);
  };

  // Initialize when Capacitor is ready
  if (typeof Capacitor !== 'undefined') {
    initCache();
  }
  document.addEventListener('deviceready', initCache);
  window.addEventListener('load', function() {
    setTimeout(initCache, 100);
  });

  console.log('[SecureStorage] Nostr key protection shim installed');
})();
</script>`;

    // Inject the shim script right after <head> tag so it runs before any app code
    if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>' + shimScript);
      await fs.writeFile(indexPath, html, 'utf8');
      log('Secure storage shim injected for Nostr key protection');
      return true;
    } else {
      log('Warning: Could not find <head> tag to inject secure storage shim');
      return false;
    }
  } catch (error) {
    log(`Warning: Failed to inject secure storage shim: ${error.message}`);
    return false;
  }
}

async function autoDetectIcon(distPath, log) {
  // Common icon file patterns to search for (in priority order)
  const iconPatterns = [
    // PWA icons (highest priority - usually best quality)
    'icon-512x512.png',
    'icon-512.png',
    'icons/icon-512x512.png',
    'icons/512x512.png',
    'icon-384x384.png',
    'icon-256x256.png',
    'icon-192x192.png',
    'icon-192.png',
    'icons/icon-192x192.png',
    'icons/192x192.png',
    // Apple touch icons (good quality)
    'apple-touch-icon.png',
    'apple-touch-icon-180x180.png',
    'apple-touch-icon-precomposed.png',
    // Standard icons
    'icon.png',
    'logo.png',
    'app-icon.png',
    'favicon.png',
    // In assets/images folders
    'assets/icon.png',
    'assets/logo.png',
    'assets/images/icon.png',
    'assets/images/logo.png',
    'images/icon.png',
    'images/logo.png',
    'img/icon.png',
    'img/logo.png',
    // Favicon as last resort (usually small)
    'favicon.ico',
    'favicon-32x32.png',
    'favicon-16x16.png'
  ];

  // Try each pattern
  for (const pattern of iconPatterns) {
    const iconPath = path.join(distPath, pattern);
    try {
      const stat = await fs.stat(iconPath);
      if (stat.isFile()) {
        // Verify it's a valid image
        const ext = path.extname(iconPath).toLowerCase();
        if (['.png', '.jpg', '.jpeg', '.ico', '.webp'].includes(ext)) {
          log(`Found icon: ${pattern}`);
          return { type: 'file', path: iconPath };
        }
      }
    } catch {
      // File doesn't exist, try next pattern
    }
  }

  // Try to parse index.html for icon links
  try {
    const indexPath = path.join(distPath, 'index.html');
    const html = await fs.readFile(indexPath, 'utf8');

    // Look for various icon link patterns
    const iconLinkPatterns = [
      /<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i,
      /<link[^>]*rel=["']icon["'][^>]*href=["']([^"']+)["']/i,
      /<link[^>]*rel=["']shortcut icon["'][^>]*href=["']([^"']+)["']/i,
      /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']apple-touch-icon["']/i,
      /<link[^>]*href=["']([^"']+)["'][^>]*rel=["']icon["']/i,
    ];

    for (const pattern of iconLinkPatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        let iconHref = match[1];
        // Remove leading slash or ./
        iconHref = iconHref.replace(/^\.?\//, '');
        const iconPath = path.join(distPath, iconHref);

        try {
          const stat = await fs.stat(iconPath);
          if (stat.isFile()) {
            log(`Found icon from HTML: ${iconHref}`);
            return { type: 'file', path: iconPath };
          }
        } catch {
          // Referenced icon doesn't exist
        }
      }
    }
  } catch {
    // Couldn't parse index.html
  }

  return null;
}

async function updateAppColors(buildDir, primaryColor) {
  // Validate color format to prevent XML injection
  if (!/^#[0-9A-Fa-f]{6}$/.test(primaryColor)) {
    throw new Error('Invalid primaryColor format. Must be hex color like #FF5733');
  }

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
  const cleanHex = hex.replace('#', '');
  const num = parseInt(cleanHex, 16);
  const r = Math.max(0, (num >> 16) - 30);
  const g = Math.max(0, ((num >> 8) & 0x00FF) - 30);
  const b = Math.max(0, (num & 0x0000FF) - 30);
  return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
}

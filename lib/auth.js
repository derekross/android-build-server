/**
 * NIP-98 Authentication and API Key Management
 * Handles per-user API keys using Nostr authentication
 */
import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { verifyEvent } from 'nostr-tools/pure';

// Persistent storage path (Docker volume)
const DATA_DIR = process.env.DATA_DIR || '/data';
const API_KEYS_FILE = path.join(DATA_DIR, 'api-keys.json');

// In-memory cache
let apiKeys = new Map(); // pubkey -> { apiKey, createdAt, lastUsed }
let apiKeyToPubkey = new Map(); // apiKey -> pubkey

/**
 * Initialize the auth module - load existing keys from disk
 */
export async function initAuth() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });

    try {
      const data = await fs.readFile(API_KEYS_FILE, 'utf8');
      const keys = JSON.parse(data);

      for (const [pubkey, info] of Object.entries(keys)) {
        apiKeys.set(pubkey, info);
        apiKeyToPubkey.set(info.apiKey, pubkey);
      }

      console.log(`[Auth] Loaded ${apiKeys.size} API keys from storage`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        console.error('[Auth] Failed to load API keys:', e.message);
      }
    }
  } catch (e) {
    console.error('[Auth] Failed to initialize:', e.message);
  }
}

/**
 * Save API keys to persistent storage
 */
async function saveApiKeys() {
  try {
    const data = Object.fromEntries(apiKeys);
    await fs.writeFile(API_KEYS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Auth] Failed to save API keys:', e.message);
  }
}

/**
 * Validate a NIP-98 Authorization header
 */
export function validateNip98Auth(authHeader, expectedUrl, expectedMethod) {
  if (!authHeader) {
    return { valid: false, error: 'Missing Authorization header' };
  }

  if (!authHeader.startsWith('Nostr ')) {
    return { valid: false, error: 'Invalid authorization scheme (expected "Nostr")' };
  }

  const base64Event = authHeader.slice(6).trim();
  let event;

  try {
    const jsonStr = Buffer.from(base64Event, 'base64').toString('utf8');
    event = JSON.parse(jsonStr);
  } catch (e) {
    return { valid: false, error: 'Invalid base64-encoded event' };
  }

  if (!event.id || !event.pubkey || !event.sig || !event.kind || !event.tags) {
    return { valid: false, error: 'Invalid event structure' };
  }

  if (event.kind !== 27235) {
    return { valid: false, error: `Invalid event kind: ${event.kind} (expected 27235)` };
  }

  // Check timestamp (within 60 seconds)
  const now = Math.floor(Date.now() / 1000);
  const timeDiff = Math.abs(now - event.created_at);
  if (timeDiff > 60) {
    return { valid: false, error: `Event timestamp too old/new: ${timeDiff}s difference` };
  }

  const uTag = event.tags.find(t => t[0] === 'u');
  const methodTag = event.tags.find(t => t[0] === 'method');

  if (!uTag || !uTag[1]) {
    return { valid: false, error: 'Missing "u" tag' };
  }

  if (!methodTag || !methodTag[1]) {
    return { valid: false, error: 'Missing "method" tag' };
  }

  // Normalize URLs for comparison
  const normalizeUrl = (url) => url.replace(/\/+$/, '').toLowerCase();

  if (normalizeUrl(uTag[1]) !== normalizeUrl(expectedUrl)) {
    return { valid: false, error: `URL mismatch: got "${uTag[1]}", expected "${expectedUrl}"` };
  }

  if (methodTag[1].toUpperCase() !== expectedMethod.toUpperCase()) {
    return { valid: false, error: `Method mismatch: got "${methodTag[1]}", expected "${expectedMethod}"` };
  }

  // Verify the signature
  try {
    const isValid = verifyEvent(event);
    if (!isValid) {
      return { valid: false, error: 'Invalid event signature' };
    }
  } catch (e) {
    return { valid: false, error: `Signature verification failed: ${e.message}` };
  }

  return { valid: true, pubkey: event.pubkey };
}

/**
 * Generate or retrieve an API key for a pubkey
 */
export async function getOrCreateApiKey(pubkey) {
  const existing = apiKeys.get(pubkey);

  if (existing) {
    existing.lastUsed = new Date().toISOString();
    await saveApiKeys();
    return { apiKey: existing.apiKey, isNew: false };
  }

  const apiKey = randomBytes(32).toString('hex');
  const info = {
    apiKey,
    createdAt: new Date().toISOString(),
    lastUsed: new Date().toISOString()
  };

  apiKeys.set(pubkey, info);
  apiKeyToPubkey.set(apiKey, pubkey);
  await saveApiKeys();

  console.log(`[Auth] Created new API key for pubkey: ${pubkey.slice(0, 8)}...`);

  return { apiKey, isNew: true };
}

/**
 * Validate an API key
 */
export function validateApiKey(apiKey) {
  const pubkey = apiKeyToPubkey.get(apiKey);

  if (pubkey) {
    const info = apiKeys.get(pubkey);
    if (info) {
      info.lastUsed = new Date().toISOString();
      saveApiKeys().catch(() => {});
    }
    return { valid: true, pubkey };
  }

  return { valid: false };
}

/**
 * Revoke an API key for a pubkey
 */
export async function revokeApiKey(pubkey) {
  const info = apiKeys.get(pubkey);
  if (info) {
    apiKeyToPubkey.delete(info.apiKey);
    apiKeys.delete(pubkey);
    await saveApiKeys();
    console.log(`[Auth] Revoked API key for pubkey: ${pubkey.slice(0, 8)}...`);
    return true;
  }
  return false;
}

/**
 * Get stats about API keys
 */
export function getAuthStats() {
  return {
    totalUsers: apiKeys.size,
    keys: Array.from(apiKeys.entries()).map(([pubkey, info]) => ({
      pubkey: pubkey.slice(0, 8) + '...',
      createdAt: info.createdAt,
      lastUsed: info.lastUsed
    }))
  };
}

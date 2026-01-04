import fs from 'fs/promises';
import path from 'path';

const STATS_FILE = process.env.STATS_FILE || '/app/data/stats.json';

let stats = {
  totalBuilds: 0,
  successfulBuilds: 0,
  failedBuilds: 0,
  cancelledBuilds: 0,
  startedAt: null,
  lastBuildAt: null
};

export async function initStats() {
  try {
    // Ensure directory exists
    await fs.mkdir(path.dirname(STATS_FILE), { recursive: true });

    // Try to load existing stats
    const data = await fs.readFile(STATS_FILE, 'utf8');
    const loaded = JSON.parse(data);
    stats = { ...stats, ...loaded };
    console.log(`Stats loaded: ${stats.totalBuilds} total builds`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // First run, initialize
      stats.startedAt = new Date().toISOString();
      await saveStats();
      console.log('Stats initialized');
    } else {
      console.error('Failed to load stats:', err.message);
    }
  }
}

async function saveStats() {
  try {
    await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error('Failed to save stats:', err.message);
  }
}

export async function recordBuildSubmitted() {
  stats.totalBuilds++;
  stats.lastBuildAt = new Date().toISOString();
  await saveStats();
}

export async function recordBuildSuccess() {
  stats.successfulBuilds++;
  await saveStats();
}

export async function recordBuildFailed() {
  stats.failedBuilds++;
  await saveStats();
}

export async function recordBuildCancelled() {
  stats.cancelledBuilds++;
  await saveStats();
}

export function getStats() {
  return { ...stats };
}

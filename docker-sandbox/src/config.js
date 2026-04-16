// =============================================================================
// Configuration — loads from .env file and environment variables
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env file
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
    }
}

function env(key, fallback) {
    return process.env[key] || fallback;
}

export const config = {
    // Broker API
    brokerUrl: env('BROKER_URL', 'https://chess-agents-api-production.up.railway.app/api/broker'),
    brokerId: env('BROKER_ID', ''),

    // Auth — provide EITHER a key file path OR inline secret depending on your auth mode
    brokerKeyPath: env('BROKER_KEY_PATH', ''),
    brokerSecret: env('BROKER_SECRET', ''),

    batchSize: parseInt(env('BATCH_SIZE', '10')),

    // Execution
    maxConcurrentMatches: parseInt(env('MAX_CONCURRENT_MATCHES', '10')),
    nightMaxConcurrent: parseInt(env('NIGHT_MAX_CONCURRENT', '20')),
    nightStartHour: parseInt(env('NIGHT_START_HOUR', '3')),
    nightEndHour: parseInt(env('NIGHT_END_HOUR', '8')),
    agentMoveTimeoutMs: parseInt(env('AGENT_MOVE_TIMEOUT_MS', '8000')),
    agentMemoryLimit: env('AGENT_MEMORY_LIMIT', '256m'),
    pollIntervalMs: parseInt(env('POLL_INTERVAL_MS', '5000')),

    // Paths
    rootDir: ROOT,
    dataDir: join(ROOT, 'data'),

    // Priority — set via PRIORITY_FILTER env var or priority.txt file
    // priority.txt is checked live each poll cycle so you can change it without restart
    priorityFilter: env('PRIORITY_FILTER', ''),
    priorityFile: join(ROOT, 'priority.txt'),

    // Docker
    sandboxImage: env('SANDBOX_IMAGE', 'agentchess-sandbox:latest'),
};

export default config;

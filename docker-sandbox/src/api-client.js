// =============================================================================
// Broker API Client — Generic adapter for chessagents.ai broker
//
// Supports two auth modes:
//   1. RSA key signing (set BROKER_KEY_PATH to your .pem file)
//   2. Shared secret    (set BROKER_SECRET)
//
// To integrate with the upstream Ed25519 auth, replace this module with your
// own implementation that calls signedPost() from broker-runner.ts.
// =============================================================================

import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import config from './config.js';

// --- Auth setup ---
let PRIVATE_KEY = null;
let PUBLIC_KEY_HEADER = '';

if (config.brokerKeyPath) {
    const keyPath = config.brokerKeyPath.startsWith('/')
        ? config.brokerKeyPath
        : join(config.rootDir, config.brokerKeyPath);
    if (existsSync(keyPath)) {
        PRIVATE_KEY = readFileSync(keyPath, 'utf-8');
        const pub = crypto.createPublicKey(PRIVATE_KEY).export({ type: 'spki', format: 'pem' });
        PUBLIC_KEY_HEADER = pub.replace(/-----[A-Z ]+-----/g, '').replace(/\n/g, '').trim();
    } else {
        console.warn(`[api-client] Key file not found: ${keyPath}`);
    }
}

function signData(data) {
    if (!PRIVATE_KEY) throw new Error('No private key loaded — set BROKER_KEY_PATH');
    const key = crypto.createPrivateKey(PRIVATE_KEY);
    return crypto.sign('sha256', Buffer.from(data), key).toString('base64');
}

function buildSigningString(endpoint, fields) {
    if (endpoint === 'next-jobs') return `next-jobs:${fields.count}`;
    if (endpoint === 'submit') return `submit:${fields.jobId}:${fields.matchId}`;
    return '';
}

async function signedPost(path, body) {
    const endpointKey = path.includes('next-jobs') ? 'next-jobs' : 'submit';
    const signingString = buildSigningString(endpointKey, body);

    const headers = { 'Content-Type': 'application/json' };

    if (PRIVATE_KEY) {
        headers['x-worker-public-key'] = PUBLIC_KEY_HEADER;
        headers['x-worker-signature'] = signData(signingString);
    } else if (config.brokerSecret) {
        headers['x-broker-secret'] = config.brokerSecret;
    }

    if (config.brokerId) {
        headers['x-broker-id'] = config.brokerId;
    }

    return fetch(`${config.brokerUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    });
}

/**
 * Decrypt agent code if encrypted (RSA-OAEP + AES-256-GCM).
 */
function decryptFromServer(encryptedPayload) {
    if (!PRIVATE_KEY) return encryptedPayload;
    try {
        const { encryptedKey, iv, authTag, ciphertext } = JSON.parse(encryptedPayload);
        const aesKey = crypto.privateDecrypt(
            { key: PRIVATE_KEY, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
            Buffer.from(encryptedKey, 'base64')
        );
        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(iv, 'base64'));
        decipher.setAuthTag(Buffer.from(authTag, 'base64'));
        return decipher.update(Buffer.from(ciphertext, 'base64')).toString('utf8') + decipher.final('utf8');
    } catch {
        return encryptedPayload;
    }
}

function maybeDecrypt(code) {
    if (!code) return code;
    if (code.trimStart().startsWith('{') && code.includes('encryptedKey')) {
        return decryptFromServer(code);
    }
    return code;
}

/**
 * Fetch next batch of match jobs from the broker.
 */
export async function fetchJobs(count) {
    const body = {
        count: count || config.batchSize,
        ...(config.brokerId && { brokerId: config.brokerId }),
    };

    const res = await signedPost('/next-jobs', body);

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Broker fetch failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
    }

    const jobs = await res.json();
    const arr = Array.isArray(jobs) ? jobs : [];

    for (const job of arr) {
        if (job.challenger?.code) job.challenger.code = maybeDecrypt(job.challenger.code);
        if (job.defender?.code) job.defender.code = maybeDecrypt(job.defender.code);
    }

    return arr;
}

/**
 * Submit a completed match result to the broker.
 */
export async function submitResult(result) {
    const body = {
        jobId: result.jobId,
        matchId: result.matchId,
        pgn: result.pgn,
        result: result.result,
        challengerScore: result.challengerScore,
        defenderScore: result.defenderScore,
    };

    const res = await signedPost('/submit', body);

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Broker submit failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`);
    }

    return res.json();
}

export default { fetchJobs, submitResult };

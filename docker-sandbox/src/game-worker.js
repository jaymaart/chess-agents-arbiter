// =============================================================================
// Game Worker — runs playGame in a worker thread so it doesn't block main
// =============================================================================

import { workerData, parentPort } from 'node:worker_threads';
import { playGame } from './sandboxed-referee.js';

try {
    const result = playGame(workerData);
    parentPort.postMessage({ ok: true, result });
} catch (err) {
    parentPort.postMessage({ ok: false, error: err.message });
}

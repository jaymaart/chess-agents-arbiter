#!/usr/bin/env node
// =============================================================================
// Match Processor — Entry point
// GPU-native match processor for chessagents.ai
// =============================================================================

import { runLoop, shutdown } from './orchestrator.js';

// Graceful shutdown on signals
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

runLoop().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

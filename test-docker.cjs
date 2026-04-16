// Integration test for DOCKER_SANDBOX=true mode
// Uses test-agent.cjs as the agent (avoids template literal escape issues)
process.env.DOCKER_SANDBOX = 'true';

const { runMatch } = require('./dist/matchmaking/runner');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agentPath = path.join(__dirname, 'test-agent.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arbiter-match-test-'));
fs.copyFileSync(agentPath, path.join(tmp, 'agent_a.cjs'));
fs.copyFileSync(agentPath, path.join(tmp, 'agent_b.cjs'));

console.log('Testing DOCKER_SANDBOX=true mode...');
const start = Date.now();

runMatch(
  { path: path.join(tmp, 'agent_a.cjs'), language: 'js', name: 'DockerA' },
  { path: path.join(tmp, 'agent_b.cjs'), language: 'js', name: 'DockerB' },
  { games: 2, matchId: 'test-integration-docker-001' }
).then(r => {
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const allClean = r.games.every(g => !g.termination.includes('engine exited') && !g.termination.includes('error'));
  console.log(allClean ? 'PASS' : 'FAIL');
  for (const g of r.games) {
    console.log(`  Game ${g.round}: ${g.result} (${g.termination})`);
  }
  console.log('Time:', elapsed + 's');
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!allClean) process.exit(1);
}).catch(e => {
  console.error('FAIL:', e.message);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});

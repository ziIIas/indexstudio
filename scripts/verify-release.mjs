// Pass an extracted ready-to-run release folder. No dependencies needed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] || fileURLToPath(new URL('../releases/ready-to-run/index-studio-1.0.0', import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, 'app', 'manifest.json'), 'utf8'));
assert.ok(!existsSync(join(root, 'node_modules')), 'Verify the extracted archive without dependencies.');
const expected = new Set([...Object.keys(manifest.files), 'app/manifest.json']);
function verifyTree(dir, prefix = '') {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix + item.name;
    assert.ok(!item.isSymbolicLink(), 'No symlinks are allowed.');
    if (item.isDirectory()) verifyTree(join(dir, item.name), relative + '/');
    else assert.ok(expected.has(relative), `Unexpected file: ${relative}`);
  }
}
verifyTree(root);
for (const [relative, hash] of Object.entries(manifest.files)) {
  assert.equal(createHash('sha256').update(readFileSync(join(root, relative))).digest('hex'), hash, relative);
}
for (const path of ['data', 'seed', 'exports', '.git', '.openai', 'sec275-index-updated-with-labs.json']) assert.ok(!existsSync(join(root, path)), path);
const temp = mkdtempSync(join(tmpdir(), 'index-release-smoke-'));
const port = String(42000 + Math.floor(Math.random() * 18000));
const env = { ...process.env, INDEX_APP_DATA_DIR: temp, INDEX_APP_PORT: port, INDEX_APP_NO_OPEN: '1', PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH}` };
const base = `http://127.0.0.1:${port}`;
async function launcher(action) {
  const options = { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] };
  const filename = action === 'start' ? 'Start' : 'Stop';
  const child = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `${filename}.cmd`], options)
    : spawn('bash', [join(root, process.platform === 'darwin' ? `${filename}.command` : `${action}.sh`)], options);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, output);
}
function status() {
  return spawnSync(process.execPath, [join(root, 'app/scripts/launcher.mjs'), 'status'], { env, encoding: 'utf8' });
}
try {
  assert.equal(status().status, 1, 'An empty instance is stopped.');
  await launcher('start');
  const active = status();
  assert.equal(active.status, 0, active.stderr);
  assert.match(active.stdout, /is running/);
  assert.equal((await fetch(base)).status, 200);
  const health = await (await fetch(`${base}/api/v1/health`)).json();
  assert.equal(health.profile.displayName, 'My Index');
  assert.equal((await (await fetch(`${base}/api/v1/status`)).json()).total, 0);
  await launcher('start'); // Repeat start reuses the owned instance.
  const created = await fetch(`${base}/api/v1/entries`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: 'example', concept: 'Release smoke entry', bookNumber: '1', pageNumber: '1' }),
  });
  assert.equal(created.status, 201);
  await launcher('stop');
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/v1/health`, { signal: AbortSignal.timeout(100) }); }
    catch { break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status().status, 1, 'Stopped instance reports stopped.');
  await launcher('start');
  assert.equal((await (await fetch(`${base}/api/v1/status`)).json()).total, 1, 'Data survives restart.');
  console.log('Extracted release verified: checksums, no user data, portable start/stop, no npm dependencies, empty first run, API write and restart persistence.');
} finally {
  await launcher('stop');
  for (let i = 0; i < 100 && existsSync(join(temp, `shutdown-token-${port}.txt`)); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(temp, { recursive: true, force: true });
}

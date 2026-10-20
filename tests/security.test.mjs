import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { defaultDataDir, configuredPort } from '../server/runtime.mjs';
import { requestAllowed } from '../server/security.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('storage uses private platform locations and ports are validated', () => {
  assert.equal(defaultDataDir('darwin', {}, '/users/example'), join('/users/example', 'Library', 'Application Support', 'Index Studio'));
  assert.equal(defaultDataDir('linux', {}, '/home/example'), join('/home/example', '.local', 'share', 'index-studio'));
  assert.equal(defaultDataDir('linux', { XDG_DATA_HOME: '/tmp/custom' }, '/home/example'), join('/tmp/custom', 'index-studio'));
  assert.equal(defaultDataDir('linux', { XDG_DATA_HOME: 'relative' }, '/home/example'), join('/home/example', '.local', 'share', 'index-studio'));
  for (const value of ['0', '80', '65536', '4010.5', 'NaN']) assert.throws(() => configuredPort(value));
  assert.equal(configuredPort('4010'), 4010);
});

test('requests require exact loopback authority and same origin', () => {
  const base = 'http://127.0.0.1:4010';
  const allowed = (headers) => requestAllowed({ headers }, base);
  assert.equal(allowed({ host: '127.0.0.1:4010' }), true);
  assert.equal(allowed({ host: '127.0.0.1:4010', origin: base }), true);
  for (const headers of [
    { host: 'evil.example:4010' },
    { host: '127.0.0.1:4010', origin: 'http://127.0.0.1:9000' },
    { host: '127.0.0.1:4010', origin: 'null' },
    { host: '127.0.0.1:4010', 'sec-fetch-site': 'cross-site' },
    { host: '127.0.0.1:4010', 'sec-fetch-site': 'same-site' },
  ]) assert.equal(allowed(headers), false);
});

test('clean server: empty data, usable API, browser isolation, private files and safe shutdown', { timeout: 20000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'index-release-security-'));
  const port = 42000 + Math.floor(Math.random() * 18000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.mjs', '--no-open', '--data-dir', temp, '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stderr.on('data', (chunk) => { log += chunk; });
  const exited = once(child, 'exit');
  const jsonPost = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/v1/health`)).ok) { ready = true; break; } } catch {}
      if (child.exitCode !== null) throw new Error(log);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, log);
    const health = await (await fetch(`${base}/api/v1/health`)).json();
    assert.equal(health.profile.displayName, 'My Index');
    assert.equal((await (await fetch(`${base}/api/v1/status`)).json()).total, 0);
    const html = await fetch(base);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(html.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal((await fetch(`${base}/api/v1/entries`, jsonPost({ keyword: 'example', concept: 'Synthetic release check', bookNumber: '1', pageNumber: '1' }))).status, 201);
    const exported = await fetch(`${base}/api/v1/exports/json`);
    assert.equal(exported.status, 200);
    assert.equal((await exported.json()).entries.length, 1);
    for (const path of ['/', '/api/v1/exports/json', '/api/v1/status']) {
      assert.equal((await fetch(`${base}${path}`, { headers: { Origin: 'https://evil.example' } })).status, 403);
      assert.equal((await fetch(`${base}${path}`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    }
    assert.equal((await fetch(`${base}/api/v1/profiles/my-index/activate`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await fetch(`${base}/api/v1/entries`, { ...jsonPost({}), body: '{broken' })).status, 400);
    assert.equal((await fetch(`${base}/api/v1/entries`, jsonPost(null))).status, 400);
    assert.equal((await fetch(`${base}/api/v1/profiles`, jsonPost({ code: 'bad"\r\nheader' }))).status, 422);
    assert.equal((await fetch(`${base}/api/v1/shutdown`, jsonPost({}))).status, 401);
    if (process.platform !== 'win32') {
      assert.equal(statSync(temp).mode & 0o777, 0o700);
      assert.equal(statSync(health.dataPath).mode & 0o777, 0o600);
      assert.equal(statSync(join(temp, `shutdown-token-${port}.txt`)).mode & 0o777, 0o600);
    }
    const token = readFileSync(join(temp, `shutdown-token-${port}.txt`), 'utf8');
    assert.equal((await fetch(`${base}/api/v1/shutdown`, { ...jsonPost({}), headers: { ...jsonPost({}).headers, Authorization: `Bearer ${token}` } })).status, 200);
    await exited;
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await exited; }
    rmSync(temp, { recursive: true, force: true });
  }
});

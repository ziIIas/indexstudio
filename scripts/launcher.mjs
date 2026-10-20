import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredPort, defaultDataDir } from '../server/runtime.mjs';

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const port = configuredPort();
  const url = `http://127.0.0.1:${port}`;
  const dataDir = defaultDataDir();
  process.umask(0o077);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const command = process.argv[2] || 'start';
  if (!['start', 'stop', 'status'].includes(command)) throw new Error('Usage: node scripts/launcher.mjs start|stop|status');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 LTS or newer.');
  function token() {
    try { return readFileSync(join(dataDir, `shutdown-token-${port}.txt`), 'utf8').trim(); } catch { return ''; }
  }
  async function running() {
    try {
      const response = await fetch(`${url}/api/v1/health`, {
        headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(800),
      });
      const health = await response.json();
      if (!response.ok || health.app !== 'Index Studio') return false;
      // Only reuse or stop an instance whose private control token we possess.
      const control = await fetch(`${url}/api/v1/control`, {
        headers: { Authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(800),
      });
      return control.ok;
    } catch { return false; }
  }
  function openBrowser() {
    const [program, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
    const child = spawn(program, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  }
  if (command === 'status') {
    const active = await running();
    console.log(active ? `Index Studio is running at ${url}` : 'Index Studio is not running.');
    process.exitCode = active ? 0 : 1;
    return;
  }
  if (command === 'stop') {
    if (!(await running())) {
      console.log('Index Studio is not running.');
    } else {
      const response = await fetch(`${url}/api/v1/shutdown`, {
        method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) throw new Error(`Stop failed (${response.status}).`);
      console.log('Index Studio is stopping.');
    }
  } else {
    if (!(await running())) {
      if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('The app has not been built. From the source folder run npm run setup, then npm run launch.');
      const logPath = join(dataDir, 'server.log');
      const log = openSync(logPath, 'a', 0o600);
      chmodSync(logPath, 0o600);
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'server', 'index.mjs'), '--no-open'], {
        cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log],
      });
      closeSync(log);
      let failed = false;
      child.on('error', () => { failed = true; });
      child.on('exit', () => { failed = true; });
      child.unref();
      let ready = false;
      for (let i = 0; i < 50 && !failed; i++) {
        if (await running()) { ready = true; break; }
        await pause(100);
      }
      if (!ready) throw new Error(`Could not start Index Studio. See ${logPath}. The port may already be in use.`);
    }
    if (process.env.INDEX_APP_NO_OPEN !== '1') openBrowser();
    console.log(`Index Studio is running at ${url}`);
    console.log(`Private data: ${dataDir}`);
  }
}

main().catch((error) => {
  console.error(`Index Studio: ${error.message}`);
  process.exitCode = 1;
});

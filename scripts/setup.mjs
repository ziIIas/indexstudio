import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Install Node.js 24 LTS or newer from https://nodejs.org/en/download, then run npm run setup again.');
  process.exit(1);
}
console.log('Setting up Index Studio from source. This downloads pinned dependencies and builds the app.');
// npm supplies its own JS entry point: no shell interpolation is needed on Windows.
const npmCli = process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) {
  console.error('Run this setup with: npm run setup');
  process.exit(1);
}
for (const args of [['ci', '--no-fund'], ['run', 'build']]) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error('Setup stopped. Resolve the error above, then run npm run setup again.');
    process.exit(result.status || 1);
  }
}
if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('The build did not produce the app.');
console.log('\nSetup complete. Start with: npm run launch\nStop with: npm run stop\nNo login is needed. Your data stays on this computer.');

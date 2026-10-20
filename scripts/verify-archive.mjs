import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a stable release version.');
const archive = resolve(process.argv[2] || join(root, 'releases', `index-studio-${version}.tar.gz`));
if (!existsSync(archive)) throw new Error(`Release archive not found: ${archive}`);
// Keep Windows paths out of Git Bash/GNU tar. Use the native archive utility.
const tar = process.platform === 'win32'
  ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';
const tempRoot = resolve(process.env.RUNNER_TEMP || tmpdir());
const stage = mkdtempSync(join(tempRoot, 'index-release smoke-'));
function run(program, args) {
  const result = spawnSync(program, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited with ${result.status ?? result.signal}.`);
}
try {
  run(tar, ['-xzf', archive, '-C', stage]);
  run(process.execPath, [join(root, 'scripts', 'verify-release.mjs'), join(stage, `index-studio-${version}`)]);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

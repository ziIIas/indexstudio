import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected a stable numeric release version.');
const name = `index-studio-${pkg.version}`;
const output = join(root, 'releases');
const files = JSON.parse(readFileSync(join(root, 'config/release-files.json'), 'utf8'));
if (!Array.isArray(files) || new Set(files).size !== files.length) throw new Error('Invalid source allowlist.');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const forbidden = /(^|\/)(data|seed|exports|private|archive|node_modules|\.git|\.openai|\.env[^/]*)(\/|$)|\.(sqlite(?:-[^/]*)?|log|pem|key)$/i;
function checkPath(relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..') || forbidden.test(relative)) {
    throw new Error(`Unsafe release path: ${relative}`);
  }
  const source = resolve(root, relative);
  if (!source.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error(`Path escapes source: ${relative}`);
  let path = root;
  for (const part of relative.split('/')) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Symlinks are forbidden: ${relative}`);
  }
  if (!lstatSync(source).isFile()) throw new Error(`Not a release file: ${relative}`);
  return source;
}
function assets(directory, prefix = 'dist') {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Symlinks are forbidden in built assets.');
    if (stat.isDirectory()) return assets(path, `${prefix}/${entry}`);
    if (!/\.(html|js|css|svg)$/.test(entry)) throw new Error(`Unexpected build asset: ${entry}`);
    return [`${prefix}/${entry}`];
  });
}
if (!existsSync(join(root, 'dist/index.html'))) throw new Error('Use npm run release to build and test before packaging.');
const runtime = [
  ['docs/QUICK-START.md', 'README.md'],
  ['docs/API.md', 'docs/API.md'],
  ['launchers/windows/Start.cmd', 'Start.cmd'],
  ['launchers/windows/Stop.cmd', 'Stop.cmd'],
  ['launchers/macos/Start.command', 'Start.command'],
  ['launchers/macos/Stop.command', 'Stop.command'],
  ['launchers/linux/start.sh', 'start.sh'],
  ['launchers/linux/stop.sh', 'stop.sh'],
  ['scripts/launcher.mjs', 'app/scripts/launcher.mjs'],
  ...files.filter((path) => path.startsWith('server/')).map((path) => [path, `app/${path}`]),
  ...assets(join(root, 'dist')).map((path) => [path, `app/${path}`]),
];
const source = files.map((path) => [path, path]);
for (const [path] of [...runtime, ...source]) checkPath(path);
function pack(label, group, mapping, manifestPath) {
  const stageRoot = join(output, group);
  const stage = join(stageRoot, label);
  mkdirSync(stageRoot, { recursive: true });
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
  const manifest = { name: pkg.name, version: pkg.version, files: {} };
  for (const [relative, destination] of mapping.sort((a, b) => a[1].localeCompare(b[1]))) {
    if (manifest.files[destination]) throw new Error(`Duplicate release destination: ${destination}`);
    const target = join(stage, destination);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(checkPath(relative), target);
    chmodSync(target, /\.(sh|command)$/.test(relative) ? 0o755 : 0o644);
    manifest.files[destination] = sha256(readFileSync(target));
  }
  mkdirSync(dirname(join(stage, manifestPath)), { recursive: true });
  writeFileSync(join(stage, manifestPath), JSON.stringify(manifest, null, 2) + '\n');
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (sha256(readFileSync(join(stage, relative))) !== hash) throw new Error(`Checksum mismatch: ${relative}`);
  }
  const archive = join(output, `${label}.tar.gz`);
  const result = spawnSync('tar', ['-czf', archive, '-C', stageRoot, label], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Could not create archive. Install tar and retry.');
  writeFileSync(`${archive}.sha256`, `${sha256(readFileSync(archive))}  ${label}.tar.gz\n`);
  console.log(`${archive} (${mapping.length} verified files)`);
}
pack(name, 'ready-to-run', runtime, 'app/manifest.json');
pack(`${name}-source`, 'source', source, 'SOURCE-MANIFEST.json');
console.log('App and source archives are separate. Both exclude personal data.');

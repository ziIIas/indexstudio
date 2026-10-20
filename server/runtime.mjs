import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function defaultDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (env.INDEX_APP_DATA_DIR) return resolve(env.INDEX_APP_DATA_DIR);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Index Studio');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Index Studio');
  const base = env.XDG_DATA_HOME?.startsWith('/') ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  return join(base, 'index-studio');
}

export function configuredPort(value = process.env.INDEX_APP_PORT ?? '4010') {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1024 || Number(value) > 65535) {
    throw new Error('Port must be an integer between 1024 and 65535.');
  }
  return Number(value);
}

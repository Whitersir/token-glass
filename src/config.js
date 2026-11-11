import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_SOURCES } from './sources.js';

export const APP_DIR = fileURLToPath(new URL('../', import.meta.url));
export const DATA_DIR = path.join(APP_DIR, 'data');

export async function readConfig(file = path.join(APP_DIR, 'config.json'), env = process.env) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT' || file !== path.join(APP_DIR, 'config.json')) throw error;
    text = await fs.readFile(path.join(APP_DIR, 'config.example.json'), 'utf8');
  }
  const config = JSON.parse(text);
  const home = os.homedir();
  const expand = value => path.resolve(value.replace(/^~(?=$|[\\/])/, home));
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const defaults = {
    codex: [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')],
    claude: [path.join(claudeHome, 'projects')],
    'chatgpt-web': [],
    'claude-web': [],
  };
  const sources = Object.entries(defaults).map(([name, roots]) => ({
    name,
    enabled: config.sources?.[name]?.enabled !== false && (!WEB_SOURCES.has(name) || config.browserBridge?.enabled !== false),
    roots: (config.sources?.[name]?.roots?.length ? config.sources[name].roots : roots).map(expand),
  }));
  const port = config.port ?? 7681;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('config.json 中的 port 必须在 1–65535 之间');
  const timezone = config.timezone || 'Asia/Shanghai';
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  const historicalTokens = Object.fromEntries(sources.map(source => {
    const value = config.historicalTokens?.[source.name] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('historicalTokens 必须是非负整数');
    return [source.name, value];
  }));
  return { port, refreshSeconds: Math.max(5, Number(config.refreshSeconds) || 30), timezone, sources, historicalTokens, browserBridge: { enabled: config.browserBridge?.enabled !== false } };
}

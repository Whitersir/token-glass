import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WEB_SOURCES } from './sources.js';

export async function readBridgeKey(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'browser-bridge.key');
  try { await fs.writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = (await fs.readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('网页统计连接密钥格式错误，原文件已保留');
  return key;
}

export function authorizedBridge(req, key) {
  const supplied = req.headers.authorization || '';
  const expected = `Bearer ${key}`;
  return typeof supplied === 'string' && supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function validateSnapshot(value) {
  const keys = ['source', 'session', 'instance', 'input', 'output', 'active', 'visible', 'estimator', 'capturedAt'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('网页计数格式错误');
  if (!WEB_SOURCES.has(value.source) || !/^[a-f0-9]{64}$/.test(value.session) || !/^[a-f0-9]{32}$/.test(value.instance)) throw new Error('网页来源或会话格式错误');
  for (const key of ['input', 'output']) if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 100_000_000) throw new Error('网页计数超出范围');
  if (typeof value.active !== 'boolean' || typeof value.visible !== 'boolean' || value.estimator !== 'unicode-v1') throw new Error('网页计数格式错误');
  if (typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))) throw new Error('网页采集时间格式错误');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

export async function readJsonBody(req, maxBytes = 4096) {
  const chunks = [];
  await new Promise((resolve, reject) => {
    let bytes = 0, tooLarge = false;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { tooLarge = true; chunks.length = 0; } else if (!tooLarge) chunks.push(chunk); });
    req.on('end', () => tooLarge ? reject(new Error('网页请求过大')) : resolve());
    req.on('error', reject); req.on('aborted', () => reject(new Error('网页请求已中断')));
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('网页请求不是有效 JSON'); }
}

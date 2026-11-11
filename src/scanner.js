import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { blankContext, parseRecord } from './parser.js';
import { dateKey } from './report.js';
import { WEB_SOURCES } from './sources.js';
import { validateSnapshot } from './browser-bridge.js';

const VERSION = 1;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), 'utf8');
  await fs.rename(temporary, file);
}

// Byte offsets are committed only at complete newline boundaries. A partially
// written UTF-8 character / JSON record is read again on the next sync.
export async function readLines(file, offset, size, visit) {
  if (offset >= size) return { offset, malformed: 0 };
  let pending = Buffer.alloc(0);
  let committed = offset;
  let malformed = 0;
  let discarding = false;
  const stream = createReadStream(file, { start: offset, end: size - 1, highWaterMark: 256 * 1024 });
  for await (const chunk of stream) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let end = pending.indexOf(10); end !== -1; end = pending.indexOf(10, start)) {
      const line = pending.subarray(start, end);
      committed += line.length + 1;
      if (discarding || line.length > MAX_LINE_BYTES) {
        if (!discarding) malformed++;
      } else if (line.length) {
        let obj;
        try { obj = JSON.parse(line.toString('utf8').replace(/^\uFEFF/, '')); }
        catch { malformed++; }
        if (obj) visit(obj);
      }
      discarding = false;
      start = end + 1;
    }
    pending = pending.subarray(start);
    if (pending.length > MAX_LINE_BYTES) {
      malformed++;
      // Do not commit an incomplete overlong record: retry from its start.
      stream.destroy();
      break;
    }
  }
  return { offset: committed, malformed };
}

async function inventory(root, found, warnings) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') warnings.push(`无法读取目录：${root}（${error.code}）`);
    return;
  }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) await inventory(file, found, warnings);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.add(file);
  }
}

async function fingerprint(file, length) {
  if (!length) return '';
  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex');
  } finally { await handle.close(); }
}

export class Tracker {
  constructor(config, dataDir) {
    this.config = config;
    this.dataDir = dataDir;
    this.state = { version: VERSION, files: {}, records: {}, lastSync: null, lastResult: null };
    this.syncPromise = null;
    this.mutation = Promise.resolve();
    this.webPresence = new Map();
  }

  async load() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.dataDir, 'usage.json'), 'utf8'));
      if (saved.version !== VERSION || !saved.files || !saved.records) throw new Error('数据格式不兼容');
      this.state = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`无法打开本地统计数据，原文件已保留：${error.message}`);
    }
    return this;
  }

  sync() {
    if (!this.syncPromise) this.syncPromise = this.enqueue(() => this.performSync()).finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }

  enqueue(operation) {
    const pending = this.mutation.then(operation);
    this.mutation = pending.catch(() => {});
    return pending;
  }

  ingestWebSnapshot(value, now = new Date()) {
    const snapshot = validateSnapshot(value);
    if (!this.config.sources.some(source => source.enabled && source.name === snapshot.source)) throw new Error('此网页来源已停用');
    return this.enqueue(async () => {
      const next = structuredClone(this.state);
      next.webConversations ||= {};
      next.webStatus ||= {};
      const key = `${snapshot.source}:${snapshot.session}`;
      const previous = next.webConversations[key] || { input: 0, output: 0 };
      // High-water marks make reloads, duplicate tabs and partial/virtualized
      // DOM snapshots idempotent. This measures observed text, not API calls.
      const input = Math.max(previous.input, snapshot.input), output = Math.max(previous.output, snapshot.output);
      const deltaInput = input - previous.input, deltaOutput = output - previous.output;
      const timestamp = now.toISOString();
      if (deltaInput || deltaOutput) {
        const id = createHash('sha256').update(`${key}:${dateKey(timestamp, this.config.timezone)}`).digest('hex');
        const old = next.records[id];
        const row = old || { id, source: snapshot.source, session: snapshot.session, model: 'web-text-estimate', project: '', timestamp, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, estimated: true, measurement: 'visible-text', estimator: 'unicode-v1' };
        row.input += deltaInput; row.output += deltaOutput; row.total = row.input + row.output;
        next.records[id] = row;
        next.webConversations[key] = { input, output };
      }
      next.webStatus[snapshot.source] = { lastSeen: timestamp, estimator: snapshot.estimator };
      next.lastSync = timestamp;
      if (deltaInput || deltaOutput) {
        await atomicWrite(path.join(this.dataDir, 'usage.json'), next);
        this.state = next;
      } else { this.state.webStatus = next.webStatus; this.state.lastSync = timestamp; }
      const seen = new Date(Math.min(now.getTime(), Date.parse(snapshot.capturedAt))).toISOString();
      this.webPresence.set(snapshot.instance, { instance: snapshot.instance, source: snapshot.source, active: snapshot.active, visible: snapshot.visible, lastSeen: seen });
      for (const [id, entry] of this.webPresence) if (now - new Date(entry.lastSeen) > 45_000) this.webPresence.delete(id);
      await atomicWrite(path.join(this.dataDir, 'browser-presence.json'), { pages: [...this.webPresence.values()] });
      return { accepted: true, addedTokens: deltaInput + deltaOutput, input, output, estimated: true };
    });
  }

  async performSync() {
    // Stage the scan. Readers continue seeing the last complete snapshot, and
    // a failed write never commits new cursors without their corresponding rows.
    const next = structuredClone(this.state);
    const result = { scannedFiles: 0, changedFiles: 0, addedRecords: 0, updatedRecords: 0, malformedLines: 0, bytesRead: 0, sources: [], warnings: [] };
    for (const source of this.config.sources.filter(item => item.enabled)) {
      if (WEB_SOURCES.has(source.name)) continue;
      const found = new Set();
      for (const root of source.roots) await inventory(root, found, result.warnings);
      result.sources.push({ name: source.name, files: found.size, roots: source.roots });
      for (const file of [...found].sort()) {
        result.scannedFiles++;
        const key = `${source.name}:${path.resolve(file)}`;
        try {
          const stat = await fs.stat(file);
          const previous = next.files[key];
          const same = previous && previous.birthtimeMs === stat.birthtimeMs && previous.inode === stat.ino && previous.offset <= stat.size && previous.prefixHash === await fingerprint(file, previous.prefixBytes);
          const offset = same ? previous.offset : 0;
          if (same && offset === stat.size) continue;
          const context = same ? structuredClone(previous.context) : blankContext();
          const parsed = [];
          const scan = await readLines(file, offset, stat.size, obj => {
            const record = parseRecord(obj, source.name, context, file);
            if (record) parsed.push(record);
          });
          for (const record of parsed) {
            const old = next.records[record.id];
            if (!old) { next.records[record.id] = record; result.addedRecords++; }
            // A streamed Claude message can be updated with final usage using
            // the same message ID. Replace its counters instead of adding twice.
            else if (record.source === 'claude' && record.total > old.total) {
              next.records[record.id] = record;
              result.updatedRecords++;
            }
          }
          const prefixBytes = Math.min(4096, scan.offset);
          next.files[key] = { offset: scan.offset, birthtimeMs: stat.birthtimeMs, inode: stat.ino, prefixBytes, prefixHash: await fingerprint(file, prefixBytes), context };
          result.changedFiles++;
          result.bytesRead += scan.offset - offset;
          result.malformedLines += scan.malformed;
        } catch (error) {
          result.warnings.push(`文件读取失败：${file}（${error.code || error.message}）`);
        }
      }
    }
    next.lastSync = new Date().toISOString();
    next.lastResult = result;
    await atomicWrite(path.join(this.dataDir, 'usage.json'), next);
    this.state = next;
    return result;
  }
}

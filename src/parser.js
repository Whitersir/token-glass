import { createHash } from 'node:crypto';

const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
const hash = value => createHash('sha256').update(value).digest('hex');
export const blankContext = () => ({ model: 'unknown', project: '', session: '', previousTotal: null });

function counters(usage = {}) {
  return {
    input: number(usage.input_tokens),
    output: number(usage.output_tokens),
    cacheRead: number(usage.cached_input_tokens ?? usage.cache_read_input_tokens),
    cacheWrite: number(usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens),
    reasoning: number(usage.reasoning_output_tokens),
  };
}

function normalize(raw, source) {
  // Codex input includes cached input; Claude reports the cache separately.
  const input = source === 'codex' ? Math.max(0, raw.input - raw.cacheRead - raw.cacheWrite) : raw.input;
  return { ...raw, input, total: input + raw.output + raw.cacheRead + raw.cacheWrite };
}

export function parseRecord(obj, source, context, fileIdentity) {
  if (!obj || typeof obj !== 'object') return null;
  const payload = obj.payload || {};
  let raw;
  let identity;
  let model = context.model;
  if (source === 'codex') {
    if (obj.type === 'session_meta') {
      context.session = payload.id || payload.session_id || context.session;
      context.project = typeof payload.cwd === 'string' ? payload.cwd : context.project;
      return null;
    }
    if (obj.type === 'turn_context') {
      if (typeof payload.model === 'string') context.model = payload.model;
      if (typeof payload.cwd === 'string') context.project = payload.cwd;
      return null;
    }
    // token_usage_record and token_count can describe the same request.
    // Read only token_count to avoid counting both representations.
    if (obj.type !== 'event_msg' || payload.type !== 'token_count' || !payload.info) return null;
    const info = payload.info;
    const total = info.total_token_usage ? counters(info.total_token_usage) : null;
    const last = info.last_token_usage ? counters(info.last_token_usage) : null;
    if (total) {
      const previous = context.previousTotal;
      if (['input', 'output', 'cacheRead', 'cacheWrite'].every(key => total[key] === 0)) raw = total;
      else if (!previous) raw = last || total;
      else if (total.input < previous.input || total.output < previous.output) raw = last || total;
      else raw = Object.fromEntries(Object.keys(total).map(key => [key, Math.max(0, total[key] - previous[key])]));
      context.previousTotal = total;
    } else raw = last;
    // Preserve original event identity across copied / forked transcripts.
    identity = JSON.stringify([source, obj.timestamp, total, last]);
  } else if (source === 'claude') {
    if (typeof obj.cwd === 'string') context.project = obj.cwd;
    if (typeof obj.sessionId === 'string') context.session = obj.sessionId;
    if (obj.type !== 'assistant') return null;
    const usage = obj.message?.usage || obj.usage;
    if (!usage || typeof usage !== 'object') return null;
    raw = counters(usage);
    model = obj.message?.model || obj.model || 'unknown';
    const messageId = obj.message?.id || obj.uuid;
    identity = JSON.stringify([source, messageId || fileIdentity, obj.requestId || obj.request_id || '', messageId ? '' : obj.timestamp]);
  } else return null;

  const time = new Date(obj.timestamp);
  if (!raw || !Number.isFinite(time.getTime())) return null;
  const usage = normalize(raw, source);
  if (!usage.total) return null;
  return {
    id: hash(identity), source, timestamp: time.toISOString(), model,
    session: context.session || hash(fileIdentity).slice(0, 24),
    project: context.project || '', ...usage,
  };
}

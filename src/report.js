import path from 'node:path';
import { SOURCE_NAMES, WEB_SOURCES } from './sources.js';

const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'];
const empty = () => Object.fromEntries([...FIELDS.map(key => [key, 0]), ['requests', 0], ['estimatedTokens', 0], ['measuredTokens', 0]]);
const add = (target, row) => { for (const key of FIELDS) target[key] += row[key] || 0; target[row.estimated ? 'estimatedTokens' : 'measuredTokens'] += row.total || 0; target.requests++; };
const formatters = new Map();

export function dateKey(timestamp, timezone) {
  if (!formatters.has(timezone)) formatters.set(timezone, new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  const parts = formatters.get(timezone).formatToParts(new Date(timestamp));
  const get = name => parts.find(part => part.type === name).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function selectRecords(state, config, filters = {}) {
  const enabled = new Set(config.sources.filter(source => source.enabled).map(source => source.name));
  return Object.values(state.records).filter(row => {
    if (!enabled.has(row.source)) return false;
    const date = dateKey(row.timestamp, config.timezone);
    return (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to) && (!filters.source || row.source === filters.source) && (!filters.model || row.model === filters.model);
  });
}

export function buildReport(state, config, filters = {}) {
  const rows = selectRecords(state, config, filters);
  const lifetimeRows = selectRecords(state, config, {source: filters.source});
  const recordedTokens = lifetimeRows.reduce((sum, row) => sum + row.total, 0);
  const estimatedTokens = lifetimeRows.reduce((sum, row) => sum + (row.estimated ? row.total : 0), 0);
  const historicalTokens = config.sources.filter(source => source.enabled && (!filters.source || source.name === filters.source)).reduce((sum, source) => sum + (config.historicalTokens?.[source.name] || 0), 0);
  const totals = empty();
  const models = new Map(), projects = new Map(), daily = new Map(), sources = new Map();
  const sessions = new Set();
  const group = (map, key, row, extras = {}) => {
    if (!map.has(key)) map.set(key, { name: key, ...extras, ...empty() });
    add(map.get(key), row);
  };
  for (const row of rows) {
    add(totals, row);
    sessions.add(`${row.source}:${row.session}`);
    group(models, `${row.source}:${row.model}`, row, { model: row.model, source: row.source });
    group(projects, row.project || '未知项目', row, { label: row.project ? path.win32.basename(row.project.replaceAll('/', '\\')) : '未知项目' });
    group(daily, dateKey(row.timestamp, config.timezone), row);
    group(sources, row.source, row);
  }
  const sorted = map => [...map.values()].sort((a, b) => b.total - a.total);
  const today = dateKey(new Date().toISOString(), config.timezone);
  const todayTotals = empty();
  for (const row of rows) if (dateKey(row.timestamp, config.timezone) === today) add(todayTotals, row);
  return {
    lifetime: { total: recordedTokens + historicalTokens, recordedTokens, historicalTokens, estimatedTokens, measuredTokens: recordedTokens - estimatedTokens + historicalTokens },
    totals: { ...totals, sessions: sessions.size }, today: todayTotals,
    models: sorted(models), projects: sorted(projects), daily: [...daily.values()].sort((a, b) => a.name.localeCompare(b.name)), sources: sorted(sources),
    recent: rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 60),
    availableModels: [...new Set(Object.values(state.records).map(row => row.model))].sort(),
    lastSync: state.lastSync, lastResult: state.lastResult, timezone: config.timezone,
    refreshSeconds: config.refreshSeconds,
    sourceLabel: SOURCE_NAMES[filters.source] || '全部来源',
    measurement: WEB_SOURCES.has(filters.source) ? 'visible-text' : estimatedTokens ? 'mixed' : 'usage',
    webStatus: state.webStatus || {},
    browserBridgeEnabled: config.browserBridge?.enabled === true,
  };
}

function cell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function exportCsv(rows) {
  const columns = ['timestamp', 'source', 'model', 'project', 'session', 'input', 'cacheRead', 'cacheWrite', 'output', 'reasoning', 'total', 'measurement'];
  const labels = ['时间（UTC；网页为首次采集日）', '工具', '模型', '项目', '会话', '普通输入', '缓存读取', '缓存写入', '输出（含推理）', '推理（输出子集）', '总 token', '计量方式（visible-text 为可见文本估算）'];
  return '\uFEFF' + [labels.map(cell).join(','), ...[...rows].sort((a,b) => a.timestamp.localeCompare(b.timestamp)).map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}

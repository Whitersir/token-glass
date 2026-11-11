const $ = id => document.getElementById(id);
const fmt = n => Number(n || 0).toLocaleString('zh-CN');
const short = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : fmt(n);
const toolName = source => ({codex:'Codex',claude:'Claude Code','chatgpt-web':'ChatGPT 网页 · 估算','claude-web':'Claude 网页 · 估算'}[source] || source);
let timezone = 'Asia/Shanghai', refreshSeconds = 30, activeRange = 'all', requestId = 0, fetching = false;

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
function message(text, error = false) {
  $('message').textContent = text;
  $('message').hidden = !text;
  $('message').classList.toggle('error', error);
}
function query() {
  const params = new URLSearchParams();
  for (const key of ['from', 'to', 'source', 'model']) if ($(key).value) params.set(key, $(key).value);
  return params.toString();
}
function dayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = name => parts.find(item => item.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function setRange(value) {
  activeRange = value;
  const today = dayKey();
  const end = new Date(`${today}T12:00:00Z`);
  if (value !== 'all') end.setUTCDate(end.getUTCDate() - (value === 'today' ? 0 : Number(value) - 1));
  $('from').value = value === 'all' ? '' : end.toISOString().slice(0,10);
  $('to').value = value === 'all' ? '' : today;
  for (const button of document.querySelectorAll('[data-range]')) {
    const selected = button.dataset.range === value;
    button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
  }
  load();
}
function renderTrend(rows) {
  const host = $('trend'); host.replaceChildren();
  if (!rows.length) { host.append(node('div', '这个时间范围还没有用量记录', 'empty')); return; }
  // Keep a daily scale, including quiet days; long histories show the latest 90 days.
  const to = $('to').value || rows.at(-1).name;
  const from = $('from').value || rows[0].name;
  const start = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  if ((end - start) / 86400000 > 89) start.setTime(end.getTime() - 89 * 86400000);
  const byDay = new Map(rows.map(row => [row.name, row.total]));
  const days = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const name = d.toISOString().slice(0, 10); days.push({ name, total: byDay.get(name) || 0 });
  }
  $('trend-caption').textContent = `每日用量 · ${days.length > 30 ? '最近 ' + days.length + ' 天' : timezone}`;
  const ns = 'http://www.w3.org/2000/svg';
  const svgNode = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [key,value] of Object.entries(attrs)) e.setAttribute(key, value); if (text !== undefined) e.textContent = text; return e; };
  const svg = svgNode('svg', { viewBox: '0 0 650 200', preserveAspectRatio: 'none', role: 'img', 'aria-label': '每日 token 柱状图' });
  const max = Math.max(1, ...days.map(row => row.total));
  for (let i = 0; i <= 3; i++) {
    const y = 15 + i * 49;
    svg.append(svgNode('line', { x1: 47, y1: y, x2: 643, y2: y, class: 'grid' }));
    svg.append(svgNode('text', { x: 39, y: y + 3, 'text-anchor': 'end' }, short(max * (3-i) / 3)));
  }
  const step = 596 / days.length;
  days.forEach((row, index) => {
    const height = row.total / max * 147;
    const bar = svgNode('rect', { x: 47 + index * step + step * .2, y: 162 - height, width: Math.max(1,step * .6), height: Math.max(row.total ? 2 : 0, height), rx: Math.min(3, step * .12), class: 'bar' });
    bar.append(svgNode('title', {}, `${row.name}：${fmt(row.total)} token`)); svg.append(bar);
    const labelStep = Math.max(1, Math.ceil(days.length / 7));
    if (index % labelStep === 0 || index === days.length - 1 && days.length % labelStep > 1) svg.append(svgNode('text', { x: 47 + index * step + step / 2, y: 187, 'text-anchor': 'middle' }, row.name.slice(5).replace('-', '/')));
  });
  host.append(svg);
  host.setAttribute('aria-label', days.map(row => `${row.name} ${fmt(row.total)} token`).join('；'));
}
function renderModels(rows, total) {
  const host = $('model-list'); host.replaceChildren();
  if (!rows.length) { host.append(node('div', '还没有模型用量', 'empty')); return; }
  for (const row of rows.slice(0,5)) {
    const item = node('div', undefined, 'model-row'), label = node('div', undefined, 'model-label'), name = node('span', undefined, 'name');
    const title = node('span', row.model, 'model-name'); title.title = `${toolName(row.source)} / ${row.model}`;
    name.append(node('i', undefined, 'dot'), title); label.append(name, node('b', `${short(row.total)} · ${(row.total / total * 100).toFixed(1)}%`));
    const meter = node('div', undefined, 'meter');
    // Use a width attribute on SVG so the page can keep a strict style policy.
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '100%'); svg.setAttribute('height', '5');
    const rect = document.createElementNS(ns, 'rect'); rect.setAttribute('width', `${Math.max(.4,row.total / total * 100)}%`); rect.setAttribute('height', '5'); rect.setAttribute('rx', '2'); rect.setAttribute('fill', '#86a880'); svg.append(rect); meter.append(svg);
    item.append(label, meter); host.append(item);
  }
  host.append(node('p', `共 ${rows.length} 个工具 / 模型组合`, 'model-footnote'));
}
function renderRecent(rows) {
  const host = $('recent'); host.replaceChildren();
  if (!rows.length) { const tr = node('tr'), td = node('td', '暂无记录。首次同步完成后，用量会显示在这里。', 'empty'); td.colSpan = 5; tr.append(td); host.append(tr); return; }
  for (const row of rows) {
    const date = new Date(row.timestamp), tr = node('tr'), when = node('td');
    when.append(node('span', new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(date)));
    const model = node('td'); const label = node('span', row.model, 'tool-name'); label.title = row.model;
    model.append(label, node('small', toolName(row.source), 'time-sub'));
    if (row.estimated) when.title = '网页可见文本估算；此时间为采集时间，不是原消息发送时间';
    const input = node('td', short(row.input), 'numeric'); input.title = `普通输入 ${fmt(row.input)}，缓存读取 ${fmt(row.cacheRead)}，缓存写入 ${fmt(row.cacheWrite)}`;
    const output = node('td', short(row.output), 'numeric'); output.title = `输出 ${fmt(row.output)}，其中推理 ${fmt(row.reasoning)}`;
    const total = node('td', (row.estimated ? '≈ ' : '') + short(row.total), 'numeric'); total.title = fmt(row.total);
    tr.append(when, model, input, output, total); host.append(tr);
  }
}
function renderProjects(rows) {
  const host = $('projects'); host.replaceChildren();
  if (!rows.length) { host.append(node('div', '还没有项目用量', 'empty')); return; }
  for (const row of rows) {
    const item = node('div', undefined, 'project'), title = node('div', undefined, 'project-title'), label = node('b', row.label);
    label.title = row.name;
    title.append(label, node('small', `${fmt(row.requests)} 条用量记录`)); item.append(title, node('strong', short(row.total))); host.append(item);
  }
}
function render(report) {
  timezone = report.timezone; refreshSeconds = report.refreshSeconds;
  $('web-note').hidden = report.measurement === 'usage';
  $('total').textContent = fmt(report.totals.total); $('input').textContent = fmt(report.totals.input); $('output').textContent = fmt(report.totals.output); $('cache').textContent = fmt(report.totals.cacheRead + report.totals.cacheWrite);
  $('total-note').textContent = report.lifetime?.historicalTokens ? `含历史补录的累计总量 ${short(report.lifetime.total)} · 补录 ${short(report.lifetime.historicalTokens)}` : `${fmt(report.totals.sessions)} 个会话 · ${fmt(report.totals.requests)} 条用量记录`;
  if (report.measurement === 'visible-text') {
    $('total').textContent = '≈ ' + fmt(report.totals.total);
    $('total-note').textContent = '网页可见文本估算 · 按采集日期归档';
  } else if (report.totals.estimatedTokens) $('total-note').textContent += ` · 其中网页文本估算 ${short(report.totals.estimatedTokens)}`;
  $('reasoning').textContent = `其中推理 ${short(report.totals.reasoning)}（已包含）`;
  $('cache-note').textContent = `读取 ${short(report.totals.cacheRead)} / 写入 ${short(report.totals.cacheWrite)}`;
  if (report.measurement === 'visible-text') {
    $('reasoning').textContent = '可见回复文本；隐藏推理不可获取';
    $('cache').textContent = '—'; $('cache-note').textContent = '网页缓存用量不可获取';
  }
  $('record-count').textContent = `${fmt(report.totals.requests)} 条记录`;
  $('range-note').textContent = `${$('from').value || $('to').value ? ($('from').value || '最早') + ' 至 ' + ($('to').value || '现在') : '全部历史'} · ${timezone}`;
  const currentModel = $('model').value;
  const options = [node('option', '所有模型')]; options[0].value = '';
  for (const name of report.availableModels) { const option = node('option', name); option.value = name; options.push(option); }
  $('model').replaceChildren(...options); $('model').value = currentModel;
  renderTrend(report.daily); renderModels(report.models, report.totals.total); renderRecent(report.recent); renderProjects(report.projects);
  const last = report.lastResult;
  const web = ['chatgpt-web','claude-web'].map(source => `${toolName(source)}：${report.webStatus?.[source] ? '已连接' : '等待扩展'}`);
  $('sources').textContent = [...(last?.sources || []).map(source => `${toolName(source.name)} ${source.files ? source.files + ' 个日志' : '未检测到'}`), ...(report.browserBridgeEnabled ? web : [])].join('　 /　 ') || '首次同步中…';
  $('sync-status').textContent = report.lastSync ? `上次同步 ${new Intl.DateTimeFormat('zh-CN',{timeZone:timezone,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(report.lastSync))} · 每 ${refreshSeconds} 秒自动同步` : '正在导入历史日志，请稍候…';
  if (last?.warnings.length || last?.malformedLines) message([...(last.warnings || []), ...(last.malformedLines ? [`本次跳过 ${last.malformedLines} 条无法解析的日志行。`] : [])].join('\n'));
  else if (last && !last.sources.some(source => source.files)) message('没有找到日志。请确认已使用过 Codex 或 Claude Code；自定义日志目录可在 config.json 中设置。');
  else message('');
}
async function load() {
  const id = ++requestId;
  if ($('from').value && $('to').value && $('from').value > $('to').value) { message('开始日期不能晚于结束日期。', true); return; }
  try {
    const response = await fetch(`/api/report?${query()}`);
    const report = await response.json();
    if (id !== requestId) return;
    if (!response.ok) throw new Error(report.error);
    render(report);
  } catch (error) { if (id === requestId) message(`无法读取统计：${error.message}。请确认统计工具仍在运行。`, true); }
}
for (const button of document.querySelectorAll('[data-range]')) button.addEventListener('click', () => setRange(button.dataset.range));
for (const id of ['source', 'model', 'from', 'to']) $(id).addEventListener('change', () => {
  if (id === 'from' || id === 'to') { activeRange = 'custom'; for (const button of document.querySelectorAll('[data-range]')) { button.classList.remove('active'); button.setAttribute('aria-pressed','false'); } }
  load();
});
$('sync').addEventListener('click', async () => {
  $('sync').disabled = true; $('sync').querySelector('span').textContent = '同步中…';
  try {
    const response = await fetch('/api/sync', { method: 'POST', headers: { 'X-Token-Meter':'local' } });
    const result = await response.json(); if (!response.ok) throw new Error(result.error);
    await load();
  } catch (error) { message(`同步失败：${error.message}`, true); }
  finally { $('sync').disabled = false; $('sync').querySelector('span').textContent = '立即同步'; }
});
$('export').addEventListener('click', () => {
  if ($('from').value && $('to').value && $('from').value > $('to').value) { message('开始日期不能晚于结束日期。', true); return; }
  window.location.href = `/api/export.csv?${query()}`;
});
async function poll() {
  if (!document.hidden && !fetching) {
    fetching = true;
    try { if (activeRange !== 'all' && activeRange !== 'custom' && $('to').value !== dayKey()) setRange(activeRange); else await load(); }
    finally { fetching = false; }
  }
  setTimeout(poll, 5000);
}
load(); setTimeout(poll, 5000);

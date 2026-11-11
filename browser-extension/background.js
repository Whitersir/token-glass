importScripts('core.js', 'connection.js');
const connection = globalThis.TOKEN_METER_CONNECTION;
let work = Promise.resolve();
const serial = operation => { const pending = work.then(operation); work = pending.catch(() => {}); return pending; };

async function flush() {
  const saved = await chrome.storage.local.get(['pending', 'status']);
  const pending = saved.pending || {}, status = saved.status || {};
  let connected = false;
  for (const [id, snapshot] of Object.entries(pending)) {
    try {
      const response = await fetch(connection.origin + '/api/browser-usage', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connection.key}` },
        body: JSON.stringify(snapshot), signal: AbortSignal.timeout(5000), credentials: 'omit',
      });
      const result = await response.json();
      if (!response.ok || !result.accepted) throw new Error(result.error || '本地服务拒绝了计数');
      delete pending[id]; connected = true;
      status[snapshot.source] = { ok: true, lastSync: new Date().toISOString(), input: result.input, output: result.output };
    } catch (error) {
      status[snapshot.source] = { ...status[snapshot.source], ok: false, error: error.message, lastAttempt: new Date().toISOString() };
      break;
    }
  }
  await chrome.storage.local.set({ pending, status });
  await chrome.action.setBadgeText({ text: Object.keys(pending).length ? '…' : connected ? '✓' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#356f59' });
  return { ok: connected, queued: Object.keys(pending).length, status };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'token-meter-status' && !sender.tab) {
    serial(flush).then(respond, error => respond({ ok: false, error: error.message })); return true;
  }
  if (message?.type !== 'token-meter-snapshot' || !sender.tab) return;
  const source = TokenMeterWeb.sourceForUrl(sender.url || sender.tab.url);
  const row = message.snapshot;
  if (!source || row?.source !== source || !/^[a-f0-9]{64}$/.test(row.session) || !/^[a-f0-9]{32}$/.test(row.instance) || !['input','output'].every(key => Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 100_000_000)) {
    respond({ ok: false, error: '网页来源或计数无效' }); return;
  }
  // Build a fresh allowlisted object. Never queue page text or an arbitrary URL.
  const snapshot = { source, session: row.session, instance: row.instance, input: row.input, output: row.output, active: row.active === true, visible: row.visible === true, estimator: 'unicode-v1', capturedAt: new Date().toISOString() };
  serial(async () => {
    const { pending = {} } = await chrome.storage.local.get('pending');
    const id = `${source}:${snapshot.session}`;
    if (!pending[id] && Object.keys(pending).length >= 2000) throw new Error('离线队列已满，请启动桌面插件后重试');
    pending[id] = TokenMeterWeb.mergeSnapshot(pending[id], snapshot);
    await chrome.storage.local.set({ pending });
    return flush();
  }).then(respond, error => respond({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.create('retry-local-counts', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'retry-local-counts') serial(flush); });
chrome.runtime.onStartup.addListener(() => serial(flush));

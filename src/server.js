import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildReport, exportCsv, selectRecords } from './report.js';
import { APP_DIR } from './config.js';
import { SOURCE_NAMES } from './sources.js';
import { authorizedBridge, readJsonBody, validateSnapshot } from './browser-bridge.js';

const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/browser.html', ['browser.html', 'text/html; charset=utf-8']],
  ['/browser-setup.js', ['browser-setup.js', 'text/javascript; charset=utf-8']],
]);

function filtersFrom(url) {
  const filters = Object.fromEntries(['from', 'to', 'source', 'model'].map(key => [key, url.searchParams.get(key) || '']));
  for (const key of ['from', 'to']) if (filters[key] && !/^\d{4}-\d{2}-\d{2}$/.test(filters[key])) throw new Error('日期格式应为 YYYY-MM-DD');
  if (filters.from && filters.to && filters.from > filters.to) throw new Error('开始日期不能晚于结束日期');
  if (filters.source && !Object.hasOwn(SOURCE_NAMES, filters.source)) throw new Error('不支持的工具');
  return filters;
}

export function createServer(tracker, { onError = console.error, onStop, bridgeKey } = {}) {
  return http.createServer(async (req, res) => {
    const address = `127.0.0.1:${req.socket.localPort}`;
    const origin = `http://${address}`;
    const send = (status, body, type = 'application/json; charset=utf-8', headers = {}) => {
      res.writeHead(status, {
        'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer', ...headers,
      });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    // Only this dedicated, authenticated endpoint accepts extension requests.
    // All existing report/stop/sync routes retain their same-origin policy.
    if (req.url === '/api/browser-usage' && req.headers.host === address) {
      const extensionOrigin = req.headers.origin;
      if (!bridgeKey || !tracker.config.browserBridge?.enabled || !/^chrome-extension:\/\/[a-p]{32}$/.test(extensionOrigin || '')) { send(403, { error: '网页统计连接未获授权' }); return; }
      const cors = { 'Access-Control-Allow-Origin': extensionOrigin, Vary: 'Origin' };
      if (req.method === 'OPTIONS') {
        send(204, '', 'text/plain', { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'authorization, content-type' }); return;
      }
      if (req.method !== 'POST' || !authorizedBridge(req, bridgeKey)) { send(403, { error: '网页统计连接密钥不匹配' }, undefined, cors); return; }
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { send(415, { error: '需要 JSON 格式' }, undefined, cors); return; }
      try { send(200, await tracker.ingestWebSnapshot(validateSnapshot(await readJsonBody(req))), undefined, cors); }
      catch (error) { send(error.message.includes('过大') ? 413 : 400, { error: error.message }, undefined, cors); }
      return;
    }
    // Limit the rest of the service to the exact loopback host and same-origin requests.
    if (req.headers.host !== address || (req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      send(403, { error: '只允许本机页面访问' }); return;
    }
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && ASSETS.has(url.pathname)) {
        const [file, type] = ASSETS.get(url.pathname);
        send(200, await fs.readFile(path.join(APP_DIR, 'public', file), 'utf8'), type);
      } else if (req.method === 'GET' && url.pathname === '/api/health') {
        send(200, { app: 'local-token-meter', version: '1.0.0' });
      } else if (req.method === 'GET' && url.pathname === '/api/report') {
        send(200, buildReport(tracker.state, tracker.config, filtersFrom(url)));
      } else if (req.method === 'GET' && url.pathname === '/api/browser-setup') {
        send(200, { enabled: tracker.config.browserBridge?.enabled === true, folder: path.join(APP_DIR, 'browser-extension'), ...Object.fromEntries(['chatgpt-web','claude-web'].map(source=>[source,tracker.state.webStatus?.[source] || null])) });
      } else if (req.method === 'POST' && ['/api/sync', '/api/stop'].includes(url.pathname)) {
        if (req.headers.origin !== origin || req.headers['x-token-meter'] !== 'local') { send(403, { error: '请从本地统计页面执行同步' }); return; }
        if (url.pathname === '/api/stop') {
          if (!onStop) { send(409, { error: '此实例不支持停止' }); return; }
          send(200, { stopped: true });
          setImmediate(onStop);
        } else send(200, await tracker.sync());
      } else if (req.method === 'GET' && url.pathname === '/api/export.csv') {
        send(200, exportCsv(selectRecords(tracker.state, tracker.config, filtersFrom(url))), 'text/csv; charset=utf-8', { 'Content-Disposition': 'attachment; filename="token-usage.csv"' });
      } else if (url.pathname === '/favicon.ico') {
        res.writeHead(204); res.end();
      } else send(404, { error: '页面不存在' });
    } catch (error) {
      onError(error.message);
      send(error.message.includes('日期') || error.message.includes('工具') ? 400 : 500, { error: error.message });
    }
  });
}

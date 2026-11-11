import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readConfig, DATA_DIR } from './config.js';
import { Tracker } from './scanner.js';
import { buildReport, exportCsv, selectRecords } from './report.js';
import { createServer } from './server.js';
import { acquireLock } from './lock.js';
import { readBridgeKey } from './browser-bridge.js';

function openBrowser(url) {
  let child;
  if (process.platform === 'win32') child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' });
  else child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => console.log(`请手动打开：${url}`));
  child.unref();
}

function printSummary(report) {
  const fmt = value => value.toLocaleString('zh-CN');
  console.log(`总 token：${fmt(report.totals.total)}　今日：${fmt(report.today.total)}　用量记录：${fmt(report.totals.requests)}　会话：${fmt(report.totals.sessions)}`);
  for (const model of report.models) console.log(`  ${model.source.padEnd(7)} ${model.model.padEnd(28)} ${fmt(model.total)}`);
  if (report.lastResult?.warnings.length) console.log(`注意：${report.lastResult.warnings.join('\n')}`);
}

async function main() {
  const command = process.argv[2] || 'serve';
  if (['--help', '-h', 'help'].includes(command)) {
    console.log('本地 Token 用量\n\nnode src/cli.js serve [--open]   启动统计页面\nnode src/cli.js stop             停止本地服务\nnode src/cli.js sync             增量同步\nnode src/cli.js report [--json]  查看已有统计\nnode src/cli.js export <文件.csv> 导出全部记录\n\n配置：config.json；数据：data/；只读取 Codex / Claude 原日志。');
    return;
  }
  if (!['serve', 'stop', 'sync', 'report', 'export'].includes(command)) throw new Error(`未知命令：${command}。运行 node src/cli.js --help 查看用法。`);
  const config = await readConfig();
  if (command === 'stop') {
    const origin = `http://127.0.0.1:${config.port}`;
    const response = await fetch(origin + '/api/stop', { method: 'POST', headers: { Origin: origin, 'X-Token-Meter': 'local' }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!response) { console.log('本地统计服务未运行。'); return; }
    const result = await response.json();
    if (!response.ok || !result.stopped) throw new Error(result.error || '停止失败');
    console.log('本地统计服务已停止。'); return;
  }
  if (command === 'serve') {
    const url = `http://127.0.0.1:${config.port}`;
    const running = await fetch(url + '/api/health', { signal: AbortSignal.timeout(1000) }).then(response => response.json()).catch(() => null);
    if (running?.app === 'local-token-meter') {
      console.log(`统计工具已经运行：${url}`);
      if (process.argv.includes('--open')) openBrowser(url);
      return;
    }
  }
  const release = ['serve', 'sync'].includes(command) ? await acquireLock(DATA_DIR) : async () => {};
  let retained = false;
  try {
    const tracker = await new Tracker(config, DATA_DIR).load();
    if (command === 'report') {
      const report = buildReport(tracker.state, config);
      if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
      else printSummary(report);
      return;
    }
    if (command === 'export') {
      const output = process.argv[3];
      if (!output) throw new Error('请指定 CSV 文件路径');
      await fs.writeFile(path.resolve(output), exportCsv(selectRecords(tracker.state, config)), { encoding: 'utf8', flag: 'wx' });
      console.log(`已导出到 ${path.resolve(output)}`); return;
    }
    if (command === 'sync') {
      const result = await tracker.sync();
      printSummary(buildReport(tracker.state, config));
      console.log(`扫描 ${result.scannedFiles} 个文件，新增 ${result.addedRecords} 条，更新 ${result.updatedRecords} 条。`);
      return;
    }
    let shutdown;
    const bridgeKey = config.browserBridge.enabled ? await readBridgeKey(DATA_DIR) : undefined;
    const server = createServer(tracker, { onStop: () => shutdown(), bridgeKey });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${config.port}`;
    console.log(`本地 Token 用量已启动：${url}\n原日志只读；统计数据保存在 ${DATA_DIR}\n按 Ctrl+C 停止。`);
    const doSync = () => tracker.sync().catch(error => console.error(`同步失败：${error.message}`));
    const timer = setInterval(doSync, config.refreshSeconds * 1000);
    timer.unref();
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      server.close();
      await tracker.mutation.catch(() => {});
      await release();
      process.exit(0);
    };
    shutdown = stop;
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    retained = true;
    if (process.argv.includes('--open')) openBrowser(url);
    await doSync();
    printSummary(buildReport(tracker.state, config));
  } finally { if (!retained) await release(); }
}

main().catch(error => {
  console.error(`启动失败：${error.code === 'EADDRINUSE' ? '端口已占用，请修改 config.json 中的 port。' : error.message}`);
  process.exitCode = 1;
});

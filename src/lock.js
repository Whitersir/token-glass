import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function acquireLock(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, 'app.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      return async () => {
        try { if (JSON.parse(await fs.readFile(file, 'utf8')).token === token) await fs.unlink(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let saved;
      try { saved = JSON.parse(await fs.readFile(file, 'utf8')); }
      catch { throw new Error('另一个统计进程可能正在启动，请稍后重试。'); }
      try { process.kill(saved.pid, 0); }
      catch (probe) {
        if (probe.code === 'ESRCH') { await fs.unlink(file).catch(() => {}); continue; }
      }
      throw new Error('统计工具已经运行。请在页面点击“立即同步”，或先关闭原进程。');
    }
  }
  throw new Error('无法获取统计数据的写入锁，请稍后重试。');
}

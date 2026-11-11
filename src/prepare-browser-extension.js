import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR, DATA_DIR, readConfig } from './config.js';
import { readBridgeKey } from './browser-bridge.js';

const config = await readConfig();
const key = await readBridgeKey(DATA_DIR);
const destination = path.join(APP_DIR, 'browser-extension');
await fs.writeFile(path.join(destination, 'connection.js'), `// This computer's local connection key. Do not share this file.\nglobalThis.TOKEN_METER_CONNECTION = Object.freeze(${JSON.stringify({ origin: `http://127.0.0.1:${config.port}`, key })});\n`, 'utf8');
console.log(`Chrome 扩展已准备：${destination}\n在 chrome://extensions 启用开发者模式，加载此文件夹，然后刷新聊天网页。\n本机连接配置已生成，无需手工填写密钥。`);

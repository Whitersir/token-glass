const $ = id => document.getElementById(id);
async function status() {
  const result = await chrome.runtime.sendMessage({ type: 'token-meter-status' });
  const saved = result.status || {};
  $('status').classList.toggle('error', Boolean(result.error || result.queued));
  $('status').textContent = result.error || (result.queued ? `有 ${result.queued} 个会话等待同步，请确认桌面插件正在运行。` : Object.values(saved).some(value => value.ok) ? '已连接本地统计服务。' : '等待采集：打开聊天页并刷新一次。');
  $('providers').replaceChildren();
  for (const [source, label] of [['chatgpt-web','ChatGPT 网页'],['claude-web','Claude 网页']]) {
    const item = document.createElement('div'); item.className = 'provider'; item.textContent = label;
    const note = document.createElement('small'), info = saved[source];
    note.textContent = info ? info.ok ? `本次会话已观察文本 ≈ ${(info.input + info.output).toLocaleString()} token` : '等待本地服务重连' : '尚未采集';
    item.append(note); $('providers').append(item);
  }
}
$('capture').addEventListener('click', async () => {
  $('capture').disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'token-meter-capture' });
    await status();
    if (!result?.messages) $('status').textContent = '当前页未识别到聊天消息。请打开聊天页、展开消息并刷新；若仍无数据，网站结构可能已改变。';
  } catch { $('status').textContent = '请在 ChatGPT 或 Claude 聊天网页中使用，并在安装扩展后刷新网页。'; }
  finally { $('capture').disabled = false; }
});
$('dashboard').addEventListener('click', async () => {
  const response = await fetch(chrome.runtime.getURL('connection.js'));
  const text = await response.text();
  // Only read the fixed generated loopback origin, never evaluate code here.
  const origin = text.match(/"origin"\s*:\s*"(http:\/\/127\.0\.0\.1:\d+)"/)?.[1];
  if (origin) chrome.tabs.create({ url: origin });
});
status().catch(error => { $('status').textContent = error.message; });

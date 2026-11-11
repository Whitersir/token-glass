async function refresh() {
  try {
    const response = await fetch('/api/browser-setup');
    if (!response.ok) throw new Error('无法读取连接状态');
    const setup = await response.json();
    document.getElementById('folder').textContent = setup.folder;
    document.getElementById('connected').textContent = !setup.enabled ? '网页接收已关闭，请启用 config.json 的 browserBridge.enabled。' : [['chatgpt-web','ChatGPT'],['claude-web','Claude']].map(([source,label])=>`${label}：${setup[source]?.lastSeen ? '已收到计数' : '等待连接'}`).join('　 /　 ');
  } catch (error) { document.getElementById('connected').textContent = error.message; }
}
refresh(); setInterval(refresh,3000);

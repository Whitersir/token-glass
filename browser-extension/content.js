(() => {
  const core = globalThis.TokenMeterWeb;
  const source = core.sourceForUrl(location.href);
  if (!source) return;
  const instance = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  let timer, busy = false, pending = false, lastStatus = null, lastSnapshot = null;
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n => n.toString(16).padStart(2, '0')).join('');

  async function capture() {
    if (busy) { pending = true; return; }
    busy = true;
    const capturedUrl = location.href;
    try {
      const counts = core.collect(document, source);
      const session = await hash(core.conversationKey(capturedUrl));
      if (capturedUrl !== location.href) return;
      // Do not assign text to a generic homepage before a conversation id is
      // available; keep the presence heartbeat but leave both counts at zero.
      const hasConversation = !core.conversationKey(capturedUrl).endsWith(':new-chat');
      const snapshot = { source, session, instance, input: hasConversation ? counts.input : 0, output: hasConversation ? counts.output : 0, active: document.visibilityState === 'visible' && document.hasFocus(), visible: document.visibilityState === 'visible', estimator: 'unicode-v1', capturedAt: new Date().toISOString() };
      lastSnapshot = snapshot;
      const result = await chrome.runtime.sendMessage({ type: 'token-meter-snapshot', snapshot, messages: counts.messages });
      lastStatus = { ...result, messages: counts.messages, collectedAt: new Date().toISOString() };
    } catch (error) { lastStatus = { ok: false, error: error.message, collectedAt: new Date().toISOString() }; }
    finally { busy = false; if (pending) { pending = false; schedule(); } }
    return lastStatus;
  }
  function schedule() { if (!timer) timer = setTimeout(() => { timer = null; capture(); }, 1000); }
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  for (const name of ['visibilitychange', 'focus', 'blur', 'popstate', 'hashchange']) addEventListener(name, schedule);
  addEventListener('pagehide', () => {
    if (lastSnapshot) chrome.runtime.sendMessage({type:'token-meter-snapshot',snapshot:{...lastSnapshot,active:false,visible:false,capturedAt:new Date().toISOString()},messages:0}).catch(()=>{});
  });
  setInterval(capture, 15_000);
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'token-meter-capture') return;
    capture().then(respond); return true;
  });
  schedule();
})();

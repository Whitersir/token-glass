// Shared by isolated content scripts, the extension worker, and local tests.
globalThis.TokenMeterWeb = (() => {
  function sourceForUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return null;
      if (['chatgpt.com', 'chat.openai.com'].includes(url.hostname)) return 'chatgpt-web';
      if (url.hostname === 'claude.ai') return 'claude-web';
    } catch {}
    return null;
  }

  function conversationKey(value) {
    const source = sourceForUrl(value);
    if (!source) return null;
    const url = new URL(value);
    const match = url.pathname.match(source === 'chatgpt-web' ? /\/c\/([a-zA-Z0-9_-]+)/ : /^\/chat\/([a-zA-Z0-9_-]+)/);
    return match ? `${source}:${match[1]}` : `${source}:new-chat`;
  }

  // A transparent, dependency-free estimate, NOT the provider's tokenizer.
  // CJK ~1.5 tokens/character; Latin words ~4 characters/token; punctuation
  // ~1 and emoji ~3. Never infer context replay, images, cache or reasoning.
  function estimateText(value) {
    const text = String(value || '').replace(/\r\n/g, '\n').trim();
    if (!text) return 0;
    let units = 0;
    for (const piece of text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{Extended_Pictographic}]|[a-zA-Z0-9_]+|\s+|./gu) || []) {
      if (/^[a-zA-Z0-9_]+$/.test(piece)) units += piece.length / 4;
      else if (/^\s+$/.test(piece)) units += piece.length / 4;
      else if (/\p{Extended_Pictographic}/u.test(piece)) units += 3;
      else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(piece)) units += 1.5;
      else units += 1;
    }
    return Math.ceil(units);
  }

  function collect(document, source) {
    const userSelector = source === 'chatgpt-web' ? '[data-message-author-role="user"]' : '[data-testid="user-message"]';
    const assistantSelector = source === 'chatgpt-web' ? '[data-message-author-role="assistant"]' : '[data-is-streaming], .font-claude-response';
    function total(selector, role) {
      const elements = [...document.querySelectorAll(selector)].filter(element => !element.parentElement?.closest(selector));
      let tokens = 0, messages = 0;
      for (const element of elements) {
        if (!element.getClientRects().length || element.closest('[aria-hidden="true"]')) continue;
        if (source === 'claude-web' && role === 'assistant' && element.matches('[data-is-streaming]') && !element.querySelector('.font-claude-response')) continue;
        const textRoot = source === 'chatgpt-web' ? element.querySelector('.markdown, .whitespace-pre-wrap') || element : element.querySelector('.font-claude-response') || element;
        // innerText excludes display:none content and never reads the composer,
        // account menus, sidebar, cookies, localStorage or authentication data.
        const text = textRoot.innerText || '';
        if (text.trim()) { tokens += estimateText(text); messages++; }
      }
      return { tokens, messages };
    }
    const input = total(userSelector, 'user'), output = total(assistantSelector, 'assistant');
    return { input: input.tokens, output: output.tokens, messages: input.messages + output.messages };
  }

  function mergeSnapshot(old, next) {
    return { ...next, input: Math.max(old?.input || 0, next.input), output: Math.max(old?.output || 0, next.output) };
  }
  return Object.freeze({ sourceForUrl, conversationKey, estimateText, collect, mergeSnapshot });
})();

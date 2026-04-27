// MRV Assistant — background service worker
// Responsibilities:
//   - Maintain extension badge reflecting current state
//   - Keep service worker alive during an active run via 20s keepalive ping
//   - Light routing for content↔popup messages

let keepAliveTimer = null;

function startKeepAlive() {
  stopKeepAlive();
  // 20s interval per PRD timing table. Touching storage prevents the
  // service worker from being terminated during long extractions.
  keepAliveTimer = setInterval(() => {
    chrome.storage.local.get('mrvState', () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function setBadge(state) {
  let text = '';
  let color = '#6b7280';
  switch (state) {
    case 'running':   text = 'RUN'; color = '#2563eb'; break;
    case 'done':      text = 'OK';  color = '#16a34a'; break;
    case 'error':     text = '!';   color = '#dc2626'; break;
    case 'stopped':   text = '||';  color = '#f59e0b'; break;
    case 'confirming':text = '?';   color = '#f59e0b'; break;
    default:          text = '';
  }
  try {
    chrome.action.setBadgeText({ text });
    if (text) chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('mrvState', (cur) => {
    if (!cur.mrvState) {
      chrome.storage.local.set({ mrvState: 'idle' });
    }
    setBadge(cur.mrvState || 'idle');
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get('mrvState', (cur) => setBadge(cur.mrvState || 'idle'));
});

// React to state changes in storage — single source of truth.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.mrvState) {
    const s = changes.mrvState.newValue;
    setBadge(s);
    if (s === 'running') startKeepAlive();
    else stopKeepAlive();
  }
});

// Light message bus. Most state moves through chrome.storage.local; this
// only handles a couple of synchronous helpers.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'progress') {
    // Already persisted by content.js; nothing to do here.
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'runStarted') {
    startKeepAlive();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'runEnded') {
    stopKeepAlive();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'findMrvTab') {
    // Popup uses this to locate the MRV tab so it can send commands.
    chrome.tabs.query({ url: 'https://viewer.ves-prod.maxfedsolutions.com/*' }, (tabs) => {
      sendResponse({ ok: true, tabs: (tabs || []).map(t => ({ id: t.id, url: t.url, active: t.active })) });
    });
    return true; // async
  }
});

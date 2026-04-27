// MRV Assistant — popup logic
// Reads state from chrome.storage.local (single source of truth).
// Sends RUN / STOP / SCAN commands to the content script via tab message.

const STATES = ['ready', 'no-document', 'no-keywords', 'confirming', 'running', 'done', 'resuming', 'error'];

const $ = (id) => document.getElementById(id);

function show(stateName) {
  STATES.forEach(s => {
    const el = $(`state-${s}`);
    if (el) el.classList.add('hidden');
  });
  const target = $(`state-${stateName}`);
  if (target) target.classList.remove('hidden');
}

function setSubtitle(text) {
  $('subtitle').textContent = text || '';
}

function fmtElapsed(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function fmtEta(remaining, perItemMs) {
  if (!remaining || !perItemMs) return '';
  const ms = remaining * perItemMs;
  const min = Math.ceil(ms / 60000);
  if (min <= 1) return 'Almost done';
  return `Est. ${min} min remaining`;
}

// ──────────────────────────────────────────────────────────────────
// Tab discovery
// ──────────────────────────────────────────────────────────────────
async function findMrvTab() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'findMrvTab' }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return resolve(null);
      const tabs = resp.tabs || [];
      const active = tabs.find(t => t.active) || tabs[0];
      resolve(active || null);
    });
  });
}

async function sendToContent(msg) {
  const tab = await findMrvTab();
  if (!tab) return null;
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tab.id, msg, (resp) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(resp || null);
    });
  });
}

// ──────────────────────────────────────────────────────────────────
// Settings persistence
// ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(['mrvDbq', 'mrvMinHits', 'mrvSpeed', 'mrvSkipExisting'], (s) => {
      if (s.mrvDbq) $('dbq').value = s.mrvDbq;
      if (s.mrvMinHits) $('minHits').value = String(s.mrvMinHits);
      if (s.mrvSpeed) $('speed').value = s.mrvSpeed;
      if (typeof s.mrvSkipExisting === 'boolean') $('skipExisting').checked = s.mrvSkipExisting;
      resolve();
    });
  });
}

async function saveSettings() {
  chrome.storage.local.set({
    mrvDbq: $('dbq').value,
    mrvMinHits: parseInt($('minHits').value, 10),
    mrvSpeed: $('speed').value,
    mrvSkipExisting: $('skipExisting').checked
  });
}

// ──────────────────────────────────────────────────────────────────
// Render based on state
// ──────────────────────────────────────────────────────────────────
async function refresh() {
  // Step 1: locate MRV tab
  const tab = await findMrvTab();
  if (!tab) {
    setSubtitle('Not on Maximus MRV');
    show('no-document');
    return;
  }

  // Step 2: read latest persisted state and the live scan
  const state = await new Promise(r => chrome.storage.local.get(null, r));

  // Active extraction → show progress regardless of scan freshness
  if (state.mrvState === 'running') {
    renderRunning(state);
    return;
  }
  if (state.mrvState === 'confirming') {
    renderConfirming(state);
    return;
  }
  if (state.mrvState === 'done') {
    renderDone(state);
    return;
  }
  if (state.mrvState === 'stopped') {
    renderResuming(state);
    return;
  }
  if (state.mrvState === 'error') {
    renderError(state);
    return;
  }

  // Step 3: ensure a recent scan; trigger one if stale.
  let scan = state.mrvScan;
  const stale = !state.mrvScanAt || (Date.now() - state.mrvScanAt > 6000);
  if (stale) {
    const resp = await sendToContent({ type: 'scan' });
    if (resp && resp.ok) scan = resp.report;
  }

  if (!scan || scan.pageCount === 0) {
    setSubtitle('Open a C-file in Maximus');
    show('no-document');
    return;
  }
  if (!scan.keywords || scan.keywords.length === 0) {
    setSubtitle(`${scan.patient || ''}${scan.patient ? ' · ' : ''}${scan.pageCount.toLocaleString()} pages`);
    show('no-keywords');
    return;
  }

  renderReady(scan, state);
}

function renderReady(scan, state) {
  const parts = [];
  if (scan.patient) parts.push(scan.patient);
  parts.push(`${scan.pageCount.toLocaleString()} pages`);
  let line2 = '';
  const hits = (typeof scan.hitCount === 'number') ? scan.hitCount : 0;
  if (hits > 0) line2 = `${hits.toLocaleString()} hits found`;
  if (scan.keywords && scan.keywords.length) {
    const kw = scan.keywords.slice(0, 3).join(', ') + (scan.keywords.length > 3 ? '…' : '');
    line2 += (line2 ? ' · ' : '') + `${kw} active`;
  }
  setSubtitle(parts.join(' · ') + (line2 ? '\n' + line2 : ''));

  if (scan.dcnCount && scan.dcnCount > 1) {
    const b = $('banner-multi-dcn');
    b.textContent = `Multiple DCNs detected (${scan.dcnCount}). All pages will be processed.`;
    b.classList.remove('hidden');
  } else {
    $('banner-multi-dcn').classList.add('hidden');
  }

  show('ready');
}

function renderConfirming(state) {
  const n = state.mrvPendingTargets || 0;
  $('confirm-msg').textContent = `About to place ${n} notes. Continue?`;
  setSubtitle(state.mrvPatient || '');
  show('confirming');
}

function renderRunning(state) {
  const p = state.mrvProgress || { current: 0, total: 0, pct: 0 };
  $('run-status').textContent = `Placing note ${p.current} of ${p.total}…`;
  $('run-fill').style.width = `${p.pct || 0}%`;
  if (state.mrvStartTime && p.current > 0) {
    const elapsed = Date.now() - state.mrvStartTime;
    const perItem = elapsed / p.current;
    const remaining = (p.total - p.current);
    $('run-eta').textContent = fmtEta(remaining, perItem);
  } else {
    $('run-eta').textContent = '';
  }
  const apiBanner = $('banner-api-warning-running');
  if (state.mrvApiWarning) {
    apiBanner.textContent = state.mrvApiWarning;
    apiBanner.classList.remove('hidden');
  } else {
    apiBanner.classList.add('hidden');
  }
  setSubtitle(state.mrvPatient || '');
  show('running');
}

function renderDone(state) {
  const r = state.mrvResults || { placed: 0, highPri: 0, lowPri: 0, skipped: 0, failed: 0 };
  if (r.zeroPages) {
    $('done-headline').textContent = 'No pages met your criteria. Try lowering the minimum hits or checking your keywords.';
  } else if (r.placed === 0 && r.failed > 0) {
    $('done-headline').textContent = 'No notes were placed. Check that Maximus is open and visible, then try Slow speed.';
  } else {
    $('done-headline').textContent = `Done! ${r.placed} notes placed`;
  }
  $('stat-high').textContent = r.highPri || 0;
  $('stat-low').textContent = r.lowPri || 0;
  $('stat-skipped').textContent = r.skipped || 0;
  $('stat-failed').textContent = r.failed || 0;
  $('stat-elapsed').textContent = fmtElapsed(state.mrvElapsedMs);

  const fl = $('failed-list');
  if (state.mrvFailedPages && state.mrvFailedPages.length) {
    fl.textContent = `Failed pages: ${state.mrvFailedPages.join(', ')}`;
  } else {
    fl.textContent = '';
  }

  const apiBanner = $('banner-api-warning');
  if (state.mrvApiWarning) {
    apiBanner.textContent = state.mrvApiWarning;
    apiBanner.classList.remove('hidden');
  } else {
    apiBanner.classList.add('hidden');
  }

  setSubtitle(state.mrvPatient || '');
  show('done');
}

function renderResuming(state) {
  const r = state.mrvResults || {};
  setSubtitle(`Stopped after ${r.placed || 0} notes`);
  show('resuming');
}

function renderError(state) {
  $('err-msg').textContent = state.mrvErrorMsg || 'Something went wrong.';
  setSubtitle('');
  show('error');
}

// ──────────────────────────────────────────────────────────────────
// Action handlers
// ──────────────────────────────────────────────────────────────────
async function onRunClicked() {
  await saveSettings();
  const opts = {
    dbq: $('dbq').value,
    minHits: parseInt($('minHits').value, 10),
    speed: $('speed').value,
    skipExisting: $('skipExisting').checked,
    confirmed: false
  };
  await chrome.storage.local.set({ mrvState: 'running', mrvShouldStop: false, mrvProgress: { current: 0, total: 0, pct: 0 } });
  const resp = await sendToContent({ type: 'run', opts });
  if (!resp || !resp.ok) {
    await chrome.storage.local.set({
      mrvState: 'error',
      mrvErrorMsg: 'Could not reach the MRV tab. Make sure Maximus is open.'
    });
  }
}

async function onConfirmYes() {
  const opts = {
    dbq: $('dbq').value || (await getStoredVal('mrvDbq', 'general')),
    minHits: parseInt($('minHits').value || (await getStoredVal('mrvMinHits', 1)), 10),
    speed: $('speed').value || (await getStoredVal('mrvSpeed', 'normal')),
    skipExisting: $('skipExisting').checked,
    confirmed: true
  };
  await sendToContent({ type: 'run', opts });
}

async function getStoredVal(k, def) {
  return new Promise(r => chrome.storage.local.get(k, (s) => r(s[k] != null ? s[k] : def)));
}

async function onConfirmNo() {
  await chrome.storage.local.set({ mrvState: 'idle' });
  refresh();
}

async function onStopClicked() {
  await sendToContent({ type: 'stop' });
}

async function onAgainClicked() {
  await chrome.storage.local.set({
    mrvState: 'idle',
    mrvResults: null,
    mrvFailedPages: [],
    mrvSkippedPages: [],
    mrvElapsedMs: 0,
    mrvApiWarning: null
  });
  refresh();
}

async function onResumeClicked() {
  // Re-run with current settings; the content script's skip-existing logic
  // will skip pages already noted from the previous partial run.
  const skip = $('skipExisting');
  await chrome.storage.local.set({ mrvSkipExisting: true });
  const opts = {
    dbq: await getStoredVal('mrvDbq', 'general'),
    minHits: parseInt(await getStoredVal('mrvMinHits', 1), 10),
    speed: await getStoredVal('mrvSpeed', 'normal'),
    skipExisting: true,
    confirmed: true
  };
  await sendToContent({ type: 'run', opts });
}

async function onFreshClicked() {
  await chrome.storage.local.set({
    mrvState: 'idle',
    mrvResults: null,
    mrvFailedPages: [],
    mrvSkippedPages: [],
    mrvProgress: { current: 0, total: 0, pct: 0 }
  });
  refresh();
}

async function onResetClicked() {
  await chrome.storage.local.set({ mrvState: 'idle', mrvErrorMsg: null });
  refresh();
}

// ──────────────────────────────────────────────────────────────────
// Wire up
// ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  $('runBtn').addEventListener('click', onRunClicked);
  $('confirmYes').addEventListener('click', onConfirmYes);
  $('confirmNo').addEventListener('click', onConfirmNo);
  $('stopBtn').addEventListener('click', onStopClicked);
  $('againBtn').addEventListener('click', onAgainClicked);
  $('resumeBtn').addEventListener('click', onResumeClicked);
  $('freshBtn').addEventListener('click', onFreshClicked);
  $('resetBtn').addEventListener('click', onResetClicked);

  ['dbq', 'minHits', 'speed', 'skipExisting'].forEach(id => {
    $(id).addEventListener('change', saveSettings);
  });

  refresh();
});

// React to state changes pushed from content/background.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  refresh();
});

// Poll while popup is open (popup closes when focus leaves, so this only
// runs while the user is looking at it).
setInterval(refresh, 1000);

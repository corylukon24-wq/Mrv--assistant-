// MRV Assistant — content script
// Injected into Maximus MRV viewer. Handles:
//   - Bearer token capture (via page-world fetch wrapper)
//   - Document scan (pages, hits, patient info)
//   - Search API calls (with DOM fallback)
//   - Note placement (scroll → click swatch → fill textarea → blur)
//   - Progress reporting via chrome.storage.local

(() => {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // 1. PAGE-WORLD FETCH HOOK (token capture)
  // ──────────────────────────────────────────────────────────────────
  // Content scripts run in an isolated world; their window.fetch is not
  // the page's window.fetch. We inject a tiny script into the page world
  // that wraps fetch and posts the captured Authorization header back to
  // us via window.postMessage.
  const hookSrc = `
    (() => {
      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        try {
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
          let auth = null;
          const init = args[1];
          if (init && init.headers) {
            const h = init.headers;
            if (h instanceof Headers) auth = h.get('Authorization') || h.get('authorization');
            else if (Array.isArray(h)) {
              const f = h.find(p => String(p[0]).toLowerCase() === 'authorization');
              if (f) auth = f[1];
            } else {
              auth = h.Authorization || h.authorization || null;
            }
          } else if (args[0] instanceof Request) {
            auth = args[0].headers.get('Authorization') || args[0].headers.get('authorization');
          }
          if (url && String(url).includes('esearch') && auth) {
            window._mrvToken = auth;
            window._mrvSearchUrl = String(url);
            window.postMessage({ __mrv: true, type: 'token', token: auth, searchUrl: String(url) }, '*');
          }
        } catch (_) {}
        return origFetch.apply(this, args);
      };
    })();
  `;
  try {
    const s = document.createElement('script');
    s.textContent = hookSrc;
    (document.documentElement || document.head || document.body).appendChild(s);
    s.remove();
  } catch (_) { /* page CSP blocked us — API path will degrade to DOM fallback */ }

  let capturedToken = null;
  let capturedSearchUrl = null;
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (d && d.__mrv && d.type === 'token' && typeof d.token === 'string') {
      capturedToken = d.token;
      if (typeof d.searchUrl === 'string') capturedSearchUrl = d.searchUrl;
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // 2. CONSTANTS
  // ──────────────────────────────────────────────────────────────────
  // Fallback URL — only used if we never observed Maximus calling the real
  // esearch endpoint. The real URL is captured live from the page's own
  // fetch() invocations (PRD Stage 1) and is preferred. The PRD truncated
  // the path to "/gateway/proxy/esearch/ap…" so we cannot rely on guessing.
  const SEARCH_API_FALLBACK = 'https://ves-viewer-2-prod-endpoint.ves-prod.maxfedsolutions.com/gateway/proxy/esearch/api/search';

  const SWATCH_HEX = {
    yellow:  '#fdfdb8',
    orange:  '#ff9000',
    green:   '#75f367',
    cyan:    '#55f5ff',
    pink:    '#ffc7ff',
    hotpink: '#ff2789'
  };

  const DBQ_CATEGORIES = {
    hip:         ['orthopedic', 'hip', 'thigh', 'surgery', 'radiology', 'mri', 'xray', 'ct', 'operative', 'medrep'],
    spine:       ['spine', 'lumbar', 'thoracic', 'cervical', 'disc', 'neuro', 'mri', 'xray', 'ct', 'radiology'],
    shoulder:    ['shoulder', 'rotator', 'bicep', 'surgery', 'radiology', 'mri', 'xray', 'orthopedic'],
    knee:        ['knee', 'leg', 'meniscus', 'acl', 'pcl', 'surgery', 'radiology', 'orthopedic'],
    mental:      ['psychology', 'psychiatry', 'ptsd', 'behavioral', 'counseling', 'mental health'],
    hypertension:['cardiology', 'cardiac', 'heart', 'bp', 'blood pressure', 'primary care'],
    diabetes:    ['endocrine', 'diabetes', 'glucose', 'hba1c', 'primary care', 'lab'],
    hearing:     ['audiology', 'ent', 'hearing', 'audiogram'],
    respiratory: ['pulmonary', 'lung', 'copd', 'asthma', 'radiology', 'ct', 'xray'],
    general:     null  // null = all pages high priority
  };

  const SPEED_MULTIPLIERS = { fast: 0.6, normal: 1, slow: 2 };

  // ──────────────────────────────────────────────────────────────────
  // 3. STATE / UTILITIES
  // ──────────────────────────────────────────────────────────────────
  let running = false;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const getMul = (speed) => SPEED_MULTIPLIERS[speed] || 1;

  // parseTranslateY handles negatives, decimals, whitespace, single/double param translate()
  function parseTranslateY(transform) {
    if (!transform) return null;
    const m = String(transform).match(/translate\(\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(-?\d+(?:\.\d+)?))?\s*\)/);
    if (!m) return null;
    return m[2] !== undefined ? parseFloat(m[2]) : 0;
  }

  function todayMMDDYYYY() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${d.getFullYear()}`;
  }

  async function setState(patch) {
    return new Promise(resolve => {
      chrome.storage.local.get(null, (cur) => {
        chrome.storage.local.set({ ...cur, ...patch }, resolve);
      });
    });
  }

  async function getState() {
    return new Promise(resolve => chrome.storage.local.get(null, resolve));
  }

  function reportProgress(current, total) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    chrome.storage.local.set({ mrvProgress: { current, total, pct } });
    try {
      chrome.runtime.sendMessage({ type: 'progress', current, total, pct });
    } catch (_) {}
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. DOM SCAN
  // ──────────────────────────────────────────────────────────────────
  function getViewSvg() {
    return document.querySelector('#viewpane > svg') || document.querySelector('#viewpane svg');
  }

  function getContainer() {
    return document.querySelector('g.container');
  }

  function scanPages() {
    // Returns array: [{ id, dcn, pageNum, translateY, category, header }]
    const result = [];
    const groups = document.querySelectorAll('g[id^="P_"]');
    const dcns = new Set();
    groups.forEach(g => {
      const id = g.getAttribute('id');
      // Format: P_{DCN}_{pageNum}
      const m = id.match(/^P_([^_]+)_(\d+)$/);
      if (!m) return;
      const dcn = m[1];
      const pageNum = parseInt(m[2], 10);
      dcns.add(dcn);
      const ty = parseTranslateY(g.getAttribute('transform')) || 0;
      // Header text: "DCN {n} Pg {n} {Category}"
      let header = '';
      let category = '';
      const txt = g.querySelector('text');
      if (txt) {
        header = (txt.textContent || '').trim();
        const cm = header.match(/Pg\s+\d+\s+(.+)$/i);
        if (cm) category = cm[1].trim();
      }
      result.push({ id, dcn, pageNum, translateY: ty, category, header });
    });
    return { pages: result, dcns: [...dcns] };
  }

  function scanHits() {
    // Returns array of { translateY } for every g[id^="sr_"]
    const hits = [];
    document.querySelectorAll('g[id^="sr_"]').forEach(g => {
      let node = g;
      let totalY = 0;
      // Hit's effective Y = walk up parents accumulating translate Y until we hit a P_ group
      while (node && node !== document) {
        const ty = parseTranslateY(node.getAttribute && node.getAttribute('transform'));
        if (ty !== null) totalY += ty;
        if (node.id && node.id.startsWith('P_')) break;
        node = node.parentNode;
      }
      hits.push({ el: g, translateY: totalY });
    });
    return hits;
  }

  function getActiveKeywords() {
    const chips = document.querySelectorAll('ul.search_chips .search_term');
    return [...chips].map(c => (c.textContent || '').trim()).filter(Boolean);
  }

  function getPatientLabel() {
    // Try to find patient/header text in the page UI. Best-effort; falls back to ''.
    const candidates = [
      '.patient_name', '.patientName', '#patientName',
      '.patient-info', '.veteran-name', '#veteranName',
      'header .name', '.header_name'
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    // Fallback: parse first page header for DCN
    const firstP = document.querySelector('g[id^="P_"]');
    if (firstP) {
      const t = firstP.querySelector('text');
      if (t) {
        const m = (t.textContent || '').match(/DCN\s+(\S+)/);
        if (m) return `DCN ${m[1]}`;
      }
    }
    return '';
  }

  function getExistingNotePages() {
    // Maps existing g.stickynote elements to nearest page Y, returns Set of page numbers
    const placed = new Set();
    const notes = document.querySelectorAll('g.stickynote');
    if (notes.length === 0) return placed;
    const { pages } = scanPages();
    notes.forEach(n => {
      // Try to locate by ancestor P_ first
      let p = n;
      while (p) {
        if (p.id && p.id.startsWith('P_')) {
          const m = p.id.match(/^P_[^_]+_(\d+)$/);
          if (m) placed.add(parseInt(m[1], 10));
          return;
        }
        p = p.parentNode;
      }
      // Fall back to Y matching
      const ny = parseTranslateY(n.getAttribute('transform'));
      if (ny === null) return;
      let best = null, bestDist = Infinity;
      pages.forEach(pg => {
        const d = Math.abs(pg.translateY - ny);
        if (d < bestDist) { bestDist = d; best = pg; }
      });
      if (best && bestDist < 1500) placed.add(best.pageNum);
    });
    return placed;
  }

  // ──────────────────────────────────────────────────────────────────
  // 5. AGGREGATION (DOM hits → pages with counts/keywords)
  // ──────────────────────────────────────────────────────────────────
  function aggregateDomHits(pages, hits) {
    // Sort pages by Y to enable nearest-page lookup
    const sorted = [...pages].sort((a, b) => a.translateY - b.translateY);
    const map = new Map(); // pageNum → { pageNum, translateY, category, hitCount, keywords:Set }

    hits.forEach(h => {
      // Find page whose Y is closest and <= hit Y, else nearest
      let page = null;
      for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].translateY <= h.translateY + 1) page = sorted[i];
        else break;
      }
      if (!page) page = sorted[0];
      if (!page) return;
      const key = page.pageNum;
      let rec = map.get(key);
      if (!rec) {
        rec = {
          pageNum: page.pageNum,
          translateY: page.translateY,
          category: page.category,
          dcn: page.dcn,
          id: page.id,
          hitCount: 0,
          keywords: new Set()
        };
        map.set(key, rec);
      }
      rec.hitCount++;
      // Try to read the term off the hit element
      const term = h.el && (h.el.getAttribute('data-term') || h.el.getAttribute('data-search'));
      if (term) rec.keywords.add(term);
    });

    return [...map.values()].sort((a, b) => a.pageNum - b.pageNum);
  }

  // ──────────────────────────────────────────────────────────────────
  // 6. SEARCH API (with DOM fallback flagging)
  // ──────────────────────────────────────────────────────────────────
  async function fetchApiHitsForTerm(term, token, url) {
    const body = {
      query_stmt: `*${term}*`,
      query_type: 'terms',
      queryOp: 'OR',
      slop: 0,
      fuzzy: 0,
      allow_stemming: false
    };
    const res = await fetch(url || SEARCH_API_FALLBACK, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();
    return extractPageNumbersFromApi(data);
  }

  function extractPageNumbersFromApi(data) {
    // Response format unknown — try common shapes. Throws if nothing parseable.
    const out = new Set();
    const visit = (v) => {
      if (!v) return;
      if (Array.isArray(v)) { v.forEach(visit); return; }
      if (typeof v !== 'object') return;
      // Accept fields named like pageNumber / page_num / pageNum / page
      for (const k of Object.keys(v)) {
        const val = v[k];
        const lk = k.toLowerCase();
        if ((lk === 'pagenumber' || lk === 'page_num' || lk === 'pagenum' || lk === 'page') &&
            (typeof val === 'number' || (typeof val === 'string' && /^\d+$/.test(val)))) {
          out.add(parseInt(val, 10));
        } else if (typeof val === 'object') {
          visit(val);
        }
      }
    };
    visit(data);
    if (out.size === 0) throw new Error('API response format unrecognised');
    return out;
  }

  // ──────────────────────────────────────────────────────────────────
  // 7. SCROLL / PAGE READY
  // ──────────────────────────────────────────────────────────────────
  async function scrollToPage(page, speed) {
    const container = getContainer();
    const svg = getViewSvg();
    if (!container || !svg) return false;
    const svgHeight = svg.getBoundingClientRect().height || svg.clientHeight || 800;
    const newY = -(page.translateY) + (svgHeight / 2);
    container.setAttribute('transform', `translate(0, ${newY})`);

    // Poll for the target page group to render in the DOM (max 20 attempts × 100ms)
    const maxAttempts = 20;
    const targetSel = `g[id="${page.id}"]`;
    for (let i = 0; i < maxAttempts; i++) {
      const el = document.querySelector(targetSel);
      if (el && isInViewport(el, svg)) return true;
      await sleep(100);
    }
    return false;
  }

  function isInViewport(el, svg) {
    try {
      const r = el.getBoundingClientRect();
      const sr = svg.getBoundingClientRect();
      // Consider in-viewport if any vertical overlap
      return r.bottom > sr.top && r.top < sr.bottom;
    } catch (_) { return false; }
  }

  // ──────────────────────────────────────────────────────────────────
  // 8. NOTE PLACEMENT
  // ──────────────────────────────────────────────────────────────────
  function findCreateNoteButton() {
    return document.querySelector('g[id^="createNoteButton"]');
  }

  function findSwatch(buttonGroup, hex) {
    if (!buttonGroup) return null;
    const swatches = buttonGroup.querySelectorAll('rect.noteColorSwitchPatch');
    const target = hex.toLowerCase();
    for (const s of swatches) {
      const f = (s.getAttribute('fill') || s.style.fill || '').toLowerCase();
      if (f === target) return s;
    }
    return null;
  }

  async function clickEl(el) {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
    el.dispatchEvent(ev);
  }

  async function waitForNewNote(beforeCount, maxWaitMs, pollMs) {
    const tries = Math.ceil(maxWaitMs / pollMs);
    for (let i = 0; i < tries; i++) {
      const now = document.querySelectorAll('g.stickynote');
      if (now.length > beforeCount) {
        return now[now.length - 1]; // assume newest
      }
      await sleep(pollMs);
    }
    return null;
  }

  function setTextareaValue(textarea, content) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    ).set;
    setter.call(textarea, content);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ──────────────────────────────────────────────────────────────────
  // 9. RELEVANCE LOGIC
  // ──────────────────────────────────────────────────────────────────
  function isHighPriority(category, dbq) {
    const cats = DBQ_CATEGORIES[dbq];
    if (cats === null || cats === undefined) return true; // general → all yellow
    if (!category) return false;
    const c = category.toLowerCase();
    return cats.some(k => c.includes(k));
  }

  // ──────────────────────────────────────────────────────────────────
  // 10. NOTE CONTENT FORMAT
  // ──────────────────────────────────────────────────────────────────
  function formatNote(highPri, keywords, pageNum) {
    const date = todayMMDDYYYY();
    const kws = [...keywords];
    let kwLine;
    if (kws.length === 0) kwLine = '';
    else if (kws.length <= 2) kwLine = kws.join(' | ');
    else kwLine = kws.slice(0, 2).join(' | ') + '…';
    const head = highPri ? '★ HI-PRI' : '⚠ REVIEW';
    const lines = [
      head,
      kwLine ? `KW: ${kwLine}` : 'KW: —',
      `Pg ${pageNum}`,
      date
    ];
    return lines.slice(0, 4).join('\n');
  }

  // ──────────────────────────────────────────────────────────────────
  // 11. MAIN RUN
  // ──────────────────────────────────────────────────────────────────
  async function buildScanReport() {
    const { pages, dcns } = scanPages();
    const hits = scanHits();
    const aggregated = aggregateDomHits(pages, hits);
    const keywords = getActiveKeywords();
    return {
      pageCount: pages.length,
      dcnCount: dcns.length,
      dcns,
      hitCount: hits.length,
      aggregated,
      keywords,
      patient: getPatientLabel()
    };
  }

  async function run(opts) {
    if (running) return;
    running = true;
    const speed = opts.speed || 'normal';
    const mul = getMul(speed);
    const dbq = opts.dbq || 'general';
    const minHits = Math.max(1, parseInt(opts.minHits, 10) || 1);
    const skipExisting = !!opts.skipExisting;
    const confirmed = !!opts.confirmed;

    const startTime = Date.now();
    let apiWarning = null;
    let stoppedByUser = false;

    try {
      // PRE-RUN CHECKS
      const report = await buildScanReport();
      if (report.pageCount === 0) {
        await setState({
          mrvState: 'error',
          mrvErrorMsg: 'No document detected. Open a C-file.',
          mrvShouldStop: false
        });
        return;
      }
      if (report.keywords.length === 0) {
        await setState({
          mrvState: 'error',
          mrvErrorMsg: 'No keywords found. Search your terms in Maximus first.',
          mrvShouldStop: false
        });
        return;
      }

      // Multi-DCN warning (informational only — proceed with all)
      const multiDcnWarning = report.dcnCount > 1
        ? `Multiple DCNs detected in this file. Proceeding with all pages.`
        : null;

      // BUILD TARGET LIST
      let pagesByNum = new Map(report.aggregated.map(p => [p.pageNum, p]));

      // STAGE 3: API merge
      if (capturedToken) {
        for (const term of report.keywords) {
          try {
            const apiPages = await fetchApiHitsForTerm(term, capturedToken, capturedSearchUrl);
            const { pages: allPages } = scanPages();
            const byNum = new Map(allPages.map(p => [p.pageNum, p]));
            apiPages.forEach(pn => {
              let rec = pagesByNum.get(pn);
              if (!rec) {
                const meta = byNum.get(pn);
                if (!meta) return; // page not loaded — can't scroll there reliably; skip
                rec = {
                  pageNum: pn,
                  translateY: meta.translateY,
                  category: meta.category,
                  dcn: meta.dcn,
                  id: meta.id,
                  hitCount: 1,
                  keywords: new Set([term])
                };
                pagesByNum.set(pn, rec);
              } else {
                rec.keywords.add(term);
              }
            });
          } catch (e) {
            apiWarning = `Search API unavailable — using on-screen hits only.`;
          }
        }
      } else {
        apiWarning = `Token not captured — using on-screen hits only.`;
      }

      // FILTER by min hits
      let targets = [...pagesByNum.values()].filter(p => p.hitCount >= minHits);
      // SORT ascending
      targets.sort((a, b) => a.pageNum - b.pageNum);

      // SKIP existing
      const existing = skipExisting ? getExistingNotePages() : new Set();
      const skippedExisting = [];
      if (skipExisting) {
        targets = targets.filter(p => {
          if (existing.has(p.pageNum)) { skippedExisting.push(p.pageNum); return false; }
          return true;
        });
      }

      if (targets.length === 0) {
        await setState({
          mrvState: 'done',
          mrvResults: { placed: 0, highPri: 0, lowPri: 0, skipped: skippedExisting.length, failed: 0, zeroPages: true },
          mrvFailedPages: [],
          mrvSkippedPages: skippedExisting,
          mrvApiWarning: apiWarning,
          mrvMultiDcnWarning: multiDcnWarning,
          mrvElapsedMs: Date.now() - startTime,
          mrvShouldStop: false
        });
        return;
      }

      // CONFIRMATION GATE: >20 notes
      if (targets.length > 20 && !confirmed) {
        await setState({
          mrvState: 'confirming',
          mrvPendingTargets: targets.length,
          mrvShouldStop: false
        });
        return;
      }

      // EXTRACTION LOOP
      await setState({
        mrvState: 'running',
        mrvProgress: { current: 0, total: targets.length, pct: 0 },
        mrvStartTime: startTime,
        mrvKeywords: report.keywords,
        mrvDbq: dbq,
        mrvSpeed: speed,
        mrvShouldStop: false,
        mrvFailedPages: [],
        mrvSkippedPages: skippedExisting,
        mrvApiWarning: apiWarning,
        mrvMultiDcnWarning: multiDcnWarning,
        mrvPatient: report.patient,
        mrvPageCount: report.pageCount
      });

      try { chrome.runtime.sendMessage({ type: 'runStarted' }); } catch (_) {}

      let placed = 0, highPri = 0, lowPri = 0, failed = [];

      const scrollWait     = Math.round(300 * mul);
      const pollInterval   = Math.round(100 * mul);
      const noteMaxWait    = Math.round(5000 * mul);
      const afterTextSet   = Math.round(100 * mul);
      const afterBlur      = Math.round(300 * mul);
      const betweenNotes   = Math.round(500 * mul);

      for (let i = 0; i < targets.length; i++) {
        // Check stop signal
        const cur = await getState();
        if (cur.mrvShouldStop) { stoppedByUser = true; break; }

        const target = targets[i];
        const ok = await placeOneNote(target, dbq, {
          scrollWait, pollInterval, noteMaxWait, afterTextSet, afterBlur
        });

        if (ok === 'failed') failed.push(target.pageNum);
        else if (ok === 'placed') {
          placed++;
          if (isHighPriority(target.category, dbq)) highPri++;
          else lowPri++;
        }

        reportProgress(i + 1, targets.length);
        await setState({
          mrvProgress: { current: i + 1, total: targets.length, pct: Math.round(((i + 1) / targets.length) * 100) },
          mrvFailedPages: failed
        });

        if (i < targets.length - 1) await sleep(betweenNotes);
      }

      const elapsedMs = Date.now() - startTime;
      await setState({
        mrvState: stoppedByUser ? 'stopped' : 'done',
        mrvResults: {
          placed, highPri, lowPri,
          skipped: skippedExisting.length,
          failed: failed.length,
          totalAttempted: targets.length
        },
        mrvFailedPages: failed,
        mrvSkippedPages: skippedExisting,
        mrvElapsedMs: elapsedMs,
        mrvApiWarning: apiWarning,
        mrvMultiDcnWarning: multiDcnWarning,
        mrvShouldStop: false
      });
      try {
        chrome.runtime.sendMessage({ type: 'runEnded', stopped: stoppedByUser });
      } catch (_) {}

    } catch (err) {
      await setState({
        mrvState: 'error',
        mrvErrorMsg: `Unexpected error: ${err && err.message ? err.message : String(err)}`,
        mrvShouldStop: false
      });
    } finally {
      running = false;
    }
  }

  async function placeOneNote(target, dbq, t) {
    const speedSetting = (await getState()).mrvSpeed || 'normal';

    // 1. Scroll
    const scrolled = await scrollToPage(target, speedSetting);
    if (!scrolled) return 'failed';
    await sleep(t.scrollWait);

    // 2. Find note button & swatch
    const button = findCreateNoteButton();
    if (!button) return 'failed';
    const highPri = isHighPriority(target.category, dbq);
    let swatch = findSwatch(button, highPri ? SWATCH_HEX.yellow : SWATCH_HEX.orange);
    if (!swatch && !highPri) swatch = findSwatch(button, SWATCH_HEX.yellow); // fallback per PRD
    if (!swatch) return 'failed';

    // 3. Snapshot count, click swatch, wait for new note
    const before = document.querySelectorAll('g.stickynote').length;
    await clickEl(swatch);
    const note = await waitForNewNote(before, t.noteMaxWait, t.pollInterval);
    if (!note) return 'failed';

    // Duplicate guard: if count didn't increase
    const after = document.querySelectorAll('g.stickynote').length;
    if (after <= before) return 'failed';

    // 4. Find textarea inside the new note
    const textarea = note.querySelector('textarea') || document.querySelector('g.stickynote textarea');
    if (!textarea) return 'failed';

    const content = formatNote(highPri, target.keywords, target.pageNum);
    setTextareaValue(textarea, content);
    await sleep(t.afterTextSet);
    textarea.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(t.afterBlur);

    return 'placed';
  }

  // ──────────────────────────────────────────────────────────────────
  // 12. MESSAGE HANDLER (popup / background → content)
  // ──────────────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    (async () => {
      try {
        if (msg.type === 'scan') {
          const report = await buildScanReport();
          sendResponse({ ok: true, report, hasToken: !!capturedToken });
        } else if (msg.type === 'run') {
          run(msg.opts || {});
          sendResponse({ ok: true });
        } else if (msg.type === 'stop') {
          await setState({ mrvShouldStop: true });
          sendResponse({ ok: true });
        } else if (msg.type === 'isAlive') {
          sendResponse({ ok: true, alive: true });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async response
  });

  // ──────────────────────────────────────────────────────────────────
  // 13. INITIAL SCAN BROADCAST (so popup has data when first opened)
  // ──────────────────────────────────────────────────────────────────
  // After document is interactive, do a delayed initial scan so the
  // popup can show patient name / page count / keyword presence.
  function broadcastInitialScan() {
    try {
      const report = {};
      const { pages, dcns } = scanPages();
      report.pageCount = pages.length;
      report.dcnCount = dcns.length;
      report.keywords = getActiveKeywords();
      report.patient = getPatientLabel();
      chrome.storage.local.set({
        mrvScan: report,
        mrvScanAt: Date.now()
      });
    } catch (_) {}
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(broadcastInitialScan, 1500);
  } else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(broadcastInitialScan, 1500));
  }
  // Re-scan periodically so popup reflects newly-loaded pages or chips
  setInterval(broadcastInitialScan, 4000);

  // Tab-reload mid-run handling: if storage says we were running but no
  // run is active in this fresh content script, transition to 'stopped'
  // so the popup offers Resume / Start fresh.
  chrome.storage.local.get(['mrvState'], (s) => {
    if (s.mrvState === 'running' && !running) {
      chrome.storage.local.set({ mrvState: 'stopped', mrvShouldStop: false });
    }
  });

})();

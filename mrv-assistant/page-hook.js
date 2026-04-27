// MRV Assistant — page-world hook
// Declared as a MAIN-world content_script in manifest.json so it executes
// in the page's JavaScript context (where window.fetch is the real one
// Maximus uses) and is not subject to the page's CSP for inline scripts.
// Wraps fetch to capture the Bearer JWT and the live esearch URL on the
// first /esearch/* call Maximus makes naturally.

(() => {
  if (window.__mrvHookInstalled) return;
  window.__mrvHookInstalled = true;

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      let auth = null;
      const init = args[1];
      if (init && init.headers) {
        const h = init.headers;
        if (h instanceof Headers) {
          auth = h.get('Authorization') || h.get('authorization');
        } else if (Array.isArray(h)) {
          const f = h.find(p => String(p[0]).toLowerCase() === 'authorization');
          if (f) auth = f[1];
        } else {
          auth = h.Authorization || h.authorization || null;
        }
      } else if (args[0] instanceof Request) {
        try {
          auth = args[0].headers.get('Authorization') || args[0].headers.get('authorization');
        } catch (_) {}
      }
      if (url && String(url).includes('esearch') && auth) {
        window._mrvToken = auth;
        window._mrvSearchUrl = String(url);
        window.postMessage({ __mrv: true, type: 'token', token: auth, searchUrl: String(url) }, '*');
      }
    } catch (_) { /* never break the host page */ }
    return origFetch.apply(this, args);
  };
})();

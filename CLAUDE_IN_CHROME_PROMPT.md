# Claude-in-Chrome Live Test Prompt

Use Claude-in-Chrome on the Maximus tab (a patient C-file must be open with at
least one keyword already searched in the left search panel). Copy the
**Probe Prompt** below into Claude-in-Chrome. Send the JSON output it produces
back to me — that is the ground truth for any selector or behaviour disagreement
between the PRD and the live DOM.

---

## Probe Prompt — copy from here ↓

You are inspecting a Maximus MRV viewer page that I have open. Run this DOM
probe **without modifying anything on the page**. Read-only inspection. Do not
click anything, do not type, do not place notes.

For each numbered item, run the JavaScript in the console (devtools → Console),
collect the result, and reply with one big JSON object using the exact keys
below. Don't summarise or paraphrase — I need the raw values.

```js
// 1. Document SVG
const svg = document.querySelector('#viewpane > svg');
result.svg_present = !!svg;
result.svg_width = svg ? svg.getAttribute('width') : null;

// 2. Page groups
const pages = document.querySelectorAll('g[id^="P_"]');
result.page_count = pages.length;
result.page_id_samples = Array.from(pages).slice(0, 3).map(p => p.id);
result.page_transform_samples = Array.from(pages).slice(0, 3)
  .map(p => p.getAttribute('transform'));

// 3. Page header text (this is what the extension uses for category filtering)
result.page_header_samples = Array.from(pages).slice(0, 5).map(p => {
  const t = p.querySelector('text');
  return t ? t.textContent.trim() : null;
});

// 4. Search hit elements (cyan highlights)
const hits = document.querySelectorAll('g[id^="sr_"]');
result.hit_count_in_dom = hits.length;
result.hit_id_samples = Array.from(hits).slice(0, 3).map(h => h.id);
result.hit_attribute_samples = Array.from(hits).slice(0, 3).map(h => ({
  outerStart: h.outerHTML.slice(0, 200),
  attrs: Array.from(h.attributes).map(a => ({ name: a.name, value: a.value }))
}));

// 5. Scroll container
const cont = document.querySelector('g.container');
result.container_present = !!cont;
result.container_transform = cont ? cont.getAttribute('transform') : null;

// 6. Note button
const btn = document.querySelector('g[id^="createNoteButton"]');
result.note_button_id = btn ? btn.id : null;
result.note_button_count = document.querySelectorAll('g[id^="createNoteButton"]').length;

// 7. Swatches (color picker)
const swatches = document.querySelectorAll('rect.noteColorSwitchPatch');
result.swatch_count = swatches.length;
result.swatch_fills = Array.from(swatches).map(s =>
  s.getAttribute('fill') || s.style.fill || null
);

// 8. Active search chips (the keywords she typed)
const chips = document.querySelectorAll('ul.search_chips .search_term');
result.chip_count = chips.length;
result.chip_terms = Array.from(chips).map(c => c.textContent.trim());

// 9. Existing sticky notes
const stickies = document.querySelectorAll('g.stickynote');
result.existing_note_count = stickies.length;
result.existing_note_transform_samples = Array.from(stickies).slice(0, 3)
  .map(n => n.getAttribute('transform'));

// 10. Did the extension capture a JWT?
result.token_captured = !!window._mrvToken;
result.token_url_captured = window._mrvSearchUrl || null;
result.token_prefix = window._mrvToken ? String(window._mrvToken).slice(0, 30) + '…' : null;
```

Reply ONLY with a JSON object containing every key above. If a query throws or
returns null, set the key to null (do not omit it). Do not click anything, do
not run the extension, do not type anything in the page.

## Probe Prompt — copy until here ↑

---

## What we'll do with the result

The fields above directly map to the extension's selectors:

| Field | Used by | Failure if… |
|---|---|---|
| `svg_present`, `page_count` | `scanPages()` | extension shows "No document detected" |
| `page_id_samples` | `P_{DCN}_{pageNum}` regex | wrong format → can't sort by page number |
| `page_header_samples` | category extraction (Strict mode) | filter wrong → too many or zero notes |
| `hit_count_in_dom`, `hit_id_samples` | `aggregateDomHits()` | pages tagged for wrong keyword |
| `container_present`, `container_transform` | `scrollToPage()` | scroll doesn't work, all notes on page 1 |
| `note_button_id`, `note_button_count` | swatch lookup | no notes ever created |
| `swatch_fills` | yellow vs orange selection | wrong colour or all skipped |
| `chip_terms` | "no keywords" pre-flight | extension says "no keywords" when there are some |
| `token_captured`, `token_url_captured` | API merge (recall fix) | only ~11 lazy-loaded pages tagged out of hundreds |

If `token_captured` is **false** after she's run a keyword search, that is the
root cause of "121 hits but only 3 tagged". The fix is already in: `page-hook.js`
runs in MAIN world via manifest, which CSP cannot block.

If `swatch_fills` reports values like `"rgb(253, 253, 184)"` instead of
`"#fdfdb8"`, I'll need to add an rgb→hex converter in `findSwatch()`. Send me
the raw values either way.

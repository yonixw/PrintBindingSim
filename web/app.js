import { buildBook, DEFAULT_SETTINGS, PRESETS, PAPER_SIZES, allowedBindings, halfNames, migrateSettings, pageNumber } from './binding.js';
import { Book3D } from './book3d.js';
import { THEMES } from './scenery.js';
import { SpreadsView, SheetsView, describeFace } from './views2d.js';
import { fetchFolders, openServerFolder, LocalSource, loadServerSettings, saveServerSettings, uploadPdf, fetchProgress, uploadImageFolder } from './source.js';

const $ = (s) => document.querySelector(s);
const state = { source: null, book: null, settings: { ...DEFAULT_SETTINGS }, view: 'v3d', folderKey: null };
let book3d = null;
const spreads = new SpreadsView($('#vspreads'), (i) => { if (!book3d) return; showView('v3d'); book3d.goTo(i); });
const sheets = new SheetsView($('#vsheets'));

// ---------- settings form ----------
for (const k of Object.keys(PAPER_SIZES)) $('#paper').insertAdjacentHTML('beforeend', `<option value="${k}">${k}</option>`);
for (const k of Object.keys(PRESETS)) $('#preset').insertAdjacentHTML('beforeend', `<option>${k}</option>`);

// Controls are either plain inputs/selects or segmented button groups (.seg).
const controls = [...document.querySelectorAll('[data-k]')];
const segVal = (el) => el.querySelector('button.on')?.value;
const segSet = (el, v) => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.value === String(v)));
const getVal = (el) => (el.classList.contains('seg') ? segVal(el) : el.value);
const setVal = (el, v) => (el.classList.contains('seg') ? segSet(el, v) : (el.value = String(v)));
const uiPages = $('[data-ui="pages"]'), uiAssemble = $('[data-ui="assemble"]');
let lastTwoPage = 'fold'; // remembered when switching to "one page" and back

function readForm() {
  const s = { ...state.settings };
  for (const el of controls) {
    const k = el.dataset.k, v = getVal(el);
    if (v === undefined) continue;
    if (typeof DEFAULT_SETTINGS[k] === 'boolean') s[k] = v === 'true';
    else if (typeof DEFAULT_SETTINGS[k] === 'number') s[k] = Math.max(0, parseFloat(v) || 0);
    else s[k] = v;
  }
  if (!(s.thickness > 0)) s.thickness = 0.1;
  // Steps 1 + 3 together decide the layout: one page -> single; two pages -> fold | cut.
  if (segVal(uiPages) === 'one') s.layout = 'single';
  else s.layout = segVal(uiAssemble) || lastTwoPage;
  if (s.layout !== 'single') lastTwoPage = s.layout;
  return s;
}
function writeForm(s) {
  if (s.layout !== 'single') lastTwoPage = s.layout;
  syncFormEnabled(s);
  for (const el of controls) setVal(el, s[el.dataset.k]);
  syncFormEnabled(s);
}
// Show only the settings that matter at each step of the pipeline.
function syncFormEnabled(s) {
  const two = s.layout !== 'single';
  segSet(uiPages, two ? 'two' : 'one');
  segSet(uiAssemble, two ? s.layout : lastTwoPage);
  const show = (sel, on) => document.querySelectorAll(sel).forEach((el) => el.classList.toggle('hide', !on));
  show('.when-one', !two);
  show('.when-two', two);
  show('.when-fold', s.layout === 'fold');
  show('.when-cut', s.layout === 'cut');
  show('.when-cutfirst', s.layout === 'cut' && s.cutOrder !== 'book');
  show('.when-duplex', s.duplex);
  show('.when-separate', s.cover === 'separate');
  show('.when-pages', s.cover !== 'separate');
  const names = halfNames(s.split);
  const cf = $('#cutFirst');
  if (cf.dataset.split !== s.split) {
    cf.dataset.split = s.split;
    cf.innerHTML = names.map((n) => `<button value="${n}">${n[0].toUpperCase() + n.slice(1)} half</button>`).join('');
  }
  if (!names.includes(s.cutFirst)) s.cutFirst = names[s.binding === 'left' ? 0 : 1] || names[0];
  segSet(cf, s.cutFirst);
  const allowed = allowedBindings(s);
  for (const b of $('#binding').querySelectorAll('button')) b.disabled = !allowed.includes(b.value);
  if (!allowed.includes(s.binding)) s.binding = allowed[0];
  segSet($('#binding'), s.binding);
}
function onFormChange() {
  state.settings = readForm();
  syncFormEnabled(state.settings);
  if (applyBlur()) resetTextures();
  rebuild(true); persist();
  $('#preset').value = '';
}
// Blur is done by the server (or the browser, for a local folder) on every image.
function applyBlur() {
  const b = state.settings.blur || 0;
  $('#blurval').textContent = b ? `— ${b}` : '— off';
  if (!state.source || !state.source.setBlur(b)) return false;
  state.source.warm();
  watchProgress();
  return true;
}
// Drop every texture (they were made from the old images), keeping the open spread.
function resetTextures() {
  if (!book3d) return;
  state.keepCur = book3d.cur;
  book3d.dispose(); book3d = null;
}
document.querySelector('[data-k="blur"]').addEventListener('input', (e) => { $('#blurval').textContent = +e.target.value ? `— ${e.target.value}` : '— off'; });
for (const el of controls) {
  if (el.classList.contains('seg')) continue;
  el.addEventListener('change', onFormChange);
}
// Segmented buttons (delegated, so the dynamically built "which half" group works too)
$('#panel').addEventListener('click', (e) => {
  const b = e.target.closest('.seg button');
  if (!b || b.disabled) return;
  segSet(b.parentElement, b.value);
  onFormChange();
});
$('#preset').addEventListener('change', (e) => {
  const p = PRESETS[e.target.value];
  if (!p) return;
  state.settings = { ...state.settings, ...p };
  writeForm(state.settings);
  rebuild(true); persist();
});

function persist() {
  try { localStorage.setItem('pbs.settings.' + state.folderKey, JSON.stringify(state.settings)); } catch { /* ignore */ }
  if (state.source && state.source.path !== undefined) saveServerSettings(state.source.path, state.settings);
}

// ---------- WebGL check ----------
// Without WebGL (e.g. a VM with no GPU and no software fallback) the 3D view can't run,
// but the 2D views (plain canvas) still work.
function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}
let HAS_WEBGL = webglAvailable();
function noWebGL() {
  HAS_WEBGL = false;
  $('#no3d').classList.remove('hide');
  $('#help').classList.add('hide');
  if (state.view === 'v3d') showView('vspreads');
}

// ---------- book ----------
function rebuild(keepSpread) {
  if (!state.source) return;
  const book = buildBook(state.source.images, state.settings);
  state.book = book;
  if (!book3d && HAS_WEBGL) {
    try {
      book3d = new Book3D($('#v3d'), state.source, { preload: $('#preload').value, theme: $('#scene').value });
      book3d.onChange = updatePos;
    } catch (e) {
      console.error(e);
      noWebGL();
    }
  }
  if (book3d) {
    book3d.source = state.source;
    book3d.setBook(book, keepSpread);
    if (state.keepCur !== undefined) { book3d.goTo(state.keepCur, false); state.keepCur = undefined; }
  }
  $('#slider').max = book.leaves.length;
  summarize(book);
  if (state.view === 'vspreads') spreads.render(book, state.source);
  if (state.view === 'vsheets') sheets.render(book, state.source);
  state.dirty2d = { vspreads: state.view !== 'vspreads', vsheets: state.view !== 'vsheets' };
}

// Each pipeline step gets a one-line "output"; the Result box gets totals + warnings.
function summarize(book) {
  const s = book.settings, imgs = state.source.images;
  const N = book.leaves.length;
  const ref = imgs[0] || { w: 0, h: 0 };
  const blankFaces = book.leaves.reduce((n, l) => n + (l.recto.img < 0) + (l.verso.img < 0), 0);
  const sigs = s.layout === 'fold' ? (s.sheetsPerSignature > 0 ? Math.ceil(book.sheets.length / s.sheetsPerSignature) : 1) : 0;
  const [h1, h2] = halfNames(book.split);
  const firstHalf = firstContentHalf(book);
  const otherHalf = firstHalf === h1 ? h2 : h1;
  const spineVertical = book.binding === 'left' || book.binding === 'right';
  const pageW = Math.round(spineVertical ? book.Ls : book.Lt), pageH = Math.round(spineVertical ? book.Lt : book.Ls);

  $('#out1').textContent = `→ ${ref.w}×${ref.h} px image = ${book.paper.landscape ? 'landscape' : 'portrait'} side` +
    (book.layout === 'single' ? ', one page' : `, two pages (${h1} ${book.split === 'vertical' ? '|' : '/'} ${h2})`);
  $('#out2').textContent = `→ ${book.sheets.length} sheets of ${book.paper.key} (${Math.round(book.W)}×${Math.round(book.H)} mm)` +
    (s.duplex ? `, back flipped around the ${book.flipAxis} axis` : ', backs blank');
  $('#out3').textContent = '→ ' + {
    single: `${N} leaves stacked`,
    fold: `${N} leaves in ${sigs} signature${sigs > 1 ? 's' : ''}`,
    cut: s.cutOrder === 'book' ? `${N} leaves, half-stacks closed like a book`
      : s.cutOrder === 'stack' ? `${N} leaves, ${firstHalf} half-stack on top of ${otherHalf}`
        : `${N} leaves, each sheet ${firstHalf} half then ${otherHalf} half`,
  }[book.layout];
  const rectoSide = { left: 'right-hand', right: 'left-hand', top: 'lower', bottom: 'upper' }[book.binding];
  const versoSide = { left: 'left-hand', right: 'right-hand', top: 'upper', bottom: 'lower' }[book.binding];
  if (book.cover) {
    const c = book.cover;
    const pl = (n) => `${n} blank page${n > 1 ? 's' : ''}`;
    $('#out4c').textContent = `→ front cover, ${pl(c.front)}, your page 1 on a ${c.shifted ? versoSide : rectoSide} page (book p${c.front + 2}) … your last page, ${pl(c.back)}, back cover`;
    const warns = [];
    if (c.shifted) {
      warns.push(`Front: ${c.front} is even, so your page 1 lands on the back of a leaf (a ${versoSide} page). Every page moves to the other side of its leaf: pages that faced each other end up back to back, and two-page images get split. ` +
        `Your printed sheets can't be bound like this as they are; it happens when the print shop re-arranges your pages. The 3D book shows that result.`);
    }
    if (c.padded) {
      warns.push(`Every leaf has two sides, so the page count must be even: one more blank page goes before the back cover (${c.back} instead of ${c.backRequested}).`);
    }
    $('#coverwarn').innerHTML = warns.map((w) => `<div class="warnline">${w}</div>`).join('');
  } else {
    $('#out4c').textContent = `→ your first page is the front cover, your last page is the back cover`;
    $('#coverwarn').innerHTML = '';
  }
  explainAssembly(book);
  const reads = { left: 'reads left → right', right: 'reads right → left', top: 'flips up', bottom: 'flips down' }[book.binding];
  $('#out4').textContent = `→ ${pageW}×${pageH} mm pages, ${reads}, ≈${(N * s.thickness).toFixed(1)} mm thick`;

  $('#summary').innerHTML = [
    `${imgs.length} images → ${book.sheets.length} printed sheets → ${N * 2} pages` +
      (book.cover ? ` incl. the cover and ${book.cover.addedPages - 2} added blank pages` : '') +
      (blankFaces - (book.cover ? book.cover.addedPages : 0) > 0 ? ` (${blankFaces - (book.cover ? book.cover.addedPages : 0)} unprinted)` : ''),
  ].map((l) => `<div>${l}</div>`).join('');

  const warns = [];
  if (book.paper.aspectMismatch > 0.03) warns.push(['', `Image aspect differs from ${book.paper.key} by ${(book.paper.aspectMismatch * 100).toFixed(0)}% — the printer will scale or crop.`]);
  const sizes = new Set(imgs.map((i) => `${i.w}x${i.h}`));
  if (sizes.size > 1) warns.push(['', `Images have ${sizes.size} different sizes.`]);
  const bad = imgs.filter((i) => i.error);
  if (bad.length) warns.push(['err', `${bad.length} unreadable image(s): ${bad.slice(0, 3).map((b) => b.name).join(', ')}`]);
  if (s.duplex && imgs.length % 2) warns.push(['', 'Odd number of sides: the last sheet has a blank back.']);
  if (s.duplex) {
    // Pages turn about the spine, so the back must be flipped about the same axis.
    const ok = (book.flipAxis === 'vertical') === spineVertical;
    if (!ok) warns.push(['err', `Step 2 vs step 4: the printer flip does not match the spine, so back pages will be upside down. Use "${s.flip === 'long' ? 'short' : 'long'} edge".`]);
  }
  $('#warnings').innerHTML = warns.length
    ? warns.map(([c, t]) => `<div class="${c}">${t}</div>`).join('')
    : '<div class="ok">✓ No problems detected</div>';
}

// Which half ("left", "right", ...) your page 1 comes from, skipping any separate cover.
function firstContentHalf(book) {
  for (const l of book.leaves) for (const f of [l.recto, l.verso]) if (f.sheet >= 0) return (f.part || '').split(' ')[0];
  return '';
}

// Step 3: say in plain words how to physically assemble the sheets, then show where the
// pages of the first sheets end up (computed from the real imposition, so it is exact).
function explainAssembly(book) {
  const s = book.settings;
  const nSheets = book.sheets.length;
  const firstHalf = firstContentHalf(book);
  const [h1, h2] = halfNames(book.split);
  const otherHalf = firstHalf === h1 ? h2 : h1;
  const line = book.split === 'vertical' ? 'vertical (left | right)' : 'horizontal (top / bottom)';
  let how;
  if (book.layout === 'single') {
    how = `Stack the ${nSheets} sheets in print order (sheet 1 on top) and bind them on the ${book.binding} edge.`;
  } else if (book.layout === 'fold') {
    const n = s.sheetsPerSignature;
    if (!n || n >= nSheets) {
      how = `Stack all ${nSheets} sheets in print order, sheet 1 on the outside, and fold the whole stack in half on the ${line} line (fronts facing out). ` +
        `Staple at the fold. Sheet 1 becomes the outermost sheet, so it holds the first two and the last two pages; the middle sheet is the centre spread.`;
    } else if (n === 1) {
      how = `Fold every sheet in half on its own on the ${line} line (front facing out), then stack the folded sheets in order, sheet 1 first. Each sheet gives 4 pages in a row.`;
    } else {
      how = `Make booklets of ${n} sheets each: stack ${n} sheets (the first one outside), fold them together on the ${line} line, then stack the booklets in order and bind them.`;
    }
  } else if (s.cutOrder === 'book') {
    how = `Cut the whole stack on the ${line} line. Lay the two half-stacks side by side like an open book, then close it: the ${firstHalf} half-stack stays as the front, and the ${otherHalf} half-stack is flipped over onto its back. ` +
      `This gives the same page order as a folded booklet, but with loose leaves, so glue or clip the spine.`;
  } else if (s.cutOrder === 'stack') {
    how = `Cut the whole stack on the ${line} line, then put the ${firstHalf} half-stack on top of the ${otherHalf} half-stack, without flipping anything.`;
  } else {
    how = `Cut each sheet on the ${line} line and keep its halves together: the ${firstHalf} half first, then the ${otherHalf} half, sheet after sheet.`;
  }
  // sheet -> its pages
  const bySheet = new Map();
  book.leaves.forEach((l, k) => {
    for (const [face, verso] of [[l.recto, false], [l.verso, true]]) {
      if (face.sheet < 0) continue;
      const half = book.layout === 'single' ? '' : ' ' + (face.part || '').split(' ')[0];
      if (!bySheet.has(face.sheet)) bySheet.set(face.sheet, []);
      bySheet.get(face.sheet).push({ p: pageNumber(k, verso), what: face.side + half });
    }
  });
  const show = [...new Set([0, 1, 2, nSheets - 1])].filter((j) => j >= 0 && j < nSheets);
  const rows = show.map((j, idx) => {
    const pages = (bySheet.get(j) || []).sort((a, b) => a.p - b.p).map((x) => `<b>p${x.p}</b> ${x.what}`).join(' · ');
    const gap = idx > 0 && j - show[idx - 1] > 1 ? '<div class="muted">…</div>' : '';
    return `${gap}<div>Sheet ${j + 1}: ${pages}</div>`;
  }).join('');
  $('#explain3').innerHTML = `<p>${how}</p><div class="map"><div class="muted">Where each printed sheet ends up:</div>${rows}</div>`;
}

function updatePos(cur) {
  const book = state.book;
  if (!book) return;
  const N = book.leaves.length;
  $('#slider').value = cur;
  let txt;
  if (cur === 0) txt = 'Front cover';
  else if (cur === N) txt = 'Back cover';
  else txt = `Spread ${cur} / ${N - 1}`;
  $('#pos').textContent = txt;
  const L = book.leaves;
  const left = cur > 0 ? describeFace(book, state.source, L[cur - 1].verso, cur - 1, true) : '';
  const right = cur < N ? describeFace(book, state.source, L[cur].recto, cur, false) : '';
  // Where the turned page (verso) and resting page (recto) sit, seen from above.
  const where = { left: ['Left', 'Right'], right: ['Right', 'Left'], top: ['Upper', 'Lower'], bottom: ['Lower', 'Upper'] }[book.binding];
  const hud = [];
  if (left) hud.push(`${where[0]}: ${left}`);
  if (right) hud.push(`${where[1]}: ${right}`);
  $('#hud').textContent = hud.join('\n');
}

// ---------- views ----------
function showView(v) {
  state.view = v;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.view === v);
  for (const el of document.querySelectorAll('.view')) el.classList.toggle('on', el.id === v);
  $('#nav').style.visibility = v === 'v3d' ? 'visible' : 'hidden';
  if (state.book && state.dirty2d && state.dirty2d[v]) {
    state.dirty2d[v] = false;
    if (v === 'vspreads') spreads.render(state.book, state.source);
    if (v === 'vsheets') sheets.render(state.book, state.source);
  }
}
for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showView(b.dataset.view);

// ---------- navigation ----------
$('#prev').onclick = () => book3d && book3d.prev();
$('#next').onclick = () => book3d && book3d.next();
$('#first').onclick = () => book3d && book3d.goTo(0);
$('#last').onclick = () => book3d && book3d.goTo(book3d.leafCount);
$('#slider').oninput = (e) => book3d && book3d.goTo(+e.target.value);
$('#camview').onchange = (e) => book3d && book3d.resetView(e.target.value);
// Themed table under the book. URL ?theme=pirate|library|cyber|fairy|none overrides.
{
  const urlTheme = new URLSearchParams(location.search).get('theme');
  let saved = null;
  try { saved = localStorage.getItem('pbs.theme'); } catch { /* ignore */ }
  for (const [k, v] of Object.entries(THEMES)) $('#scene').insertAdjacentHTML('beforeend', `<option value="${k}">${v}</option>`);
  $('#scene').value = THEMES[urlTheme] ? urlTheme : THEMES[saved] ? saved : 'library';
  $('#scene').onchange = (e) => {
    try { localStorage.setItem('pbs.theme', e.target.value); } catch { /* ignore */ }
    if (book3d) book3d.setTheme(e.target.value);
  };
}
$('#preload').onchange = (e) => book3d && book3d.setPreload(e.target.value);
window.addEventListener('keydown', (e) => {
  if (!book3d || state.view !== 'v3d' || /INPUT|SELECT/.test(document.activeElement.tagName) && document.activeElement.type !== 'range') return;
  // For right-bound books the "next" page is to the left.
  const rtl = state.book && state.book.binding === 'right';
  if (e.key === 'ArrowRight') { rtl ? book3d.prev() : book3d.next(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { rtl ? book3d.next() : book3d.prev(); e.preventDefault(); }
  else if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') { book3d.next(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' || e.key === 'PageUp') { book3d.prev(); e.preventDefault(); }
  else if (e.key === 'Home') book3d.goTo(0);
  else if (e.key === 'End') book3d.goTo(book3d.leafCount);
});
setInterval(() => {
  if (!book3d) return;
  const s = book3d.stats();
  $('#loadstat').textContent = `${s.software ? 'Software rendering (no GPU) · ' : ''}textures: ${s.full} full-res, ${s.lo} thumbnails${s.queued ? `, ${s.queued} queued` : ''}`;
  $('#loadstat').title = s.renderer;
}, 500);

// ---------- sources ----------
async function useSource(src, key, serverSettings) {
  state.source = src;
  state.folderKey = key;
  let saved = serverSettings;
  if (!saved) { try { saved = JSON.parse(localStorage.getItem('pbs.settings.' + key) || 'null'); } catch { saved = null; } }
  state.settings = { ...DEFAULT_SETTINGS, ...(migrateSettings(saved) || {}) };
  writeForm(state.settings);
  $('#out0').textContent = `${src.images.length} ${src.kind === 'pdf' ? 'pages' : 'images'} in ${src.label}`;
  if (book3d) book3d.source = src;
  // drop textures from a previous source
  if (book3d) { book3d.dispose(); book3d = null; }
  applyBlur();
  rebuild(false);
  // URL ?spread=N opens that spread (handy for links and screenshots)
  const sp = new URLSearchParams(location.search).get('spread');
  if (sp !== null && book3d && !state.spreadFromUrl) { state.spreadFromUrl = true; book3d.goTo(+sp, false); }
}

async function openFolder(path) {
  $('#out0').textContent = 'Loading…';
  try {
    const src = await openServerFolder(path);
    const saved = await loadServerSettings(path);
    localStorage.setItem('pbs.folder', path);
    await useSource(src, 'srv:' + path, saved);
    watchProgress();
  } catch (e) { $('#out0').textContent = 'Error: ' + e.message; }
}

async function loadFolders(selectPath) {
  try {
    const { folders, root } = await fetchFolders();
    const sel = $('#folder');
    sel.innerHTML = folders.length ? '' : '<option value="">(no image folders found)</option>';
    for (const f of folders) {
      const label = f.kind === 'pdf' ? `📄 ${f.path} — ${f.error ? 'unreadable' : f.count + ' pages'}` : `📁 ${f.path || '(root)'} — ${f.count} images`;
      sel.insertAdjacentHTML('beforeend', `<option value="${f.path}">${label}</option>`);
    }
    sel.title = 'Server data folder: ' + root;
    const want = selectPath ?? localStorage.getItem('pbs.folder');
    const pick = folders.find((f) => f.path === want) || folders[0];
    if (pick) { sel.value = pick.path; await openFolder(pick.path); }
  } catch {
    $('#folder').innerHTML = '<option>(no server — use "Open local folder")</option>';
  }
}
$('#folder').onchange = (e) => openFolder(e.target.value);

// ---------- PDF upload + background preparation progress ----------
function setBar(id, frac, text) {
  const el = $(id);
  el.classList.toggle('hide', frac === null);
  if (frac === null) return;
  el.firstElementChild.style.width = Math.round(frac * 100) + '%';
  el.lastElementChild.textContent = text;
}
$('#pdfup').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const mb = (n) => (n / 1048576).toFixed(0);
  try {
    setBar('#upbar', 0, 'Uploading…');
    const r = await uploadPdf(file, (l, t) => setBar('#upbar', l / t, l < t ? `Uploading ${mb(l)} / ${mb(t)} MB` : 'Reading PDF…'));
    setBar('#upbar', null);
    await loadFolders(r.path);
  } catch (err) {
    setBar('#upbar', 1, 'Upload failed: ' + err.message);
  }
};
$('#imgup').onchange = async (e) => {
  const all = [...e.target.files];
  e.target.value = '';
  const files = all.filter((f) => /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(f.name) && f.webkitRelativePath.split('/').length === 2);
  if (!files.length) { setBar('#upbar', 1, 'No images found in the top level of that folder'); return; }
  const folder = (files[0].webkitRelativePath || 'images').split('/')[0];
  try {
    setBar('#upbar', 0, 'Uploading images…');
    const path = await uploadImageFolder(folder, files, (d, t) => setBar('#upbar', d / t, `Uploading images ${d} / ${t}`));
    setBar('#upbar', null);
    await loadFolders(path);
  } catch (err) {
    setBar('#upbar', 1, 'Upload failed: ' + err.message);
  }
};
/** In-page dialog. Resolves true for Yes, false for No / Esc / backdrop. no=null → single OK button. */
function ask({ title, text, yes = 'Yes', no = 'No', danger = false }) {
  const m = $('#modal'), yesB = m.querySelector('.yes'), noB = m.querySelector('.no');
  m.querySelector('h3').textContent = title;
  m.querySelector('p').textContent = text;
  yesB.textContent = yes;
  yesB.classList.toggle('danger', danger);
  noB.textContent = no || '';
  noB.classList.toggle('hide', !no);
  m.classList.remove('hide');
  (danger ? noB : yesB).focus();
  return new Promise((resolve) => {
    const done = (v) => {
      m.classList.add('hide');
      m.onclick = yesB.onclick = noB.onclick = m.onkeydown = null;
      resolve(v);
    };
    yesB.onclick = () => done(true);
    noB.onclick = () => done(false);
    m.onclick = (e) => { if (e.target === m) done(false); };
    m.onkeydown = (e) => { if (e.key === 'Escape') done(false); };
  });
}
$('#clearall').onclick = async () => {
  try {
    const s = await (await fetch('/api/data-summary')).json();
    if (!s.imageFolders && !s.pdfs) { await ask({ title: 'Nothing to clear', text: 'img/ and pdf/ are already empty.', yes: 'OK', no: null }); return; }
    const what = [s.imageFolders && `${s.imageFolders} image folder${s.imageFolders > 1 ? 's' : ''} (img/)`, s.pdfs && `${s.pdfs} PDF${s.pdfs > 1 ? 's' : ''} (pdf/)`].filter(Boolean).join(' and ');
    const ok = await ask({
      title: 'Clear all data?',
      text: `Permanently delete ${what} from the server's data folder.

Other files in the data folder are not touched. This cannot be undone.`,
      yes: 'Yes, delete', no: 'No', danger: true,
    });
    if (!ok) return;
    const r = await fetch('/api/clear', { method: 'POST' });
    if (!r.ok) throw new Error((await r.json()).error);
    if (book3d) { book3d.dispose(); book3d = null; }
    state.source = null;
    await loadFolders();
  } catch (err) { ask({ title: 'Clear failed', text: err.message, yes: 'OK', no: null }); }
};
let progressTimer = null;
function watchProgress() {
  clearTimeout(progressTimer);
  const src = state.source;
  if (!src || src.path === undefined) { setBar('#prepbar', null); return; }
  const tick = async () => {
    if (state.source !== src) return;
    try {
      const { done, total } = await fetchProgress(src.path);
      if (!total || done >= total) { setBar('#prepbar', null); return; }
      setBar('#prepbar', done / total, `Preparing ${src.kind === 'pdf' ? 'pages' : 'thumbnails'} ${done} / ${total}`);
    } catch { /* server busy */ }
    progressTimer = setTimeout(tick, 800);
  };
  progressTimer = setTimeout(tick, 300);
}
$('#reload').onclick = () => loadFolders($('#folder').value);
$('#localdir').onchange = async (e) => {
  if (!e.target.files.length) return;
  const src = await LocalSource.create(e.target.files);
  const dir = (e.target.files[0].webkitRelativePath || 'local').split('/')[0];
  src.label = 'local: ' + dir;
  await useSource(src, 'local:' + dir, null);
};

if (!HAS_WEBGL) noWebGL();
loadFolders();

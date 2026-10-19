import { buildBook, DEFAULT_SETTINGS, PRESETS, PAPER_SIZES, allowedBindings, halfNames, migrateSettings, coverBlanksOdd } from './binding.js';
import { Book3D } from './book3d.js';
import { SpreadsView, SheetsView, describeFace } from './views2d.js';
import { fetchFolders, openServerFolder, LocalSource, loadServerSettings, saveServerSettings } from './source.js';

const $ = (s) => document.querySelector(s);
const state = { source: null, book: null, settings: { ...DEFAULT_SETTINGS }, view: 'v3d', folderKey: null };
let book3d = null;
const spreads = new SpreadsView($('#vspreads'), (i) => { showView('v3d'); book3d.goTo(i); });
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
  rebuild(true); persist();
  $('#preset').value = '';
}
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

// ---------- book ----------
function rebuild(keepSpread) {
  if (!state.source) return;
  const book = buildBook(state.source.images, state.settings);
  state.book = book;
  if (!book3d) {
    book3d = new Book3D($('#v3d'), state.source, { preload: $('#preload').value });
    book3d.onChange = updatePos;
  }
  book3d.source = state.source;
  book3d.setBook(book, keepSpread);
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
  const firstHalf = book.leaves[0]?.part.split(' ')[0];
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
  const firstSide = { left: 'right-hand', right: 'left-hand', top: 'lower', bottom: 'upper' }[book.binding];
  if (s.cover === 'separate') {
    const nb = coverBlanksOdd(s.coverBlanks);
    $('#out4c').textContent = `→ cover, then ${nb} blank page${nb > 1 ? 's' : ''}, then your page 1 on a ${firstSide} page (book p${nb + 2}); mirrored at the back`;
  } else {
    $('#out4c').textContent = `→ your first page is the front cover, your last page is the back cover`;
  }
  const reads = { left: 'reads left → right', right: 'reads right → left', top: 'flips up', bottom: 'flips down' }[book.binding];
  $('#out4').textContent = `→ ${pageW}×${pageH} mm pages, ${reads}, ≈${(N * s.thickness).toFixed(1)} mm thick`;

  $('#summary').innerHTML = [
    `${imgs.length} images → ${book.sheets.length} printed sheets → ${N * 2} pages` +
      (book.extraLeaves ? ` incl. 4 cover pages and ${(book.extraLeaves - 1) * 4} added blank pages` : '') +
      (blankFaces - book.extraLeaves * 4 > 0 ? ` (${blankFaces - book.extraLeaves * 4} unprinted)` : ''),
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
  $('#loadstat').textContent = `GPU textures: ${s.full} full-res, ${s.lo} thumbnails`;
}, 500);

// ---------- sources ----------
async function useSource(src, key, serverSettings) {
  state.source = src;
  state.folderKey = key;
  let saved = serverSettings;
  if (!saved) { try { saved = JSON.parse(localStorage.getItem('pbs.settings.' + key) || 'null'); } catch { saved = null; } }
  state.settings = { ...DEFAULT_SETTINGS, ...(migrateSettings(saved) || {}) };
  writeForm(state.settings);
  $('#out0').textContent = `${src.images.length} images in ${src.label}`;
  if (book3d) book3d.source = src;
  // drop textures from a previous source
  if (book3d) { book3d.dispose(); book3d = null; }
  rebuild(false);
}

async function openFolder(path) {
  $('#out0').textContent = 'Loading…';
  try {
    const src = await openServerFolder(path);
    const saved = await loadServerSettings(path);
    localStorage.setItem('pbs.folder', path);
    await useSource(src, 'srv:' + path, saved);
  } catch (e) { $('#out0').textContent = 'Error: ' + e.message; }
}

async function loadFolders(selectPath) {
  try {
    const { folders, root } = await fetchFolders();
    const sel = $('#folder');
    sel.innerHTML = folders.length ? '' : '<option value="">(no image folders found)</option>';
    for (const f of folders) sel.insertAdjacentHTML('beforeend', `<option value="${f.path}">${f.path || '(root)'} — ${f.count} images</option>`);
    sel.title = 'Server data folder: ' + root;
    const want = selectPath ?? localStorage.getItem('pbs.folder');
    const pick = folders.find((f) => f.path === want) || folders[0];
    if (pick) { sel.value = pick.path; await openFolder(pick.path); }
  } catch {
    $('#folder').innerHTML = '<option>(no server — use "Open local folder")</option>';
  }
}
$('#folder').onchange = (e) => openFolder(e.target.value);
$('#reload').onclick = () => loadFolders($('#folder').value);
$('#localdir').onchange = async (e) => {
  if (!e.target.files.length) return;
  const src = await LocalSource.create(e.target.files);
  const dir = (e.target.files[0].webkitRelativePath || 'local').split('/')[0];
  src.label = 'local: ' + dir;
  await useSource(src, 'local:' + dir, null);
};

loadFolders();

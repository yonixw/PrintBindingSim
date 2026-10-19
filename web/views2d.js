import { spineFrame, pageNumber } from './binding.js';

// Draw one leaf face onto a 2D canvas, opened flat and seen from above.
// sgn = +1 for a resting recto (right of spine for left binding), -1 for a turned verso.
export function drawFace(ctx, book, face, im, sgn, cx, cy, sc) {
  const { a, d } = spineFrame(book.binding);
  const { Ls, Lt } = book;
  const iw = im.width, ih = im.height;
  // canvas from (sN,tN)
  const oc = [cx - a[0] * Lt / 2 * sc, cy + a[1] * Lt / 2 * sc];
  const e1c = [sgn * Ls * sc * d[0], -sgn * Ls * sc * d[1]];
  const e2c = [Lt * sc * a[0], -Lt * sc * a[1]];
  // image px from (sN,tN)
  const oi = [face.o[0] * iw, (1 - face.o[1]) * ih];
  const e1i = [face.ds[0] * iw, -face.ds[1] * ih];
  const e2i = [face.dt[0] * iw, -face.dt[1] * ih];
  // T = C * I^-1
  const det = e1i[0] * e2i[1] - e2i[0] * e1i[1];
  const inv = [e2i[1] / det, -e2i[0] / det, -e1i[1] / det, e1i[0] / det]; // [[p,q],[r,s]] row-major
  const ia = inv[0], ib = inv[1], ic = inv[2], id = inv[3];
  // (sN,tN) = inv * (img - oi)
  const A = e1c[0] * ia + e2c[0] * ic, B = e1c[1] * ia + e2c[1] * ic;
  const C = e1c[0] * ib + e2c[0] * id, D = e1c[1] * ib + e2c[1] * id;
  const E = oc[0] - (A * oi[0] + C * oi[1]), F = oc[1] - (B * oi[0] + D * oi[1]);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(oc[0], oc[1]);
  ctx.lineTo(oc[0] + e1c[0], oc[1] + e1c[1]);
  ctx.lineTo(oc[0] + e1c[0] + e2c[0], oc[1] + e1c[1] + e2c[1]);
  ctx.lineTo(oc[0] + e2c[0], oc[1] + e2c[1]);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = '#fff';
  ctx.fill();
  if (im) {
    ctx.setTransform(A, B, C, D, E, F);
    ctx.drawImage(im, 0, 0, iw, ih);
  }
  ctx.restore();
}

function spreadExtent(book) {
  const { a, d } = spineFrame(book.binding);
  return {
    w: Math.abs(a[0]) * book.Lt + Math.abs(d[0]) * 2 * book.Ls,
    h: Math.abs(a[1]) * book.Lt + Math.abs(d[1]) * 2 * book.Ls,
  };
}

export function describeFace(book, source, face, leafIndex, isVerso) {
  if (!face) return '';
  const p = pageNumber(leafIndex, isVerso);
  if (face.label) return `p${p} — ${face.label}${face.kind === 'blank' ? ' page (added)' : ' (separate cover)'}`;
  const name = face.img >= 0 ? source.images[face.img].name : '(blank)';
  return `p${p} — sheet ${face.sheet + 1} ${face.side}${book.layout !== 'single' ? ', ' + book.leaves[leafIndex].part : ''} — ${name}`;
}

/** Grid of every spread, drawn lazily as it scrolls into view. */
export class SpreadsView {
  constructor(el, onPick) {
    this.el = el;
    this.onPick = onPick;
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) { this.io.unobserve(e.target); this._draw(e.target); }
    }, { root: el, rootMargin: '400px' });
  }
  render(book, source) {
    this.book = book; this.source = source;
    this.io.disconnect();
    this.el.innerHTML = '';
    const ext = spreadExtent(book);
    const W = 360, sc = W / ext.w, H = Math.round(ext.h * sc);
    const N = book.leaves.length;
    const frag = document.createDocumentFragment();
    for (let i = 0; i <= N; i++) {
      const card = document.createElement('div');
      card.className = 'spread-card';
      const cv = document.createElement('canvas');
      cv.width = W * 2; cv.height = H * 2; // hi-dpi
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      cv.dataset.i = i;
      const cap = document.createElement('div');
      cap.className = 'cap';
      const left = i > 0 ? pageNumber(i - 1, true) : null, right = i < N ? pageNumber(i, false) : null;
      cap.textContent = i === 0 ? `Front cover (p${right})` : i === N ? `Back cover (p${left})` : `Spread ${i}: p${left} | p${right}`;
      if (i > 0 && i < N && book.binding === 'right') cap.textContent = `Spread ${i}: p${right} | p${left}`;
      card.title = [i > 0 ? describeFace(book, source, book.leaves[i - 1].verso, i - 1, true) : '', i < N ? describeFace(book, source, book.leaves[i].recto, i, false) : ''].filter(Boolean).join('\n');
      card.append(cv, cap);
      card.onclick = () => this.onPick(i);
      frag.append(card);
      this.io.observe(cv);
    }
    this.el.append(frag);
    this.sc = sc * 2; this.cw = W * 2; this.ch = H * 2;
  }
  async _draw(cv) {
    const book = this.book, src = this.source, i = +cv.dataset.i, N = book.leaves.length;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#3a3f48'; ctx.fillRect(0, 0, cv.width, cv.height);
    const jobs = [];
    if (i > 0) jobs.push([book.leaves[i - 1].verso, -1]);
    if (i < N) jobs.push([book.leaves[i].recto, 1]);
    for (const [face, sgn] of jobs) {
      let im = null;
      if (face.label) {
        const vert = book.binding === 'left' || book.binding === 'right';
        const pw = vert ? book.Ls : book.Lt, ph = vert ? book.Lt : book.Ls, k = 400 / Math.max(pw, ph);
        im = labelCanvas(face, Math.round(pw * k), Math.round(ph * k));
      } else if (face.img >= 0) { try { im = await src.get(face.img, 'lo'); } catch { /* missing */ } }
      if (this.book !== book) return;
      drawFace(ctx, book, face, im, sgn, cv.width / 2, cv.height / 2, this.sc);
    }
    // spine line
    const { a } = spineFrame(book.binding);
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cv.width / 2 - a[0] * cv.width / 2, cv.height / 2 - a[1] * cv.height / 2);
    ctx.lineTo(cv.width / 2 + a[0] * cv.width / 2, cv.height / 2 + a[1] * cv.height / 2);
    ctx.stroke();
  }
}

/** The physical sheets as they come out of the printer: front and back side by side. */
export class SheetsView {
  constructor(el) { this.el = el; }
  render(book, source) {
    this.el.innerHTML = '';
    const frag = document.createDocumentFragment();
    const ref = source.images[0] || { w: book.W, h: book.H };
    const W = 220, H = Math.round(W * ref.h / ref.w); // raw image, as the file looks
    const io = new IntersectionObserver((ents) => {
      for (const e of ents) if (e.isIntersecting) {
        io.unobserve(e.target);
        const img = +e.target.dataset.img;
        source.get(img, 'lo').then((im) => {
          const ctx = e.target.getContext('2d');
          ctx.drawImage(im, 0, 0, e.target.width, e.target.height);
        }).catch(() => {});
      }
    }, { root: this.el, rootMargin: '400px' });
    for (const sh of book.sheets) {
      const card = document.createElement('div');
      card.className = 'sheet-card';
      const head = document.createElement('div');
      head.className = 'cap';
      head.textContent = `Sheet ${sh.index + 1}`;
      card.append(head);
      const row = document.createElement('div');
      row.className = 'sheet-row';
      for (const side of ['front', 'back']) {
        if (side === 'back' && !book.settings.duplex) continue;
        const box = document.createElement('div');
        box.className = 'side';
        const cv = document.createElement('canvas');
        cv.width = W * 2; cv.height = H * 2; cv.style.width = W + 'px'; cv.style.height = H + 'px';
        const img = sh[side];
        const lab = document.createElement('div');
        lab.className = 'sub';
        lab.textContent = `${side}: ${img >= 0 ? source.images[img].name : '(blank)'}`;
        if (img >= 0) { cv.dataset.img = img; io.observe(cv); } else { const c = cv.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height); }
        box.append(cv, lab);
        row.append(box);
      }
      card.append(row);
      frag.append(card);
    }
    this.el.append(frag);
    this._io && this._io.disconnect();
    this._io = io;
  }
}

/** Canvas for a page this job does not print (cover / blank), drawn upright. */
export function labelCanvas(face, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  const cover = face.kind === 'cover';
  const outside = cover && !/Inside/.test(face.label);
  c.fillStyle = outside ? '#b9c9e0' : cover ? '#e4ebf5' : '#ffffff';
  c.fillRect(0, 0, w, h);
  c.strokeStyle = outside ? '#8ea3c2' : '#d5d9e0';
  c.lineWidth = Math.max(2, w / 100);
  c.strokeRect(c.lineWidth, c.lineWidth, w - 2 * c.lineWidth, h - 2 * c.lineWidth);
  c.fillStyle = outside ? '#34496b' : '#a3aab5';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = `${outside ? 700 : 400} ${Math.round(Math.min(w, h) / (outside ? 9 : 14))}px system-ui, sans-serif`;
  c.fillText(face.label.toUpperCase(), w / 2, h / 2);
  if (outside) {
    c.font = `${Math.round(Math.min(w, h) / 22)}px system-ui, sans-serif`;
    c.fillText('(separate cover, not in this print)', w / 2, h / 2 + Math.min(w, h) / 9);
  }
  return cv;
}

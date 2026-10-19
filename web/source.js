// Image sources. Both return decoded images (ImageBitmap/HTMLImageElement/canvas)
// for an index at a level: 'lo' (thumbnail, ~512px) or 'full'.

const LO_SIZE = 512;

function loadImg(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('failed to load ' + url));
    im.src = url;
  });
}

class BaseSource {
  constructor() {
    this.cache = { lo: new Map(), full: new Map() };
    this.fullLimit = 24; // keep at most this many full-res images decoded
    this.blur = 0;
  }
  /** Change blur strength; drops every cached image. Returns true if it changed. */
  setBlur(b) {
    b = Math.max(0, Math.min(100, +b || 0));
    if (b === this.blur) return false;
    this.blur = b;
    this.cache = { lo: new Map(), full: new Map() };
    return true;
  }
  get(i, level) {
    const c = this.cache[level];
    if (c.has(i)) {
      const p = c.get(i);
      c.delete(i); c.set(i, p); // LRU bump
      return p;
    }
    const p = this._load(i, level).catch((e) => { c.delete(i); throw e; });
    c.set(i, p);
    if (level === 'full') {
      while (c.size > this.fullLimit) {
        // Drop the oldest; it may still be referenced by a live texture, so no close().
        c.delete(c.keys().next().value);
      }
    }
    return p;
  }
  peek(i, level) { return this.cache[level].get(i); }
}

export class ServerSource extends BaseSource {
  constructor(path, images) {
    super();
    this.path = path;
    this.images = images;
    this.label = path || '(root)';
  }
  url(i, level) {
    const rel = (this.path ? this.path + '/' : '') + this.images[i].name;
    return `/api/image?path=${encodeURIComponent(rel)}&size=${level}${this.blur ? '&blur=' + this.blur : ''}`;
  }
  _load(i, level) { return loadImg(this.url(i, level)); }
  /** Ask the server to pre-render (blurred) versions of every file. */
  warm() { fetch(`/api/warm?path=${encodeURIComponent(this.path)}&blur=${this.blur}`).catch(() => {}); }
}

export class LocalSource extends BaseSource {
  constructor(files) {
    super();
    this.files = files;
    this.label = 'local folder';
    this.images = [];
  }
  static async create(fileList) {
    const files = [...fileList].filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name));
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const s = new LocalSource(files);
    // Dimensions: decode the first one, assume the rest similar until loaded.
    const dims = await Promise.all(files.map(async (f, i) => {
      if (i > 0) return null;
      const bm = await createImageBitmap(f);
      const d = { w: bm.width, h: bm.height }; bm.close(); return d;
    }));
    const d0 = dims[0] || { w: 1, h: 1 };
    s.images = files.map((f) => ({ name: f.name, w: d0.w, h: d0.h }));
    return s;
  }
  warm() {}
  async _load(i, level) {
    const f = this.files[i];
    if (this.blur > 0) return this._blurred(f, level === 'full' ? 1600 : LO_SIZE);
    if (level === 'full') return createImageBitmap(f);
    const bm = await createImageBitmap(f);
    const k = LO_SIZE / Math.max(bm.width, bm.height);
    if (k >= 1) return bm;
    const out = await createImageBitmap(bm, { resizeWidth: Math.round(bm.width * k), resizeHeight: Math.round(bm.height * k), resizeQuality: 'high' });
    bm.close();
    return out;
  }
}

LocalSource.prototype._blurred = async function (f, size) {
  const bm = await createImageBitmap(f);
  const k = Math.min(1, size / Math.max(bm.width, bm.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bm.width * k); cv.height = Math.round(bm.height * k);
  const c = cv.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
  c.filter = `blur(${(this.blur / 1000) * Math.max(cv.width, cv.height)}px)`;
  c.drawImage(bm, 0, 0, cv.width, cv.height);
  bm.close();
  return cv;
};

export async function fetchFolders() {
  const r = await fetch('/api/folders');
  if (!r.ok) throw new Error('server error');
  return r.json();
}

export async function openServerFolder(path) {
  const r = await fetch('/api/folder?path=' + encodeURIComponent(path));
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'failed');
  return new ServerSource(path, j.images);
}

export async function loadServerSettings(path) {
  try { const r = await fetch('/api/settings?path=' + encodeURIComponent(path)); return r.ok ? await r.json() : null; } catch { return null; }
}
export async function saveServerSettings(path, settings) {
  try { await fetch('/api/settings?path=' + encodeURIComponent(path), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) }); } catch { /* offline */ }
}

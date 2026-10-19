import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { faceUV, spineFrame } from './binding.js';
import { labelCanvas } from './views2d.js';

const SEG = 28;          // segments across a leaf (for the page curl)
const CURL = 0.65;       // how much the free edge lags while turning
const FLIP_MS = 650;
const MIN_GAP = 0.3;     // mm, minimum visual distance between stacked leaves

export class Book3D {
  constructor(container, source, opts = {}) {
    this.container = container;
    this.source = source;
    this.opts = { preload: 'window', loWindow: 8, ...opts };
    this.onChange = () => {};
    this.cur = 0;          // number of turned leaves (target)
    this.anims = new Map(); // leaf index -> {from,to,start,dur,dir}

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2b2f36);
    this.camera = new THREE.PerspectiveCamera(35, 1, 5, 20000);
    this.camera.up.set(0, 1, 0);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;

    // Tuned so a flat page facing the reader renders at ~its true color.
    const hemi = new THREE.HemisphereLight(0xffffff, 0x7d828c, 2.45);
    hemi.position.set(0, 0, 1);
    this.scene.add(hemi);
    const dl = new THREE.DirectionalLight(0xffffff, 0.85);
    dl.position.set(-300, 300, 900);
    this.scene.add(dl);

    this.blankMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.loadingMat = new THREE.MeshLambertMaterial({ color: 0xd9dce2 });
    this.edgeMat = new THREE.MeshLambertMaterial({ color: 0xf2efe6 });
    this.mats = new Map();  // image index -> material
    this.tex = { lo: new Map(), full: new Map() }; // image index -> texture (or 'pending')

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this._bindPointer();
    this.resize();
    this.renderer.setAnimationLoop((t) => this._frame(t));
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this._ro.disconnect();
    this._clearBook();
    for (const lvl of ['lo', 'full']) for (const t of this.tex[lvl].values()) t !== 'pending' && t.dispose();
    for (const m of this.mats.values()) m.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------- book construction ----------
  setBook(book, keepSpread = false) {
    const prev = this.cur;
    const old = this.book;
    const sameShape = old && old.Ls === book.Ls && old.Lt === book.Lt && old.binding === book.binding;
    this._clearBook();
    this.book = book;
    const { a, d } = spineFrame(book.binding);
    this.a3 = new THREE.Vector3(a[0], a[1], 0);
    this.d3 = new THREE.Vector3(d[0], d[1], 0);
    this.n3 = new THREE.Vector3(0, 0, 1);
    this.flipWinding = d[0] * a[1] - d[1] * a[0] < 0;
    // Visual leaf spacing. Real paper (0.1 mm) is too thin for the depth buffer, so
    // enforce a minimum gap; the book gets a little chunkier than reality.
    this.th = Math.max(MIN_GAP, book.settings.thickness);
    const N = book.leaves.length;

    this.leafObjs = book.leaves.map((leaf, k) => {
      const rec = this._faceMesh(leaf.recto, true);
      const ver = this._faceMesh(leaf.verso, false);
      rec.userData.leaf = k; ver.userData.leaf = k;
      this.group.add(rec, ver);
      return { leaf, rec, ver, theta: -1 };
    });
    // Page-block edges (the stacks of resting leaves)
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0.5, 0.5, 0.5);
    this.rightBlock = new THREE.Mesh(box, this.edgeMat);
    this.leftBlock = new THREE.Mesh(box, this.edgeMat);
    this.group.add(this.rightBlock, this.leftBlock);

    // Center the book on the spine midpoint
    this.group.position.copy(this.a3).multiplyScalar(-book.Lt / 2);
    this.cur = keepSpread ? Math.min(prev, N) : 0;
    this.anims.clear();
    this._updateSpine();
    for (let k = 0; k < N; k++) this._setTheta(k, k < this.cur ? Math.PI : 0);
    this._updateBlocks();
    this._updateTextures();
    if (!keepSpread || !sameShape) this.resetView();
    this.onChange(this.cur);
  }

  _clearBook() {
    if (!this.leafObjs) return;
    for (const o of this.leafObjs) {
      o.rec.geometry.dispose(); o.ver.geometry.dispose();
      this.group.remove(o.rec, o.ver);
    }
    this.group.remove(this.rightBlock, this.leftBlock);
    this.rightBlock.geometry.dispose();
    this.leftBlock.geometry.dispose();
    this.leafObjs = null;
  }

  _faceMesh(face, isRecto) {
    const g = new THREE.BufferGeometry();
    const nv = (SEG + 1) * 2;
    const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    for (let i = 0; i <= SEG; i++) {
      for (let j = 0; j <= 1; j++) {
        const vi = i * 2 + j;
        const [u, v] = faceUV(face, i / SEG, j);
        uv[vi * 2] = u; uv[vi * 2 + 1] = v;
      }
    }
    const idx = [];
    let ccw = isRecto !== this.flipWinding;
    for (let i = 0; i < SEG; i++) {
      const a = i * 2, b = (i + 1) * 2, c = i * 2 + 1, e = (i + 1) * 2 + 1;
      if (ccw) idx.push(a, b, c, b, e, c); else idx.push(a, c, b, b, c, e);
    }
    g.setIndex(idx);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const m = new THREE.Mesh(g, face.label ? this._labelMat(face) : this._matFor(face.img));
    m.userData.face = face;
    m.frustumCulled = false;
    return m;
  }

  // Cover / blank pages that this print job does not produce: a labelled card.
  _labelMat(face) {
    const { Ls, Lt, binding } = this.book;
    const vert = binding === 'left' || binding === 'right';
    const pw = vert ? Ls : Lt, ph = vert ? Lt : Ls;
    const key = `${face.kind}|${face.label}|${Math.round(pw)}x${Math.round(ph)}`;
    this.labelMats = this.labelMats || new Map();
    if (!this.labelMats.has(key)) {
      const k = 512 / Math.max(pw, ph);
      const tex = new THREE.CanvasTexture(labelCanvas(face, Math.round(pw * k), Math.round(ph * k)));
      tex.colorSpace = THREE.SRGBColorSpace;
      this.labelMats.set(key, new THREE.MeshLambertMaterial({ map: tex }));
    }
    return this.labelMats.get(key);
  }

  _matFor(img) {
    if (img < 0) return this.blankMat;
    if (!this.mats.has(img)) {
      const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
      m.visible = true;
      this.mats.set(img, m);
    }
    const m = this.mats.get(img);
    return m.map ? m : this.loadingMat;
  }

  // All leaves hinge on one spine line at height spineZ, so the two facing pages always
  // meet there. The spine sits at the top of the thinner stack; the top page of the
  // thicker stack curves down through the gutter (width G) to meet it, like a real open
  // book. Pages under the top one (incl. the covers at the bottom) stay flat.
  _updateSpine() {
    const N = this.leafObjs.length, th = this.th, c = this.cur;
    const topR = c < N ? (N - c - 0.5) * th : 0; // center height of the top resting leaf, right
    const topL = c > 0 ? (c - 0.5) * th : 0;
    this.spineZ = c > 0 && c < N ? Math.min(topR, topL) : Math.max(topR, topL, th / 2);
    const dz = Math.abs(topR - topL);
    this.G = Math.min(0.45 * this.book.Ls, Math.max(0.06 * this.book.Ls, 4 * dz));
  }
  // 1 at the spine, easing to 0 at the end of the gutter
  _gutter(u) {
    if (u >= this.G) return 0;
    const x = u / this.G;
    return 1 - x * x * (3 - 2 * x);
  }

  // Position the vertices of leaf k for turn angle theta (0 = resting right, PI = turned).
  _setTheta(k, theta, dir = 1) {
    const o = this.leafObjs[k];
    const bends = !!o.isTop || this.anims.has(k); // only the visible top page follows the gutter
    if (o.theta === theta && o.spineZ === this.spineZ && o.G === this.G && o.bends === bends && !this.anims.has(k)) return;
    o.theta = theta; o.spineZ = this.spineZ; o.G = this.G; o.bends = bends;
    const { Ls, Lt } = this.book;
    const N = this.leafObjs.length, th = this.th;
    const zR = (N - 1 - k) * th + th / 2, zL = k * th + th / 2;
    const hingeZ = this.spineZ;
    // How much each resting shape applies: fully at rest, none when the leaf stands upright.
    const cR = Math.max(0, Math.cos(theta)) ** 2, cL = Math.max(0, -Math.cos(theta)) ** 2;
    const dropR = (zR - hingeZ) * cR, dropL = (zL - hingeZ) * cL;
    const bend = -dir * CURL * Math.sin(theta);
    const a = this.a3, d = this.d3;
    const pr = o.rec.geometry.attributes.position.array;
    const pv = o.ver.geometry.attributes.position.array;
    let px = 0, pz = 0; // position in (d, n) plane
    const ds = Ls / SEG;
    for (let i = 0; i <= SEG; i++) {
      const w = i / SEG;
      const phi = Math.min(Math.PI, Math.max(0, theta + bend * Math.pow(w, 1.6)));
      if (i > 0) {
        const wm = (i - 0.5) / SEG;
        const phm = Math.min(Math.PI, Math.max(0, theta + bend * Math.pow(wm, 1.6)));
        px += Math.cos(phm) * ds; pz += Math.sin(phm) * ds;
      }
      // surface normal in (d,n): (-sin phi, cos phi)
      const nx = -Math.sin(phi), nz = Math.cos(phi);
      for (let j = 0; j <= 1; j++) {
        const t = j * Lt, vi = (i * 2 + j) * 3;
        for (const [arr, sgn] of [[pr, 0.5], [pv, -0.5]]) {
          const ox = px + nx * th * sgn, oz = pz + nz * th * sgn;
          arr[vi] = a.x * t + d.x * ox;
          arr[vi + 1] = a.y * t + d.y * ox;
          arr[vi + 2] = hingeZ + oz + (dropR + dropL) * (bends ? 1 - this._gutter(i * ds) : 1);
        }
      }
    }
    for (const m of [o.rec, o.ver]) {
      m.geometry.attributes.position.needsUpdate = true;
      m.geometry.computeVertexNormals();
      m.geometry.computeBoundingSphere();
    }
  }

  _updateBlocks() {
    const { Ls, Lt } = this.book;
    const N = this.leafObjs.length, th = this.th;
    // resting leaves on each side (ignoring animating ones)
    let right = 0, left = 0;
    for (let k = 0; k < N; k++) {
      if (this.anims.has(k)) continue;
      if (this.leafObjs[k].theta === 0) right = Math.max(right, N - k); else left = Math.max(left, k + 1);
    }
    // Only draw leaves that can be seen: the top and bottom leaf of each resting stack
    // and the ones being turned. Buried leaves are hidden (no z-fighting, less work);
    // the stacks' edges are drawn by the blocks.
    const topRight = N - right, topLeft = left - 1;
    for (let k = 0; k < N; k++) {
      const o = this.leafObjs[k];
      let vis = this.anims.has(k) || k === topRight || k === topLeft;
      if (!vis && o.theta === 0 && k === N - 1) vis = true; // back cover, bottom of right stack
      if (!vis && o.theta === Math.PI && k === 0) vis = true; // front cover, bottom of left stack
      o.rec.visible = o.ver.visible = vis;
      o.isTop = k === topRight || k === topLeft;
      if (vis && !this.anims.has(k) && o.theta >= 0) this._setTheta(k, o.theta);
    }
    const inset = 0.15;
    // The page block of a stack: flat on top, rising/dipping to the spine in the gutter
    // exactly like its leaves, so the stack edges stay under the visible page.
    const place = (mesh, count, side) => {
      mesh.visible = count > 0;
      if (!count) return;
      const top = (count - 0.5) * th - th * 0.5, bottom = th * 0.5;
      const zAt = (u) => Math.max(bottom, top + (this.spineZ - th * 0.5 - top) * this._gutter(u));
      const a = this.a3, d = this.d3.clone().multiplyScalar(side);
      const pos = [];
      const P = (u, t, z) => [a.x * t + d.x * u, a.y * t + d.y * u, z];
      const quad = (p0, p1, p2, p3) => pos.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
      const t0 = inset, t1 = Lt - inset;
      for (let i = 0; i < SEG; i++) {
        const u0 = inset + (Ls - 2 * inset) * i / SEG, u1 = inset + (Ls - 2 * inset) * (i + 1) / SEG;
        const z0 = zAt(u0), z1 = zAt(u1);
        quad(P(u0, t0, z0), P(u1, t0, z1), P(u1, t1, z1), P(u0, t1, z0));                 // top
        quad(P(u0, t0, bottom), P(u1, t0, bottom), P(u1, t0, z1), P(u0, t0, z0));         // side t0
        quad(P(u0, t1, bottom), P(u1, t1, bottom), P(u1, t1, z1), P(u0, t1, z0));         // side t1
        quad(P(u0, t0, bottom), P(u1, t0, bottom), P(u1, t1, bottom), P(u0, t1, bottom)); // bottom
      }
      const ue = Ls - inset, ze = zAt(ue);
      quad(P(ue, t0, bottom), P(ue, t1, bottom), P(ue, t1, ze), P(ue, t0, ze));             // fore edge
      const us = inset, zs = zAt(us);
      quad(P(us, t0, bottom), P(us, t1, bottom), P(us, t1, zs), P(us, t0, zs));             // spine side
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      mesh.geometry.dispose();
      mesh.geometry = g;
      mesh.matrixAutoUpdate = true;
      mesh.matrix.identity();
      mesh.position.set(0, 0, 0);
      mesh.material.side = THREE.DoubleSide;
    };
    place(this.rightBlock, right, 1);
    place(this.leftBlock, left, -1);
  }

  // ---------- navigation ----------
  get leafCount() { return this.leafObjs ? this.leafObjs.length : 0; }

  goTo(target, animate = true) {
    const N = this.leafCount;
    target = Math.max(0, Math.min(N, Math.round(target)));
    if (target === this.cur && !animate) return;
    const from = this.cur;
    this.cur = target;
    this._updateSpine();
    const now = performance.now();
    const ks = [];
    if (target > from) for (let k = from; k < target; k++) ks.push(k);
    else for (let k = from - 1; k >= target; k--) ks.push(k);
    const n = ks.length;
    // Long jumps: snap all but the last few leaves.
    const animCount = animate ? Math.min(n, 12) : 0;
    const stagger = n > 1 ? Math.min(90, 500 / animCount) : 0;
    ks.forEach((k, i) => {
      const to = k < target ? Math.PI : 0;
      const ai = i - (n - animCount);
      if (ai < 0) { this.anims.delete(k); this._setTheta(k, to); return; }
      const o = this.leafObjs[k];
      const fromT = this.anims.has(k) ? o.theta : (to === Math.PI ? 0 : Math.PI);
      this.anims.set(k, { from: fromT, to, start: now + ai * stagger, dur: FLIP_MS * (n > 3 ? 0.7 : 1), dir: to > fromT ? 1 : -1 });
    });
    this._updateBlocks();
    this._updateTextures();
    this.onChange(this.cur);
  }
  next() { this.goTo(this.cur + 1); }
  prev() { this.goTo(this.cur - 1); }

  resetView(kind = 'angled') {
    if (!this.book) return;
    const { Ls, Lt } = this.book;
    // Open spread extent in view coords
    const w = Math.abs(this.a3.x) * Lt + Math.abs(this.d3.x) * 2 * Ls;
    const h = Math.abs(this.a3.y) * Lt + Math.abs(this.d3.y) * 2 * Ls;
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    const dist = Math.max(h / 2 / tanH, w / 2 / (tanH * this.camera.aspect)) * 1.12;
    this.controls.target.set(0, 0, 0);
    if (kind === 'top') this.camera.position.set(0, 0.001, dist);
    else if (kind === 'back') this.camera.position.set(0, 0.001, -dist);
    else this.camera.position.set(0, -Math.sin(0.5) * dist * 1.1, Math.cos(0.5) * dist * 1.1);
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
  }

  _bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button }; });
    el.addEventListener('pointerup', (e) => {
      if (!down || down.b !== 0) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5 || !this.leafObjs) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const meshes = [];
      for (const o of this.leafObjs) if (o.rec.visible) meshes.push(o.rec, o.ver);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit) return;
      const k = hit.object.userData.leaf;
      if (k < this.cur) this.prev(); else this.next();
    });
  }

  _frame(now) {
    if (this.leafObjs && this.anims.size) {
      let done = false;
      for (const [k, an] of this.anims) {
        const p = Math.min(1, Math.max(0, (now - an.start) / an.dur));
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        this._setTheta(k, an.from + (an.to - an.from) * e, an.dir);
        if (p >= 1) { this.anims.delete(k); this.leafObjs[k].theta = -1; this._setTheta(k, an.to); done = true; }
      }
      if (done) { this._updateBlocks(); this._updateTextures(); }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- textures ----------
  setPreload(mode) { this.opts.preload = mode; this._updateTextures(); }

  _imgsOfLeaves(k0, k1) {
    const s = new Set();
    const L = this.book.leaves;
    for (let k = Math.max(0, k0); k <= Math.min(L.length - 1, k1); k++) {
      if (L[k].recto.img >= 0) s.add(L[k].recto.img);
      if (L[k].verso.img >= 0) s.add(L[k].verso.img);
    }
    return s;
  }

  _updateTextures() {
    if (!this.book) return;
    const L = this.book.leaves, N = L.length, c = this.cur;
    const wantFull = this._imgsOfLeaves(c - 2, c + 1);
    for (const k of this.anims.keys()) for (const i of this._imgsOfLeaves(k, k)) wantFull.add(i);
    let wantLo;
    if (this.opts.preload === 'all') wantLo = this._imgsOfLeaves(0, N - 1);
    else {
      wantLo = this._imgsOfLeaves(c - this.opts.loWindow, c + this.opts.loWindow);
      for (const i of this._imgsOfLeaves(0, 0)) wantLo.add(i);          // front cover
      for (const i of this._imgsOfLeaves(N - 1, N - 1)) wantLo.add(i);  // back cover
    }
    this._sync('full', wantFull);
    this._sync('lo', wantLo);
    // Load order: nearest first
    const order = [...wantLo].sort((x, y) => Math.abs(this._imgLeaf(x) - c) - Math.abs(this._imgLeaf(y) - c));
    for (const i of wantFull) this._ensure(i, 'full');
    for (const i of order) this._ensure(i, 'lo');
  }

  _imgLeaf(img) {
    if (!this._imgLeafMap || this._imgLeafBook !== this.book) {
      this._imgLeafMap = new Map(); this._imgLeafBook = this.book;
      this.book.leaves.forEach((l, k) => {
        for (const f of [l.recto, l.verso]) if (!this._imgLeafMap.has(f.img)) this._imgLeafMap.set(f.img, k);
      });
    }
    return this._imgLeafMap.get(img) ?? 0;
  }

  _sync(level, want) {
    const m = this.tex[level];
    for (const [i, t] of m) {
      if (want.has(i)) continue;
      m.delete(i);
      if (t !== 'pending') { t.dispose(); this._refreshMat(i); }
    }
  }

  _ensure(i, level) {
    const m = this.tex[level];
    if (m.has(i)) return;
    m.set(i, 'pending');
    this.source.get(i, level).then((im) => {
      if (m.get(i) !== 'pending') return; // no longer wanted
      const t = new THREE.Texture(im);
      t.colorSpace = THREE.SRGBColorSpace;
      if (typeof ImageBitmap !== 'undefined' && im instanceof ImageBitmap) {
        t.flipY = false; t.repeat.set(1, -1); t.offset.set(0, 1);
      }
      t.anisotropy = level === 'full' ? this.renderer.capabilities.getMaxAnisotropy() : 4;
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.needsUpdate = true;
      m.set(i, t);
      this._refreshMat(i);
    }).catch(() => m.delete(i));
  }

  _refreshMat(i) {
    const full = this.tex.full.get(i), lo = this.tex.lo.get(i);
    const t = full && full !== 'pending' ? full : lo && lo !== 'pending' ? lo : null;
    if (!this.mats.has(i)) this.mats.set(i, new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const mat = this.mats.get(i);
    if (mat.map !== t) { mat.map = t; mat.needsUpdate = true; }
    if (!this.leafObjs) return;
    for (const o of this.leafObjs) {
      for (const mesh of [o.rec, o.ver]) {
        if (mesh.userData.face.img === i) mesh.material = t ? mat : this.loadingMat;
      }
    }
  }

  stats() {
    let lo = 0, full = 0;
    for (const t of this.tex.lo.values()) if (t !== 'pending') lo++;
    for (const t of this.tex.full.values()) if (t !== 'pending') full++;
    return { lo, full };
  }
}

// Low-poly themed tables under the book. Everything is built from a few primitive shapes
// with flat shading, and nothing animates, so the 3D view still only redraws on change.
// World units are mm; Z is up (the book lies on z = 0). ext = open-spread size {w, h}.
import * as THREE from 'three';

export const THEMES = {
  none: 'None',
  pirate: 'Pirate sheep captain',
  library: 'Wizard library',
  cyber: 'Cyberpunk',
  fairy: 'Fairy forest',
};

const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
const glow = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...extra });

function mesh(geo, mat, x = 0, y = 0, z = 0, parent) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (parent) parent.add(m);
  return m;
}
const box = (w, d, h, mat, x, y, z, p) => mesh(new THREE.BoxGeometry(w, d, h), mat, x, y, z, p);
// Cylinder standing up along Z
function cyl(rTop, rBot, h, seg, mat, x, y, z, p) {
  const m = mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat, x, y, z, p);
  m.rotation.x = Math.PI / 2;
  return m;
}
function cone(r, h, seg, mat, x, y, z, p) {
  const m = mesh(new THREE.ConeGeometry(r, h, seg), mat, x, y, z, p);
  m.rotation.x = Math.PI / 2;
  return m;
}

// Soft dark ellipse under the book so it sits on the table instead of floating.
function contactShadow(w, h, z, parent) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(64, 64, 10, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  const mat = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false });
  mesh(new THREE.PlaneGeometry(w * 1.25, h * 1.35), mat, 0, 0, z, parent);
}

// Rectangular table: top surface at z = top, legs down to the floor.
function table(W, D, T, legH, topMat, legMat, top, parent, legR) {
  box(W, D, T, topMat, 0, 0, top - T / 2, parent);
  const lx = W / 2 - legR * 2, ly = D / 2 - legR * 2;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) cyl(legR, legR * 0.8, legH, 6, legMat, sx * lx, sy * ly, top - T - legH / 2, parent);
  return top - T - legH; // floor height
}

// ---------- themes ----------

function pirate(g, ext, S, top) {
  const W = ext.w * 1.8, D = ext.h * 1.9, T = S * 0.05;
  // Weathered planks
  const woods = [0x6b4423, 0x7a4f2a, 0x5e3b1e, 0x734a26];
  const n = 7, pw = W / n;
  for (let i = 0; i < n; i++) box(pw * 0.96, D, T, lam(woods[i % woods.length]), -W / 2 + pw * (i + 0.5), 0, top - T / 2, g);
  const floor = top - T - S * 0.9;
  const legM = lam(0x4a2e16);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(S * 0.06, S * 0.06, S * 0.9, legM, sx * (W / 2 - S * 0.06), sy * (D / 2 - S * 0.06), top - T - S * 0.45, g);
  // Deck floor
  box(W * 4, D * 4, S * 0.02, lam(0x3d2814), 0, 0, floor - S * 0.01, g);

  // Treasure chest (back left)
  const cx = -W / 2 + S * 0.22, cy = D / 2 - S * 0.2, cw = S * 0.28, cd = S * 0.18, ch = S * 0.14;
  const wood = lam(0x8b5a2b), gold = lam(0xe0b03a, { emissive: 0x3a2a00 });
  box(cw, cd, ch, wood, cx, cy, top + ch / 2, g);
  const lid = mesh(new THREE.CylinderGeometry(cd / 2, cd / 2, cw, 8, 1, false, 0, Math.PI), wood, cx, cy, top + ch, g);
  lid.rotation.z = Math.PI / 2; lid.rotation.y = Math.PI / 2;
  for (const dx of [-0.35, 0.35]) box(cw * 0.08, cd * 1.04, ch * 1.02, gold, cx + dx * cw, cy, top + ch / 2, g);
  for (let i = 0; i < 9; i++) {
    const a = i * 2.4, r = S * (0.05 + 0.02 * (i % 3));
    cyl(S * 0.018, S * 0.018, S * 0.005, 8, gold, cx + cw * 0.6 + Math.cos(a) * r, cy - cd * 0.6 + Math.sin(a) * r * 0.6, top + S * 0.003 + (i % 2) * S * 0.005, g);
  }

  // The captain: a sheep in a tricorn hat with an eye patch (back right)
  const sx = W / 2 - S * 0.27, sy = D / 2 - S * 0.27, s = S * 0.24;
  const sheep = new THREE.Group();
  sheep.position.set(sx, sy, top);
  sheep.rotation.z = -Math.PI * 0.8; // look at the book
  g.add(sheep);
  const wool = lam(0xf3f0e8), skin = lam(0x2b2b2b), black = lam(0x151515);
  mesh(new THREE.IcosahedronGeometry(s * 0.55, 0), wool, 0, 0, s * 0.75, sheep).scale.set(1.25, 0.9, 0.85);
  for (const [lx, ly] of [[-0.35, -0.25], [0.35, -0.25], [-0.35, 0.25], [0.35, 0.25]]) cyl(s * 0.07, s * 0.06, s * 0.4, 5, skin, lx * s, ly * s, s * 0.2, sheep);
  const head = mesh(new THREE.DodecahedronGeometry(s * 0.28, 0), skin, s * 0.62, 0, s * 1.05, sheep);
  head.scale.set(1.2, 0.85, 0.9);
  mesh(new THREE.IcosahedronGeometry(s * 0.2, 0), wool, s * 0.5, 0, s * 1.28, sheep); // wool tuft
  for (const ey of [-1, 1]) box(s * 0.08, s * 0.22, s * 0.06, skin, s * 0.5, ey * s * 0.3, s * 1.12, sheep); // ears
  box(s * 0.04, s * 0.09, s * 0.09, glow(0xffffff), s * 0.86, s * 0.12, s * 1.1, sheep); // eye
  box(s * 0.05, s * 0.12, s * 0.12, black, s * 0.87, -s * 0.12, s * 1.1, sheep); // patch
  box(s * 0.02, s * 0.5, s * 0.02, black, s * 0.8, 0, s * 1.2, sheep).rotation.x = 0.5; // patch strap
  const hat = mesh(new THREE.ConeGeometry(s * 0.42, s * 0.22, 3), black, s * 0.55, 0, s * 1.45, sheep); // tricorn
  hat.rotation.x = Math.PI / 2; hat.rotation.y = Math.PI / 6;
  cyl(s * 0.2, s * 0.24, s * 0.2, 7, black, s * 0.55, 0, s * 1.55, sheep);
  box(s * 0.06, s * 0.06, s * 0.06, glow(0xffffff), s * 0.72, 0, s * 1.58, sheep); // skull badge

  // Lantern (front right)
  const lx2 = W / 2 - S * 0.14, ly2 = -D / 2 + S * 0.18;
  box(S * 0.08, S * 0.08, S * 0.012, black, lx2, ly2, top + S * 0.006, g);
  box(S * 0.06, S * 0.06, S * 0.1, glow(0xffb347), lx2, ly2, top + S * 0.062, g);
  cone(S * 0.05, S * 0.04, 4, black, lx2, ly2, top + S * 0.13, g);
  return { bg: 0x0f2236, fog: [0x0f2236, S * 3, S * 9] };
}

function library(g, ext, S, top) {
  const W = ext.w * 1.7, D = ext.h * 1.8, T = S * 0.06;
  const wood = lam(0x4a2416), dark = lam(0x2e160c);
  const floor = table(W, D, T, S * 0.85, wood, dark, top, g, S * 0.035);
  box(W * 4, D * 4, S * 0.02, lam(0x2a1c14), 0, 0, floor - S * 0.01, g);

  // Bookshelf wall behind
  const shelfY = D / 2 + S * 0.5, shelfW = W * 1.6, shelfH = S * 2.2;
  box(shelfW, S * 0.25, shelfH, dark, 0, shelfY + S * 0.1, floor + shelfH / 2, g);
  const colors = [0x7a1f1f, 0x1f4a7a, 0x2f6b2f, 0x6b5a1f, 0x4a1f6b, 0x8a5a2a, 0x1f6b6b];
  for (let r = 0; r < 5; r++) {
    const z = floor + S * 0.25 + r * S * 0.42;
    box(shelfW, S * 0.3, S * 0.03, wood, 0, shelfY - S * 0.02, z, g);
    let x = -shelfW / 2 + S * 0.05;
    let k = r * 3;
    while (x < shelfW / 2 - S * 0.1) {
      const bw = S * (0.035 + ((k * 7) % 5) * 0.008), bh = S * (0.24 + ((k * 3) % 4) * 0.03);
      box(bw, S * 0.2, bh, lam(colors[k % colors.length]), x + bw / 2, shelfY - S * 0.05, z + S * 0.015 + bh / 2, g);
      x += bw + S * 0.006; k++;
    }
  }
  // Stack of books (back left)
  const bx = -W / 2 + S * 0.25, by = D / 2 - S * 0.2;
  [[0x7a1f1f, 0], [0x1f4a7a, 0.2], [0x2f6b2f, -0.15]].forEach(([c, rot], i) => {
    const b = new THREE.Group(); b.position.set(bx, by, top + S * 0.03 + i * S * 0.045); b.rotation.z = rot; g.add(b);
    box(S * 0.3, S * 0.21, S * 0.045, lam(c), 0, 0, 0, b);
    box(S * 0.28, S * 0.2, S * 0.035, lam(0xeee3c8), S * 0.012, 0, 0, b);
  });
  // Candles (on the table and floating above, wizard-school style)
  const candle = (x, y, z, h) => {
    cyl(S * 0.022, S * 0.024, h, 7, lam(0xf1e6c8), x, y, z + h / 2, g);
    cone(S * 0.012, S * 0.04, 5, glow(0xffc04d), x, y, z + h + S * 0.02, g);
  };
  candle(W / 2 - S * 0.15, D / 2 - S * 0.15, top, S * 0.12);
  candle(W / 2 - S * 0.22, D / 2 - S * 0.1, top, S * 0.08);
  for (let i = 0; i < 7; i++) candle((i - 3) * S * 0.35, D / 2 + S * 0.05 + (i % 2) * S * 0.2, top + S * (0.9 + (i % 3) * 0.15), S * 0.1);
  // Potion (front right)
  const px = W / 2 - S * 0.16, py = -D / 2 + S * 0.16;
  mesh(new THREE.IcosahedronGeometry(S * 0.05, 1), glow(0x46e08a, { transparent: true, opacity: 0.85 }), px, py, top + S * 0.05, g);
  cyl(S * 0.015, S * 0.02, S * 0.05, 6, lam(0xa8d8c0, { transparent: true, opacity: 0.7 }), px, py, top + S * 0.115, g);
  cyl(S * 0.017, S * 0.015, S * 0.02, 6, lam(0x8b5a2b), px, py, top + S * 0.15, g);
  return { bg: 0x1a120c, fog: [0x1a120c, S * 3, S * 8] };
}

function cyber(g, ext, S, top) {
  const W = ext.w * 1.7, D = ext.h * 1.8, T = S * 0.04;
  const metal = lam(0x1d1f2b), dark = lam(0x111219);
  box(W, D, T, metal, 0, 0, top - T / 2, g);
  const cyan = glow(0x00f0ff), pink = glow(0xff2bd6), violet = glow(0x8a5cff);
  box(W * 1.002, S * 0.012, S * 0.012, cyan, 0, -D / 2, top - T / 2, g);
  box(W * 1.002, S * 0.012, S * 0.012, pink, 0, D / 2, top - T / 2, g);
  for (const sx of [-1, 1]) box(S * 0.012, D, S * 0.012, violet, sx * W / 2, 0, top - T / 2, g);
  // Single pedestal leg
  const floor = top - T - S * 0.9;
  box(S * 0.25, S * 0.25, S * 0.9, dark, 0, 0, top - T - S * 0.45, g);
  box(S * 0.26, S * 0.26, S * 0.01, cyan, 0, 0, top - T - S * 0.3, g);
  // Neon grid floor
  const grid = new THREE.GridHelper(S * 12, 48, 0xff2bd6, 0x3a1d5c);
  grid.rotation.x = Math.PI / 2; grid.position.z = floor; g.add(grid);
  // Glowing grid etched into the tabletop
  const etch = glow(0x0d5563);
  const step = S * 0.12;
  for (let x = -W / 2 + step; x < W / 2; x += step) box(S * 0.003, D * 0.98, S * 0.001, etch, x, 0, top + 0.02, g);
  for (let y = -D / 2 + step; y < D / 2; y += step) box(W * 0.98, S * 0.003, S * 0.001, etch, 0, y, top + 0.02, g);
  // Hologram screen standing at the back
  const holo = new THREE.Group();
  holo.position.set(W * 0.18, D / 2 - S * 0.08, top);
  g.add(holo);
  box(S * 0.5, S * 0.005, S * 0.3, glow(0x00f0ff, { transparent: true, opacity: 0.18, depthWrite: false }), 0, 0, S * 0.22, holo);
  for (const [w, h, x, z] of [[S * 0.5, S * 0.006, 0, S * 0.07], [S * 0.5, S * 0.006, 0, S * 0.37], [S * 0.006, S * 0.3, -S * 0.25, S * 0.22], [S * 0.006, S * 0.3, S * 0.25, S * 0.22]]) box(w, S * 0.006, h, cyan, x, 0, z, holo);
  for (let i = 0; i < 5; i++) box(S * (0.1 + (i % 3) * 0.08), S * 0.006, S * 0.012, i % 2 ? pink : cyan, -S * 0.16 + (i % 3) * S * 0.04, 0, S * (0.31 - i * 0.045), holo);
  box(S * 0.12, S * 0.06, S * 0.02, dark, 0, 0, S * 0.01, holo); // projector base
  // Neon ring (front left)
  const ring = mesh(new THREE.TorusGeometry(S * 0.05, S * 0.012, 6, 16), pink, -W / 2 + S * 0.15, -D / 2 + S * 0.15, top + S * 0.013, g);
  ring.rotation.x = 0;
  // Skyline behind, close enough to be seen from the reading angle
  for (let i = 0; i < 18; i++) {
    const h = S * (1.2 + ((i * 37) % 11) * 0.25), bw = S * (0.3 + (i % 3) * 0.12);
    const x = (i - 8.5) * S * 0.42, y = D / 2 + S * (0.9 + (i % 4) * 0.35);
    box(bw, bw, h, dark, x, y, floor + h / 2, g);
    box(bw * 0.06, bw * 1.01, h * 0.8, i % 2 ? cyan : pink, x - bw * 0.3, y, floor + h * 0.45, g);
    for (let k = 0; k < 4; k++) box(bw * 0.5, bw * 1.01, S * 0.01, violet, x + bw * 0.1, y, floor + h * (0.3 + k * 0.17), g);
  }
  // Data cube (wireframe) and a can
  const cube = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(S * 0.1, S * 0.1, S * 0.1)), new THREE.LineBasicMaterial({ color: 0x00f0ff }));
  cube.position.set(-W / 2 + S * 0.16, D / 2 - S * 0.16, top + S * 0.09); cube.rotation.set(0.6, 0.4, 0.7); g.add(cube);
  mesh(new THREE.OctahedronGeometry(S * 0.025), pink, -W / 2 + S * 0.16, D / 2 - S * 0.16, top + S * 0.09, g);
  cyl(S * 0.028, S * 0.028, S * 0.1, 10, lam(0x2a2e44), W / 2 - S * 0.14, -D / 2 + S * 0.16, top + S * 0.05, g);
  cyl(S * 0.029, S * 0.029, S * 0.02, 10, cyan, W / 2 - S * 0.14, -D / 2 + S * 0.16, top + S * 0.06, g);
  return { bg: 0x0a0614, fog: [0x0a0614, S * 3, S * 10] };
}

function fairy(g, ext, S, top) {
  // A big tree stump as the table
  const R = Math.hypot(ext.w, ext.h) * 0.62, T = S * 0.9;
  cyl(R, R * 1.12, T, 11, lam(0x5b3a22), 0, 0, top - T / 2, g);
  cyl(R * 0.99, R * 0.99, S * 0.01, 11, lam(0xc9a46b), 0, 0, top - S * 0.004, g); // cut face
  cyl(R * 0.7, R * 0.7, S * 0.012, 11, lam(0xb8935c), 0, 0, top - S * 0.002, g);   // growth ring
  const floor = top - T;
  cyl(S * 8, S * 8, S * 0.02, 12, lam(0x2f5a2a), 0, 0, floor - S * 0.01, g);
  // Roots
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3;
    const r = mesh(new THREE.CylinderGeometry(S * 0.05, S * 0.09, S * 0.6, 5), lam(0x4e321d), Math.cos(a) * R * 1.2, Math.sin(a) * R * 1.2, floor + S * 0.05, g);
    r.rotation.z = a + Math.PI / 2; r.rotation.y = 1.2;
  }
  // Mushrooms around the edge
  const shroom = (x, y, z, s, cap) => {
    cyl(s * 0.18, s * 0.22, s * 0.6, 6, lam(0xf2ead8), x, y, z + s * 0.3, g);
    const c = mesh(new THREE.SphereGeometry(s * 0.45, 7, 4, 0, Math.PI * 2, 0, Math.PI / 2), lam(cap), x, y, z + s * 0.55, g);
    c.rotation.x = Math.PI / 2;
    for (let i = 0; i < 4; i++) {
      const a = i * 1.7;
      mesh(new THREE.IcosahedronGeometry(s * 0.06, 0), glow(0xffffff), x + Math.cos(a) * s * 0.25, y + Math.sin(a) * s * 0.25, z + s * 0.85, g);
    }
  };
  shroom(R * 0.78, R * 0.45, top, S * 0.16, 0xd8342c);
  shroom(R * 0.62, R * 0.62, top, S * 0.1, 0xe0662c);
  shroom(-R * 0.85, R * 0.35, top, S * 0.12, 0xd8342c);
  shroom(R * 1.3, -R * 0.4, floor, S * 0.35, 0xc23a7a);
  shroom(-R * 1.25, -R * 0.6, floor, S * 0.28, 0xd8342c);
  // Flowers and grass on the ground
  const petal = [0xff9ad5, 0xffe066, 0xa98bff, 0x9df5ff];
  for (let i = 0; i < 22; i++) {
    const a = i * 2.39, r = R * (1.25 + (i % 5) * 0.18), x = Math.cos(a) * r, y = Math.sin(a) * r;
    cone(S * 0.02, S * (0.15 + (i % 3) * 0.06), 4, lam(0x4f9a3a), x, y, floor + S * 0.08, g);
    if (i % 2 === 0) mesh(new THREE.IcosahedronGeometry(S * 0.04, 0), glow(petal[i % 4]), x, y, floor + S * 0.2 + (i % 3) * S * 0.05, g);
  }
  // Moss on the stump rim, and fireflies
  for (let i = 0; i < 8; i++) {
    const a = i * 0.79 + 0.2;
    mesh(new THREE.DodecahedronGeometry(S * 0.05, 0), lam(0x5f9e3c), Math.cos(a) * R * 0.97, Math.sin(a) * R * 0.97, top - S * 0.01, g).scale.set(1, 1, 0.4);
  }
  for (let i = 0; i < 18; i++) {
    const a = i * 1.37, r = R * (0.6 + (i % 4) * 0.3);
    mesh(new THREE.IcosahedronGeometry(S * 0.008, 0), glow(0xfff6a0), Math.cos(a) * r, Math.sin(a) * r, top + S * (0.15 + (i % 5) * 0.12), g);
  }
  return { bg: 0x10261f, fog: [0x10261f, S * 3, S * 9] };
}

const BUILDERS = { pirate, library, cyber, fairy };

/** Build the scenery for a theme. Returns { group, bg, fog } (group null for 'none'). */
export function buildScenery(theme, ext) {
  const build = BUILDERS[theme];
  if (!build) return { group: null, bg: 0x2b2f36, fog: null };
  const S = Math.max(ext.w, ext.h);
  const group = new THREE.Group();
  const top = -0.25; // table surface just under the book's back cover
  contactShadow(ext.w, ext.h, top + 0.05, group);
  const env = build(group, ext, S, top);
  return { group, ...env };
}

export function disposeGroup(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}

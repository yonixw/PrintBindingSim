// Binding / imposition model.
//
// Coordinates used throughout:
//  * Sheet coords (x, y) in mm, as seen looking at the FRONT side of a sheet with the
//    front image upright. x right, y up, origin bottom-left. W x H is the paper size.
//  * Leaf coords (s, t): s = distance from the spine (0..Ls), t = position along the
//    spine (0..Lt). Leaves are what you actually turn in the finished book.
//  * Image uv: (u, v) in 0..1, v up (matches three.js textures with flipY).
//
// Every leaf face maps (sN, tN) in 0..1 to image uv with an affine transform, so the
// 3D viewer and the 2D spread view share exactly the same physics.

export const PAPER_SIZES = {
  A3: [297, 420], A4: [210, 297], A5: [148, 210], A6: [105, 148],
  B5: [176, 250], Letter: [215.9, 279.4], Legal: [215.9, 355.6],
  Tabloid: [279.4, 431.8], 'Half Letter': [139.7, 215.9],
};

export const DEFAULT_SETTINGS = {
  rotate: 0,             // FIRST step: image rotation on the paper, clockwise degrees (0/90/180/270).
                         // The rotated image is what one printed side looks like.
  duplex: true,          // print on both sides
  flip: 'short',         // 'long' | 'short' : duplex flip edge (printer driver setting)
  layout: 'fold',        // 'single' : each side is one page
                         // 'fold'   : each side is two pages, sheet folded in half
                         // 'cut'    : each side is two pages, sheet cut in half
  split: 'vertical',     // 'vertical' | 'horizontal' : the fold / cut line
  sheetsPerSignature: 0, // fold: folded sheets nested together (0 = all in one booklet)
  cutOrder: 'book',      // cut: 'book'  = lay the two half-stacks open like a book and close it
                         //      'stack' = put one half-stack on top of the other
                         //      'sheet' = keep the two halves of each sheet together
  cutFirst: 'right',     // cut stack/sheet: which half comes first (left/right or top/bottom)
  binding: 'right',      // 'left' | 'right' | 'top' | 'bottom' : where the spine is
  paper: 'auto',         // key of PAPER_SIZES or 'auto' (closest to image aspect)
  thickness: 0.1,        // paper thickness, mm
  cover: 'pages',        // 'pages'    : the first and last printed pages ARE the covers
                         // 'separate' : a separate cover is wrapped around the printed block
  coverBlanks: 1,        // separate cover: blank pages between the cover and the first page
                         // (same at the back). Always odd: the inside of the cover is one, every
                         // extra blank leaf adds two, because printed leaves cannot be split.
};

export const PRESETS = {
  'Booklet, left-to-right (saddle stitch)': { duplex: true, flip: 'short', layout: 'fold', split: 'vertical', sheetsPerSignature: 0, binding: 'left' },
  'Booklet, right-to-left / manga (saddle stitch)': { duplex: true, flip: 'short', layout: 'fold', split: 'vertical', sheetsPerSignature: 0, binding: 'right' },
  'Folded sheets stacked (each sheet its own signature), RTL': { duplex: true, flip: 'short', layout: 'fold', split: 'vertical', sheetsPerSignature: 1, binding: 'right' },
  'Cut in half, close like a book, RTL': { duplex: true, flip: 'short', layout: 'cut', split: 'vertical', cutOrder: 'book', binding: 'right' },
  'Cut in half, right half-stack on top, RTL': { duplex: true, flip: 'short', layout: 'cut', split: 'vertical', cutOrder: 'stack', cutFirst: 'right', binding: 'right' },
  'Portrait book, duplex long edge, bound left': { duplex: true, flip: 'long', layout: 'single', binding: 'left' },
  'Landscape, duplex short edge, bound left': { duplex: true, flip: 'short', layout: 'single', binding: 'left' },
  'Landscape calendar, duplex long edge, bound top': { duplex: true, flip: 'long', layout: 'single', binding: 'top' },
  'Single sided, bound left': { duplex: false, layout: 'single', binding: 'left' },
};

/** Accept settings saved by older versions (which had `fold: none|vertical|horizontal`). */
export function migrateSettings(s) {
  if (!s) return s;
  s = { ...s };
  if (s.fold !== undefined && s.layout === undefined) {
    if (s.fold === 'none') s.layout = 'single';
    else { s.layout = 'fold'; s.split = s.fold; }
  }
  delete s.fold;
  delete s.skipFirst;
  delete s.blankBefore;
  return s;
}

/** Spine positions that make physical sense for these settings. */
export function allowedBindings(st) {
  const folded = st.layout === 'fold' || (st.layout === 'cut' && st.cutOrder === 'book');
  if (folded) return st.split === 'horizontal' ? ['top', 'bottom'] : ['left', 'right'];
  return ['left', 'right', 'top', 'bottom'];
}

export function coverBlanksOdd(n) { n = Math.max(1, Math.round(n || 1)); return n % 2 ? n : n + 1; }

export function halfNames(split) { return split === 'horizontal' ? ['top', 'bottom'] : ['left', 'right']; }

/** Pick paper W x H (mm) for the given image pixel size and settings. */
export function paperSize(settings, imgW, imgH) {
  const rot = ((settings.rotate % 360) + 360) % 360;
  const rotated = rot === 90 || rot === 270;
  const pw = rotated ? imgH : imgW, ph = rotated ? imgW : imgH;
  const landscape = pw > ph;
  const aspect = Math.max(pw, ph) / Math.min(pw, ph);
  let key = settings.paper;
  if (!PAPER_SIZES[key]) {
    let best = 'A4', bestErr = Infinity;
    for (const [k, [a, b]] of Object.entries(PAPER_SIZES)) {
      const err = Math.abs(b / a - aspect);
      if (err < bestErr) { bestErr = err; best = k; }
    }
    key = best;
  }
  const [a, b] = PAPER_SIZES[key];
  const W = landscape ? b : a, H = landscape ? a : b;
  const paperAspect = b / a;
  return { W, H, key, landscape, aspectMismatch: Math.abs(paperAspect - aspect) / paperAspect };
}

function rotateUV(u, v, rot) {
  // Paper uv -> image uv, for an image rotated clockwise by `rot` on the paper.
  switch (rot) {
    case 90: return [1 - v, u];
    case 180: return [1 - u, 1 - v];
    case 270: return [v, 1 - u];
    default: return [u, v];
  }
}

/**
 * Build the book: list of leaves, each with recto/verso faces.
 * images: array of {name, w, h} in print order.
 * Returns { leaves, W, H, Ls, Lt, sheets, ... }.
 */
export function buildBook(images, settings) {
  const st = { ...DEFAULT_SETTINGS, ...settings };
  const rot = ((st.rotate % 360) + 360) % 360;
  const ref = images.find(Boolean) || { w: 1, h: 1.414 };
  const paper = paperSize(st, ref.w, ref.h);
  const { W, H } = paper;

  // Sides in print order: index into images or -1 for blank.
  const sides = images.map((_, i) => i);

  // Sheets
  const sheets = [];
  if (st.duplex) {
    for (let i = 0; i < sides.length; i += 2) sheets.push({ front: sides[i], back: i + 1 < sides.length ? sides[i + 1] : -1 });
  } else {
    for (const s of sides) sheets.push({ front: s, back: -1 });
  }
  sheets.forEach((s, i) => (s.index = i));

  // Duplex flip axis, in sheet coords. Long-edge flip rotates the sheet about an axis
  // parallel to its long side.
  const longIsHorizontal = W > H;
  const flipAxis = (st.flip === 'long') === longIsHorizontal ? 'horizontal' : 'vertical';

  function uvAt(side, x, y) {
    let u = x / W, v = y / H;
    if (side === 'back') {
      if (flipAxis === 'vertical') u = 1 - u; else v = 1 - v;
    }
    return rotateUV(u, v, rot);
  }

  let binding = st.binding;
  const allowed = allowedBindings(st);
  if (!allowed.includes(binding)) binding = allowed[0];
  const layout = st.layout === 'cut' || st.layout === 'single' ? st.layout : 'fold';
  const split = st.split === 'horizontal' ? 'horizontal' : 'vertical';
  const flipped = layout === 'fold' || (layout === 'cut' && st.cutOrder === 'book'); // one half turned over
  const spineVertical = binding === 'left' || binding === 'right';

  // The region of the sheet that becomes one page (whole sheet or one half).
  const rects = {
    whole: [0, 0, W, H],
    left: [0, 0, W / 2, H], right: [W / 2, 0, W, H],
    bottom: [0, 0, W, H / 2], top: [0, H / 2, W, H],
  };
  // Page size, then leaf size along s (away from the spine) and t (along the spine)
  const pw = layout === 'single' || split === 'horizontal' ? W : W / 2;
  const ph = layout === 'single' || split === 'vertical' ? H : H / 2;
  const Ls = spineVertical ? pw : ph, Lt = spineVertical ? ph : pw;

  // (s,t) -> sheet (x,y) for a region lying the right way up (front facing the reader).
  function upright([x0, y0, x1, y1]) {
    if (binding === 'left') return (s, t) => [x0 + s, y0 + t];
    if (binding === 'right') return (s, t) => [x1 - s, y0 + t];
    if (binding === 'top') return (s, t) => [x0 + t, y1 - s];
    return (s, t) => [x0 + t, y0 + s];
  }

  // A leaf that is not printed by this job (cover / blank). Faces map to an upright
  // label: recto as is; verso mirrored across the spine, as it is seen once turned.
  function synthLeaf(rectoLabel, versoLabel, kind) {
    const face = (label, isVerso) => {
      // (sN,tN) -> page uv with v up, page read upright from the front
      let o, ds, dt;
      if (binding === 'left') { o = [0, 0]; ds = [1, 0]; dt = [0, 1]; }
      else if (binding === 'right') { o = [1, 0]; ds = [-1, 0]; dt = [0, 1]; }
      else if (binding === 'top') { o = [0, 1]; ds = [0, -1]; dt = [1, 0]; }
      else { o = [0, 0]; ds = [0, 1]; dt = [1, 0]; }
      if (isVerso) {
        const mirrorU = spineVertical;
        o = mirrorU ? [1 - o[0], o[1]] : [o[0], 1 - o[1]];
        ds = mirrorU ? [-ds[0], ds[1]] : [ds[0], -ds[1]];
        dt = mirrorU ? [-dt[0], dt[1]] : [dt[0], -dt[1]];
      }
      return { img: -1, label, kind, sheet: -1, side: null, o, ds, dt };
    };
    return { recto: face(rectoLabel, false), verso: face(versoLabel, true), sheet: -1, part: kind, synthetic: true };
  }

  // A leaf is a region of a sheet, described by (s,t) -> sheet (x,y) and which sheet
  // side faces the reader at rest (recto).
  function makeLeaf(sheet, toSheet, rectoSide, label) {
    const versoSide = rectoSide === 'front' ? 'back' : 'front';
    const face = (side) => {
      const img = sheet[side];
      // Affine fit from 3 points
      const p = (sN, tN) => { const [x, y] = toSheet(sN * Ls, tN * Lt); return uvAt(side, x, y); };
      const o = p(0, 0), ps = p(1, 0), pt = p(0, 1);
      return {
        img, sheet: sheet.index, side,
        // uv = o + sN*(ps-o) + tN*(pt-o)
        o, ds: [ps[0] - o[0], ps[1] - o[1]], dt: [pt[0] - o[0], pt[1] - o[1]],
      };
    };
    return { recto: face(rectoSide), verso: face(versoSide), sheet: sheet.index, part: label };
  }

  const leaves = [];
  if (layout === 'single') {
    for (const sh of sheets) leaves.push(makeLeaf(sh, upright(rects.whole), 'front', 'whole'));
  } else if (flipped) {
    // Fold (or cut and close like a book): the cover half faces the reader, the other
    // half is turned over onto the back. Folding mirrors across the split line.
    let coverF, backF, coverName, backName;
    if (split === 'vertical') {
      if (binding === 'left') { coverF = (s, t) => [W / 2 + s, t]; backF = (s, t) => [W / 2 - s, t]; coverName = 'right'; backName = 'left'; }
      else { coverF = (s, t) => [W / 2 - s, t]; backF = (s, t) => [W / 2 + s, t]; coverName = 'left'; backName = 'right'; }
    } else {
      if (binding === 'top') { coverF = (s, t) => [t, H / 2 - s]; backF = (s, t) => [t, H / 2 + s]; coverName = 'bottom'; backName = 'top'; }
      else { coverF = (s, t) => [t, H / 2 + s]; backF = (s, t) => [t, H / 2 - s]; coverName = 'top'; backName = 'bottom'; }
    }
    const n = layout === 'fold' && st.sheetsPerSignature > 0 ? st.sheetsPerSignature : sheets.length;
    for (let g = 0; g < sheets.length; g += n) {
      const sig = sheets.slice(g, g + n);
      const first = [], second = [];
      sig.forEach((sh) => {
        first.push(makeLeaf(sh, coverF, 'front', coverName + ' half'));
        second.unshift(makeLeaf(sh, backF, 'back', backName + ' half'));
      });
      for (const l of first) l.signature = g / n;
      for (const l of second) l.signature = g / n;
      leaves.push(...first, ...second);
    }
  } else {
    // Cut, both halves kept face up.
    const names = halfNames(split);
    const firstName = names.includes(st.cutFirst) ? st.cutFirst : names[0];
    const otherName = names.find((x) => x !== firstName);
    const A = upright(rects[firstName]), B = upright(rects[otherName]);
    if (st.cutOrder === 'sheet') {
      for (const sh of sheets) leaves.push(makeLeaf(sh, A, 'front', firstName + ' half'), makeLeaf(sh, B, 'front', otherName + ' half'));
    } else {
      for (const sh of sheets) leaves.push(makeLeaf(sh, A, 'front', firstName + ' half'));
      for (const sh of sheets) leaves.push(makeLeaf(sh, B, 'front', otherName + ' half'));
    }
  }
  // Separate cover: wrap the printed block in a cover leaf plus blank leaves, front and back.
  // These are not printed by this job, so their faces carry a label instead of an image.
  let extraLeaves = 0;
  if (st.cover === 'separate') {
    const blankLeaves = Math.max(0, Math.floor((coverBlanksOdd(st.coverBlanks) - 1) / 2));
    const front = [synthLeaf('Front cover', 'Inside front cover', 'cover')];
    const back = [synthLeaf('Inside back cover', 'Back cover', 'cover')];
    for (let i = 0; i < blankLeaves; i++) {
      front.push(synthLeaf('Blank', 'Blank', 'blank'));
      back.unshift(synthLeaf('Blank', 'Blank', 'blank'));
    }
    extraLeaves = front.length;
    leaves.unshift(...front);
    leaves.push(...back);
  }
  leaves.forEach((l, i) => (l.index = i));

  return { leaves, sheets, W, H, Ls, Lt, binding, layout, split, flipped, flipAxis, paper, settings: st, extraLeaves };
}

/** uv for normalized leaf coords */
export function faceUV(face, sN, tN) {
  return [face.o[0] + sN * face.ds[0] + tN * face.dt[0], face.o[1] + sN * face.ds[1] + tN * face.dt[1]];
}

/** Spread i shows verso of leaf i-1 and recto of leaf i. Spreads: 0..leaves.length */
export function spreadFaces(book, i) {
  const L = book.leaves;
  return { turned: i > 0 ? L[i - 1].verso : null, unturned: i < L.length ? L[i].recto : null };
}

/** Logical page number of a face (1-based) */
export function pageNumber(leafIndex, isVerso) { return leafIndex * 2 + (isVerso ? 2 : 1); }

/** Spine frame unit vectors in view coords: a = along spine, d = from spine into the leaf. */
export function spineFrame(binding) {
  switch (binding) {
    case 'right': return { a: [0, 1], d: [-1, 0] };
    case 'top': return { a: [1, 0], d: [0, -1] };
    case 'bottom': return { a: [1, 0], d: [0, 1] };
    default: return { a: [0, 1], d: [1, 0] };
  }
}

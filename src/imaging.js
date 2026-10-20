// Pure pixel operations on ImageData-like objects ({ width, height, data: RGBA bytes }).
// No DOM access here so the logic can be exercised outside the webview.
(function (exports) {
  'use strict';

  // Max per-channel deviation for a border pixel to count as "flat" background.
  // Screenshot backgrounds repeat the exact same color; dark photo edges only look flat.
  const FLAT = 2;

  const dist = (d, i, c) =>
    Math.max(Math.abs(d[i] - c[0]), Math.abs(d[i + 1] - c[1]), Math.abs(d[i + 2] - c[2]));

  function borderPixels(W, H) {
    const out = [];
    for (let x = 0; x < W; x++) out.push(x, (H - 1) * W + x);
    for (let y = 1; y < H - 1; y++) out.push(y * W, y * W + W - 1);
    return out;
  }

  // Most common opaque border color, or null when the border is already transparent.
  function borderColor(img) {
    const { width: W, height: H, data: d } = img;
    const border = borderPixels(W, H);
    const buckets = new Map();
    let transparent = 0;
    for (const p of border) {
      const i = p * 4;
      if (d[i + 3] < 250) { transparent++; continue; }
      const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      const b = buckets.get(key);
      if (b) { b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; }
      else buckets.set(key, { n: 1, r: d[i], g: d[i + 1], b: d[i + 2] });
    }
    if (transparent > border.length * 0.1) return null;
    let best = null;
    for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
    return best && { color: [best.r / best.n, best.g / best.n, best.b / best.n], border };
  }

  // Makes the solid background (the chat background captured in a screenshot,
  // white, ...) transparent. Mutates `img`. Returns false and leaves the image
  // untouched when the border is not mostly one flat color (photos, scenes).
  function removeBackground(img, tol) {
    const { width: W, height: H, data: d } = img;
    if (W < 3 || H < 3) return false;
    const found = borderColor(img);
    if (!found) return false;
    const { color: bg, border } = found;
    // Screenshot backgrounds are flat to within a few levels; textured photo
    // edges (curtains, sky gradients) are not, no matter how similar in hue.
    let flat = 0;
    for (const p of border) if (dist(d, p * 4, bg) <= FLAT) flat++;
    if (flat < border.length * 0.4) return false;

    const N = W * H;
    const isBg = new Uint8Array(N);
    const stack = new Int32Array(N);
    let sp = 0;
    const fill = (test) => {
      while (sp) {
        const p = stack[--sp];
        const x = p % W;
        const visit = (q) => { if (!isBg[q] && test(q)) { isBg[q] = 1; stack[sp++] = q; } };
        if (x > 0) visit(p - 1);
        if (x < W - 1) visit(p + 1);
        if (p >= W) visit(p - W);
        if (p < N - W) visit(p + W);
      }
    };

    // 1. Flood fill from the edges.
    const near = (q) => dist(d, q * 4, bg) <= tol;
    for (const p of border) if (!isBg[p] && near(p)) { isBg[p] = 1; stack[sp++] = p; }
    fill(near);

    // 2. Enclosed pockets (e.g. between an arm and the head). Only for a tinted
    //    background like KakaoTalk's blue: with white/gray it would eat eyes and teeth.
    const tinted = Math.max(...bg) - Math.min(...bg) >= 20;
    if (tinted) {
      const tight = (q) => dist(d, q * 4, bg) <= tol / 2;
      const seen = new Uint8Array(N);
      for (let p = 0; p < N; p++) {
        if (isBg[p] || seen[p] || !tight(p)) continue;
        const region = [p];
        seen[p] = 1;
        for (let k = 0; k < region.length; k++) {
          const q = region[k], x = q % W;
          const add = (r) => { if (!seen[r] && !isBg[r] && tight(r)) { seen[r] = 1; region.push(r); } };
          if (x > 0) add(q - 1);
          if (x < W - 1) add(q + 1);
          if (q >= W) add(q - W);
          if (q < N - W) add(q + W);
        }
        if (region.length >= 16) for (const q of region) isBg[q] = 1;
      }
    }

    let removed = 0;
    for (let p = 0; p < N; p++) removed += isBg[p];
    if (removed === N) return false;

    // 3. Anti-aliased rim: pixels touching the background are a blend of
    //    subject and background. Estimate alpha and un-blend the background color
    //    so no blue/white halo shows on a different chat background.
    const soft = tol * 3;
    for (let p = 0; p < N; p++) {
      if (isBg[p]) continue;
      const x = p % W;
      const rim = (x > 0 && isBg[p - 1]) || (x < W - 1 && isBg[p + 1]) ||
        (p >= W && isBg[p - W]) || (p < N - W && isBg[p + W]);
      if (!rim) continue;
      const i = p * 4;
      const dd = dist(d, i, bg);
      if (dd >= soft) continue;
      const a = Math.max(0.1, (dd - tol) / (soft - tol));
      for (let c = 0; c < 3; c++) {
        d[i + c] = Math.min(255, Math.max(0, Math.round((d[i + c] - (1 - a) * bg[c]) / a)));
      }
      d[i + 3] = Math.round(d[i + 3] * a);
    }
    for (let p = 0; p < N; p++) {
      if (isBg[p]) { const i = p * 4; d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
    }
    return true;
  }

  // Bounding box of non-transparent pixels, or null if fully transparent.
  function alphaBBox(img) {
    const { width: W, height: H, data: d } = img;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] === 0) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  // Placement of a w×h image centered in a size×size canvas with `pad`% margin per side.
  // Aspect ratio is always preserved (never stretched).
  function fitBox(w, h, size, pad) {
    const margin = Math.round(size * pad / 100);
    const box = Math.max(1, size - 2 * margin);
    const s = Math.min(box / w, box / h);
    const dw = Math.max(1, Math.round(w * s));
    const dh = Math.max(1, Math.round(h * s));
    return { x: Math.floor((size - dw) / 2), y: Math.floor((size - dh) / 2), w: dw, h: dh };
  }

  exports.removeBackground = removeBackground;
  exports.alphaBBox = alphaBBox;
  exports.fitBox = fitBox;
})(typeof module === 'object' ? module.exports : (window.imaging = {}));

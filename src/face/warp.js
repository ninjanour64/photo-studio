// Displacement field for reshaping. It is a backward map stored in image pixels on a coarse grid:
// output pixel x shows the source pixel x + D(x). Face sliders write `face`, the reshape brush
// writes `liq`, and the GPU samples their sum.

import * as L from './landmarks.js';

export class WarpField {
  constructor(W, H) {
    this.W = W; this.H = H;
    const long = 512;
    this.gw = W >= H ? long : Math.max(8, Math.round((long * W) / H));
    this.gh = H >= W ? long : Math.max(8, Math.round((long * H) / W));
    this.cx = W / this.gw; // image px per cell
    this.cy = H / this.gh;
    const n = this.gw * this.gh * 2;
    this.face = new Float32Array(n);
    this.liq = new Float32Array(n);
    this.out = new Float32Array(n);
  }

  combine() {
    const { face, liq, out } = this;
    for (let i = 0; i < out.length; i++) out[i] = face[i] + liq[i];
    return out;
  }

  // Bilinear sample of a field at image pixel (x, y).
  sample(field, x, y) {
    const { gw, gh } = this;
    const fx = Math.min(gw - 1, Math.max(0, x / this.cx - 0.5));
    const fy = Math.min(gh - 1, Math.max(0, y / this.cy - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const at = (xx, yy, c) => field[(yy * gw + xx) * 2 + c];
    const r = [0, 0];
    for (let c = 0; c < 2; c++) {
      const a = at(x0, y0, c) * (1 - tx) + at(x1, y0, c) * tx;
      const b = at(x0, y1, c) * (1 - tx) + at(x1, y1, c) * tx;
      r[c] = a * (1 - ty) + b * ty;
    }
    return r;
  }

  // Where in the original image the displayed (warped) pixel comes from.
  toSource(x, y) {
    const d = this.sample(this.out, x, y);
    return [x + d[0], y + d[1]];
  }

  // Visit grid cells within radius r of image point c: fn(index, dx, dy, k) with k the falloff.
  each(c, r, fn) {
    const { gw, gh, cx, cy } = this;
    const i0 = Math.max(0, Math.floor((c[0] - r) / cx)), i1 = Math.min(gw - 1, Math.ceil((c[0] + r) / cx));
    const j0 = Math.max(0, Math.floor((c[1] - r) / cy)), j1 = Math.min(gh - 1, Math.ceil((c[1] + r) / cy));
    const r2 = r * r;
    for (let j = j0; j <= j1; j++) {
      const y = (j + 0.5) * cy;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * cx;
        const dx = x - c[0], dy = y - c[1];
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const t = 1 - d2 / r2;
        fn((j * gw + i) * 2, dx, dy, t * t);
      }
    }
  }

  // Content near c moves by v.
  move(field, c, v, r) {
    this.each(c, r, (idx, dx, dy, k) => { field[idx] -= v[0] * k; field[idx + 1] -= v[1] * k; });
  }

  // Magnify (s > 0) or shrink (s < 0) around c; with `axis`, only along that direction.
  scale(field, c, s, r, axis = null) {
    this.each(c, r, (idx, dx, dy, k) => {
      if (axis) {
        const p = dx * axis[0] + dy * axis[1];
        field[idx] -= axis[0] * p * s * k; field[idx + 1] -= axis[1] * p * s * k;
      } else {
        field[idx] -= dx * s * k; field[idx + 1] -= dy * s * k;
      }
    });
  }

  // ---- face sliders ------------------------------------------------------------------------------

  // img (optional) lets the under-chin tuck stay on skin.
  setFaces(faces, shapes, img = null) {
    const f = this.face;
    f.fill(0);
    faces.forEach((P, i) => {
      const s = shapes[i];
      if (!s) return;
      const m = L.faceMetrics(P);
      const toward = (p, amount) => {
        // Unit vector from p toward the face's vertical axis (through the nose bridge).
        const axisPt = P[168];
        const side = Math.sign((p[0] - axisPt[0]) * m.right[0] + (p[1] - axisPt[1]) * m.right[1]) || 1;
        return L.mul(m.right, -side * amount);
      };
      const k = (v) => v / 100;

      if (s.slim) {
        for (const side of [L.CHEEK_L, L.CHEEK_R]) {
          side.forEach((idx, n) => {
            const w = 0.55 + 0.45 * Math.sin((n / (side.length - 1)) * Math.PI); // strongest mid-cheek
            this.move(f, P[idx], toward(P[idx], k(s.slim) * m.width * 0.028 * w), m.width * 0.26);
          });
        }
      }
      if (s.jaw) {
        for (const side of [L.JAW_L, L.JAW_R]) {
          for (const idx of side) this.move(f, P[idx], toward(P[idx], k(s.jaw) * m.width * 0.03), m.width * 0.17);
        }
      }
      if (s.chin) {
        const down = L.mul(m.up, -1);
        this.move(f, P[152], L.mul(down, k(s.chin) * m.height * 0.07), m.width * 0.3);
      }
      if (s.underChin > 0) this.tuckUnderChin(f, P, m, k(s.underChin), img);
      if (s.forehead) {
        for (const idx of [10, 109, 338]) this.move(f, P[idx], L.mul(m.up, k(s.forehead) * m.height * 0.035), m.width * 0.32);
      }
      if (s.eyes) {
        for (const c of [m.eyeL, m.eyeR]) this.scale(f, c, k(s.eyes) * 0.32, m.eyeW * 1.15);
      }
      if (s.noseSlim) {
        for (const idx of [64, 294, 98, 327]) this.move(f, P[idx], toward(P[idx], k(s.noseSlim) * m.noseW * 0.07), m.noseW * 0.55);
      }
      if (s.noseSmall) {
        const c = L.mid(P[4], P[6]);
        this.scale(f, c, -k(s.noseSmall) * 0.22, m.noseW * 1.15);
      }
      if (s.lips) {
        this.scale(f, m.mouth, k(s.lips) * 0.3, m.mouthW * 0.6, m.up);
      }
      if (s.smile) {
        for (const idx of [61, 291]) {
          const out = toward(P[idx], -1);
          const v = L.add(L.mul(m.up, 0.75), L.mul(out, 0.3));
          this.move(f, P[idx], L.mul(v, k(s.smile) * m.mouthW * 0.07), m.mouthW * 0.38);
        }
      }
    });
  }

  // Under-chin tuck: the band below the jaw line is pulled up toward the jaw. The jaw edge itself
  // stays put (no change to the face), the soft tissue just under it is compressed, and the neck
  // lower down is stretched slightly to fill, which reads as a firmer, single chin line.
  tuckUnderChin(f, P, m, amount, img) {
    const jaw = L.jawProfile(P, m);
    const depth = m.height * 0.3;             // how far down the neck the effect reaches
    const lift = amount * depth * 0.2;        // well under depth/π keeps the map fold-free
    const halfW = Math.max(Math.abs(jaw.u0), Math.abs(jaw.u1)) * 1.05;
    const { gw, gh, cx, cy } = this;
    // Bounding box of the affected area in image pixels.
    const corners = [];
    for (const u of [-halfW, halfW]) for (const v of [jaw.at(u) - 2, depth + 2]) {
      corners.push([jaw.origin[0] + m.right[0] * u + jaw.down[0] * v, jaw.origin[1] + m.right[1] * u + jaw.down[1] * v]);
    }
    corners.push([jaw.origin[0] + jaw.down[0] * (depth + jaw.at(0)), jaw.origin[1] + jaw.down[1] * (depth + jaw.at(0))]);
    const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor(Math.min(...xs) / cx) - 1), i1 = Math.min(gw - 1, Math.ceil(Math.max(...xs) / cx) + 1);
    const j0 = Math.max(0, Math.floor(Math.min(...ys) / cy) - 1), j1 = Math.min(gh - 1, Math.ceil(Math.max(...ys) / cy) + 1);
    // Skin weight per cell, blurred so the field stays smooth (no tearing at a collar edge).
    const bw = i1 - i0 + 1, bh = j1 - j0 + 1;
    let skinW = null;
    if (img && bw > 0 && bh > 0) {
      const skin = L.sampleSkin(img, P, m);
      skinW = new Float32Array(bw * bh);
      for (let j = 0; j < bh; j++) {
        for (let i = 0; i < bw; i++) {
          const x = Math.min(img.width - 1, Math.floor((i0 + i + 0.5) * cx)), y = Math.min(img.height - 1, Math.floor((j0 + j + 0.5) * cy));
          const k = (y * img.width + x) * 4;
          skinW[j * bw + i] = L.skinLikeness(img.data[k], img.data[k + 1], img.data[k + 2], skin);
        }
      }
      const rad = Math.max(1, Math.round((m.width * 0.04) / cx));
      skinW = blurField(blurField(skinW, bw, bh, rad), bw, bh, rad);
    }
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5) * cx - jaw.origin[0], dy = (j + 0.5) * cy - jaw.origin[1];
        const u = dx * m.right[0] + dy * m.right[1];
        const v = dx * jaw.down[0] + dy * jaw.down[1];
        const t = v - jaw.at(u);
        if (t <= 0 || t >= depth || Math.abs(u) >= halfW) continue;
        const across = 1 - (u / halfW) ** 2;
        const w = across * across * (skinW ? Math.min(1, skinW[(j - j0) * bw + (i - i0)] * 1.4) : 1);
        // Sample from further down (content moves up): strongest in the upper part of the band.
        const q = t / depth;
        const g = lift * w * 6.75 * q * (1 - q) * (1 - q);
        const idx = (j * gw + i) * 2;
        f[idx] += jaw.down[0] * g;
        f[idx + 1] += jaw.down[1] * g;
      }
    }
  }

  // ---- reshape brush -----------------------------------------------------------------------------

  push(from, to, r, strength) {
    const old = this.liq.slice();
    const d = [(to[0] - from[0]) * strength, (to[1] - from[1]) * strength];
    this.each(to, r, (idx, dx, dy, k) => {
      const x = to[0] + dx, y = to[1] + dy;
      const back = this.sample(old, x - d[0] * k, y - d[1] * k);
      this.liq[idx] = -d[0] * k + back[0];
      this.liq[idx + 1] = -d[1] * k + back[1];
    });
  }

  restore(c, r, strength) {
    this.each(c, r, (idx, dx, dy, k) => {
      const f = 1 - k * strength;
      this.liq[idx] *= f; this.liq[idx + 1] *= f;
    });
  }
}

// Separable box blur of a scalar field (used to smooth weights).
function blurField(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; } }
      tmp[y * w + x] = s / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; } }
      out[y * w + x] = s / n;
    }
  }
  return out;
}

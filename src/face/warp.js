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

  setFaces(faces, shapes) {
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

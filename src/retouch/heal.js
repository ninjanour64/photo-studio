// Healing: copy texture from the best-matching nearby patch, then fix its colour/lighting with a
// membrane (harmonic) correction so the patch meets the surroundings seamlessly — the same idea
// as a Poisson "healing brush". Also: automatic blemish finding on detected skin.

const LUM = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;

// img: {data: Uint8ClampedArray, width, height}. region: {x0, y0, w, h, mask: Uint8Array w*h (1 = fix)}.
// allowed(x, y) → may this pixel be used as a source. Returns {x, y, w, h, before, after} or null.
export function heal(img, region, allowed = null) {
  const { width: W, height: H, data } = img;
  const pad = 4;
  const rx0 = Math.max(0, region.x0 - pad), ry0 = Math.max(0, region.y0 - pad);
  const rx1 = Math.min(W, region.x0 + region.w + pad), ry1 = Math.min(H, region.y0 + region.h + pad);
  const w = rx1 - rx0, h = ry1 - ry0;
  if (w < 3 || h < 3) return null;

  // Target mask in the padded rect, dilated by one pixel so the seam lands on clean skin.
  const raw = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < region.h; y++) {
    for (let x = 0; x < region.w; x++) {
      if (!region.mask[y * region.w + x]) continue;
      const X = region.x0 + x - rx0, Y = region.y0 + y - ry0;
      if (X >= 0 && Y >= 0 && X < w && Y < h) { raw[Y * w + X] = 1; count++; }
    }
  }
  if (!count) return null;
  const om = dilate(raw, w, h, 1);
  // Keep the outermost ring outside the mask so the Dirichlet boundary always exists.
  for (let x = 0; x < w; x++) { om[x] = 0; om[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { om[y * w] = 0; om[y * w + w - 1] = 0; }

  // Comparison band: a ring just outside the mask.
  const outer = dilate(om, w, h, 3);
  const band = [];
  for (let i = 0; i < w * h; i++) if (outer[i] && !om[i]) band.push(i);
  const inside = [];
  for (let i = 0; i < w * h; i++) if (om[i]) inside.push(i);

  const best = findSource(img, rx0, ry0, w, h, om, band, inside, allowed);
  if (!best) return null;
  const [ox, oy] = best;

  // Membrane: F = target - source on the boundary, harmonic inside.
  const before = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) before.set(data.subarray(((ry0 + y) * W + rx0) * 4, ((ry0 + y) * W + rx0 + w) * 4), y * w * 4);
  const after = before.slice();
  const F = new Float32Array(w * h);
  const known = new Uint8Array(w * h);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (om[i]) { known[i] = 0; continue; }
        const si = ((ry0 + y + oy) * W + rx0 + x + ox) * 4;
        F[i] = before[i * 4 + c] - data[si + c];
        known[i] = 1;
      }
    }
    pushPull(F, known, w, h);
    sor(F, om, w, h, Math.min(160, Math.max(20, Math.round(Math.max(w, h) * 0.6))));
    for (const i of inside) {
      const x = i % w, y = (i / w) | 0;
      const si = ((ry0 + y + oy) * W + rx0 + x + ox) * 4;
      after[i * 4 + c] = data[si + c] + F[i];
    }
  }
  for (let y = 0; y < h; y++) data.set(after.subarray(y * w * 4, (y + 1) * w * 4), ((ry0 + y) * W + rx0) * 4);
  return { x: rx0, y: ry0, w, h, before, after };
}

export function putRect(img, r, pixels) {
  const { width: W, data } = img;
  for (let y = 0; y < r.h; y++) data.set(pixels.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * W + r.x) * 4);
}

function dilate(m, w, h, r) {
  let cur = m;
  for (let k = 0; k < r; k++) {
    const nx = cur.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) nx[i] = 1;
      }
    }
    cur = nx;
  }
  return cur;
}

// Search rings of candidate offsets; score by how well the source's surroundings match the
// target's surroundings, and how similar its texture energy is.
function findSource(img, rx0, ry0, w, h, om, band, inside, allowed) {
  const { width: W, height: H, data } = img;
  const size = Math.max(w, h);
  const ringVar = variance(img, rx0, ry0, w, band, 0, 0);
  const stride = Math.max(2, Math.round(size / 6));
  const ringEdge = edgeEnergy(img, rx0, ry0, w, band, 0, 0, stride);
  let best = null, bestCost = Infinity;
  const stepB = Math.max(1, Math.floor(band.length / 400));
  const stepI = Math.max(1, Math.floor(inside.length / 300));
  for (const dist of [0.75, 1.0, 1.35, 1.8, 2.5]) {
    const n = 24;
    for (let a = 0; a < n; a++) {
      const ang = (a / n) * Math.PI * 2 + dist;
      const ox = Math.round(Math.cos(ang) * size * dist), oy = Math.round(Math.sin(ang) * size * dist);
      if (rx0 + ox < 0 || ry0 + oy < 0 || rx0 + ox + w > W || ry0 + oy + h > H) continue;
      // The source must not overlap the area being fixed and must be allowed (e.g. skin).
      let bad = 0;
      for (let k = 0; k < inside.length; k += stepI) {
        const i = inside[k];
        const x = i % w, y = (i / w) | 0;
        const sx = x + ox, sy = y + oy;
        if (sx >= 0 && sy >= 0 && sx < w && sy < h && om[sy * w + sx]) bad++;
        else if (allowed && !allowed(rx0 + sx, ry0 + sy)) bad++;
      }
      if (bad > inside.length / stepI * 0.05) continue;
      // Boundary match after removing the mean offset: the membrane fixes overall colour and
      // lighting differences, so only the boundary's shape needs to agree.
      let sum = 0, sum2 = 0, nb = 0;
      for (let k = 0; k < band.length; k += stepB) {
        const i = band[k];
        const x = i % w, y = (i / w) | 0;
        const ti = ((ry0 + y) * W + rx0 + x) * 4, si = ti + (oy * W + ox) * 4;
        for (let c = 0; c < 3; c++) { const d = data[ti + c] - data[si + c]; sum += d; sum2 += d * d; }
        nb += 3;
      }
      const mean = sum / nb;
      let cost = (sum2 / nb - mean * mean) * 1.5;
      // Reject sources carrying structure (a nostril, an eyelid, a hair edge) the surroundings
      // don't have: that is what makes a heal look like a pasted patch.
      const v = variance(img, rx0, ry0, w, inside, ox, oy);
      const e = edgeEnergy(img, rx0, ry0, w, inside, ox, oy, stride);
      const extra = Math.max(0, e - ringEdge * 1.1 - 1);
      cost += extra * extra * 40 + e * e * 1.2 + Math.abs(v - ringVar) * 6 + dist * 6;
      if (cost < bestCost) { bestCost = cost; best = [ox, oy]; }
    }
  }
  return best;
}

// Mean luminance difference (0..255 units) across `d` pixels, over a pixel set shifted by
// (ox, oy). Using a stride tied to the patch size catches soft shadows, not just fine texture.
function edgeEnergy(img, rx0, ry0, w, idx, ox, oy, d) {
  const { width: W, height: H, data } = img;
  let s = 0, n = 0;
  const step = Math.max(1, Math.floor(idx.length / 400));
  for (let k = 0; k < idx.length; k += step) {
    const i = idx[k];
    const X = rx0 + (i % w) + ox, Y = ry0 + ((i / w) | 0) + oy;
    if (X < 0 || Y < 0 || X >= W - d || Y >= H - d) continue;
    const p = (Y * W + X) * 4;
    const l = LUM(data, p);
    s += (Math.abs(LUM(data, p + 4 * d) - l) + Math.abs(LUM(data, p + W * 4 * d) - l)) * 255;
    n++;
  }
  return n ? s / n : 0;
}

function variance(img, rx0, ry0, w, idx, ox, oy) {
  const { width: W, data } = img;
  let s = 0, s2 = 0, n = 0;
  const step = Math.max(1, Math.floor(idx.length / 300));
  for (let k = 0; k < idx.length; k += step) {
    const i = idx[k];
    const x = i % w, y = (i / w) | 0;
    const l = LUM(data, ((ry0 + y + oy) * W + rx0 + x + ox) * 4) * 255;
    s += l; s2 += l * l; n++;
  }
  if (!n) return 0;
  const m = s / n;
  return Math.sqrt(Math.max(0, s2 / n - m * m));
}

// Fast smooth fill of unknown values from known ones (push-pull pyramid).
function pushPull(v, known, w, h) {
  if (w <= 1 && h <= 1) return;
  const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
  const cv = new Float32Array(cw * ch), ck = new Uint8Array(cw * ch);
  const cwt = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!known[i]) continue;
      const j = (y >> 1) * cw + (x >> 1);
      cv[j] += v[i]; cwt[j] += 1;
    }
  }
  let all = true;
  for (let j = 0; j < cv.length; j++) {
    if (cwt[j] > 0) { cv[j] /= cwt[j]; ck[j] = 1; } else all = false;
  }
  if (!all) pushPull(cv, ck, cw, ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      // Bilinear from the coarse level.
      const fx = Math.min(cw - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(ch - 1, Math.max(0, (y - 0.5) / 2));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(cw - 1, x0 + 1), y1 = Math.min(ch - 1, y0 + 1);
      const tx = fx - x0, ty = fy - y0;
      v[i] = (cv[y0 * cw + x0] * (1 - tx) + cv[y0 * cw + x1] * tx) * (1 - ty) + (cv[y1 * cw + x0] * (1 - tx) + cv[y1 * cw + x1] * tx) * ty;
    }
  }
}

// Successive over-relaxation of Laplace's equation inside the mask.
function sor(F, om, w, h, iters) {
  const omega = 1.85;
  for (let it = 0; it < iters; it++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!om[i]) continue;
        const avg = (F[i - 1] + F[i + 1] + F[i - w] + F[i + w]) * 0.25;
        F[i] += omega * (avg - F[i]);
      }
    }
  }
}

// ---- automatic blemishes -----------------------------------------------------------------------

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / n;
      s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

// skin: {x0, y0, w, h, mask (1 = skin), faceW}. Returns full-res heal regions.
export function findBlemishes(img, skin, sensitivity = 1) {
  const { width: W, data } = img;
  const f = Math.max(1, skin.faceW / 420); // analyse at ~420px face width
  const w = Math.max(1, Math.floor(skin.w / f)), h = Math.max(1, Math.floor(skin.h / f));
  const lum = new Float32Array(w * h), red = new Float32Array(w * h), m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(skin.w - 1, Math.floor((x + 0.5) * f)), sy = Math.min(skin.h - 1, Math.floor((y + 0.5) * f));
      const di = ((skin.y0 + sy) * W + skin.x0 + sx) * 4;
      const i = y * w + x;
      lum[i] = LUM(data, di);
      red[i] = (data[di] - (data[di + 1] + data[di + 2]) / 2) / 255;
      m[i] = skin.mask[sy * skin.w + sx];
    }
  }
  const fw = skin.faceW / f;
  const r = Math.max(2, Math.round(fw * 0.03));
  let lb = boxBlur(boxBlur(lum, w, h, r), w, h, r);
  let rb = boxBlur(boxBlur(red, w, h, r), w, h, r);
  const score = new Float32Array(w * h);
  let s = 0, s2 = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!m[i]) continue;
    const v = Math.max(0, lb[i] - lum[i]) + Math.max(0, red[i] - rb[i]) * 0.9;
    score[i] = v;
    s += v; s2 += v * v; n++;
  }
  if (n < 100) return [];
  const mean = s / n, sd = Math.sqrt(Math.max(1e-8, s2 / n - mean * mean));
  const hiT = Math.max(0.032 / sensitivity, mean + 3.2 * sd / sensitivity);
  const loT = hiT * 0.55;

  const seen = new Uint8Array(w * h);
  const minA = Math.max(2, (fw * 0.004) ** 2), maxA = Math.PI * (fw * 0.03) ** 2;
  const blobs = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || !m[i] || score[i] < hiT) continue;
    const pix = [];
    let peak = 0, touchesEdge = false;
    stack.push(i); seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      pix.push(j);
      peak = Math.max(peak, score[j]);
      const x = j % w, y = (j / w) | 0;
      for (const k of [j - 1, j + 1, j - w, j + w]) {
        if (k < 0 || k >= w * h || seen[k]) continue;
        if ((k === j - 1 && x === 0) || (k === j + 1 && x === w - 1)) continue;
        if (!m[k]) { touchesEdge = true; continue; }
        if (score[k] >= loT) { seen[k] = 1; stack.push(k); }
      }
      if (pix.length > maxA * 2) break;
    }
    if (touchesEdge || pix.length < minA || pix.length > maxA) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (const j of pix) { const x = j % w, y = (j / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.max(bw, bh) / Math.min(bw, bh) > 3) continue; // lines: wrinkles, hair, lashes
    if (pix.length / (bw * bh) < 0.3) continue;
    blobs.push({ pix, x0, y0, bw, bh, peak });
  }
  blobs.sort((a, b) => b.peak - a.peak);

  // Map each blob back to full resolution, grown a little to cover its soft edge.
  const grow = Math.max(1, Math.round(skin.faceW * 0.004));
  return blobs.slice(0, 60).map((b) => {
    const X0 = skin.x0 + Math.floor(b.x0 * f) - grow, Y0 = skin.y0 + Math.floor(b.y0 * f) - grow;
    const rw = Math.ceil(b.bw * f) + grow * 2, rh = Math.ceil(b.bh * f) + grow * 2;
    const small = new Uint8Array(b.bw * b.bh);
    for (const j of b.pix) small[((j / w | 0) - b.y0) * b.bw + (j % w) - b.x0] = 1;
    const mask = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        // Distance test against the blob in small space with a grow margin.
        const sx = (x - grow) / f, sy = (y - grow) / f;
        const g = grow / f + 0.5;
        let hit = 0;
        for (let yy = Math.max(0, Math.floor(sy - g)); yy <= Math.min(b.bh - 1, Math.ceil(sy + g)) && !hit; yy++) {
          for (let xx = Math.max(0, Math.floor(sx - g)); xx <= Math.min(b.bw - 1, Math.ceil(sx + g)); xx++) {
            if (small[yy * b.bw + xx] && Math.hypot(xx + 0.5 - sx, yy + 0.5 - sy) <= g + 0.5) { hit = 1; break; }
          }
        }
        mask[y * rw + x] = hit;
      }
    }
    return { x0: X0, y0: Y0, w: rw, h: rh, mask };
  });
}

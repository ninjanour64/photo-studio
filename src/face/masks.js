// Rasterises feature masks from face landmarks.
//   mask A (wide feather):  R skin, G under-eye crescent, B whole face, A under-chin/neck
//   mask B (tight feather): R teeth, G eyes, B irises, A lips

import * as L from './landmarks.js';

function layer(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineJoin = ctx.lineCap = 'round';
  return { c, ctx };
}

function path(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
}

// Smooth closed curve through points (Catmull-Rom → Bézier), nicer than a polygon for contours.
function curve(ctx, pts) {
  const n = pts.length;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
  }
  ctx.closePath();
}

const pick = (P, idx, s) => idx.map((i) => [P[i][0] * s, P[i][1] * s]);

// Crescent under the lower lid: the lid line plus the same line pushed down by a bulge.
function underEye(P, lower, m, s) {
  const lid = pick(P, lower, s);
  const down = L.mul(m.up, -1);
  const depth = m.eyeW * s * 0.55;
  const bottom = lid.map((p, i) => {
    const t = i / (lid.length - 1);
    const k = Math.sin(Math.PI * t) ** 0.8;
    return [p[0] + down[0] * depth * k + down[0] * depth * 0.12, p[1] + down[1] * depth * k + down[1] * depth * 0.12];
  });
  return [...lid, ...bottom.reverse()];
}

// Draws one face's features into the given layers. `s` scales image px to mask px.
function drawFace(P, s, ly) {
  const m = L.faceMetrics(P);
  const fw = m.width * s;

  // Skin: face oval minus eyes, brows and lips (each dilated a little).
  const sk = ly.skin.ctx;
  sk.globalCompositeOperation = 'source-over';
  curve(sk, pick(P, L.FACE_OVAL, s));
  sk.fill();
  sk.globalCompositeOperation = 'destination-out';
  for (const eye of [L.EYE_L, L.EYE_R]) {
    path(sk, pick(P, eye, s));
    sk.lineWidth = fw * 0.06;
    sk.fill(); sk.stroke();
  }
  for (const brow of [L.BROW_L, L.BROW_R]) {
    path(sk, pick(P, brow, s));
    sk.lineWidth = fw * 0.035;
    sk.fill(); sk.stroke();
  }
  path(sk, pick(P, L.LIPS_OUTER, s));
  sk.lineWidth = fw * 0.025;
  sk.fill(); sk.stroke();
  sk.globalCompositeOperation = 'source-over';

  // Under-eye crescents, minus the eyes themselves.
  const ue = ly.under.ctx;
  ue.globalCompositeOperation = 'source-over';
  path(ue, underEye(P, L.EYE_L_LOWER, m, s)); ue.fill();
  path(ue, underEye(P, L.EYE_R_LOWER, m, s)); ue.fill();
  ue.globalCompositeOperation = 'destination-out';
  for (const eye of [L.EYE_L, L.EYE_R]) {
    path(ue, pick(P, eye, s));
    ue.lineWidth = fw * 0.02;
    ue.fill(); ue.stroke();
  }
  ue.globalCompositeOperation = 'source-over';

  // Under the chin: a band starting a little below the jaw line (so the jaw's defining shadow is
  // kept) and reaching down the neck, deepest under the chin and tapering at the jaw corners.
  {
    const jaw = L.jawProfile(P, m);
    const depth = m.height * 0.36;
    const halfW = Math.max(Math.abs(jaw.u0), Math.abs(jaw.u1));
    const toImg = (u, v) => [(jaw.origin[0] + m.right[0] * u + jaw.down[0] * v) * s, (jaw.origin[1] + m.right[1] * u + jaw.down[1] * v) * s];
    const top = [], bottom = [];
    for (let k = 0; k <= 16; k++) {
      const u = -halfW * 0.92 + (k / 16) * halfW * 1.84;
      const taper = Math.cos((u / halfW) * Math.PI * 0.5);
      top.push(toImg(u, jaw.at(u) + depth * 0.07));
      bottom.push(toImg(u, jaw.at(u) + depth * (0.25 + 0.75 * taper)));
    }
    path(ly.chin.ctx, [...top, ...bottom.reverse()]);
    ly.chin.ctx.fill();
  }

  curve(ly.face.ctx, pick(P, L.FACE_OVAL, s));
  ly.face.ctx.fill();

  path(ly.teeth.ctx, pick(P, L.LIPS_INNER, s));
  ly.teeth.ctx.fill();

  for (const eye of [L.EYE_L, L.EYE_R]) {
    path(ly.eyes.ctx, pick(P, eye, s));
    ly.eyes.ctx.fill();
  }

  // Irises: circles clipped to the eye opening.
  const ir = ly.iris.ctx;
  for (const [eye, iris] of [[L.EYE_L, L.IRIS_L], [L.EYE_R, L.IRIS_R]]) {
    const c = P[iris.c];
    const r = iris.ring.reduce((a, i) => a + L.len(L.sub(P[i], c)), 0) / iris.ring.length;
    ir.save();
    path(ir, pick(P, eye, s));
    ir.clip();
    ir.beginPath();
    ir.arc(c[0] * s, c[1] * s, r * s * 0.95, 0, Math.PI * 2);
    ir.fill();
    // Pupil stays dark and untinted.
    ir.globalCompositeOperation = 'destination-out';
    ir.beginPath();
    ir.arc(c[0] * s, c[1] * s, r * s * 0.32, 0, Math.PI * 2);
    ir.fill();
    ir.restore();
  }

  const lp = ly.lips.ctx;
  path(lp, pick(P, L.LIPS_OUTER, s));
  lp.fill();
  lp.globalCompositeOperation = 'destination-out';
  path(lp, pick(P, L.LIPS_INNER, s));
  lp.fill();
  lp.globalCompositeOperation = 'source-over';
  return m;
}

function pack(layers, w, h) {
  const out = new Uint8Array(w * h * 4);
  layers.forEach((ly, ch) => {
    if (!ly) return;
    const d = ly.ctx.getImageData(0, 0, w, h).data;
    for (let i = 0, j = ch; i < d.length; i += 4, j += 4) out[j] = d[i + 3];
  });
  return out;
}

// faces: array of pixel-landmark arrays (image px). Returns packed masks + feather sizes.
export function buildMasks(faces, W, H, mW, mH) {
  const s = mW / W;
  const ly = {};
  for (const k of ['skin', 'under', 'face', 'chin', 'teeth', 'eyes', 'iris', 'lips']) ly[k] = layer(mW, mH);
  let fw = 0;
  for (const P of faces) fw = Math.max(fw, drawFace(P, s, ly).width * s);
  return {
    a: pack([ly.skin, ly.under, ly.face, ly.chin], mW, mH),
    b: pack([ly.teeth, ly.eyes, ly.iris, ly.lips], mW, mH),
    sigmaA: Math.max(1, fw * 0.022),
    sigmaB: Math.max(0.6, fw * 0.004),
  };
}

// Full-resolution skin mask for one face (inside its bounding box), for blemish detection.
// Features are dilated generously so moles near eyes/lips and nostril shadows aren't touched.
export function skinMaskForFace(P, W, H) {
  const m = L.faceMetrics(P);
  const pad = m.width * 0.05;
  const x0 = Math.max(0, Math.floor(m.box.x0 - pad)), y0 = Math.max(0, Math.floor(m.box.y0 - pad));
  const x1 = Math.min(W, Math.ceil(m.box.x1 + pad)), y1 = Math.min(H, Math.ceil(m.box.y1 + pad));
  const w = x1 - x0, h = y1 - y0;
  const { ctx } = layer(w, h);
  ctx.translate(-x0, -y0);
  const fw = m.width;
  // Shrink the oval inward (hairline, jaw shadow) by stroking its edge out.
  curve(ctx, pick(P, L.FACE_OVAL, 1));
  ctx.fill();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = fw * 0.09;
  curve(ctx, pick(P, L.FACE_OVAL, 1));
  ctx.stroke();
  for (const [poly, wd] of [[L.EYE_L, 0.16], [L.EYE_R, 0.16], [L.BROW_L, 0.09], [L.BROW_R, 0.09], [L.LIPS_OUTER, 0.08]]) {
    path(ctx, pick(P, poly, 1));
    ctx.lineWidth = fw * wd;
    ctx.fill(); ctx.stroke();
  }
  // Nose wings/nostrils.
  ctx.beginPath();
  path(ctx, pick(P, [64, 98, 97, 2, 326, 327, 294, 278, 4, 48], 1));
  ctx.lineWidth = fw * 0.07;
  ctx.fill(); ctx.stroke();
  const d = ctx.getImageData(0, 0, w, h).data;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = d[i * 4 + 3] > 128 ? 1 : 0;
  return { x0, y0, w, h, mask, faceW: fw };
}

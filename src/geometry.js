// Crop/rotate/flip and view (zoom/pan) maths.
//
// "Frame" space is the image rotated by θ = rot·90° + straighten and flipped, centred on the
// origin, measured in image pixels. The crop rectangle lives in frame space. Affines are
// [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f.

export const ASPECTS = [
  { id: 'original', label: 'Original' },
  { id: 'free', label: 'Free' },
  { id: '1:1', label: 'Square', v: 1 },
  { id: '4:5', label: '4:5', v: 4 / 5 },
  { id: '9:16', label: 'Story', v: 9 / 16 },
  { id: '16:9', label: '16:9', v: 16 / 9 },
  { id: '3:2', label: '3:2', v: 3 / 2 },
  { id: '2:3', label: '2:3', v: 2 / 3 },
];

export const mulA = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const invA = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
};
export const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
const T = (x, y) => [1, 0, 0, 1, x, y];
const Sc = (x, y = x) => [x, 0, 0, y, 0, 0];
const R = (t) => [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0];

export function angleOf(crop) {
  return ((crop.rot * 90 + crop.straighten) * Math.PI) / 180;
}

// Image px -> frame.
export function imageToFrame(crop, W, H) {
  const F = Sc(crop.flipH ? -1 : 1, crop.flipV ? -1 : 1);
  return mulA(R(angleOf(crop)), mulA(F, T(-W / 2, -H / 2)));
}

export function frameExtents(crop, W, H) {
  const t = angleOf(crop);
  const c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
  return { ex: (c * W + s * H) / 2, ey: (s * W + c * H) / 2 };
}

export function aspectValue(crop, W, H) {
  if (crop.aspect === 'free') return null;
  if (crop.aspect === 'original') return crop.rot % 2 ? H / W : W / H;
  return ASPECTS.find((a) => a.id === crop.aspect)?.v ?? null;
}

// Largest rect of aspect a centred in the straightened image.
export function fitRect(crop, W, H, aspect = aspectValue(crop, W, H)) {
  const Wr = crop.rot % 2 ? H : W, Hr = crop.rot % 2 ? W : H;
  const phi = (crop.straighten * Math.PI) / 180;
  const c = Math.abs(Math.cos(phi)), s = Math.abs(Math.sin(phi));
  const a = aspect ?? Wr / Hr;
  const w = Math.min(Wr / (c + s / a), Hr / (s + c / a));
  const h = w / a;
  return { x: -w / 2, y: -h / 2, w, h };
}

export const cropRect = (crop, W, H) => crop.rect || fitRect(crop, W, H);

export function rectInside(crop, W, H, r) {
  const inv = invA(imageToFrame(crop, W, H));
  const eps = 0.75;
  for (const p of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]]) {
    const q = apply(inv, p);
    if (q[0] < -eps || q[1] < -eps || q[0] > W + eps || q[1] > H + eps) return false;
  }
  return r.w > 8 && r.h > 8;
}

// The region shown: the crop, or (while cropping) the whole rotated image.
export function outputRegion(crop, W, H, cropping) {
  if (cropping) {
    const { ex, ey } = frameExtents(crop, W, H);
    return { x: -ex, y: -ey, w: ex * 2, h: ey * 2 };
  }
  return cropRect(crop, W, H);
}

// Builds the shader frame for a target of size (vw, vh) device px.
// view: {zoom (device px per frame px) | null for fit, cx, cy (frame point at view centre)}
export function makeFrame({ crop, W, H, vw, vh, view, cropping, pad = 24 }) {
  const region = outputRegion(crop, W, H, cropping);
  const fitZoom = Math.min((vw - pad * 2) / region.w, (vh - pad * 2) / region.h);
  const zoom = view?.zoom ?? fitZoom;
  const cx = view?.zoom ? view.cx : region.x + region.w / 2;
  const cy = view?.zoom ? view.cy : region.y + region.h / 2;
  const screenToFrame = mulA(T(cx, cy), mulA(Sc(1 / zoom), T(-vw / 2, -vh / 2)));
  return buildFrame(crop, W, H, screenToFrame, cropRect(crop, W, H), 1 / zoom, { zoom, fitZoom, cx, cy, region });
}

// Export: output pixel q maps straight onto the crop rect.
export function exportFrame(crop, W, H, outW, outH) {
  const r = cropRect(crop, W, H);
  const k = r.w / outW;
  const screenToFrame = mulA(T(r.x, r.y), Sc(k, r.h / outH));
  return buildFrame(crop, W, H, screenToFrame, r, k, {});
}

function buildFrame(crop, W, H, screenToFrame, rect, pxScale, extra) {
  const frameToImg = invA(imageToFrame(crop, W, H));
  const toImgPx = mulA(frameToImg, screenToFrame);
  const toImg = mulA(Sc(1 / W, 1 / H), toImgPx);
  const toCrop = mulA(Sc(1 / rect.w, 1 / rect.h), mulA(T(-rect.x, -rect.y), screenToFrame));
  return { toImg, toImgPx, toCrop, screenToFrame, cropPx: [rect.w, rect.h], pxScale, rect, ...extra };
}

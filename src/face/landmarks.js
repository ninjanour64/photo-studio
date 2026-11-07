// MediaPipe Face Mesh (478 points, with irises) index sets used for masks and reshaping.
// "Left/right" below are image-left/right (the subject's right/left).

export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

// Eye contours: outer corner, lower lid to inner corner, then upper lid back.
export const EYE_L = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const EYE_R = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
export const EYE_L_LOWER = [33, 7, 163, 144, 145, 153, 154, 155, 133];
export const EYE_R_LOWER = [263, 249, 390, 373, 374, 380, 381, 382, 362];
export const BROW_L = [46, 53, 52, 65, 55, 107, 66, 105, 63, 70];
export const BROW_R = [276, 283, 282, 295, 285, 336, 296, 334, 293, 300];
export const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
export const IRIS_L = { c: 468, ring: [469, 470, 471, 472] };
export const IRIS_R = { c: 473, ring: [474, 475, 476, 477] };

// Cheek/jaw contour points per side (top to bottom), used by "slim face" and "jawline".
export const CHEEK_L = [234, 93, 132, 58, 172, 136, 150];
export const CHEEK_R = [454, 323, 361, 288, 397, 365, 379];
export const JAW_L = [172, 136, 150, 149];
export const JAW_R = [397, 365, 379, 378];

// Landmarks are normalised; convert a face to pixel points once.
export function toPixels(lm, W, H) {
  return lm.map((p) => [p.x * W, p.y * H]);
}

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a, s) => [a[0] * s, a[1] * s];
export const len = (a) => Math.hypot(a[0], a[1]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const centroid = (pts) => {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
};

// Orientation and scale of a face in pixels.
export function faceMetrics(P) {
  const up = norm(sub(P[10], P[152]));
  const right = norm(sub(P[454], P[234]));
  const width = len(sub(P[454], P[234]));
  const height = len(sub(P[10], P[152]));
  const xs = FACE_OVAL.map((i) => P[i][0]);
  const ys = FACE_OVAL.map((i) => P[i][1]);
  const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  return {
    up, right, width, height, box,
    center: mid(P[234], P[454]),
    eyeL: centroid(EYE_L.map((i) => P[i])),
    eyeR: centroid(EYE_R.map((i) => P[i])),
    eyeW: (len(sub(P[33], P[133])) + len(sub(P[263], P[362]))) / 2,
    nose: P[4],
    noseW: len(sub(P[64], P[294])),
    mouth: mid(P[13], P[14]),
    mouthW: len(sub(P[61], P[291])),
  };
}

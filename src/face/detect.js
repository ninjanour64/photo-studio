// On-device face landmarks and person segmentation (MediaPipe Tasks, WASM on the CPU).
// Everything is served locally from /wasm and /models, so photos never leave the browser.

import { FilesetResolver, FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL;
let filesetP = null;
let landmarkerP = null;
let segmenterP = null;

const fileset = () => (filesetP ??= FilesetResolver.forVisionTasks(new URL(BASE + 'wasm', location.href).href));

function landmarker() {
  return (landmarkerP ??= fileset().then((fs) => FaceLandmarker.createFromOptions(fs, {
    baseOptions: { modelAssetPath: BASE + 'models/face_landmarker.task', delegate: 'CPU' },
    runningMode: 'IMAGE',
    numFaces: 8,
    minFaceDetectionConfidence: 0.4,
    minFacePresenceConfidence: 0.4,
  })));
}

function segmenter() {
  return (segmenterP ??= fileset().then((fs) => ImageSegmenter.createFromOptions(fs, {
    baseOptions: { modelAssetPath: BASE + 'models/selfie_segmenter.tflite', delegate: 'CPU' },
    runningMode: 'IMAGE',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  })));
}

export const preload = () => Promise.allSettled([landmarker(), segmenter()]);

const faceCenter = (lm) => {
  let x = 0, y = 0;
  for (const p of lm) { x += p.x; y += p.y; }
  return [x / lm.length, y / lm.length];
};

// The landmarker's detector is tuned for faces that fill a good part of the frame. If the whole
// photo finds nothing (group shots, full-body shots), retry on overlapping tiles and map back.
export async function detectFaces(canvas) {
  const lmk = await landmarker();
  const W = canvas.width, H = canvas.height;
  let faces = lmk.detect(canvas).faceLandmarks || [];
  if (faces.length) return faces;

  const tile = Math.round(Math.min(W, H) * 0.6);
  const step = Math.round(tile * 0.6);
  const c = document.createElement('canvas');
  c.width = c.height = Math.min(tile, 1024);
  const ctx = c.getContext('2d');
  const scale = c.width / tile;
  const found = [];
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const x0 = Math.min(x, Math.max(0, W - tile)), y0 = Math.min(y, Math.max(0, H - tile));
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(canvas, x0, y0, tile, tile, 0, 0, c.width, c.height);
      for (const f of lmk.detect(c).faceLandmarks || []) {
        found.push(f.map((p) => ({ x: (x0 + (p.x * c.width) / scale) / W, y: (y0 + (p.y * c.height) / scale) / H, z: p.z })));
      }
      if (x0 + tile >= W) break;
    }
    if (y + tile >= H) break;
  }
  // De-duplicate faces seen by several tiles.
  for (const f of found) {
    const [cx, cy] = faceCenter(f);
    if (!faces.some((g) => { const [gx, gy] = faceCenter(g); return Math.hypot((gx - cx) * W, (gy - cy) * H) < tile * 0.08; })) faces.push(f);
  }
  return faces;
}

// Returns {mask: Uint8Array (0..255 person confidence), width, height} or null.
export async function segmentPerson(canvas) {
  const seg = await segmenter();
  let out = null;
  seg.segment(canvas, (result) => {
    const m = result.confidenceMasks?.[result.confidenceMasks.length - 1];
    if (!m) return;
    const f = m.getAsFloat32Array();
    const u8 = new Uint8Array(f.length);
    let sum = 0;
    for (let i = 0; i < f.length; i++) { u8[i] = Math.round(Math.min(1, Math.max(0, f[i])) * 255); sum += f[i]; }
    out = { mask: u8, width: m.width, height: m.height, coverage: sum / f.length };
  });
  return out;
}

// One-tap enhancement: reads the photo's histogram and colour cast and proposes slider values
// (so the user can see, and tweak, exactly what "auto" did).

const srgbToLin = (v) => Math.pow(v, 2.2);

export function analyze(img, hasFaces) {
  const { width: W, height: H, data } = img;
  const step = Math.max(1, Math.floor(Math.sqrt((W * H) / 90000)));
  const lums = [];
  let sr = 0, sg = 0, sb = 0, sn = 0, satSum = 0;
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lums.push(l);
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx - mn;
      satSum += sat;
      // Grey-world on near-neutral midtones only, so a red dress doesn't read as a colour cast.
      if (l > 0.15 && l < 0.9 && sat < 0.22) { sr += r; sg += g; sb += b; sn++; }
    }
  }
  lums.sort((a, b) => a - b);
  const n = lums.length;
  const pct = (p) => lums[Math.min(n - 1, Math.floor(p * n))];
  const lo = pct(0.005), hi = pct(0.995), median = pct(0.5);
  const dark = lums.filter((l) => l < 0.18).length / n;
  const bright = lums.filter((l) => l > 0.96).length / n;
  let mean = 0;
  for (const l of lums) mean += l;
  mean /= n;
  let sd = 0;
  for (const l of lums) sd += (l - mean) ** 2;
  sd = Math.sqrt(sd / n);
  const sat = satSum / n;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const a = {};
  // Exposure is judged by headroom, not by a target brightness: a photo whose brightest tones
  // already reach near-white is exposed fine even if it is mostly dark (a navy suit, a night
  // scene, darker skin). Only lift when the whole range sits low; only lower when it sits high.
  const headroom = Math.log2(srgbToLin(0.96) / srgbToLin(Math.max(0.05, hi)));
  let ev = 0;
  if (hi < 0.86) ev = Math.min(headroom, 1.2) * 0.7;
  else if (median > 0.62 && lo > 0.12) ev = -Math.min(0.5, (median - 0.62) * 2);
  a.exposure = clamp(Math.round(ev * 50), -25, 45);
  a.blacks = lo > 0.04 ? clamp(-Math.round((lo - 0.02) * 260), -35, 0) : 0;
  a.whites = hi < 0.93 && ev < 0.3 ? clamp(Math.round((0.97 - hi) * 220), 0, 30) : 0;
  a.shadows = dark > 0.3 ? clamp(Math.round(dark * 40), 6, 25) : 5;
  a.highlights = bright > 0.02 ? -clamp(Math.round(bright * 600), 15, 55) : -10;
  a.contrast = sd < 0.2 ? clamp(Math.round((0.22 - sd) * 140), 4, 22) : 4;
  a.vibrance = sat < 0.3 ? clamp(Math.round((0.32 - sat) * 110), 6, 30) : 6;
  a.clarity = hasFaces ? 6 : 14;
  a.sharpen = hasFaces ? 12 : 20;
  if (sn > n * 0.04) {
    const r = sr / sn, g = sg / sn, b = sb / sn;
    const temp = (b - r) / ((r + g + b) / 3);
    const tint = ((r + b) / 2 - g) / ((r + g + b) / 3);
    a.temp = clamp(Math.round(temp * 0.5 * 260), -30, 30) + (hasFaces ? 3 : 0);
    a.tint = clamp(Math.round(tint * 0.5 * 260), -20, 20);
  } else {
    a.temp = hasFaces ? 3 : 0;
    a.tint = 0;
  }
  return a;
}

// What the face part of "Fix my photo" does at 100%.
export const MAGIC_FACE = { smooth: 55, shine: 35, underEye: 40, teeth: 45, eyes: 35 };

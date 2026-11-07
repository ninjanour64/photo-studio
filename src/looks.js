// Looks (filters) are bundles of slider offsets plus split toning / B&W. Strength scales them.
// Values use the same -100..100 slider units as the Adjust panel.

export const LOOKS = [
  { id: 'none', name: 'Original' },
  { id: 'natural', name: 'Natural', adj: { contrast: 8, vibrance: 14, clarity: 6, highlights: -10, shadows: 8 } },
  { id: 'glow', name: 'Soft Glow', adj: { exposure: 6, contrast: -6, glow: 45, highlights: -10, fade: 8, temp: 6 }, hi: [0.03, 0.01, -0.01] },
  { id: 'golden', name: 'Golden Hour', adj: { temp: 30, tint: 4, vibrance: 18, contrast: 8, glow: 18 }, sh: [0.02, 0.0, -0.03], hi: [0.05, 0.025, -0.03] },
  { id: 'warm', name: 'Warm', adj: { temp: 22, vibrance: 10, contrast: 4 } },
  { id: 'cool', name: 'Cool Breeze', adj: { temp: -24, tint: -4, contrast: 6, vibrance: 8 }, sh: [-0.02, 0.0, 0.03] },
  { id: 'film', name: 'Film', adj: { contrast: 14, fade: 22, saturation: -8, grain: 22, temp: 6 }, sh: [0.0, 0.02, 0.03], hi: [0.04, 0.02, -0.02] },
  { id: 'vintage', name: 'Vintage', adj: { fade: 32, saturation: -22, temp: 18, contrast: -6, grain: 28, vignette: -30 }, sh: [0.03, 0.02, 0.0], hi: [0.04, 0.03, -0.04] },
  { id: 'matte', name: 'Matte', adj: { fade: 38, contrast: -10, saturation: -6, highlights: -12 } },
  { id: 'moody', name: 'Moody', adj: { exposure: -8, contrast: 22, saturation: -18, highlights: -25, vignette: -40, clarity: 12 }, sh: [-0.01, 0.01, 0.04] },
  { id: 'teal', name: 'Teal & Orange', adj: { contrast: 18, vibrance: 14, clarity: 8 }, sh: [-0.04, 0.02, 0.06], hi: [0.06, 0.02, -0.05] },
  { id: 'pastel', name: 'Pastel', adj: { exposure: 10, contrast: -18, fade: 18, saturation: -12, highlights: -15 }, sh: [0.02, 0.0, 0.04], hi: [0.02, 0.01, 0.03] },
  { id: 'vivid', name: 'Vivid', adj: { contrast: 16, vibrance: 35, saturation: 10, clarity: 14, dehaze: 10 } },
  { id: 'rosy', name: 'Rosy', adj: { tint: 14, temp: 8, glow: 14, contrast: -4 }, hi: [0.04, 0.0, 0.02] },
  { id: 'bw', name: 'B&W', bw: 1, adj: { contrast: 18, clarity: 10 } },
  { id: 'noir', name: 'Noir', bw: 1, adj: { contrast: 40, blacks: -20, vignette: -45, grain: 20, clarity: 18 } },
  { id: 'silver', name: 'Silver', bw: 1, adj: { contrast: -6, fade: 20, highlights: -10, grain: 10 }, sh: [0.0, 0.0, 0.025] },
];

export const lookById = (id) => LOOKS.find((l) => l.id === id) || LOOKS[0];

// Combines user adjustments with the active look into shader-ready values (-1..1-ish).
export function resolveAdjust(adjust, look) {
  const L = lookById(look.id);
  const k = (look.strength ?? 80) / 100;
  const out = {};
  for (const [key, v] of Object.entries(adjust)) out[key] = (v + (L.adj?.[key] || 0) * k) / 100;
  const sh = (L.sh || [0, 0, 0]).map((v) => v * k);
  const hi = (L.hi || [0, 0, 0]).map((v) => v * k);
  return { adj: out, look: { splitShadow: sh, splitHigh: hi, bw: (L.bw || 0) * k } };
}

# Glow Photo Studio

A browser photo editor for everyday people: one tap fixes light, colour and skin, and every
Photoshop/Facetune-style tool sits behind a plain-language slider or brush. Everything runs on
the device (WebGL2 + on-device MediaPipe models): photos are never uploaded.

```bash
cd photo-studio
npm install
npm run dev        # http://localhost:5174
npm run build      # static site in dist/ (any static host works)
```

## What it does

| Tab | Tools |
|---|---|
| **Magic** | *Fix my photo*: auto light and colour, skin smoothing, automatic blemish removal, brighter eyes and teeth, lifted under-eyes, all on one Strength slider. One-tap ideas: blur background, colour pop, slim under chin, golden hour, B&W, soft glow, square crop. |
| **Face** | Smooth skin, reduce shine, under-eye circles, remove blemishes, whiten teeth, brighten eyes, eye colour, lip colour. Chin & neck: slim under chin (tucks a double chin and softens neck folds) and jawline. Shape: slim face, chin length, forehead, bigger eyes, slim/smaller nose, fuller lips, smile. With several people you can edit each face separately. |
| **Adjust** | Brightness, contrast, highlights, shadows, whites, blacks, warmth, tint, vibrance, saturation, clarity, sharpen, dehaze, glow, fade, vignette, grain, plus an Auto button. |
| **Looks** | 16 filters with live thumbnails of your photo, plus a strength slider. |
| **Retouch** | Brushes: Heal (content-aware, Poisson-blended), Smooth, Whiten, Details, Reshape (liquify), Unshape, Eraser. |
| **Crop** | Aspect presets, straighten, rotate and flip. The crop always stays inside the photo. |
| **Background** | Portrait blur, colour pop, remove (transparent or a colour fill), background brightness. |

You also get unlimited undo/redo, hold-to-compare (or the `\` key), pinch/scroll zoom, and export
to JPG/PNG/WebP at full or social size, with Share on phones.

## How it works

| Path | What's there |
|---|---|
| `src/gl/` | WebGL2 pipeline. Passes only re-run when their inputs change: warp → bilateral skin blur → background blur → retouch → adjustments/look/crop/view. |
| `src/face/` | MediaPipe face landmarks and person segmentation (`detect.js`), feature masks (`masks.js`), reshape displacement field (`warp.js`). |
| `src/retouch/heal.js` | Patch search plus harmonic (Poisson) blending for the heal brush, and the automatic blemish finder. |
| `src/auto.js` | Histogram-based auto light. It is headroom-based, so it never brightens a photo just because it is mostly dark (or because the skin is dark). |
| `src/looks.js`, `src/geometry.js`, `src/state.js` | Looks, crop/view maths, and edit state with history. |
| `src/ui/` | Panels, canvas input (brushes, crop handles, pan/zoom), save dialog. |

The models (`public/models/`) are committed. The MediaPipe WASM runtime is copied from
`node_modules` into `public/wasm/` at build/dev start, so the app works fully offline.

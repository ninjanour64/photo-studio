// Save dialog: format, size, quality → renders the full-resolution edit offscreen.

import { h, chips, slider, button } from './controls.js';
import { icon } from './icons.js';
import { cropRect, exportFrame } from '../geometry.js';
import { resolveAdjust } from '../looks.js';

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

export function bgFill(app) {
  const b = app.params.bg;
  if (b.mode !== 'remove' || b.fill === 'transparent' || app.personStatus !== 'done') return null;
  return [...hexToRgb(b.fill), 1];
}

export async function renderBlob(app, { format, scale, quality }) {
  const { width: W, height: H } = app.img;
  const r = cropRect(app.params.crop, W, H);
  const outW = Math.max(1, Math.round(r.w * scale)), outH = Math.max(1, Math.round(r.h * scale));
  app.pipe.update(app.faceUniforms(), app.bgUniforms());
  const frame = exportFrame(app.params.crop, W, H, outW, outH);
  const { adj, look } = resolveAdjust(app.params.adjust, app.params.look);
  let fill = bgFill(app);
  if (!fill && format === 'image/jpeg') fill = [1, 1, 1, 1]; // JPEG has no transparency
  const px = app.pipe.readTarget(outW, outH, { ...frame, outside: [0, 0, 0, 0] }, adj, look, { fill });
  const c = document.createElement('canvas');
  c.width = outW; c.height = outH;
  c.getContext('2d').putImageData(new ImageData(px, outW, outH), 0, 0);
  const blob = await new Promise((res) => c.toBlob(res, format, quality));
  return { blob, outW, outH };
}

export function openExport(app) {
  const dlg = document.querySelector('#export-dialog');
  const { width: W, height: H } = app.img;
  const r = cropRect(app.params.crop, W, H);
  const long = Math.max(r.w, r.h);
  const transparent = app.params.bg.mode === 'remove' && app.params.bg.fill === 'transparent' && app.personStatus === 'done';
  const opts = { format: transparent ? 'image/png' : 'image/jpeg', size: 'full', quality: 92 };
  const sizes = [
    { id: 'full', label: `Full (${Math.round(r.w)}×${Math.round(r.h)})`, s: 1 },
    ...(long > 2048 ? [{ id: 'large', label: 'Large (2048)', s: 2048 / long }] : []),
    ...(long > 1080 ? [{ id: 'social', label: 'Social (1080)', s: 1080 / long }] : []),
  ];
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
  const name = h('input', { type: 'text', value: (app.fileName || 'photo') + '-edited', spellcheck: 'false', 'aria-label': 'File name' });
  const qual = slider({ label: 'Quality', min: 50, max: 100, def: 92, get: () => opts.quality, set: (v) => { opts.quality = v; }, fmt: (v) => v + '%' });
  const note = h('p', { class: 'hint' });
  const sync = () => {
    qual.style.display = opts.format === 'image/png' ? 'none' : '';
    note.textContent = transparent && opts.format === 'image/jpeg' ? 'JPG can’t be see-through, so the background will be white. Choose PNG to keep it clear.' : '';
  };
  const job = async () => {
    const s = sizes.find((x) => x.id === opts.size)?.s ?? 1;
    app.busy('Saving…');
    try {
      const res = await renderBlob(app, { format: opts.format, scale: s, quality: opts.quality / 100 });
      return { ...res, file: `${name.value.trim() || 'photo'}.${ext[opts.format]}` };
    } finally {
      app.busy();
    }
  };
  const save = async () => {
    const { blob, file } = await job();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = file;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    dlg.close();
    app.toast('Saved ' + file);
  };
  const share = async () => {
    const { blob, file } = await job();
    const f = new File([blob], file, { type: blob.type });
    try { await navigator.share({ files: [f] }); dlg.close(); } catch { /* cancelled */ }
  };
  const canShare = !!navigator.canShare?.({ files: [new File([new Blob()], 'x.jpg', { type: 'image/jpeg' })] });

  dlg.replaceChildren(h('form', { method: 'dialog', class: 'dlg' },
    h('div', { class: 'dlg-head' }, h('h2', {}, 'Save photo'), h('button', { class: 'icon-btn', value: 'cancel', 'aria-label': 'Close', html: icon('close') })),
    h('h4', {}, 'Format'),
    chips([{ id: 'image/jpeg', label: 'JPG' }, { id: 'image/png', label: 'PNG' }, { id: 'image/webp', label: 'WebP' }], () => opts.format, (v) => { opts.format = v; sync(); }),
    h('h4', {}, 'Size'),
    chips(sizes.map((s) => ({ id: s.id, label: s.label })), () => opts.size, (v) => { opts.size = v; }),
    qual,
    h('h4', {}, 'File name'),
    name,
    note,
    h('div', { class: 'dlg-actions' },
      canShare ? button('Share', (e) => { e.preventDefault(); share(); }, { ic: 'share' }) : null,
      button('Save', (e) => { e.preventDefault(); save(); }, { cls: 'primary', ic: 'save' }))));
  sync();
  dlg.showModal();
}

// Side/bottom panel contents for each tab.

import { h, section, hint, slider, chips, tiles, button } from './controls.js';
import { icon } from './icons.js';
import { LOOKS, resolveAdjust } from '../looks.js';
import { ASPECTS, exportFrame, cropRect } from '../geometry.js';
import { SHAPE_DEFAULTS, ADJUST_DEFAULTS, CROP_DEFAULTS } from '../state.js';

export const TABS = [
  { id: 'magic', label: 'Magic', icon: 'magic' },
  { id: 'face', label: 'Face', icon: 'face' },
  { id: 'adjust', label: 'Adjust', icon: 'adjust' },
  { id: 'looks', label: 'Looks', icon: 'looks' },
  { id: 'retouch', label: 'Retouch', icon: 'brush' },
  { id: 'crop', label: 'Crop', icon: 'crop' },
  { id: 'background', label: 'Background', icon: 'person' },
];

export function buildPanel(app, tab) {
  if (!app.img) {
    return h('div', { class: 'panel-empty' },
      h('div', { class: 'empty-ic', html: icon(TABS.find((t) => t.id === tab)?.icon || 'magic', 34) }),
      h('p', {}, 'Open a photo to start editing.'),
      button('Open photo', () => document.querySelector('#file').click(), { cls: 'primary', ic: 'open' }));
  }
  const builders = { magic, face, adjust, looks, retouch, crop, background };
  return h('div', { class: 'panel-inner' }, builders[tab](app));
}

const live = (app, fn) => (v) => { fn(v); app.requestRender(); };
const retouchDirty = (app) => app.pipe.dirty.add('retouch');

function faceStatus(app) {
  if (app.faceStatus === 'loading') return h('div', { class: 'status' }, h('span', { class: 'spinner' }), 'Finding faces…');
  if (app.faceStatus === 'error') return h('div', { class: 'status warn' }, "Face tools couldn't load. Adjust, Looks and brushes still work.");
  if (!app.faces.length) return h('div', { class: 'status' }, 'No faces found in this photo. Face tools are off — brushes in Retouch still work.');
  return h('div', { class: 'status ok' }, h('span', { html: icon('check', 16) }), `${app.faces.length} face${app.faces.length > 1 ? 's' : ''} found`);
}

// ---- Magic -------------------------------------------------------------------------------------

function magic(app) {
  const p = app.params;
  const out = [];
  if (!p.magic.on) {
    out.push(h('div', { class: 'hero' },
      h('div', { class: 'hero-ic', html: icon('sparkle', 30) }),
      h('h2', {}, 'One tap to a better photo'),
      h('p', {}, 'Balances light and colour, smooths skin, clears blemishes and brightens eyes and teeth. You can fine-tune everything afterwards.'),
      button('Fix my photo', () => app.magicFix(), { cls: 'primary big', ic: 'magic' })));
  } else {
    const done = ['Light & colour balanced'];
    if (app.faces.length) {
      done.push('Skin smoothed', 'Eyes brightened', 'Teeth whitened', 'Under-eyes lifted');
      if (p.magic.healed > 0) done.push(`${p.magic.healed} blemish${p.magic.healed === 1 ? '' : 'es'} removed`);
    }
    out.push(h('div', { class: 'hero done' },
      h('div', { class: 'hero-ic ok', html: icon('check', 26) }),
      h('h2', {}, 'Photo fixed'),
      h('ul', { class: 'done-list' }, done.map((d) => h('li', {}, d))),
      slider({
        label: 'Strength', min: 0, max: 100, def: 70, get: () => p.magic.strength,
        set: (v) => { p.magic.strength = v; app.applyMagicStrength(); },
        commit: () => { app.commit('Fix strength'); },
      }),
      hint('Hold the compare button (or press \\) to see the original.')));
  }
  out.push(faceStatus(app));

  const ideas = [
    { id: 'bgblur', label: 'Blur background', icon: 'blur', need: 'person', run: () => { p.bg.mode = p.bg.mode === 'blur' ? 'none' : 'blur'; return p.bg.mode === 'blur'; } },
    { id: 'pop', label: 'Colour pop', icon: 'bw', need: 'person', run: () => { p.bg.mode = p.bg.mode === 'bw' ? 'none' : 'bw'; return p.bg.mode === 'bw'; } },
    { id: 'golden', label: 'Golden hour', icon: 'sun', run: () => toggleLook('golden') },
    { id: 'bw', label: 'Black & white', icon: 'bw', run: () => toggleLook('bw') },
    { id: 'glow', label: 'Soft glow', icon: 'sparkle', run: () => toggleLook('glow') },
    { id: 'square', label: 'Square crop', icon: 'crop', run: () => { const on = p.crop.aspect !== '1:1'; p.crop.aspect = on ? '1:1' : 'original'; p.crop.rect = null; return on; } },
  ];
  function toggleLook(id) {
    const on = p.look.id !== id;
    p.look.id = on ? id : 'none';
    return on;
  }
  const isOn = (o) => ({ bgblur: p.bg.mode === 'blur', pop: p.bg.mode === 'bw', golden: p.look.id === 'golden', bw: p.look.id === 'bw', glow: p.look.id === 'glow', square: p.crop.aspect === '1:1' })[o.id];
  const grid = h('div', { class: 'tiles' });
  for (const o of ideas) {
    const blocked = o.need === 'person' && app.personStatus !== 'done';
    const b = h('button', {
      type: 'button', class: 'tile' + (isOn(o) ? ' on' : ''), disabled: blocked && app.personStatus !== 'loading' ? true : null,
      title: blocked ? (app.personStatus === 'loading' ? 'Finding the person…' : 'No person found in this photo') : o.label,
      onclick: () => {
        if (o.need === 'person' && app.personStatus === 'loading') { app.toast('Still finding the person in your photo…'); return; }
        o.run();
        app.pipe.dirty.add('retouch');
        app.commit(o.label);
        app.refreshPanel();
        app.requestRender();
      },
    }, h('span', { class: 'tile-ic', html: icon(o.icon, 24) }), h('span', { class: 'tile-l' }, o.label));
    grid.append(b);
  }
  out.push(section('Quick ideas', grid));
  out.push(h('div', { class: 'row-end' }, button('Start over', () => app.resetAll(), { cls: 'ghost small', ic: 'restore' })));
  return out;
}

// ---- Face --------------------------------------------------------------------------------------

function face(app) {
  const p = app.params;
  const f = p.face;
  const out = [faceStatus(app)];
  if (!app.faces.length) return out;
  const fs = (label, key, extra = {}) => slider({
    label, min: 0, max: 100, def: 0, get: () => f[key],
    set: live(app, (v) => { f[key] = v; retouchDirty(app); }), commit: () => app.commit(label), ...extra,
  });

  out.push(section('Skin',
    fs('Smooth skin', 'smooth'),
    fs('Reduce shine', 'shine'),
    fs('Under-eye circles', 'underEye'),
    h('div', { class: 'row' },
      button(p.magic.healed > 0 ? `Blemishes removed (${p.magic.healed})` : 'Remove blemishes', () => {
        app.busy('Finding blemishes…');
        setTimeout(() => {
          const r = app.removeBlemishes(p.magic.healed ? 1.35 : 1);
          app.busy();
          if (r.count) {
            p.magic.healed = Math.max(0, p.magic.healed) + r.count;
            app.commit('Remove blemishes', r.rasters);
            app.toast(`Removed ${r.count} blemish${r.count === 1 ? '' : 'es'}. Tap again to catch fainter ones.`);
          } else app.toast('No more blemishes found. Use the Heal brush in Retouch for anything left.');
          app.refreshPanel();
        }, 20);
      }, { cls: 'wide', ic: 'heal' }))));

  const eyeOpts = [
    { id: 'none', label: 'Natural' }, { id: 'blue', label: 'Blue', swatch: '#3f7fd9' }, { id: 'green', label: 'Green', swatch: '#4c9e60' },
    { id: 'hazel', label: 'Hazel', swatch: '#8c7338' }, { id: 'brown', label: 'Brown', swatch: '#6b4224' }, { id: 'gray', label: 'Grey', swatch: '#8c99a6' },
    { id: 'violet', label: 'Violet', swatch: '#8059bf' },
  ];
  const lipOpts = [
    { id: 'none', label: 'Natural' }, { id: 'nude', label: 'Nude', swatch: '#bd8070' }, { id: 'rose', label: 'Rose', swatch: '#c75c73' },
    { id: 'coral', label: 'Coral', swatch: '#ed6b59' }, { id: 'red', label: 'Red', swatch: '#bf1a26' }, { id: 'berry', label: 'Berry', swatch: '#801f4d' },
    { id: 'plum', label: 'Plum', swatch: '#6b294d' },
  ];
  const colorPick = (key, amtKey, opts, label) => {
    const amt = slider({
      label: 'Intensity', min: 0, max: 100, def: 50, get: () => f[amtKey],
      set: live(app, (v) => { f[amtKey] = v; retouchDirty(app); }), commit: () => app.commit(label),
    });
    const wrap = h('div', {});
    const ch = chips(opts, () => f[key], (v) => {
      f[key] = v; retouchDirty(app); app.commit(label); app.requestRender();
      amt.style.display = v === 'none' ? 'none' : '';
    }, { cls: 'swatches' });
    amt.style.display = f[key] === 'none' ? 'none' : '';
    wrap.append(h('h4', {}, label), ch, amt);
    return wrap;
  };
  out.push(section('Features',
    fs('Whiten teeth', 'teeth'),
    fs('Brighten eyes', 'eyes'),
    colorPick('eyeColor', 'eyeColorAmt', eyeOpts, 'Eye colour'),
    colorPick('lipColor', 'lipAmt', lipOpts, 'Lip colour')));

  // Shape (per face, or all at once).
  const targets = () => (app.selectedFace === 'all' ? app.faces.map((_, i) => i) : [app.selectedFace]);
  const shapeSlider = (label, key) => slider({
    label, min: -100, max: 100, def: 0,
    get: () => app.shapeFor(targets()[0])[key],
    set: (v) => { for (const i of targets()) app.shapeFor(i)[key] = v; app.updateWarp(); },
    commit: () => app.commit(label),
  });
  const shapeSec = section('Shape');
  if (app.faces.length > 1) {
    shapeSec.append(chips([{ id: 'all', label: 'All faces' }, ...app.faces.map((_, i) => ({ id: String(i), label: `Face ${i + 1}` }))],
      () => String(app.selectedFace), (v) => app.selectFace(v === 'all' ? 'all' : +v)));
    shapeSec.append(hint('Tip: tap the numbers on the photo to pick a face.'));
  }
  shapeSec.append(
    shapeSlider('Slim face', 'slim'), shapeSlider('Jawline', 'jaw'), shapeSlider('Chin length', 'chin'),
    shapeSlider('Forehead', 'forehead'), shapeSlider('Bigger eyes', 'eyes'), shapeSlider('Slim nose', 'noseSlim'),
    shapeSlider('Smaller nose', 'noseSmall'), shapeSlider('Fuller lips', 'lips'), shapeSlider('Smile', 'smile'),
    h('div', { class: 'row-end' }, button('Reset shape', () => {
      for (const i of targets()) p.shape[i] = { ...SHAPE_DEFAULTS };
      app.updateWarp(); app.commit('Reset shape'); app.refreshPanel();
    }, { cls: 'ghost small', ic: 'restore' })));
  out.push(shapeSec);
  return out;
}

// ---- Adjust ------------------------------------------------------------------------------------

function adjust(app) {
  const a = app.params.adjust;
  const s = (label, key, min = -100, max = 100) => slider({
    label, min, max, def: ADJUST_DEFAULTS[key], get: () => a[key],
    set: live(app, (v) => { a[key] = v; }), commit: () => app.commit(label),
  });
  return [
    h('div', { class: 'row' },
      button('Auto', () => app.autoLight(), { cls: 'primary wide', ic: 'magic' }),
      button('Reset', () => { Object.assign(a, ADJUST_DEFAULTS); app.commit('Reset adjustments'); app.refreshPanel(); app.requestRender(); }, { cls: 'ghost', ic: 'restore' })),
    section('Light', s('Brightness', 'exposure'), s('Contrast', 'contrast'), s('Highlights', 'highlights'),
      s('Shadows', 'shadows'), s('Whites', 'whites'), s('Blacks', 'blacks')),
    section('Colour', s('Warmth', 'temp'), s('Tint', 'tint'), s('Vibrance', 'vibrance'), s('Saturation', 'saturation')),
    section('Detail', s('Clarity', 'clarity'), s('Sharpen', 'sharpen', 0, 100), s('Dehaze', 'dehaze')),
    section('Effects', s('Glow', 'glow', 0, 100), s('Fade', 'fade', 0, 100), s('Vignette', 'vignette'), s('Grain', 'grain', 0, 100)),
  ];
}

// ---- Looks -------------------------------------------------------------------------------------

function looks(app) {
  const L = app.params.look;
  const grid = h('div', { class: 'looks' });
  const cards = [];
  for (const look of LOOKS) {
    const cv = h('canvas', { class: 'look-thumb' });
    const card = h('button', {
      type: 'button', class: 'look' + (L.id === look.id ? ' on' : ''),
      onclick: () => {
        L.id = look.id;
        cards.forEach((c) => c.classList.toggle('on', c.dataset.id === look.id));
        app.commit('Look: ' + look.name);
        app.requestRender();
      },
      'data-id': look.id,
    }, cv, h('span', {}, look.name));
    cards.push(card);
    grid.append(card);
  }
  // Thumbnails rendered from the current edit, after the panel is on screen.
  setTimeout(() => renderThumbs(app, cards), 30);
  return [
    grid,
    slider({ label: 'Strength', min: 0, max: 100, def: 80, get: () => L.strength, set: live(app, (v) => { L.strength = v; }), commit: () => app.commit('Look strength') }),
  ];
}

function renderThumbs(app, cards) {
  if (!cards[0]?.isConnected) return;
  const { W, H } = { W: app.img.width, H: app.img.height };
  const r = cropRect(app.params.crop, W, H);
  const long = 150;
  const tw = Math.max(1, Math.round(r.w >= r.h ? long : (long * r.w) / r.h));
  const th = Math.max(1, Math.round(r.h >= r.w ? long : (long * r.h) / r.w));
  const frame = exportFrame(app.params.crop, W, H, tw, th);
  const fill = app.params.bg.mode === 'remove' ? [1, 1, 1, 1] : null;
  for (const card of cards) {
    const look = { id: card.dataset.id, strength: app.params.look.strength };
    const { adj, look: lk } = resolveAdjust(app.params.adjust, look);
    const px = app.pipe.readTarget(tw, th, { ...frame, outside: [0, 0, 0, 1] }, adj, lk, { fill });
    const cv = card.querySelector('canvas');
    cv.width = tw; cv.height = th;
    cv.getContext('2d').putImageData(new ImageData(px, tw, th), 0, 0);
  }
}

// ---- Retouch (brushes) -------------------------------------------------------------------------

const TOOLS = [
  { id: 'heal', label: 'Heal', icon: 'heal', hint: 'Paint over a spot, blemish or small distraction. It disappears when you lift your finger.' },
  { id: 'smooth', label: 'Smooth', icon: 'smooth', hint: 'Paint to smooth skin anywhere — neck, arms, or a face the app missed.' },
  { id: 'whiten', label: 'Whiten', icon: 'whiten', hint: 'Paint over teeth or the whites of the eyes.' },
  { id: 'details', label: 'Details', icon: 'details', hint: 'Paint to sharpen eyes, lashes, hair or jewellery.' },
  { id: 'reshape', label: 'Reshape', icon: 'reshape', hint: 'Drag to gently push shapes. Use a big brush for natural results.' },
  { id: 'unshape', label: 'Unshape', icon: 'restore', hint: 'Paint to undo reshaping in an area.' },
  { id: 'eraser', label: 'Eraser', icon: 'eraser', hint: 'Paint to remove smoothing, whitening and other retouching from an area.' },
];

function retouch(app) {
  const tip = hint('');
  const setTip = () => { tip.textContent = TOOLS.find((t) => t.id === app.tool)?.hint || ''; };
  setTip();
  const size = slider({
    label: 'Brush size', min: 4, max: 300, def: 50, get: () => app.brush.size, fmt: (v) => v + ' px',
    set: (v) => { app.brush.size = v; app.input.drawOverlay(); },
  });
  size.setAttribute('data-brush-size', '');
  return [
    tiles(TOOLS, () => app.tool, (v) => { app.tool = v; setTip(); }),
    tip,
    section('Brush',
      size,
      slider({ label: 'Strength', min: 5, max: 100, def: 70, get: () => app.brush.strength, fmt: (v) => v + '%', set: (v) => { app.brush.strength = v; } }),
      hint('Zoom with pinch, scroll or the + button. Hold Space (or use two fingers) to move around. [ and ] change brush size.')),
    h('div', { class: 'row-end' }, button('Clear brush strokes', () => {
      const before = app.brushBuf.slice();
      const beforeLiq = app.warp.liq.slice();
      const set = (buf, liq) => {
        app.brushBuf.set(buf); app.pipe.updateBrush(app.brushBuf, 0, 0, app.mW, app.mH);
        app.warp.liq.set(liq); app.pipe.setDisp(app.warp.combine(), app.warp.gw, app.warp.gh); app.requestRender();
      };
      const after = new Uint8Array(before.length), afterLiq = new Float32Array(beforeLiq.length);
      set(after, afterLiq);
      app.commit('Clear brush strokes', [{ undo: () => set(before, beforeLiq), redo: () => set(after, afterLiq) }]);
    }, { cls: 'ghost small', ic: 'restore' })),
  ];
}

// ---- Crop --------------------------------------------------------------------------------------

function crop(app) {
  const c = app.params.crop;
  const changed = (label) => { c.rect = null; app.commit(label); app.requestRender(); };
  return [
    section('Shape', chips(ASPECTS.map((a) => ({ id: a.id, label: a.label })), () => c.aspect, (v) => { c.aspect = v; changed('Crop shape'); })),
    section('Straighten',
      slider({
        label: 'Angle', min: -45, max: 45, step: 0.5, def: 0, get: () => c.straighten, fmt: (v) => v.toFixed(1) + '°',
        set: (v) => { c.straighten = v; c.rect = null; app.requestRender(); }, commit: () => app.commit('Straighten'),
      }),
      h('div', { class: 'row' },
        button('Rotate', () => { c.rot = (c.rot + 1) % 4; changed('Rotate'); }, { ic: 'rotate' }),
        button('Flip', () => { c.flipH = !c.flipH; changed('Flip'); }, { ic: 'flipH' }),
        button('Flip vertical', () => { c.flipV = !c.flipV; changed('Flip vertical'); }, { ic: 'flipV' }))),
    hint('Drag inside the frame to move it, or drag its edges and corners.'),
    h('div', { class: 'row-end' }, button('Reset crop', () => { Object.assign(c, { ...CROP_DEFAULTS }); changed('Reset crop'); app.refreshPanel(); }, { cls: 'ghost small', ic: 'restore' })),
  ];
}

// ---- Background --------------------------------------------------------------------------------

function background(app) {
  const b = app.params.bg;
  const out = [];
  if (app.personStatus === 'loading') out.push(h('div', { class: 'status' }, h('span', { class: 'spinner' }), 'Finding the person in your photo…'));
  else if (app.personStatus !== 'done') {
    out.push(h('div', { class: 'status warn' }, app.personStatus === 'error' ? "Background tools couldn't load." : 'No person found in this photo, so background tools are off.'));
    return out;
  } else out.push(h('div', { class: 'status ok' }, h('span', { html: icon('check', 16) }), 'Person found'));

  const opts = h('div', {});
  const renderOpts = () => {
    opts.replaceChildren();
    if (b.mode === 'blur') {
      opts.append(slider({ label: 'Blur amount', min: 0, max: 100, def: 60, get: () => b.blur, set: live(app, (v) => { b.blur = v; }), commit: () => app.commit('Background blur') }));
    }
    if (b.mode === 'remove') {
      const fills = [
        { id: 'transparent', label: 'Clear', swatch: 'repeating-conic-gradient(#bbb 0 25%, #eee 0 50%) 50% / 10px 10px' },
        { id: '#ffffff', label: 'White', swatch: '#fff' }, { id: '#111111', label: 'Black', swatch: '#111' },
        { id: '#e9e4de', label: 'Studio', swatch: '#e9e4de' }, { id: '#f6d4d2', label: 'Blush', swatch: '#f6d4d2' },
        { id: '#cfe3f2', label: 'Sky', swatch: '#cfe3f2' },
      ];
      opts.append(h('h4', {}, 'Fill'), chips(fills, () => b.fill, (v) => { b.fill = v; app.commit('Background fill'); app.requestRender(); }, { cls: 'swatches' }));
      if (b.fill === 'transparent') opts.append(hint('Save as PNG to keep the background see-through.'));
    }
    if (b.mode !== 'remove') {
      opts.append(slider({ label: 'Background brightness', def: 0, get: () => b.light, set: live(app, (v) => { b.light = v; retouchDirty(app); }), commit: () => app.commit('Background brightness') }));
    }
  };
  out.push(tiles([
    { id: 'none', label: 'Original', icon: 'none' },
    { id: 'blur', label: 'Blur', icon: 'blur' },
    { id: 'bw', label: 'Colour pop', icon: 'bw' },
    { id: 'remove', label: 'Remove', icon: 'cutout' },
  ], () => b.mode, (v) => {
    b.mode = v;
    retouchDirty(app);
    app.commit('Background: ' + v);
    renderOpts();
    app.requestRender();
  }));
  renderOpts();
  out.push(opts);
  return out;
}

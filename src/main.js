import './styles.css';
import { Pipeline } from './gl/pipeline.js';
import { History, defaultParams, clone, SHAPE_DEFAULTS, FACE_DEFAULTS } from './state.js';
import { resolveAdjust } from './looks.js';
import { analyze, MAGIC_FACE } from './auto.js';
import { makeFrame } from './geometry.js';
import { WarpField } from './face/warp.js';
import { buildMasks, skinMaskForFace } from './face/masks.js';
import { faceMetrics, toPixels } from './face/landmarks.js';
import * as detect from './face/detect.js';
import { heal, findBlemishes, putRect } from './retouch/heal.js';
import { buildPanel, TABS } from './ui/panels.js';
import { Input } from './ui/input.js';
import { openExport, bgFill } from './ui/export.js';
import { icon } from './ui/icons.js';
import { h } from './ui/controls.js';

export const EYE_COLORS = {
  none: null, blue: [0.25, 0.5, 0.85], green: [0.3, 0.62, 0.38], hazel: [0.55, 0.45, 0.22],
  brown: [0.42, 0.26, 0.14], gray: [0.55, 0.6, 0.65], violet: [0.5, 0.35, 0.75],
};
export const LIP_COLORS = {
  none: null, rose: [0.78, 0.36, 0.45], red: [0.75, 0.1, 0.15], berry: [0.5, 0.12, 0.3],
  coral: [0.93, 0.42, 0.35], nude: [0.74, 0.5, 0.44], plum: [0.42, 0.16, 0.3],
};

const $ = (s) => document.querySelector(s);

class App {
  constructor() {
    this.stage = $('#stage');
    this.glCanvas = $('#gl');
    this.overlay = $('#overlay');
    try {
      this.pipe = new Pipeline(this.glCanvas);
    } catch (e) {
      $('#drop').innerHTML = `<div class="drop-inner"><h2>Your browser can't run the editor</h2><p>${e.message} Try the latest Chrome, Edge, Safari or Firefox.</p></div>`;
      throw e;
    }
    this.params = defaultParams();
    this.history = new History(() => this.syncTopbar());
    this.tab = 'magic';
    this.view = null; // null = fit
    this.tool = 'heal';
    this.brush = { size: 50, strength: 70 };
    this.faces = [];
    this.faceStatus = 'idle';
    this.personStatus = 'idle';
    this.selectedFace = 'all';
    this.compare = false;
    this.img = null;
    this.input = new Input(this);
    this.buildChrome();
    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.resize();
    detect.preload();
  }

  // ---- chrome ----------------------------------------------------------------------------------

  buildChrome() {
    const tabs = $('#tabs');
    for (const t of TABS) {
      tabs.append(h('button', { type: 'button', class: 'tab', 'data-tab': t.id, onclick: () => this.setTab(t.id) },
        h('span', { html: icon(t.icon, 22) }), h('span', { class: 'tab-l' }, t.label)));
    }
    $('#btn-open').addEventListener('click', () => $('#file').click());
    $('#drop-open').addEventListener('click', () => $('#file').click());
    $('#file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) this.loadFile(f); e.target.value = ''; });
    $('#btn-undo').addEventListener('click', () => this.undo());
    $('#btn-redo').addEventListener('click', () => this.redo());
    $('#btn-export').addEventListener('click', () => this.img && openExport(this));
    const cmp = $('#btn-compare');
    const on = (e) => { e.preventDefault(); this.setCompare(true); };
    const off = () => this.setCompare(false);
    cmp.addEventListener('pointerdown', on);
    cmp.addEventListener('pointerup', off);
    cmp.addEventListener('pointerleave', off);
    cmp.addEventListener('pointercancel', off);
    $('#zoom-in').addEventListener('click', () => this.zoomBy(1.4));
    $('#zoom-out').addEventListener('click', () => this.zoomBy(1 / 1.4));
    $('#zoom-fit').addEventListener('click', () => { this.view = null; this.requestRender(); });

    window.addEventListener('dragover', (e) => { e.preventDefault(); this.stage.classList.add('dragging'); });
    window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) this.stage.classList.remove('dragging'); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      this.stage.classList.remove('dragging');
      const f = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/') || /\.(heic|heif|avif)$/i.test(f.name));
      if (f) this.loadFile(f);
    });
    window.addEventListener('paste', (e) => {
      const f = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
      if (f) this.loadFile(f);
    });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('beforeunload', (e) => { if (this.history.canUndo) e.preventDefault(); });
    this.setTab('magic');
    this.syncTopbar();
  }

  onKey(e, down) {
    if (e.target.closest?.('input, textarea, select, dialog')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (down && mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (down && mod && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redo(); return; }
    if (down && mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (this.img) openExport(this); return; }
    if (e.key === '\\') { this.setCompare(down); return; }
    if (e.key === ' ') { this.input.spaceDown = down; if (down) e.preventDefault(); return; }
    if (!down || mod) return;
    if (e.key === '[') this.setBrushSize(this.brush.size / 1.2);
    else if (e.key === ']') this.setBrushSize(this.brush.size * 1.2);
    else if (e.key === '0') { this.view = null; this.requestRender(); }
    else if (e.key === '+' || e.key === '=') this.zoomBy(1.4);
    else if (e.key === '-') this.zoomBy(1 / 1.4);
  }

  setBrushSize(s) {
    this.brush.size = Math.max(4, Math.min(400, Math.round(s)));
    this.panelEl?.querySelector('[data-brush-size]')?.sync?.();
    this.input.drawOverlay();
  }

  setTab(id) {
    this.tab = id;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    this.stage.dataset.tab = id;
    this.refreshPanel();
    this.requestRender();
  }

  refreshPanel() {
    const body = $('#panel-body');
    const scroll = body.scrollTop;
    body.replaceChildren(this.panelEl = buildPanel(this, this.tab));
    body.scrollTop = scroll;
  }

  syncTopbar() {
    $('#btn-undo').disabled = !this.history.canUndo;
    $('#btn-redo').disabled = !this.history.canRedo;
    for (const id of ['#btn-export', '#btn-compare']) $(id).disabled = !this.img;
  }

  setCompare(on) {
    if (!this.img || this.compare === on) return;
    this.compare = on;
    $('#btn-compare').classList.toggle('on', on);
    this.stage.classList.toggle('comparing', on);
    this.requestRender();
  }

  toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => t.classList.remove('show'), ms);
  }

  busy(msg) {
    const b = $('#busy');
    b.textContent = msg || '';
    b.classList.toggle('show', !!msg);
  }

  // ---- loading ---------------------------------------------------------------------------------

  async loadFile(file) {
    if (this.history.canUndo && !confirm('Open a new photo? Your current edits will be lost unless you saved them.')) return;
    this.busy('Opening photo…');
    let bmp;
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      try {
        bmp = await new Promise((res, rej) => {
          const im = new Image();
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = URL.createObjectURL(file);
        });
      } catch {
        this.busy();
        this.toast("That file couldn't be opened. Try a JPG, PNG or WebP photo.", 4000);
        return;
      }
    }
    this.fileName = (file.name || 'photo').replace(/\.[^.]+$/, '');
    this.setImage(bmp);
    this.busy();
  }

  setImage(src) {
    const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
    const mobile = matchMedia('(pointer: coarse)').matches;
    const cap = Math.min(this.pipe.maxTex, mobile ? 3072 : 4096);
    const k = Math.min(1, cap / Math.max(sw, sh));
    const W = Math.max(1, Math.round(sw * k)), H = Math.max(1, Math.round(sh * k));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, W, H);
    src.close?.();
    const data = ctx.getImageData(0, 0, W, H);
    this.srcCanvas = c;
    this.img = { width: W, height: H, data: data.data };
    // Masks: half resolution, but at least 1024px (or full size) and at most 2048px on the long side.
    const long = Math.max(W, H);
    const mk = Math.min(2048, Math.max(Math.min(long, 1024), long / 2)) / long;
    this.mW = Math.max(1, Math.round(W * mk));
    this.mH = Math.max(1, Math.round(H * mk));
    this.pipe.setImage(new Uint8Array(data.data.buffer.slice(0)), W, H, this.mW, this.mH);
    this.brushBuf = new Uint8Array(this.mW * this.mH * 4);
    this.warp = new WarpField(W, H);
    this.pipe.setDisp(this.warp.combine(), this.warp.gw, this.warp.gh);
    this.faces = [];
    this.selectedFace = 'all';
    this.params = defaultParams();
    this.history.reset(this.params);
    this.view = null;
    this.autoAdjust = null;
    $('#drop').classList.add('hidden');
    this.stage.classList.add('has-image');
    this.syncTopbar();
    this.refreshPanel();
    this.requestRender();
    this.analyzeImage();
  }

  async analyzeImage() {
    const token = (this.loadToken = Symbol());
    const W = this.img.width, H = this.img.height;
    this.faceStatus = 'loading';
    this.personStatus = 'loading';
    this.refreshPanel();
    // Let the first frame paint before the (synchronous) WASM inference blocks the thread.
    await new Promise((r) => setTimeout(r, 60));
    try {
      const lms = await detect.detectFaces(this.srcCanvas);
      if (token !== this.loadToken) return;
      this.faces = lms.map((lm) => toPixels(lm, W, H));
      this.faces.sort((a, b) => faceMetrics(a).center[0] - faceMetrics(b).center[0]);
      this.faceStatus = 'done';
      if (this.faces.length) {
        const m = buildMasks(this.faces, W, H, this.mW, this.mH);
        this.pipe.setAutoMasks(m.a, m.b, m.sigmaA, m.sigmaB);
        const widths = this.faces.map((P) => faceMetrics(P).width).sort((a, b) => a - b);
        this.pipe.setSmoothRadius(Math.max(2, widths[widths.length >> 1] * 0.022));
      }
    } catch (e) {
      console.error(e);
      this.faceStatus = 'error';
    }
    this.refreshPanel();
    this.requestRender();
    await new Promise((r) => setTimeout(r, 30));
    try {
      const seg = await detect.segmentPerson(this.srcCanvas);
      if (token !== this.loadToken) return;
      if (seg && seg.coverage > 0.01) {
        this.pipe.setPerson(seg.mask, seg.width, seg.height);
        this.personStatus = 'done';
      } else this.personStatus = 'none';
    } catch (e) {
      console.error(e);
      this.personStatus = 'error';
    }
    this.refreshPanel();
    this.requestRender();
  }

  // ---- edits -----------------------------------------------------------------------------------

  selectFace(i) {
    this.selectedFace = i;
    if (this.tab !== 'face') this.setTab('face');
    else this.refreshPanel();
    this.input.drawOverlay();
  }

  shapeFor(i) {
    return (this.params.shape[i] ??= { ...SHAPE_DEFAULTS });
  }

  // Shape sliders changed: rebuild the face part of the displacement field.
  updateWarp() {
    if (!this.warp) return;
    this.warp.setFaces(this.faces, this.faces.map((_, i) => this.params.shape[i]));
    this.pipe.setDisp(this.warp.combine(), this.warp.gw, this.warp.gh);
    this.requestRender();
  }

  commit(label, rasters = []) {
    this.history.commit(this.params, label, rasters);
  }

  applyParams(p) {
    this.params = p;
    this.updateWarp();
    this.pipe.dirty.add('retouch');
    this.refreshPanel();
    this.requestRender();
  }

  undo() {
    const r = this.history.undo();
    if (r) { this.applyParams(r.params); this.toast('Undid ' + r.label, 1400); }
  }

  redo() {
    const r = this.history.redo();
    if (r) { this.applyParams(r.params); this.toast('Redid ' + r.label, 1400); }
  }

  // Raster record for a healed rectangle (undo puts the old pixels back).
  healRecord(rect) {
    const up = (px) => { putRect(this.img, rect, px); this.pipe.updateBase(new Uint8Array(px.buffer, px.byteOffset, px.byteLength), rect.x, rect.y, rect.w, rect.h); this.requestRender(); };
    return { undo: () => up(rect.before), redo: () => up(rect.after) };
  }

  applyHeal(rect) {
    this.pipe.updateBase(new Uint8Array(rect.after.buffer), rect.x, rect.y, rect.w, rect.h);
    this.requestRender();
    return this.healRecord(rect);
  }

  // Finds and heals blemishes on every face. Returns {count, rasters}.
  removeBlemishes(sensitivity = 1) {
    const rasters = [];
    let count = 0;
    for (const P of this.faces) {
      const skin = skinMaskForFace(P, this.img.width, this.img.height);
      const allowed = (x, y) => {
        const lx = x - skin.x0, ly = y - skin.y0;
        return lx >= 0 && ly >= 0 && lx < skin.w && ly < skin.h && skin.mask[ly * skin.w + lx] === 1;
      };
      for (const region of findBlemishes(this.img, skin, sensitivity)) {
        const r = heal(this.img, region, allowed);
        if (r) { rasters.push(this.applyHeal(r)); count++; }
      }
    }
    return { count, rasters };
  }

  // The headline feature: light, colour and face fixes in one tap, scaled by one slider.
  async magicFix() {
    if (!this.img) return;
    if (this.faceStatus === 'loading') {
      this.busy('Finding faces…');
      while (this.faceStatus === 'loading') await new Promise((r) => setTimeout(r, 100));
    }
    this.busy('Fixing your photo…');
    await new Promise((r) => setTimeout(r, 30));
    const hasFaces = this.faces.length > 0;
    this.autoAdjust = analyze(this.img, hasFaces);
    const p = this.params;
    p.magic.on = true;
    let rasters = [];
    if (hasFaces && !p.magic.healed) {
      const res = this.removeBlemishes(1);
      rasters = res.rasters;
      p.magic.healed = res.count || -1;
    }
    this.applyMagicStrength();
    this.commit('Fix my photo', rasters);
    this.busy();
    this.refreshPanel();
    const bits = ['light & colour'];
    if (hasFaces) bits.push('skin', 'eyes', 'teeth');
    if (p.magic.healed > 0) bits.push(`${p.magic.healed} blemish${p.magic.healed === 1 ? '' : 'es'}`);
    this.toast('Fixed ' + bits.join(', '));
  }

  applyMagicStrength() {
    const p = this.params;
    const k = p.magic.strength / 100;
    const a = this.autoAdjust || analyze(this.img, this.faces.length > 0);
    this.autoAdjust = a;
    for (const [key, v] of Object.entries(a)) p.adjust[key] = Math.round(v * k * 1.2);
    if (this.faces.length) for (const [key, v] of Object.entries(MAGIC_FACE)) p.face[key] = Math.round(v * k * 1.2);
    this.pipe.dirty.add('retouch');
    this.requestRender();
  }

  autoLight() {
    const a = analyze(this.img, this.faces.length > 0);
    Object.assign(this.params.adjust, a);
    this.commit('Auto light');
    this.refreshPanel();
    this.requestRender();
  }

  resetAll() {
    if (!confirm('Remove all edits and go back to the original photo?')) return;
    // Undo everything so healed pixels come back too, then drop the redo stack.
    while (this.history.canUndo) this.history.undo();
    this.history.entries.length = 0;
    this.history.index = -1;
    this.applyParams(defaultParams());
    this.history.reset(this.params);
  }

  // ---- view ------------------------------------------------------------------------------------

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.stage.getBoundingClientRect();
    this.dpr = dpr;
    for (const c of [this.glCanvas, this.overlay]) {
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
    }
    this.requestRender();
  }

  frame() {
    return makeFrame({
      crop: this.params.crop, W: this.img.width, H: this.img.height,
      vw: this.glCanvas.width, vh: this.glCanvas.height, view: this.view,
      cropping: this.tab === 'crop', pad: 24 * this.dpr,
    });
  }

  zoomBy(f, at) {
    if (!this.img) return;
    const fr = this.frame();
    const vw = this.glCanvas.width, vh = this.glCanvas.height;
    at ??= [vw / 2, vh / 2];
    const zoom = Math.max(fr.fitZoom * 0.5, Math.min(fr.fitZoom * 40, fr.zoom * f, 16));
    // Keep the frame point under the cursor fixed.
    const fx = fr.cx + (at[0] - vw / 2) / fr.zoom, fy = fr.cy + (at[1] - vh / 2) / fr.zoom;
    this.view = { zoom, cx: fx - (at[0] - vw / 2) / zoom, cy: fy - (at[1] - vh / 2) / zoom };
    if (Math.abs(zoom - fr.fitZoom) / fr.fitZoom < 0.02) this.view = null;
    this.requestRender();
  }

  requestRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  faceUniforms() {
    const f = { ...FACE_DEFAULTS, ...this.params.face };
    const has = this.faces.length > 0;
    const eye = EYE_COLORS[f.eyeColor], lip = LIP_COLORS[f.lipColor];
    return {
      smooth: has ? f.smooth / 100 : 0, shine: has ? f.shine / 100 : 0, underEye: has ? f.underEye / 100 : 0,
      teeth: has ? f.teeth / 100 : 0, eyes: has ? f.eyes / 100 : 0,
      eyeColor: eye || [0, 0, 0], eyeColorAmt: has && eye ? f.eyeColorAmt / 100 : 0,
      lipColor: lip || [0, 0, 0], lipAmt: has && lip ? f.lipAmt / 100 : 0,
    };
  }

  bgUniforms() {
    const b = this.params.bg;
    return { mode: b.mode, light: b.light / 100 };
  }

  render() {
    const gl = this.pipe.gl;
    if (!this.img) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    const bg = this.params.bg;
    this.pipe.setBgBlur(bg.mode === 'blur' ? bg.blur / 100 : 0);
    this.pipe.update(this.faceUniforms(), this.bgUniforms());
    const fr = this.frame();
    this.lastFrame = fr;
    const { adj, look } = resolveAdjust(this.params.adjust, this.params.look);
    const outside = getComputedStyle(this.stage).getPropertyValue('--stage-rgb').trim().split(',').map((v) => +v / 255);
    this.pipe.final(null, { ...fr, outside: [...(outside.length === 3 ? outside : [0.07, 0.07, 0.08]), 1] }, adj, look, {
      raw: this.compare, checker: true, fill: this.compare ? null : bgFill(this),
    });
    this.input.drawOverlay();
    this.onRendered?.();
  }
}

window.app = new App();

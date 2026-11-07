// Pointer handling on the photo: brushes, crop handles, pan/zoom (wheel, pinch, space-drag),
// and the overlay (brush ring, crop frame, face numbers).

import { apply, invA, cropRect, rectInside, aspectValue } from '../geometry.js';
import { heal } from '../retouch/heal.js';
import { faceMetrics } from '../face/landmarks.js';

const BRUSH_CHANNELS = { smooth: 0, whiten: 1, details: 2 };

export class Input {
  constructor(app) {
    this.app = app;
    this.el = app.overlay;
    this.ctx = this.el.getContext('2d');
    this.pointers = new Map();
    this.spaceDown = false;
    this.hover = null;
    this.stroke = null;
    const el = this.el;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('pointerleave', () => { this.hover = null; this.drawOverlay(); });
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    el.addEventListener('dblclick', (e) => this.dblclick(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  pos(e) {
    const r = this.el.getBoundingClientRect();
    return [(e.clientX - r.left) * this.app.dpr, (e.clientY - r.top) * this.app.dpr];
  }

  get brushing() {
    return this.app.tab === 'retouch' && this.app.img;
  }

  // Screen (device px) → displayed image px, and → original image px (through the warp).
  toImage(p) {
    return apply(this.app.lastFrame.toImgPx, p);
  }

  down(e) {
    const app = this.app;
    if (!app.img) return;
    this.el.setPointerCapture(e.pointerId);
    const p = this.pos(e);
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      // Second finger: abandon any stroke and start a pinch.
      this.cancelStroke();
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
      return;
    }
    if (this.pointers.size > 2) return;
    const tag = this.faceTagAt(p);
    if (tag != null) { app.selectFace(tag); return; }
    const panButton = e.button === 1 || e.button === 2 || this.spaceDown;
    if (panButton || (!this.brushing && app.tab !== 'crop')) {
      if (app.view || panButton) this.pan = { last: p };
      return;
    }
    if (app.tab === 'crop') return this.cropDown(p);
    this.startStroke(p);
  }

  move(e) {
    const p = this.pos(e);
    this.hover = p;
    const app = this.app;
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      this.panBy(c[0] - this.pinch.c[0], c[1] - this.pinch.c[1]);
      app.zoomBy(d / this.pinch.d, c);
      this.pinch = { d, c };
      return;
    }
    if (this.pan) {
      this.panBy(p[0] - this.pan.last[0], p[1] - this.pan.last[1]);
      this.pan.last = p;
      return;
    }
    if (this.cropDrag) return this.cropMove(p);
    if (this.stroke) this.continueStroke(p);
    this.drawOverlay();
    this.el.style.cursor = this.cursorFor(p);
  }

  up(e, cancel = false) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pan) { this.pan = null; return; }
    if (this.cropDrag) { this.cropDrag = null; this.app.commit('Crop'); this.app.requestRender(); return; }
    if (this.stroke) cancel ? this.cancelStroke() : this.endStroke();
  }

  panBy(dx, dy) {
    const app = this.app;
    const fr = app.lastFrame;
    app.view = { zoom: fr.zoom, cx: fr.cx - dx / fr.zoom, cy: fr.cy - dy / fr.zoom };
    app.requestRender();
  }

  wheel(e) {
    if (!this.app.img) return;
    e.preventDefault();
    const p = this.pos(e);
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2 && e.deltaMode === 0 && !e.shiftKey) {
      this.app.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), p);
    } else {
      this.panBy(-e.deltaX, -e.deltaY);
    }
  }

  dblclick(e) {
    const app = this.app;
    if (!app.img || this.brushing || app.tab === 'crop') return;
    if (app.view) { app.view = null; app.requestRender(); return; }
    const fr = app.lastFrame;
    app.zoomBy(Math.max(2, 1 / fr.zoom / (app.dpr || 1)), this.pos(e));
  }

  cursorFor(p) {
    const app = this.app;
    if (!app.img) return 'default';
    if (this.spaceDown || this.pan) return 'grab';
    if (this.brushing) return 'none';
    if (app.tab === 'crop') {
      const hnd = this.cropHit(p);
      return hnd ? ({ move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' })[hnd] : 'default';
    }
    return app.view ? 'grab' : 'default';
  }

  // ---- brushes ---------------------------------------------------------------------------------

  brushRadiusImg() {
    return (this.app.brush.size / 2) * this.app.dpr * this.app.lastFrame.pxScale;
  }

  startStroke(p) {
    const app = this.app;
    const tool = app.tool;
    const q = this.toImage(p);
    this.stroke = { tool, last: q, pts: [q], screen: [p] };
    if (tool in BRUSH_CHANNELS || tool === 'eraser') {
      this.stroke.before = app.brushBuf.slice();
      this.stroke.dirty = null;
      this.stamp(q);
    } else if (tool === 'reshape' || tool === 'unshape') {
      this.stroke.before = app.warp.liq.slice();
      if (tool === 'unshape') this.unshape(q);
    }
    this.drawOverlay();
  }

  continueStroke(p) {
    const app = this.app;
    const s = this.stroke;
    const q = this.toImage(p);
    const r = this.brushRadiusImg();
    const dist = Math.hypot(q[0] - s.last[0], q[1] - s.last[1]);
    if (s.tool === 'reshape') {
      if (dist < 0.5) return;
      app.warp.push(s.last, q, r, 0.6 + (app.brush.strength / 100) * 0.4);
      s.last = q;
      app.pipe.setDisp(app.warp.combine(), app.warp.gw, app.warp.gh);
      app.requestRender();
      return;
    }
    const spacing = Math.max(1, r * 0.2);
    if (dist < spacing) return;
    const n = Math.ceil(dist / spacing);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const pt = [s.last[0] + (q[0] - s.last[0]) * t, s.last[1] + (q[1] - s.last[1]) * t];
      if (s.tool === 'heal') s.pts.push(pt);
      else if (s.tool === 'unshape') this.unshape(pt);
      else this.stamp(pt);
    }
    s.screen.push(p);
    s.last = q;
    if (s.tool === 'unshape') { app.pipe.setDisp(app.warp.combine(), app.warp.gw, app.warp.gh); app.requestRender(); }
  }

  unshape(q) {
    this.app.warp.restore(q, this.brushRadiusImg(), 0.12 + this.app.brush.strength / 400);
  }

  // Soft round stamp into the brush mask buffer (mask resolution, original-image space).
  stamp(q) {
    const app = this.app;
    const src = app.warp.toSource(q[0], q[1]);
    const k = app.mW / app.img.width;
    const cx = src[0] * k, cy = src[1] * k;
    const r = Math.max(1, this.brushRadiusImg() * k);
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(app.mW - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(app.mH - 1, Math.ceil(cy + r));
    if (x1 < x0 || y1 < y0) return;
    const buf = app.brushBuf;
    const strength = app.brush.strength / 100;
    const tool = this.stroke.tool;
    const ch = BRUSH_CHANNELS[tool];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d >= 1) continue;
        const f = d < 0.5 ? 1 : 1 - (d - 0.5) / 0.5;
        const v = Math.round(255 * strength * f * f * (3 - 2 * f));
        const i = (y * app.mW + x) * 4;
        if (tool === 'eraser') {
          for (let c = 0; c < 3; c++) buf[i + c] = Math.min(buf[i + c], 255 - v);
          buf[i + 3] = Math.max(buf[i + 3], v);
        } else {
          buf[i + ch] = Math.max(buf[i + ch], v);
          buf[i + 3] = Math.min(buf[i + 3], 255 - v);
        }
      }
    }
    const d = this.stroke.dirty;
    this.stroke.dirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1];
    this.uploadBrush([x0, y0, x1, y1]);
  }

  uploadBrush([x0, y0, x1, y1]) {
    const app = this.app;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) out.set(app.brushBuf.subarray(((y0 + y) * app.mW + x0) * 4, ((y0 + y) * app.mW + x0 + w) * 4), y * w * 4);
    app.pipe.updateBrush(out, x0, y0, w, h);
    app.requestRender();
  }

  cancelStroke() {
    const s = this.stroke;
    if (!s) return;
    const app = this.app;
    if (s.before && s.dirty) { app.brushBuf.set(s.before); this.uploadBrush([0, 0, app.mW - 1, app.mH - 1]); }
    if (s.before && (s.tool === 'reshape' || s.tool === 'unshape')) {
      app.warp.liq.set(s.before);
      app.pipe.setDisp(app.warp.combine(), app.warp.gw, app.warp.gh);
    }
    this.stroke = null;
    app.requestRender();
  }

  endStroke() {
    const s = this.stroke;
    this.stroke = null;
    const app = this.app;
    const labels = { smooth: 'Smooth brush', whiten: 'Whiten brush', details: 'Details brush', eraser: 'Eraser', reshape: 'Reshape', unshape: 'Restore shape', heal: 'Heal' };
    if (s.tool === 'heal') return this.finishHeal(s);
    if (s.tool === 'reshape' || s.tool === 'unshape') {
      const before = s.before, after = app.warp.liq.slice();
      const set = (v) => { app.warp.liq.set(v); app.pipe.setDisp(app.warp.combine(), app.warp.gw, app.warp.gh); app.requestRender(); };
      app.commit(labels[s.tool], [{ undo: () => set(before), redo: () => set(after) }]);
      return;
    }
    if (!s.dirty) return;
    const [x0, y0, x1, y1] = s.dirty;
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const grab = (buf) => {
      const out = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) out.set(buf.subarray(((y0 + y) * app.mW + x0) * 4, ((y0 + y) * app.mW + x0 + w) * 4), y * w * 4);
      return out;
    };
    const before = grab(s.before), after = grab(app.brushBuf);
    const put = (px) => {
      for (let y = 0; y < h; y++) app.brushBuf.set(px.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * app.mW + x0) * 4);
      app.pipe.updateBrush(px, x0, y0, w, h);
      app.requestRender();
    };
    app.commit(labels[s.tool], [{ undo: () => put(before), redo: () => put(after) }]);
    this.drawOverlay();
  }

  // Heal: rasterise the stroke (in original-image space) and fix it in one go on release.
  finishHeal(s) {
    const app = this.app;
    const r = this.brushRadiusImg();
    const pts = s.pts.map((q) => app.warp.toSource(q[0], q[1]));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r); x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r); }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(app.img.width - 1, Math.ceil(x1)); y1 = Math.min(app.img.height - 1, Math.ceil(y1));
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w < 2 || h < 2) { this.drawOverlay(); return; }
    if (w * h > 1600 * 1600) { app.toast('That area is too big to heal in one go — try smaller strokes.'); this.drawOverlay(); return; }
    const mask = new Uint8Array(w * h);
    const r2 = r * r;
    for (const p of pts) {
      const cx = p[0] - x0, cy = p[1] - y0;
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r2) mask[y * w + x] = 1;
        }
      }
    }
    app.busy('Healing…');
    this.healPreview = s.screen;
    this.drawOverlay();
    setTimeout(() => {
      const res = heal(app.img, { x0, y0, w, h, mask });
      app.busy();
      this.healPreview = null;
      if (!res) { app.toast("Couldn't find a clean patch nearby — try a smaller brush."); this.drawOverlay(); return; }
      app.commit('Heal', [app.applyHeal(res)]);
    }, 16);
  }

  // ---- crop ------------------------------------------------------------------------------------

  // Crop rect corners in screen space.
  cropScreen() {
    const app = this.app;
    const fr = app.lastFrame;
    const r = cropRect(app.params.crop, app.img.width, app.img.height);
    const toScreen = invA(fr.screenToFrame);
    const a = apply(toScreen, [r.x, r.y]), b = apply(toScreen, [r.x + r.w, r.y + r.h]);
    return { x0: a[0], y0: a[1], x1: b[0], y1: b[1], r };
  }

  cropHit(p) {
    const s = this.cropScreen();
    const tol = 18 * this.app.dpr;
    const nearX0 = Math.abs(p[0] - s.x0) < tol, nearX1 = Math.abs(p[0] - s.x1) < tol;
    const nearY0 = Math.abs(p[1] - s.y0) < tol, nearY1 = Math.abs(p[1] - s.y1) < tol;
    const inX = p[0] > s.x0 - tol && p[0] < s.x1 + tol, inY = p[1] > s.y0 - tol && p[1] < s.y1 + tol;
    if (!inX || !inY) return null;
    let v = nearY0 ? 'n' : nearY1 ? 's' : '';
    let hz = nearX0 ? 'w' : nearX1 ? 'e' : '';
    if (v || hz) return v + hz;
    if (p[0] > s.x0 && p[0] < s.x1 && p[1] > s.y0 && p[1] < s.y1) return 'move';
    return null;
  }

  cropDown(p) {
    const hnd = this.cropHit(p);
    if (!hnd) return;
    const app = this.app;
    this.cropDrag = { hnd, start: apply(app.lastFrame.screenToFrame, p), rect: { ...cropRect(app.params.crop, app.img.width, app.img.height) } };
  }

  cropMove(p) {
    const app = this.app;
    const { W, H } = { W: app.img.width, H: app.img.height };
    const crop = app.params.crop;
    const d = this.cropDrag;
    const f = apply(app.lastFrame.screenToFrame, p);
    const dx = f[0] - d.start[0], dy = f[1] - d.start[1];
    const a = aspectValue(crop, W, H);
    const make = (t) => {
      const r = { ...d.rect };
      const mx = dx * t, my = dy * t;
      if (d.hnd === 'move') { r.x += mx; r.y += my; return r; }
      if (d.hnd.includes('w')) { r.x += mx; r.w -= mx; }
      if (d.hnd.includes('e')) r.w += mx;
      if (d.hnd.includes('n')) { r.y += my; r.h -= my; }
      if (d.hnd.includes('s')) r.h += my;
      if (a) {
        // Keep the aspect: the dominant edge drives, the other follows around the fixed side.
        if (d.hnd === 'n' || d.hnd === 's') { const nw = r.h * a; r.x += (r.w - nw) / 2; r.w = nw; }
        else if (d.hnd === 'e' || d.hnd === 'w') { const nh = r.w / a; r.y += (r.h - nh) / 2; r.h = nh; }
        else {
          const nh = r.w / a;
          if (d.hnd.includes('n')) r.y += r.h - nh;
          r.h = nh;
        }
      }
      return r;
    };
    let r = make(1);
    if (r.w < 16 || r.h < 16 || !rectInside(crop, W, H, r)) {
      // Slide as far as allowed.
      let lo = 0, hi = 1;
      for (let i = 0; i < 12; i++) {
        const m = (lo + hi) / 2;
        const t = make(m);
        if (t.w >= 16 && t.h >= 16 && rectInside(crop, W, H, t)) lo = m; else hi = m;
      }
      r = make(lo);
    }
    crop.rect = r;
    app.requestRender();
  }

  // ---- overlay ---------------------------------------------------------------------------------

  drawOverlay() {
    const app = this.app;
    const ctx = this.ctx;
    const dpr = app.dpr || 1;
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    if (!app.img || !app.lastFrame || app.compare) return;
    if (app.tab === 'crop') this.drawCrop(ctx, dpr);
    if (app.tab === 'face' && app.faces.length > 1) this.drawFaceTags(ctx, dpr);
    if (this.healPreview || (this.stroke?.tool === 'heal')) {
      const pts = this.healPreview || this.stroke.screen;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 92, 120, 0.55)';
      ctx.lineWidth = app.brush.size * dpr;
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      if (pts.length === 1) ctx.lineTo(pts[0][0] + 0.1, pts[0][1]);
      ctx.stroke();
      ctx.restore();
    }
    if (this.brushing && this.hover && !this.pan && !this.pinch) {
      const [x, y] = this.hover;
      const r = (app.brush.size / 2) * dpr;
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.stroke();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      if (app.tool !== 'heal' && app.tool !== 'reshape') {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.5, 0, Math.PI * 2);
        ctx.setLineDash([3 * dpr, 4 * dpr]);
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawCrop(ctx, dpr) {
    const s = this.cropScreen();
    const w = this.el.width, h = this.el.height;
    ctx.save();
    ctx.fillStyle = 'rgba(10,10,12,0.62)';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.rect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1 * dpr;
    for (let i = 1; i < 3; i++) {
      const x = s.x0 + ((s.x1 - s.x0) * i) / 3, y = s.y0 + ((s.y1 - s.y0) * i) / 3;
      ctx.beginPath(); ctx.moveTo(x, s.y0); ctx.lineTo(x, s.y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s.x0, y); ctx.lineTo(s.x1, y); ctx.stroke();
    }
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * dpr;
    ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
    ctx.lineWidth = 4 * dpr;
    ctx.lineCap = 'round';
    const L = 18 * dpr;
    for (const [x, y, sx, sy] of [[s.x0, s.y0, 1, 1], [s.x1, s.y0, -1, 1], [s.x0, s.y1, 1, -1], [s.x1, s.y1, -1, -1]]) {
      ctx.beginPath(); ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L); ctx.stroke();
    }
    ctx.restore();
  }

  faceTagPositions() {
    const app = this.app;
    if (app.tab !== 'face' || app.faces.length < 2 || !app.lastFrame) return [];
    const toScreen = invA(app.lastFrame.toImgPx);
    const dpr = app.dpr || 1;
    return app.faces.map((P) => {
      const m = faceMetrics(P);
      const [x, y] = apply(toScreen, [(m.box.x0 + m.box.x1) / 2, m.box.y0]);
      return [x, y - 16 * dpr];
    });
  }

  faceTagAt(p) {
    const r = 14 * (this.app.dpr || 1);
    const i = this.faceTagPositions().findIndex(([x, y]) => Math.hypot(p[0] - x, p[1] - y) < r);
    return i < 0 ? null : i;
  }

  drawFaceTags(ctx, dpr) {
    const app = this.app;
    this.faceTagPositions().forEach(([x, y0], i) => {
      const y = y0 + 16 * dpr;
      const sel = app.selectedFace === i;
      ctx.save();
      ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.beginPath();
      ctx.arc(x, y - 16 * dpr, 11 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = sel ? '#ff7a59' : 'rgba(20,20,24,0.75)';
      ctx.fill();
      ctx.lineWidth = 1.5 * dpr;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(String(i + 1), x, y - 16 * dpr);
      ctx.restore();
    });
  }
}


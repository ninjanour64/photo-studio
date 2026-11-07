// The GPU pipeline. Passes only re-run when their inputs change:
//
//   base ──warp(disp)──▶ W ──bilateral──▶ S (½ res)
//                         │──premultiplied bg blur──▶ BG (¼ res)
//   W,S,masks,brush,person ──retouch──▶ R (full res, mipmapped) ──blur──▶ MID (¼ res)
//   R,MID ──adjust/look/crop/view──▶ screen or export framebuffer

import { createProgram, createTexture, createTarget, deleteTarget } from './glutil.js';
import * as S from './shaders.js';

const affineToMat3 = (m) => new Float32Array([m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);

export class Pipeline {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.canvas = canvas;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.p = {};
    for (const [k, src] of Object.entries({
      warp: S.WARP_FS, copy: S.COPY_FS, blur: S.BLUR_FS, bilateral: S.BILATERAL_FS,
      person: S.PERSON_FS, bgpre: S.BGPRE_FS, retouch: S.RETOUCH_FS, final: S.FINAL_FS,
    })) this.p[k] = createProgram(gl, src);
    this.dirty = new Set();
    this.ready = false;
  }

  // ---- setup -----------------------------------------------------------------------------------

  setImage(origData, W, H, maskW, maskH) {
    const gl = this.gl;
    this.dispose();
    this.W = W; this.H = H; this.mW = maskW; this.mH = maskH;
    const mk = (w, h, mips = false) => createTarget(gl, w, h, mips);
    this.tOrig = createTexture(gl, W, H, { data: origData, mips: true });
    gl.generateMipmap(gl.TEXTURE_2D);
    this.tBase = createTexture(gl, W, H, { data: origData, mips: true });
    gl.generateMipmap(gl.TEXTURE_2D);
    this.tDisp = createTexture(gl, 2, 2, { internal: gl.RG16F, format: gl.RG, type: gl.FLOAT, data: new Float32Array(8) });
    const zero = new Uint8Array(4);
    this.tMaskARaw = createTexture(gl, 1, 1, { data: zero });
    this.tMaskBRaw = createTexture(gl, 1, 1, { data: zero });
    this.tPersonRaw = createTexture(gl, 1, 1, { data: new Uint8Array([255, 255, 255, 255]) });
    this.tBrush = createTexture(gl, maskW, maskH, { data: new Uint8Array(maskW * maskH * 4) });

    this.fW = mk(W, H, true);
    this.fS = mk(W / 2, H / 2);
    this.fR = mk(W, H, true);
    const qw = Math.max(1, W / 4), qh = Math.max(1, H / 4);
    this.fMid = mk(qw, qh); this.fMidTmp = mk(qw, qh);
    this.fBG = mk(qw, qh); this.fBGTmp = mk(qw, qh);
    this.fMaskA = mk(1, 1); this.fMaskB = mk(1, 1); this.fMaskTmp = null;
    this.fPerson = mk(1, 1);
    this.clearTarget(this.fMaskA, [0, 0, 0, 0]);
    this.clearTarget(this.fMaskB, [0, 0, 0, 0]);
    this.clearTarget(this.fPerson, [1, 1, 1, 1]);
    this.hasPerson = false;
    this.smoothRadius = Math.max(2, Math.max(W, H) * 0.004);
    this.bgBlur = 0;
    this.ready = true;
    this.dirty = new Set(['warp']);
  }

  dispose() {
    const gl = this.gl;
    for (const k of ['tOrig', 'tBase', 'tDisp', 'tMaskARaw', 'tMaskBRaw', 'tPersonRaw', 'tBrush']) {
      if (this[k]) gl.deleteTexture(this[k].tex);
      this[k] = null;
    }
    for (const k of ['fW', 'fS', 'fR', 'fMid', 'fMidTmp', 'fBG', 'fBGTmp', 'fMaskA', 'fMaskB', 'fMaskTmp', 'fPerson']) {
      deleteTarget(gl, this[k]);
      this[k] = null;
    }
    this.ready = false;
  }

  clearTarget(t, rgba) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearColor(...rgba);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // ---- inputs ----------------------------------------------------------------------------------

  updateBase(data, x, y, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tBase.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.dirty.add('warp');
  }

  setDisp(field, gw, gh) {
    const gl = this.gl;
    if (this.tDisp.w !== gw || this.tDisp.h !== gh) {
      gl.deleteTexture(this.tDisp.tex);
      this.tDisp = createTexture(gl, gw, gh, { internal: gl.RG16F, format: gl.RG, type: gl.FLOAT, data: field });
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.tDisp.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gw, gh, gl.RG, gl.FLOAT, field);
    }
    this.dirty.add('warp');
  }

  // Auto masks arrive as two RGBA buffers at mask resolution plus a feather (sigma, in mask px).
  setAutoMasks(a, b, sigmaA, sigmaB) {
    const gl = this.gl;
    const { mW, mH } = this;
    for (const k of ['tMaskARaw', 'tMaskBRaw']) gl.deleteTexture(this[k].tex);
    this.tMaskARaw = createTexture(gl, mW, mH, { data: a });
    this.tMaskBRaw = createTexture(gl, mW, mH, { data: b });
    for (const k of ['fMaskA', 'fMaskB', 'fMaskTmp']) deleteTarget(gl, this[k]);
    this.fMaskA = createTarget(gl, mW, mH);
    this.fMaskB = createTarget(gl, mW, mH);
    this.fMaskTmp = createTarget(gl, mW, mH);
    this.blur2(this.tMaskARaw, this.fMaskTmp, this.fMaskA, sigmaA);
    this.blur2(this.tMaskBRaw, this.fMaskTmp, this.fMaskB, sigmaB);
    this.dirty.add('retouch');
  }

  updateBrush(rgba, x, y, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tBrush.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    this.dirty.add('retouch');
  }

  setPerson(mask8, w, h) {
    const gl = this.gl;
    gl.deleteTexture(this.tPersonRaw.tex);
    this.tPersonRaw = createTexture(gl, w, h, { internal: gl.R8, format: gl.RED, data: mask8 });
    deleteTarget(gl, this.fPerson);
    this.fPerson = createTarget(gl, this.mW, this.mH);
    const p = this.use('person', this.fPerson);
    this.bindTex(0, this.tPersonRaw, p.uniforms.uMask);
    this.bindTex(1, this.tOrig, p.uniforms.uGuide);
    gl.uniform2f(p.uniforms.uGuideSize, this.W, this.H);
    const radius = Math.max(this.W, this.H) * 0.008;
    gl.uniform1f(p.uniforms.uRadius, radius);
    gl.uniform1f(p.uniforms.uLod, Math.max(0, Math.log2(this.W / this.mW)));
    this.draw();
    this.hasPerson = true;
    this.dirty.add('bg');
    this.dirty.add('retouch');
  }

  setSmoothRadius(r) {
    if (Math.abs(r - this.smoothRadius) < 0.01) return;
    this.smoothRadius = r;
    this.dirty.add('smooth');
  }

  setBgBlur(amount) {
    if (amount === this.bgBlur) return;
    this.bgBlur = amount;
    this.dirty.add('bg');
  }

  // ---- passes ----------------------------------------------------------------------------------

  use(name, target) {
    const gl = this.gl;
    const p = this.p[name];
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    const w = target ? target.w : this.canvas.width;
    const h = target ? target.h : this.canvas.height;
    gl.viewport(0, 0, w, h);
    if (p.uniforms.uOut) gl.uniform2f(p.uniforms.uOut, w, h);
    return p;
  }

  bindTex(unit, t, loc) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.uniform1i(loc, unit);
  }

  draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  blur2(src, tmp, dst, sigmaPx) {
    const gl = this.gl;
    const step = Math.max(1, (sigmaPx * 3) / 24);
    const sigmaTaps = Math.max(0.35, sigmaPx / step);
    let p = this.use('blur', tmp);
    this.bindTex(0, src, p.uniforms.uSrc);
    gl.uniform2f(p.uniforms.uDir, step / src.w, 0);
    gl.uniform1f(p.uniforms.uSigma, sigmaTaps);
    this.draw();
    p = this.use('blur', dst);
    this.bindTex(0, tmp, p.uniforms.uSrc);
    gl.uniform2f(p.uniforms.uDir, 0, step / tmp.h);
    gl.uniform1f(p.uniforms.uSigma, sigmaTaps);
    this.draw();
  }

  genMips(t) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  update(face, bg) {
    const gl = this.gl;
    const d = this.dirty;
    if (d.has('warp')) {
      const p = this.use('warp', this.fW);
      this.bindTex(0, this.tBase, p.uniforms.uBase);
      this.bindTex(1, this.tDisp, p.uniforms.uDisp);
      gl.uniform2f(p.uniforms.uImgSize, this.W, this.H);
      this.draw();
      this.genMips(this.fW);
      d.delete('warp');
      d.add('smooth'); d.add('bg'); d.add('retouch');
    }
    if (d.has('smooth')) {
      const p = this.use('bilateral', this.fS);
      this.bindTex(0, this.fW, p.uniforms.uSrc);
      gl.uniform2f(p.uniforms.uSrcSize, this.W, this.H);
      gl.uniform1f(p.uniforms.uRadius, this.smoothRadius);
      gl.uniform1f(p.uniforms.uRange, 0.085);
      this.draw();
      d.delete('smooth');
      d.add('retouch');
    }
    if (d.has('bg')) {
      if (this.hasPerson && this.bgBlur > 0) {
        const p = this.use('bgpre', this.fBG);
        this.bindTex(0, this.fW, p.uniforms.uW);
        this.bindTex(1, this.fPerson, p.uniforms.uPerson);
        this.bindTex(2, this.tDisp, p.uniforms.uDisp);
        gl.uniform2f(p.uniforms.uImgSize, this.W, this.H);
        gl.uniform1f(p.uniforms.uLod, 2);
        this.draw();
        // Two blur rounds approximate a wider, rounder bokeh than one long gaussian.
        const sigma = (Math.max(this.fBG.w, this.fBG.h) * 0.022) * this.bgBlur;
        this.blur2(this.fBG, this.fBGTmp, this.fBG, sigma);
        this.blur2(this.fBG, this.fBGTmp, this.fBG, sigma * 0.6);
      }
      d.delete('bg');
      d.add('retouch');
    }
    if (d.has('retouch')) {
      const p = this.use('retouch', this.fR);
      const u = p.uniforms;
      this.bindTex(0, this.fW, u.uW);
      this.bindTex(1, this.fS, u.uS);
      this.bindTex(2, this.fMaskA, u.uMaskA);
      this.bindTex(3, this.fMaskB, u.uMaskB);
      this.bindTex(4, this.tBrush, u.uBrush);
      this.bindTex(5, this.fPerson, u.uPerson);
      this.bindTex(6, this.fBG, u.uBg);
      this.bindTex(7, this.tDisp, u.uDisp);
      gl.uniform2f(u.uImgSize, this.W, this.H);
      gl.uniform1f(u.uSmooth, face.smooth);
      gl.uniform1f(u.uShine, face.shine);
      gl.uniform1f(u.uUnderEye, face.underEye);
      gl.uniform1f(u.uUnderChin, face.underChin || 0);
      gl.uniform3fv(u.uSkin, face.skin || [0.7, 0.55, 0.45]);
      gl.uniform1f(u.uTeeth, face.teeth);
      gl.uniform1f(u.uEyes, face.eyes);
      gl.uniform1f(u.uEyeColorAmt, face.eyeColorAmt);
      gl.uniform3fv(u.uEyeColor, face.eyeColor);
      gl.uniform1f(u.uLipAmt, face.lipAmt);
      gl.uniform3fv(u.uLipColor, face.lipColor);
      const mode = { none: 0, blur: 1, bw: 2, remove: 3 }[bg.mode] ?? 0;
      gl.uniform1i(u.uBgMode, this.hasPerson ? mode : 0);
      gl.uniform1f(u.uBgLight, bg.light);
      gl.uniform1f(u.uHasPerson, this.hasPerson ? 1 : 0);
      this.draw();
      this.genMips(this.fR);
      d.delete('retouch');
      d.add('mid');
    }
    if (d.has('mid')) {
      const p = this.use('copy', this.fMid);
      this.bindTex(0, this.fR, p.uniforms.uSrc);
      gl.uniform1f(p.uniforms.uLod, 2);
      this.draw();
      this.blur2(this.fMid, this.fMidTmp, this.fMid, Math.max(this.fMid.w, this.fMid.h) * 0.012);
      d.delete('mid');
    }
  }

  // frame: {toImg, toCrop (affines, screen px -> uv), cropPx:[w,h], pxScale, outside:[r,g,b,a]}
  final(target, frame, adj, look, opts) {
    const gl = this.gl;
    const p = this.use('final', target);
    const u = p.uniforms;
    this.bindTex(0, opts.raw ? this.tOrig : this.fR, u.uImg);
    this.bindTex(1, this.fMid, u.uMid);
    gl.uniformMatrix3fv(u.uToImg, false, affineToMat3(frame.toImg));
    gl.uniformMatrix3fv(u.uToCrop, false, affineToMat3(frame.toCrop));
    gl.uniform2f(u.uImgSize, this.W, this.H);
    gl.uniform2f(u.uCropPx, frame.cropPx[0], frame.cropPx[1]);
    gl.uniform1f(u.uViewH, target ? target.h : this.canvas.height);
    gl.uniform1f(u.uPxScale, frame.pxScale);
    gl.uniform1i(u.uRaw, opts.raw ? 1 : 0);
    gl.uniform1f(u.uChecker, opts.checker ? 1 : 0);
    gl.uniform4fv(u.uFill, opts.fill || [0, 0, 0, 0]);
    gl.uniform4fv(u.uOutside, frame.outside || [0, 0, 0, 0]);
    for (const [k, v] of Object.entries(adj)) if (u['u' + k[0].toUpperCase() + k.slice(1)]) gl.uniform1f(u['u' + k[0].toUpperCase() + k.slice(1)], v);
    gl.uniform3fv(u.uSplitShadow, look.splitShadow);
    gl.uniform3fv(u.uSplitHigh, look.splitHigh);
    gl.uniform1f(u.uBW, look.bw);
    this.draw();
  }

  readTarget(w, h, frame, adj, look, opts) {
    const gl = this.gl;
    const t = createTarget(gl, w, h);
    this.final(t, frame, adj, look, opts);
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    deleteTarget(gl, t);
    // readPixels is bottom-up; flip into ImageData order.
    const out = new Uint8ClampedArray(w * h * 4);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }
}

// Edit state: every slider/toggle lives in `params` (plain JSON, cheap to snapshot); pixel-level
// edits (heal, brush masks, liquify) live in typed arrays owned by their modules and record their
// own before/after rectangles into the same history entries.

export const ADJUST_DEFAULTS = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  temp: 0, tint: 0, vibrance: 0, saturation: 0,
  clarity: 0, dehaze: 0, sharpen: 0, glow: 0, fade: 0, vignette: 0, grain: 0,
};

export const FACE_DEFAULTS = {
  smooth: 0, shine: 0, underEye: 0, teeth: 0, eyes: 0,
  eyeColor: 'none', eyeColorAmt: 60, lipColor: 'none', lipAmt: 50,
};

export const SHAPE_DEFAULTS = {
  slim: 0, jaw: 0, chin: 0, forehead: 0, eyes: 0, noseSlim: 0, noseSmall: 0, lips: 0, smile: 0,
};

export const BG_DEFAULTS = { mode: 'none', blur: 60, light: 0, fill: 'transparent' };

export const CROP_DEFAULTS = { rot: 0, straighten: 0, flipH: false, flipV: false, rect: null, aspect: 'original' };

export function defaultParams(faceCount = 0) {
  return {
    adjust: { ...ADJUST_DEFAULTS },
    look: { id: 'none', strength: 80 },
    face: { ...FACE_DEFAULTS },
    shape: Array.from({ length: faceCount }, () => ({ ...SHAPE_DEFAULTS })),
    bg: { ...BG_DEFAULTS },
    crop: { ...CROP_DEFAULTS },
    magic: { on: false, strength: 70, healed: 0 },
  };
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------------------------------------
// History. An entry is {label, before, after, rasters:[{undo(), redo()}]}.
// `commit()` diffs the live params against the last committed snapshot, so callers just mutate
// `state.params` while dragging and commit once on release.

export class History {
  constructor(onChange) {
    this.entries = [];
    this.index = -1; // entries[0..index] are applied
    this.onChange = onChange;
    this.snapshot = null;
    this.limit = 60;
  }

  reset(params) {
    this.entries = [];
    this.index = -1;
    this.snapshot = clone(params);
    this.onChange?.();
  }

  commit(params, label, rasters = []) {
    const after = clone(params);
    if (!rasters.length && JSON.stringify(after) === JSON.stringify(this.snapshot)) return false;
    this.entries.length = this.index + 1;
    this.entries.push({ label, before: this.snapshot, after, rasters });
    if (this.entries.length > this.limit) this.entries.shift();
    this.index = this.entries.length - 1;
    this.snapshot = after;
    this.onChange?.();
    return true;
  }

  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.entries.length - 1; }

  undo() {
    if (!this.canUndo) return null;
    const e = this.entries[this.index--];
    for (let i = e.rasters.length - 1; i >= 0; i--) e.rasters[i].undo();
    this.snapshot = clone(e.before);
    this.onChange?.();
    return { params: clone(e.before), label: e.label };
  }

  redo() {
    if (!this.canRedo) return null;
    const e = this.entries[++this.index];
    for (const r of e.rasters) r.redo();
    this.snapshot = clone(e.after);
    this.onChange?.();
    return { params: clone(e.after), label: e.label };
  }
}

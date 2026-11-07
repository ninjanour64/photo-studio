// Fragment shaders for the edit pipeline. All intermediate passes address their output by
// gl_FragCoord / output size, with uv.y = 0 being the TOP row of the image (that's how rows are
// uploaded), so every pass agrees on orientation without flips.

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 o;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA); }
`;

// Base image through the displacement field (face reshape + liquify).
export const WARP_FS = HEAD + `
uniform sampler2D uBase;
uniform sampler2D uDisp;
uniform vec2 uImgSize;
uniform vec2 uOut;
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec2 src = clamp(uv + texture(uDisp, uv).rg / uImgSize, vec2(0.0), vec2(1.0));
  o = texture(uBase, src);
}`;

// Plain (optionally mip-level) copy, used for downsampling.
export const COPY_FS = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uOut;
uniform float uLod;
void main() { o = textureLod(uSrc, gl_FragCoord.xy / uOut, uLod); }`;

// Separable gaussian. uDir is the uv step between taps; uSigma is measured in taps.
export const BLUR_FS = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uOut;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec4 s = vec4(0.0);
  float ws = 0.0;
  float k = 1.0 / (2.0 * uSigma * uSigma);
  for (int i = -24; i <= 24; i++) {
    float f = float(i);
    float w = exp(-f * f * k);
    s += texture(uSrc, uv + uDir * f) * w;
    ws += w;
  }
  o = s / ws;
}`;

// Edge-preserving skin blur: a 3-ring disc of prefiltered (mip) samples, weighted by colour
// similarity to the centre so pores and blotches melt while eyelids, nostrils and lips hold.
export const BILATERAL_FS = HEAD + `
uniform sampler2D uSrc;
uniform vec2 uOut;
uniform vec2 uSrcSize;
uniform float uRadius;
uniform float uRange;
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec3 c0 = textureLod(uSrc, uv, 0.0).rgb;
  float lod = max(0.0, log2(uRadius / 7.0));
  vec3 sum = c0;
  float ws = 1.0;
  float kr = 1.0 / (2.0 * uRange * uRange);
  float ks = 1.0 / (2.0 * 0.45 * 0.45);
  for (int r = 1; r <= 3; r++) {
    float fr = float(r) / 3.0;
    int count = 8 * r;
    float wsp = exp(-fr * fr * ks);
    for (int k = 0; k < 24; k++) {
      if (k >= count) break;
      float a = (float(k) + 0.5 * float(r)) / float(count) * 6.2831853;
      vec2 off = vec2(cos(a), sin(a)) * (uRadius * fr) / uSrcSize;
      vec3 c = textureLod(uSrc, uv + off, lod).rgb;
      vec3 d = c - c0;
      float w = wsp * exp(-dot(d, d) * kr);
      sum += c * w;
      ws += w;
    }
  }
  o = vec4(sum / ws, 1.0);
}`;

// Refines the coarse person mask against the photo so edges hug hair and shoulders.
export const PERSON_FS = HEAD + `
uniform sampler2D uMask;
uniform sampler2D uGuide;
uniform vec2 uOut;
uniform vec2 uGuideSize;
uniform float uRadius;
uniform float uLod;
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec3 g0 = textureLod(uGuide, uv, uLod).rgb;
  float sum = 0.0, ws = 0.0;
  for (int y = -4; y <= 4; y++) {
    for (int x = -4; x <= 4; x++) {
      vec2 off = vec2(float(x), float(y)) * 0.25 * uRadius / uGuideSize;
      vec3 g = textureLod(uGuide, uv + off, uLod).rgb;
      float m = texture(uMask, uv + off).r;
      vec3 d = g - g0;
      float w = exp(-dot(d, d) * 40.0) * exp(-float(x * x + y * y) / 10.0);
      sum += m * w;
      ws += w;
    }
  }
  float m = smoothstep(0.25, 0.75, sum / ws);
  o = vec4(m, m, m, 1.0);
}`;

// Background pre-pass for portrait blur: premultiply by "how much background" so blurring never
// drags the person's colours into the bokeh.
export const BGPRE_FS = HEAD + `
uniform sampler2D uW;
uniform sampler2D uPerson;
uniform sampler2D uDisp;
uniform vec2 uImgSize;
uniform vec2 uOut;
uniform float uLod;
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec2 src = clamp(uv + texture(uDisp, uv).rg / uImgSize, vec2(0.0), vec2(1.0));
  float m = texture(uPerson, src).r;
  float b = 1.0 - smoothstep(0.05, 0.6, m);
  vec3 c = textureLod(uW, uv, uLod).rgb;
  o = vec4(c * b, b);
}`;

// Face retouch + background, at full resolution, in warped space. Masks live in the original
// (unwarped) image, so they are looked up through the same displacement as the pixels.
export const RETOUCH_FS = HEAD + `
uniform sampler2D uW;
uniform sampler2D uS;
uniform sampler2D uMaskA;  // skin, under-eye, whole face, under-chin
uniform sampler2D uMaskB;  // teeth, eyes, irises, lips
uniform sampler2D uBrush;  // smooth, whiten, details, protect
uniform sampler2D uPerson;
uniform sampler2D uBg;
uniform sampler2D uDisp;
uniform vec2 uImgSize;
uniform vec2 uOut;
uniform float uSmooth, uShine, uUnderEye, uUnderChin, uTeeth, uEyes, uEyeColorAmt, uLipAmt;
uniform vec3 uEyeColor, uLipColor;
uniform vec3 uSkin;      // average skin colour of the faces
uniform int uBgMode;     // 0 none, 1 blur, 2 b&w, 3 remove
uniform float uBgLight;
uniform float uHasPerson;

vec3 setLum(vec3 c, float l) {
  c += l - luma(c);
  float L = luma(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = L + (c - L) * L / max(L - n, 1e-4);
  if (x > 1.0) c = L + (c - L) * (1.0 - L) / max(x - L, 1e-4);
  return c;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec2 src = clamp(uv + texture(uDisp, uv).rg / uImgSize, vec2(0.0), vec2(1.0));
  vec4 mA = texture(uMaskA, src);
  vec4 mB = texture(uMaskB, src);
  vec4 br = texture(uBrush, src);
  vec2 tx = 1.0 / uImgSize;

  vec4 base = texture(uW, uv);
  vec3 c = base.rgb;
  vec3 nb = (texture(uW, uv + vec2(tx.x, 0.0)).rgb + texture(uW, uv - vec2(tx.x, 0.0)).rgb +
             texture(uW, uv + vec2(0.0, tx.y)).rgb + texture(uW, uv - vec2(0.0, tx.y)).rgb) * 0.25;
  vec3 fine = c - nb;
  vec3 s = texture(uS, uv).rgb;
  vec3 orig = c;

  // Skin: edge-aware blur, with the finest pore texture put back so it never looks plastic.
  float skin = clamp(mA.r * uSmooth + br.r, 0.0, 1.0);
  c = mix(c, s + fine * 0.6, skin * 0.92);

  // Shine: pull down specular hot spots that sit above the local skin tone.
  float l = luma(c);
  float hot = max(l - luma(s) - 0.015, 0.0) * 1.6 + max(l - 0.8, 0.0) * 0.6;
  c -= vec3(hot * uShine * mA.r * 0.8);

  // Under-eyes: lift the crescent toward the surrounding tone.
  float ue = mA.g * uUnderEye;
  vec3 lifted = (s + fine * 0.5) * (1.0 + 0.2 * (1.0 - luma(s)));
  lifted = mix(lifted, vec3(luma(lifted)), 0.15);
  c = mix(c, lifted, clamp(ue, 0.0, 1.0) * 0.85);

  // Under the chin: soften neck folds and the double-chin crease. Folds are darker than their
  // surroundings, so lift whatever sits below the local (edge-aware) average, and calm the bulge's
  // highlight a little, then blend toward the smooth layer with texture kept.
  float uc = clamp(mA.a * uUnderChin, 0.0, 1.0);
  if (uc > 0.0) {
    // Only on skin: compare chromaticity with the face's skin, loosely on brightness.
    vec3 sc = s / (s.r + s.g + s.b + 1e-3), kc = uSkin / (uSkin.r + uSkin.g + uSkin.b + 1e-3);
    vec2 dch = sc.rg - kc.rg;
    float lr = log((s.r + s.g + s.b + 1e-3) / (uSkin.r + uSkin.g + uSkin.b + 1e-3));
    uc *= clamp(exp(-(dot(dch, dch) / 0.0016 + lr * lr / 0.35)) * 1.4, 0.0, 1.0);
  }
  if (uc > 0.0) {
    float lc = luma(c), lsm = luma(s);
    vec3 even = s + fine * 0.65;
    c = mix(c, even, uc * 0.75);
    c += c * max(lsm - lc, 0.0) / max(lc, 0.04) * uc * 0.6;
    c -= vec3(max(lc - lsm - 0.01, 0.0) * uc * 0.5);
  }

  // Teeth (auto) and whiten (brush): drain yellow, add a little brightness; spare lips/tongue.
  l = luma(c);
  float red = c.r - c.g;
  float tooth = smoothstep(0.16, 0.42, l) * (1.0 - smoothstep(0.07, 0.2, red));
  float wt = clamp(mB.r * uTeeth * tooth + br.g * smoothstep(0.08, 0.3, l), 0.0, 1.0);
  c = vec3(l) + (c - vec3(l)) * (1.0 - 0.8 * wt);
  c += (1.0 - c) * 0.22 * wt;

  // Eyes: crisper and a touch brighter; calm redness in the whites.
  float ey = mB.g * uEyes;
  c += fine * 1.6 * ey;
  l = luma(c);
  c += (1.0 - c) * 0.14 * ey * smoothstep(0.08, 0.55, l);
  float whiteness = smoothstep(0.35, 0.7, l);
  c.r -= max(c.r - (c.g + c.b) * 0.5, 0.0) * 0.6 * ey * whiteness;

  // Iris colour (colour blend, keeps the catchlight).
  l = luma(c);
  float iw = mB.b * uEyeColorAmt * (1.0 - smoothstep(0.5, 0.78, l));
  c = mix(c, setLum(uEyeColor, l * 1.05), clamp(iw, 0.0, 1.0) * 0.8);

  // Lip colour.
  float lw = mB.a * uLipAmt * (1.0 - smoothstep(0.45, 0.7, l) * (1.0 - smoothstep(0.08, 0.2, c.r - c.g)));
  vec3 lip = setLum(uLipColor, l);
  c = mix(c, lip, clamp(lw, 0.0, 1.0) * 0.65);

  // Details brush.
  c += fine * br.b * 2.2 + (c - s) * br.b * 0.35;

  // Restore brush.
  c = mix(c, orig, br.a);

  // Background.
  float alpha = base.a;
  if (uHasPerson > 0.5 && (uBgMode > 0 || uBgLight != 0.0)) {
    float m = texture(uPerson, src).r;
    vec3 bgc = c;
    if (uBgMode == 1) {
      vec4 b = texture(uBg, uv);
      bgc = b.a > 0.002 ? b.rgb / b.a : c;
    } else if (uBgMode == 2) {
      bgc = vec3(luma(c));
    }
    bgc *= 1.0 + uBgLight;
    c = mix(bgc, c, m);
    if (uBgMode == 3) alpha *= m;
  }
  o = vec4(clamp(c, 0.0, 1.0), alpha);
}`;

// Global adjustments, look, vignette and grain, plus the view (zoom/pan) and crop transform.
export const FINAL_FS = HEAD + `
uniform sampler2D uImg;
uniform sampler2D uMid;
uniform mat3 uToImg;    // screen pixel -> image uv
uniform mat3 uToCrop;   // screen pixel -> crop uv (0..1)
uniform vec2 uImgSize;
uniform vec2 uCropPx;
uniform float uViewH;
uniform float uPxScale; // image pixels per screen pixel
uniform int uRaw;
uniform float uChecker;
uniform vec4 uFill;
uniform vec4 uOutside;
uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks, uTemp, uTint;
uniform float uVibrance, uSaturation, uClarity, uDehaze, uSharpen, uGlow, uFade, uVignette, uGrain;
uniform vec3 uSplitShadow, uSplitHigh;
uniform float uBW;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 shoulder(vec3 x) {
  vec3 e = max(x - 0.8, 0.0);
  return min(x, vec3(0.8)) + 0.2 * (1.0 - exp(-e / 0.2));
}

void main() {
  vec2 px = vec2(gl_FragCoord.x, uViewH - gl_FragCoord.y);
  vec2 uv = (uToImg * vec3(px, 1.0)).xy;
  vec2 cuv = (uToCrop * vec3(px, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { o = uOutside; return; }
  float lod = max(0.0, log2(uPxScale));
  vec4 src = textureLod(uImg, uv, lod);
  vec3 c = src.rgb;

  if (uRaw == 0) {
    vec3 mid = texture(uMid, uv).rgb;
    float midL = luma(mid);

    // Sharpen (unsharp mask against the 4-neighbourhood at the displayed scale).
    vec2 d = exp2(lod) / uImgSize;
    vec3 nb = (textureLod(uImg, uv + vec2(d.x, 0.0), lod).rgb + textureLod(uImg, uv - vec2(d.x, 0.0), lod).rgb +
               textureLod(uImg, uv + vec2(0.0, d.y), lod).rgb + textureLod(uImg, uv - vec2(0.0, d.y), lod).rgb) * 0.25;
    c += (c - nb) * uSharpen * 1.4;

    // Dehaze.
    if (uDehaze > 0.0) {
      float dc = min(min(mid.r, mid.g), mid.b) * uDehaze * 0.75;
      c = (c - dc) / max(1.0 - dc, 0.2);
      c = mix(vec3(luma(c)), c, 1.0 + 0.3 * uDehaze);
    } else {
      c = mix(c, vec3(0.78) + (c - 0.5) * 0.35, -uDehaze * 0.45);
    }

    // White balance + exposure in linear light.
    vec3 lin = pow(max(c, 0.0), vec3(2.2));
    vec3 wb = vec3(1.0 + uTemp * 0.2, 1.0 - uTint * 0.14, 1.0 - uTemp * 0.2);
    wb /= dot(wb, LUMA);
    lin *= wb * exp2(uExposure * 2.0);
    if (uExposure > 0.0) lin = mix(lin, shoulder(lin), clamp(uExposure * 4.0, 0.0, 1.0));
    c = pow(max(lin, 0.0), vec3(1.0 / 2.2));

    // Whites / blacks (levels).
    float bp = -uBlacks * 0.09;
    float wp = 1.0 - uWhites * 0.12;
    c = (c - bp) / max(wp - bp, 0.05);

    // Shadows / highlights, driven by a locally-averaged luminance to keep contrast.
    float l = luma(c);
    float lb = mix(l, midL, 0.6);
    float ws = 1.0 - smoothstep(0.0, 0.6, lb);
    float wh = smoothstep(0.35, 1.0, lb);
    c *= 1.0 + uShadows * (uShadows > 0.0 ? 1.0 : 0.55) * ws * ws;
    c *= 1.0 + uHighlights * 0.38 * wh * wh;

    // Clarity (midtone local contrast).
    l = luma(c);
    c += (l - midL) * uClarity * 0.9 * clamp(4.0 * l * (1.0 - l), 0.0, 1.0);

    // Contrast.
    c = clamp(c, 0.0, 1.2);
    if (uContrast >= 0.0) c = mix(c, c * c * (3.0 - 2.0 * clamp(c, 0.0, 1.0)), uContrast * 0.85);
    else c = mix(c, 0.5 + (c - 0.5) * 0.45, -uContrast);

    // Vibrance + saturation.
    l = luma(c);
    float sat = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
    float vib = uVibrance * (uVibrance > 0.0 ? (1.0 - sat) * (1.0 - sat) : 1.0);
    c = mix(vec3(l), c, max(0.0, 1.0 + vib + uSaturation));

    // Look: split toning, black & white, fade.
    l = clamp(luma(c), 0.0, 1.0);
    c += uSplitShadow * (1.0 - l) * (1.0 - l) + uSplitHigh * l * l;
    c = mix(c, vec3(luma(c)), uBW);
    c = mix(c, c * 0.84 + 0.11, uFade);

    // Glow: soft bloom of the highlights.
    vec3 bloom = clamp((mid - 0.5) * 2.0, 0.0, 1.0);
    c = 1.0 - (1.0 - c) * (1.0 - bloom * uGlow * 0.55);
    c = mix(c, mid, uGlow * 0.12);

    // Vignette, relative to the crop.
    float aspect = uCropPx.x / uCropPx.y;
    vec2 q = (cuv - 0.5) * vec2(aspect, 1.0);
    float dist = length(q) / length(vec2(aspect, 1.0) * 0.5);
    float v = smoothstep(0.3, 1.05, dist);
    if (uVignette < 0.0) c *= 1.0 + uVignette * v * 0.85;
    else c = mix(c, vec3(1.0), v * uVignette * 0.6);

    // Film grain, in output pixels.
    vec2 gp = floor(cuv * uCropPx / max(1.0, uCropPx.y / 1400.0));
    float g = (hash(gp) + hash(gp + 17.31) - 1.0);
    l = clamp(luma(c), 0.0, 1.0);
    c += g * uGrain * 0.16 * (1.0 - abs(2.0 * l - 1.0) * 0.6);
  }

  c = clamp(c, 0.0, 1.0);
  float a = src.a;
  if (uFill.a > 0.0) { c = mix(uFill.rgb, c, a); a = 1.0; }
  if (uChecker > 0.0 && a < 1.0) {
    vec2 cell = floor(px / 10.0);
    float chk = mod(cell.x + cell.y, 2.0) < 1.0 ? 0.92 : 0.78;
    c = mix(vec3(chk), c, a);
    a = 1.0;
  }
  o = vec4(c, a);
}`;

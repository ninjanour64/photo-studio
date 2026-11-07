// Tiny DOM helpers for panel controls.
import { icon } from './icons.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

export const section = (title, ...children) => h('section', { class: 'sec' }, title ? h('h3', {}, title) : null, ...children);

export const hint = (text) => h('p', { class: 'hint' }, text);

// Slider with a live value, a centre mark for bipolar ranges, and double-click to reset.
// get() → value, set(v) live, commit() on release.
export function slider({ label, min = -100, max = 100, step = 1, get, set, commit, def = 0, fmt }) {
  const input = h('input', { type: 'range', min, max, step });
  input.value = get();
  const out = h('output', {}, '');
  const bipolar = min < 0 && max > 0;
  const paint = () => {
    const v = +input.value;
    out.textContent = fmt ? fmt(v) : (v > 0 && bipolar ? '+' : '') + v;
    const p = (x) => ((x - min) / (max - min)) * 100;
    const a = bipolar ? Math.min(p(0), p(v)) : 0, b = bipolar ? Math.max(p(0), p(v)) : p(v);
    input.style.setProperty('--a', a + '%');
    input.style.setProperty('--b', b + '%');
    row.classList.toggle('changed', v !== def);
  };
  input.addEventListener('input', () => { set(+input.value); paint(); });
  input.addEventListener('change', () => commit?.());
  const reset = () => { input.value = def; set(def); paint(); commit?.(); };
  const lab = h('label', { title: 'Double-click to reset', ondblclick: reset }, label);
  const row = h('div', { class: 'slider' + (bipolar ? ' bipolar' : '') }, h('div', { class: 'slider-top' }, lab, out), input);
  row.sync = () => { input.value = get(); paint(); };
  paint();
  return row;
}

export function chips(options, get, set, { cls = '' } = {}) {
  const wrap = h('div', { class: 'chips ' + cls });
  const sync = () => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  for (const o of options) {
    const b = h('button', { type: 'button', 'data-v': o.id, title: o.title || o.label, onclick: () => { set(o.id); sync(); } },
      o.swatch ? h('span', { class: 'swatch', style: `background:${o.swatch}` }) : null,
      o.icon ? h('span', { html: icon(o.icon, 18) }) : null,
      o.label);
    wrap.append(b);
  }
  wrap.sync = sync;
  sync();
  return wrap;
}

export function tiles(options, get, set) {
  const wrap = h('div', { class: 'tiles' });
  const sync = () => wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(get())));
  for (const o of options) {
    wrap.append(h('button', { type: 'button', class: 'tile', 'data-v': o.id, title: o.title || o.label, onclick: () => { set(o.id); sync(); } },
      h('span', { class: 'tile-ic', html: icon(o.icon, 24) }), h('span', { class: 'tile-l' }, o.label)));
  }
  wrap.sync = sync;
  sync();
  return wrap;
}

export const button = (label, onclick, { cls = '', ic, title } = {}) =>
  h('button', { type: 'button', class: 'btn ' + cls, onclick, title }, ic ? h('span', { html: icon(ic, 18) }) : null, label);

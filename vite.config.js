// Copies MediaPipe's WASM runtime out of node_modules into public/wasm so face detection and
// person segmentation run fully offline, both under `npm run dev` and in the built site.
import { defineConfig } from 'vite';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function mediapipeWasm() {
  const from = resolve('node_modules/@mediapipe/tasks-vision/wasm');
  const to = resolve('public/wasm');
  return {
    name: 'mediapipe-wasm',
    buildStart() {
      if (!existsSync(from)) return;
      mkdirSync(to, { recursive: true });
      cpSync(from, to, { recursive: true });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [mediapipeWasm()],
  server: { port: 5174 },
  build: { target: 'es2022' },
});

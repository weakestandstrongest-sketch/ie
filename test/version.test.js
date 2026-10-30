import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');

// 版の番号がずれると、iPhone に古いファイルが残ることがあるのでそろえておく
test('app.js・sw.js・index.html の版の番号がそろっている', () => {
  const app = /APP_VERSION = '(\d+)'/.exec(read('app.js'))[1];
  assert.equal(/CACHE = 'ie-v(\d+)'/.exec(read('sw.js'))[1], app);
  const html = read('index.html');
  const vs = [...html.matchAll(/\?v=(\d+)"/g)].map((m) => m[1]);
  assert.ok(vs.length >= 4);
  assert.ok(vs.every((v) => v === app));
});

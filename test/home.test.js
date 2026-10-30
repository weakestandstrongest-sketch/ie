import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const html = readFileSync(new URL('./fixtures/result.html', import.meta.url), 'utf8');
const empty = '<html><body>経路なし</body></html>';

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

// 住所・最寄り駅・Yahoo の応答を差し替える。yahoo(from) が false を返すとその出発地では経路なし
function mock({ address = true, yahoo = () => true } = {}) {
  const asked = [];
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('LonLatToAddress')) {
      return address ? Response.json({ results: { muniCd: '21201', lv01Nm: '司町' } }) : new Response('', { status: 500 });
    }
    if (url.includes('muni.js')) return new Response(`GSI.MUNI_ARRAY["21201"] = '21,岐阜県,21201,岐阜市';`);
    if (url.includes('geoapi.heartrails')) return new Response('', { status: 500 });
    if (url.includes('express.heartrails')) {
      return Response.json({ response: { station: [{ name: '名鉄岐阜', line: '名鉄名古屋本線', distance: '400m' }, { name: '岐阜', line: 'JR東海道本線', distance: '600m' }] } });
    }
    if (url.includes('/search/result')) {
      const from = new URL(url).searchParams.get('from');
      asked.push(from);
      return new Response(yahoo(from) ? html : empty);
    }
    throw new Error(`unexpected ${url}`);
  };
  return asked;
}

const call = (qs) => worker.fetch(new Request(`https://ie.example.workers.dev/api/home?${qs}`), {}, { waitUntil() {} });
const QS = 'lat=35.42&lng=136.76&home=渋谷&date=2026-10-30&time=18:00';

test('現在地の住所から家までの経路を返す', async () => {
  const asked = mock();
  const res = await call(QS);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(asked, ['岐阜県岐阜市司町']);
  assert.equal(body.start.label, '現在地');
  assert.equal(body.home, '渋谷');
  assert.equal(body.routes.length, 3);
});

test('住所で見つからなければ最寄り駅から探す', async () => {
  const asked = mock({ yahoo: (from) => from === '岐阜' });
  const body = await (await call(QS)).json();
  assert.deepEqual(asked, ['岐阜県岐阜市司町', '名鉄岐阜', '岐阜']);
  assert.equal(body.start.station, true);
  assert.equal(body.start.from, '岐阜');
});

test('住所が取れなくても最寄り駅から探す', async () => {
  const asked = mock({ address: false });
  const body = await (await call(QS)).json();
  assert.deepEqual(asked, ['名鉄岐阜']);
  assert.equal(body.routes.length, 3);
});

test('どこからも見つからなければエラー', async () => {
  mock({ yahoo: () => false });
  const res = await call(QS);
  assert.equal(res.status, 502);
  assert.ok((await res.json()).error);
});

test('家が未設定・位置がおかしいときは 400', async () => {
  mock();
  assert.equal((await call('lat=35.4&lng=136.7&date=2026-10-30&time=18:00')).status, 400);
  assert.equal((await call('lat=0&lng=0&home=渋谷&date=2026-10-30&time=18:00')).status, 400);
});

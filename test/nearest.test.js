import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoords, summarizeStations, findNearest } from '../src/nearest.js';

test('日本の範囲外や不正な座標は受け付けない', () => {
  assert.equal(parseCoords(new URLSearchParams('lat=abc&lng=139')), null);
  assert.equal(parseCoords(new URLSearchParams('lat=51.5&lng=-0.1')), null);
  assert.deepEqual(parseCoords(new URLSearchParams('lat=35.6896&lng=139.7006')), { lat: '35.689600', lng: '139.700600' });
});

test('同じ駅の路線をまとめる', () => {
  const json = { response: { station: [
    { name: '新宿', line: 'JR山手線', distance: '120m' },
    { name: '新宿', line: '小田急線', distance: '150m' },
    { name: '新宿三丁目', line: '東京メトロ丸ノ内線', distance: '400m' },
  ] } };
  assert.deepEqual(summarizeStations(json), [
    { name: '新宿', lines: ['JR山手線', '小田急線'], distance: '120m' },
    { name: '新宿三丁目', lines: ['東京メトロ丸ノ内線'], distance: '400m' },
  ]);
  assert.deepEqual(summarizeStations({}), []);
});

test('https が失敗したら http で再試行する', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.startsWith('https:')) throw new Error('tls');
    return new Response(JSON.stringify({ response: { station: [{ name: '渋谷', line: 'JR', distance: '1m' }] } }));
  };
  const r = await findNearest({ lat: '35.658000', lng: '139.701000' }, fake);
  assert.equal(r[0].name, '渋谷');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /^http:\/\/express\.heartrails\.com\/api\/json\?method=getStations&x=139\.701000&y=35\.658000$/);
});

import { parseMuni, findAddress, resetMuniCache } from '../src/nearest.js';

const MUNI_JS = `GSI.MUNI_ARRAY["13104"] = '13,東京都,13104,新宿区';
GSI.MUNI_ARRAY["1101"] = '1,北海道,01101,札幌市　中央区';
GSI.MUNI_ARRAY["23106"] = '23,愛知県,23106,名古屋市　中区';`;

test('muni.js の対応表を読む（先頭の 0 や全角空白を吸収）', () => {
  const m = parseMuni(MUNI_JS);
  assert.equal(m['13104'], '東京都新宿区');
  assert.equal(m['1101'], '北海道札幌市中央区');
  assert.equal(m['23106'], '愛知県名古屋市中区');
});

function fakeFetch(routes) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    for (const [prefix, body] of routes) {
      if (url.startsWith(prefix)) {
        if (body instanceof Error) throw body;
        return new Response(typeof body === 'string' ? body : JSON.stringify(body));
      }
    }
    throw new Error('unexpected ' + url);
  };
  f.calls = calls;
  return f;
}

test('国土地理院の逆ジオコーダーで住所を作る', async () => {
  resetMuniCache();
  const f = fakeFetch([
    ['https://maps.gsi.go.jp/js/muni.js', MUNI_JS],
    ['https://mreversegeocoder.gsi.go.jp/', { results: { muniCd: '23106', lv01Nm: '大須三丁目' } }],
  ]);
  assert.equal(await findAddress({ lat: '35.159000', lng: '136.903000' }, f), '愛知県名古屋市中区大須三丁目');
  assert.match(f.calls.find((u) => u.includes('LonLatToAddress')), /lat=35\.159000&lon=136\.903000$/);
});

test('町名が「－」のときは市区町村まで', async () => {
  resetMuniCache();
  const f = fakeFetch([
    ['https://maps.gsi.go.jp/js/muni.js', MUNI_JS],
    ['https://mreversegeocoder.gsi.go.jp/', { results: { muniCd: '01101', lv01Nm: '－' } }],
  ]);
  assert.equal(await findAddress({ lat: '43.06', lng: '141.35' }, f), '北海道札幌市中央区');
});

test('国土地理院が使えないときは HeartRails Geo API', async () => {
  resetMuniCache();
  const f = fakeFetch([
    ['https://maps.gsi.go.jp/', new Error('down')],
    ['https://mreversegeocoder.gsi.go.jp/', new Error('down')],
    ['https://geoapi.heartrails.com/', { response: { location: [{ prefecture: '東京都', city: '新宿区', town: '西新宿二丁目' }] } }],
  ]);
  assert.equal(await findAddress({ lat: '35.6896', lng: '139.6917' }, f), '東京都新宿区西新宿二丁目');
});

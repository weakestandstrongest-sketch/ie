import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSearchUrl, parseResult, InputError } from '../src/yahoo.js';

const html = readFileSync(new URL('./fixtures/result.html', import.meta.url), 'utf8');

test('経路の概要を読み取る', () => {
  const { routes } = parseResult(html);
  assert.equal(routes.length, 3);
  const s = routes[0].summary;
  assert.equal(s.dep, '13:05');
  assert.equal(s.arr, '13:12');
  assert.equal(s.duration, '7分(乗車5分)');
  assert.equal(s.transfers, 0);
  assert.equal(s.fare, 1170);
  assert.equal(s.fareNote, '(IC優先)');
  assert.deepEqual(s.tags, ['早', '安', '楽']);
  assert.equal(s.alert, false);
  assert.equal(routes[1].summary.alert, true);
});

test('入れ子の fareSection を順番通りに展開する', () => {
  const steps = parseResult(html).routes[0].steps;
  assert.deepEqual(steps.map((s) => s.kind), ['station', 'access', 'station', 'access', 'station']);
  assert.deepEqual(steps[0], { kind: 'station', name: '新宿', arr: '', dep: '13:05', isStation: true });
  assert.equal(steps[1].line, 'JR山手線内回り');
  assert.equal(steps[1].destination, '渋谷行');
  assert.equal(steps[1].color, '#7ac142');
  assert.equal(steps[1].platform, '[発] 14番線 → [着] 1番線');
  assert.equal(steps[2].arr, '13:09');
  assert.equal(steps[2].dep, '13:10');
  assert.equal(steps[3].walk, true);
  assert.equal(steps[3].alert, true);
  assert.equal(steps[3].line, '徒歩');
  assert.equal(steps[4].arr, '13:12');
});

test('リンクのない駅名も読める', () => {
  const steps = parseResult(html).routes[1].steps;
  assert.equal(steps[0].name, '東京タワー');
});

test('経路がないページは空配列', () => {
  assert.deepEqual(parseResult('<html><body>該当なし</body></html>').routes, []);
});

test('検索 URL を作る', () => {
  const p = new URLSearchParams('from=新宿&to=渋谷&via=代々木&date=2026-10-12&time=9:05&type=arr&s=1&shin=0');
  const u = new URL(buildSearchUrl(p));
  assert.equal(u.origin + u.pathname, 'https://transit.yahoo.co.jp/search/result');
  const q = u.searchParams;
  assert.equal(q.get('from'), '新宿');
  assert.equal(q.get('via'), '代々木');
  assert.equal(q.get('hh'), '09');
  assert.equal(q.get('m1'), '0');
  assert.equal(q.get('m2'), '5');
  assert.equal(q.get('type'), '4');
  assert.equal(q.get('s'), '1');
  assert.equal(q.get('shin'), '0');
  assert.equal(q.get('ex'), '1');
});

test('不正な入力は InputError', () => {
  assert.throws(() => buildSearchUrl(new URLSearchParams('from=a')), InputError);
  assert.throws(() => buildSearchUrl(new URLSearchParams('from=a&to=b&date=x&time=1:00')), InputError);
});

test('町名から出発する徒歩区間：リンクの文字を消して「徒歩N分」にする', () => {
  const steps = parseResult(html).routes[2].steps;
  assert.equal(steps[0].name, '大須');
  assert.equal(steps[0].isStation, false);
  assert.equal(steps[1].walk, true);
  assert.equal(steps[1].line, '徒歩2分');
  assert.equal(steps[1].walkMinutes, 2);
  assert.equal(steps[1].exit, '');
  assert.equal(steps[1].platform, '');
  assert.equal(steps[2].isStation, true);
  assert.equal(steps[3].line, '名古屋市営鶴舞線');
  assert.equal(steps[3].platform, '[発] 1番線');
});

test('徒歩区間の出口の情報', () => {
  const page = `<div id="route01"><div class="routeSummary"><ul class="summary"><li class="time">10:00発→10:05着5分</li></ul></div>
    <div class="routeDetail"><div class="station"><ul class="time"><li>10:00発</li></ul><dl><dt><a href="/station/top/1/">栄</a></dt></dl></div>
    <div class="access"><ul class="info"><li class="transport">出口：16番 徒歩5分 地図でルート表示</li></ul></div>
    <div class="station"><ul class="time"><li>10:05着</li></ul><dl><dt>名古屋テレビ塔</dt></dl></div></div></div>`;
  const walk = parseResult(page).routes[0].steps[1];
  assert.equal(walk.line, '徒歩5分');
  assert.equal(walk.exit, '16番');
  assert.equal(walk.platform, '出口：16番');
});

import { searchResult } from './nextdata.js';

test('埋め込み JSON（__NEXT_DATA__）から経路を読む', () => {
  const r = parseResult(searchResult);
  assert.equal(r.total, 5);
  const route = r.routes[0];
  assert.deepEqual(route.summary, {
    dep: '08:05', arr: '09:02', duration: '57分(乗車45分)', transfers: 1, fare: 1230, fareNote: '',
    distance: '40.2km', tags: ['早', '安'], alert: true,
  });
  const s = route.steps;
  assert.deepEqual(s.map((x) => x.kind), ['station', 'access', 'station', 'access', 'station', 'access', 'station']);
  assert.deepEqual(s[0], { kind: 'station', name: '青葉台', arr: '', dep: '08:05', isStation: true, code: '100' });
  assert.equal(s[1].line, '架空本線快速');
  assert.equal(s[1].destination, '港町行');
  assert.equal(s[1].platform, '[発] 3番線 → [着] 1番線');
  assert.equal(s[1].stops, '3駅');
  assert.deepEqual(s[1].stopList, [{ name: 'A', time: '08:12' }, { name: 'B', time: '08:20' }]);
  assert.equal(s[1].color, '#e91a4c');
  // 運賃の区間（0 番目の駅から 1 番目の駅まで 830 円）
  assert.equal(s[1].fareGroup, '0_0');
  assert.equal(s[1].farePrice, 830);
  assert.equal(s[5].fareGroup, '');
  assert.deepEqual([s[2].arr, s[2].dep], ['08:30', '08:33']);
  assert.equal(s[3].walk, true);
  assert.equal(s[3].line, '徒歩4分');
  assert.equal(s[3].platform, '出口：北口');
  assert.equal(s[4].isStation, false);
  assert.equal(s[5].platform, '[発] 5のりば');
  assert.equal(s[5].alert, true);
  assert.equal(s[5].alertText, '遅れ');
  // 終点は到着時刻
  assert.deepEqual([s[6].arr, s[6].dep], ['09:02', '']);
});

test('2 ページ目は fl=4&tl=6', () => {
  const u = new URL(buildSearchUrl(new URLSearchParams('from=a&to=b&date=2026-10-12&time=9:05&page=2')));
  assert.equal(u.searchParams.get('fl'), '4');
  assert.equal(u.searchParams.get('tl'), '6');
  const u1 = new URL(buildSearchUrl(new URLSearchParams('from=a&to=b&date=2026-10-12&time=9:05&page=9')));
  assert.equal(u1.searchParams.get('fl'), null);
});

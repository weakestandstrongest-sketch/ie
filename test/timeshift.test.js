import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// public/timeshift.js はブラウザ用のスクリプトなので vm で読み込む
const ctx = {};
vm.runInNewContext(readFileSync(new URL('../public/timeshift.js', import.meta.url), 'utf8') + '\nthis.TimeShift = TimeShift;', ctx);
const { plan, resolve, chainNext, combineRoute, formatMinutes } = ctx.TimeShift;
// vm 内で作られたオブジェクトは deepEqual で比べにくいので JSON で比べる
const plain = (v) => JSON.parse(JSON.stringify(v));

const at = (s) => new Date(s);
const hm = (d) => `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const R = (dep, arr) => ({ dep, arr });

// Yahoo の検索を真似る：出発検索は「出発が t 以降」のうち到着が早い 3 本、
// 到着検索は「到着が t 以前」のうち到着が遅い 3 本
const TIMETABLE = [
  R('09:40', '10:20'), R('09:45', '10:40'), // 09:45 は各駅停車（遅く着く）
  R('09:52', '10:25'), R('09:58', '10:45'),
  R('10:00', '10:30'), R('10:05', '10:50'), R('10:10', '10:38'), R('10:20', '10:48'),
];
const depSearch = (t) => TIMETABLE.filter((r) => r.dep >= t).sort((a, b) => a.arr.localeCompare(b.arr)).slice(0, 3);
const arrSearch = (t) => TIMETABLE.filter((r) => r.arr <= t).sort((a, b) => b.arr.localeCompare(a.arr) || b.dep.localeCompare(a.dep)).slice(0, 3);
const hhmm = (d) => hm(d).slice(-5);

test('出発検索の 1 本後：出発のまま、最も早い出発の 1 分後', () => {
  const p = plan(1, 'dep', at('2026-10-12T10:00'), depSearch('10:00'));
  assert.equal(p.type, 'dep');
  assert.equal(hm(p.date), '10/12 10:01');
});

test('出発検索の 1 本前：出発のまま、直前の電車（遅く着く各駅停車は飛ばす）', () => {
  const shown = depSearch('10:00'); // 10:00, 10:10, 10:20
  const p = plan(-1, 'dep', at('2026-10-12T10:00'), shown);
  assert.equal(p.type, 'dep');
  assert.equal(p.probe.type, 'arr');
  assert.equal(hhmm(p.probe.date), '10:29');
  const d = resolve(p, arrSearch(hhmm(p.probe.date)));
  assert.equal(hm(d), '10/12 09:52');
  // もう一度 1 本前
  const p2 = plan(-1, 'dep', d, depSearch('09:52'));
  assert.equal(hm(resolve(p2, arrSearch(hhmm(p2.probe.date)))), '10/12 09:40');
});

test('1 本前が見つからないときは 30 分前、ただし今より後には進まない', () => {
  const p = plan(-1, 'dep', at('2026-10-12T10:00'), [R('10:00', '10:30')]);
  assert.equal(hm(resolve(p, [])), '10/12 09:30');
  assert.equal(hm(resolve(p, [R('10:05', '10:20')])), '10/12 09:59');
});

test('到着検索の 1 本前：到着のまま、最も遅い到着の 1 分前', () => {
  const p = plan(-1, 'arr', at('2026-10-12T10:40'), arrSearch('10:40'));
  assert.equal(p.type, 'arr');
  assert.equal(hm(p.date), '10/12 10:39');
});

test('到着検索の 1 本後：到着のまま、次に早く着く電車の到着時刻', () => {
  const shown = arrSearch('10:30'); // 10:00→10:30, 09:52→10:25, 09:40→10:20
  const p = plan(1, 'arr', at('2026-10-12T10:30'), shown);
  assert.equal(p.type, 'arr');
  assert.equal(p.probe.type, 'dep');
  assert.equal(hhmm(p.probe.date), '10:01');
  assert.equal(hm(resolve(p, depSearch(hhmm(p.probe.date)))), '10/12 10:38');
});

test('日付をまたぐ', () => {
  assert.equal(hm(plan(1, 'dep', at('2026-10-12T23:50'), [R('00:05', '00:30')]).date), '10/13 00:06');
  const p = plan(-1, 'dep', at('2026-10-13T00:05'), [R('00:10', '00:40')]);
  assert.equal(hm(p.probe.date), '10/13 00:39');
  assert.equal(hm(resolve(p, [R('23:55', '00:20')])), '10/12 23:55');
});

test('終電・始発：朝や夜に検索しても日付がずれない', () => {
  assert.equal(hm(plan(1, 'last', at('2026-10-12T08:00'), [R('23:40', '00:20')]).date), '10/12 23:41');
  assert.equal(hm(plan(1, 'last', at('2026-10-12T08:00'), [R('00:10', '00:50')]).date), '10/13 00:11');
  assert.equal(hm(plan(1, 'first', at('2026-10-12T21:00'), [R('05:02', '05:40')]).date), '10/12 05:03');
});

test('結果がないときは 30 分ずらし、種類は変えない', () => {
  assert.equal(hm(plan(1, 'dep', at('2026-10-12T13:00'), []).date), '10/12 13:30');
  assert.equal(hm(plan(-1, 'dep', at('2026-10-12T13:00'), []).date), '10/12 12:30');
  const p = plan(-1, 'arr', at('2026-10-12T13:00'), []);
  assert.equal(p.type, 'arr');
  assert.equal(hm(p.date), '10/12 12:30');
});

test('前後のダイヤ：次は読んだ中で最も遅い出発の 1 分後から', () => {
  assert.equal(hm(chainNext(depSearch('10:00'), at('2026-10-12T10:00'))), '10/12 10:21');
  // 進まないときは 10 分進める
  assert.equal(hm(chainNext([], at('2026-10-12T10:00'))), '10/12 10:10');
});

test('乗換駅から先を差し替えても、出発駅からの全体ルートになる', () => {
  const S = (name, arr, dep) => ({ kind: 'station', name, arr, dep });
  const A = (line, walk = false) => ({ kind: 'access', line, walk });
  const route = {
    summary: { dep: '06:29', arr: '07:46', alert: false },
    steps: [S('知立', '', '06:29'), A('名鉄名古屋本線'), S('名鉄名古屋', '06:54', ''), A('徒歩', true),
      S('名古屋', '07:00', '07:20'), A('JR東海道本線'), S('岐阜', '07:46', '')],
  };
  const tail = {
    summary: { dep: '07:32', arr: '07:52', alert: false },
    steps: [S('名古屋', '', '07:32'), A('JR東海道本線特別快速'), S('岐阜', '07:52', '')],
  };
  const c = plain(combineRoute(route, 4, tail));
  assert.deepEqual(c.steps.map((s) => s.name || s.line),
    ['知立', '名鉄名古屋本線', '名鉄名古屋', '徒歩', '名古屋', 'JR東海道本線特別快速', '岐阜']);
  assert.deepEqual(c.steps[4], S('名古屋', '07:00', '07:32'));
  assert.equal(c.summary.dep, '06:29');
  assert.equal(c.summary.arr, '07:52');
  assert.equal(c.summary.duration, '1時間23分');
  assert.equal(c.summary.transfers, 1);
  assert.equal(c.summary.fare, null);
  assert.equal(c.changedAt, 4);
  // 元のルートは書き換えない
  assert.equal(route.steps[4].dep, '07:20');
  // 出発駅なら差し替え先そのもの
  assert.equal(combineRoute(route, 0, tail), tail);
});

test('所要時間の表示', () => {
  assert.equal(formatMinutes(26), '26分');
  assert.equal(formatMinutes(77), '1時間17分');
  assert.equal(formatMinutes(120), '2時間');
  assert.equal(formatMinutes(NaN), '');
});

test('最初に乗る駅（前が徒歩だけ）なら、出発地を出る時刻も電車に合わせてずらす', () => {
  const S = (name, arr, dep) => ({ kind: 'station', name, arr, dep });
  const route = {
    summary: { dep: '09:54', arr: '11:38', alert: false, fare: 1520 },
    steps: [S('愛知県知立市栄2丁目', '', '09:54'), { kind: 'access', line: '徒歩4分', walk: true },
      S('知立', '09:58', '10:01'), { kind: 'access', line: '名鉄名古屋本線快速特急', walk: false }, S('岐大口', '11:38', '')],
  };
  assert.equal(ctx.TimeShift.isWalkOnlyBefore(route, 2), true);
  const tail = {
    summary: { dep: '09:49', arr: '11:38', alert: false, fare: 1520 },
    steps: [S('知立', '', '09:49'), { kind: 'access', line: '名鉄名古屋本線', walk: false }, S('岐大口', '11:38', '')],
  };
  const c = plain(combineRoute(route, 2, tail));
  // 10:01 → 09:49 の 12 分前倒し。家を出るのも 12 分早く、知立に着くのも 12 分早い
  assert.equal(c.summary.dep, '09:42');
  assert.deepEqual([c.steps[2].arr, c.steps[2].dep], ['09:46', '09:49']);
  assert.equal(c.steps[0].dep, '09:42');
  assert.equal(c.summary.duration, '1時間56分');
  assert.equal(c.summary.fare, 1520);
});

test('電車から乗り換える駅なら、それより前の時刻は変えない', () => {
  const S = (name, arr, dep) => ({ kind: 'station', name, arr, dep });
  const route = {
    summary: { dep: '09:31', arr: '10:58' },
    steps: [S('知立', '', '09:31'), { kind: 'access', line: '快速特急', walk: false }, S('名鉄名古屋', '09:52', '09:55'),
      { kind: 'access', line: '特急', walk: false }, S('名鉄岐阜', '10:24', '')],
  };
  assert.equal(ctx.TimeShift.isWalkOnlyBefore(route, 2), false);
  assert.equal(ctx.TimeShift.isWalkOnlyBefore(route, 0), false);
  assert.equal(ctx.TimeShift.shiftTime('00:05', -10), '23:55');
});

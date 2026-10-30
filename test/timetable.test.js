import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNextData } from '../src/yahoo.js';
import { parseDirections, parseTimetable, pickGroups, findTrain, lookupTimetable } from '../src/timetable.js';
import { timetableTop, timetableToMinato, timetableToYamate } from './nextdata.js';

test('時刻表から全列車を読む（24 時台は翌日 0 時台）', () => {
  const t = parseTimetable(extractNextData(timetableToMinato));
  assert.equal(t.railName, '架空本線');
  assert.equal(t.direction, '港町方面');
  assert.deepEqual(t.trains.map((x) => `${x.time} ${x.kind} ${x.destination}`),
    ['07:58 普通 浜(架空県)', '08:01 普通 浜(架空県)', '08:05 快速 港町', '08:12 普通 港町', '00:10 普通 浜(架空県)']);
  assert.equal(t.trains[2].cars, '8');
  assert.equal(t.trains[2].track, '3');
  assert.equal(t.trains[4].min, 24 * 60 + 10);
});

test('経路の路線名に合う方面を選ぶ', () => {
  const dirs = parseDirections(extractNextData(timetableTop));
  assert.deepEqual(pickGroups(dirs, '架空本線快速').map((g) => g.groupId), ['11', '12']);
  // 合う路線がなければ全部
  assert.deepEqual(pickGroups(dirs, '別の線').map((g) => g.groupId), ['11', '12', '21']);
});

test('時刻・種別・行き先で乗る電車を探す', () => {
  const t = parseTimetable(extractNextData(timetableToMinato)).trains;
  assert.deepEqual({ ...findTrain(t, '08:05', '架空本線快速', '港町行') }, { index: 2, score: 4 });
  assert.equal(findTrain(t, '08:01', '架空本線', '浜行').index, 1);
  assert.equal(findTrain(t, '08:02', '架空本線', '浜行').index, -1);
});

test('反対方面に同じ時刻の電車があっても、よく合う方面を選ぶ', async () => {
  const pages = {
    '/timetable/100': timetableTop,
    '/timetable/100/11': timetableToMinato,
    '/timetable/100/12': timetableToYamate,
  };
  const asked = [];
  const fetchPage = async (path) => { asked.push(path); return pages[path.split('?')[0]]; };
  const r = await lookupTimetable({ code: '100', date: '2026-10-12', time: '08:05', line: '架空本線快速', destination: '港町行' }, fetchPage);
  assert.equal(r.groupId, '11');
  assert.equal(r.matchedIndex, 2);
  assert.ok(asked.includes('/timetable/100/11?ym=202610&d=12&hh=8'));
});

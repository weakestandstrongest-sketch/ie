import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTrainPage, stopFromItem, findStops } from '../src/train.js';
import { wrap } from './nextdata.js';

test('停車駅の要素を読む（いろいろなキー名に対応）', () => {
  assert.deepEqual(stopFromItem({ stationName: '中央', stationCode: '200', arrivalTime: '08:30', departureTime: '08:31' }),
    { name: '中央', arr: '08:30', dep: '08:31', code: '200' });
  assert.deepEqual(stopFromItem({ name: '港町', departureTime: '9:05' }), { name: '港町', arr: '', dep: '09:05', code: '' });
  assert.deepEqual(stopFromItem({ name: '浜', yomi: 'はま', time: '09:10', id: 300 }), { name: '浜', arr: '', dep: '09:10', code: '300' });
  assert.equal(stopFromItem({ railName: '架空本線', time: '09:10' }), null);
  assert.equal(stopFromItem({ name: '時刻なし' }), null);
});

test('ページの JSON から停車駅の並びを探す', () => {
  const html = wrap({
    trainInfo: { trainName: '快速', destination: '港町' },
    other: [{ name: 'お知らせ', date: '2026/10/12' }, { name: 'x' }],
    stationList: [
      { stationName: '青葉台', stationCode: '100', departureTime: '08:05' },
      { stationName: '中央', stationCode: '200', arrivalTime: '08:30', departureTime: '08:31' },
      { stationName: '港町', stationCode: '300', arrivalTime: '08:50' },
    ],
  });
  const r = parseTrainPage(html);
  assert.equal(r.outline, null);
  assert.deepEqual(r.stops.map((s) => `${s.name} ${s.arr}/${s.dep}`), ['青葉台 /08:05', '中央 08:30/08:31', '港町 08:50/']);
});

test('読めないときは原因を調べるための形の要約を返す', () => {
  const r = parseTrainPage(wrap({ foo: { bar: [1, 2, 3] }, baz: 'abc' }));
  assert.deepEqual(r.stops, []);
  assert.deepEqual(r.outline, { foo: { bar: ['number', '×3'] }, baz: 'str3' });
  assert.deepEqual(findStops(null), []);
});

test('Yahoo の列車ページの形（時刻が "947" のようにコロンなし）', () => {
  const html = wrap({
    timetableStationTrainResult: {
      timetable: {
        trainId: '174601',
        displayName: '特急',
        stopStation: [
          { stationCode: '25037', stationName: '知立', areaCode: '5', prefCode: '23', arrivalTime: null, departureTime: '947' },
          { stationCode: '25001', stationName: '神宮前', areaCode: '5', prefCode: '23', arrivalTime: '1004', departureTime: '1005' },
          { stationCode: '24990', stationName: '名鉄名古屋', areaCode: '5', prefCode: '23', arrivalTime: '1013', departureTime: '1015' },
          { stationCode: '24468', stationName: '名鉄岐阜', areaCode: '5', prefCode: '21', arrivalTime: '1045', departureTime: null },
        ],
      },
    },
    directionDetail: { stationName: '知立' },
  });
  const r = parseTrainPage(html);
  assert.deepEqual(r.stops.map((s) => `${s.name}(${s.code}) ${s.arr}/${s.dep}`),
    ['知立(25037) /09:47', '神宮前(25001) 10:04/10:05', '名鉄名古屋(24990) 10:13/10:15', '名鉄岐阜(24468) 10:45/']);
});

test('24 時台（"2410"）は 0:10、駅コードは時刻と間違えない', () => {
  assert.deepEqual(stopFromItem({ stationCode: '1234', stationName: '終点', arrivalTime: '2410' }),
    { name: '終点', arr: '00:10', dep: '', code: '1234' });
  assert.equal(stopFromItem({ stationName: '駅', prefCode: '2359' }), null);
});

// テスト用：Yahoo!乗換案内のページに埋め込まれる JSON（__NEXT_DATA__）と同じ形の架空データ
export const wrap = (pageProps) =>
  `<html><body><div>本文</div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></body></html>`;

const edge = (o) => ({
  stationName: o.name,
  stationCode: o.code || '',
  railName: o.rail ? `${o.rail}・${o.dest}` : '',
  railNameExcludingDestination: o.rail || '',
  destination: o.dest || '',
  timeInfo: o.times,
  exitName: { from: o.exit || '', to: '' },
  ridingPositionInfo: o.pos || null,
  stopStationList: o.stops || [],
  diaInfoStatus: o.alert ? [{ title: o.alert }] : [],
  linkInfo: { station: o.noLink ? null : `/station/${o.code}`, time: `/timetable/${o.code}` },
  priceInfo: o.fare ? { edgeGroup: o.fare[0], price: o.fare[1] } : { edgeGroup: null, price: '0' },
  accessInfo: o.access === undefined ? null : o.access,
});

export const searchResult = wrap({
  naviSearchParam: {
    resultInfo: { Total: 5 },
    displayInfo: { fromName: '青葉台', toName: '若葉町' },
    featureInfoList: [{
      summaryInfo: {
        departureTime: '08:05', arrivalTime: '09:02', totalTime: '57分', timeOnBoard: '45分',
        totalPrice: '1,230', transferCount: '1', isFast: true, isEasy: false, isCheap: true, distance: '40.2km',
      },
      edgeInfoList: [
        edge({ name: '青葉台', code: '100', rail: '架空本線快速', dest: '港町行', times: [{ time: '08:05', type: 3 }], fare: ['0_0', '830'],
          pos: { departure: ['3', '番線'], arrival: ['1', '番線'] }, stops: [{ name: 'A', departureTime: '08:12' }, { name: 'B', departureTime: '08:20' }],
          access: { type: 0, color: 'e91a4c' } }),
        edge({ name: '中央', code: '200', times: [{ time: '08:30', type: 2 }, { time: '08:33', type: 1 }],
          access: { type: 1, color: null }, exit: '北口' }),
        edge({ name: '中央/架空バス', code: '9001', noLink: true, rail: '架空バス・循環線', dest: '若葉町行',
          times: [{ time: '08:37', type: 2 }, { time: '08:40', type: 1 }], pos: { departure: ['5', 'のりば'], arrival: [null, '情報なし'] },
          access: { type: 2, color: '3f007d' }, alert: '遅れ' }),
        edge({ name: '若葉町/架空バス', code: '9002', noLink: true, times: [{ time: '09:02', type: 3 }] }),
      ],
    }],
  },
});

// 駅の時刻表トップ（路線と方面）
export const timetableTop = wrap({
  directionDetail: {
    stationName: '青葉台',
    directionItem: {
      routeInfos: [
        { railName: '架空本線', railGroup: [{ direction: '港町方面', groupId: '11' }, { direction: '山手方面', groupId: '12' }] },
        { railName: '架空支線', railGroup: [{ direction: '谷町方面', groupId: '21' }] },
      ],
    },
  },
});

const T = (minute, kindId, destinationId, trainId, track = '3', numOfCar = '4') =>
  ({ minute: String(minute), kindId, destinationId, trainId, trackNumber: track, numOfCar });
const master = {
  kind: [{ id: '1', name: '普通' }, { id: '2', name: '快速' }],
  destination: [{ id: '1', name: '港町' }, { id: '2', name: '浜(架空県)' }, { id: '3', name: '山手' }],
};

// 港町方面：08:05 の快速港町行がある
export const timetableToMinato = wrap({
  timetableItem: {
    stationName: '青葉台', railName: '架空本線', directionName: '港町方面', master,
    hourTimeTable: [
      { hour: '7', minTimeTable: [T(58, '1', '2', 't1')] },
      { hour: '8', minTimeTable: [T(1, '1', '2', 't2'), T(5, '2', '1', 't3', '3', '8'), T(12, '1', '1', 't4')] },
      { hour: '24', minTimeTable: [T(10, '1', '2', 't9')] },
    ],
  },
});

// 山手方面：同じ 08:05 に反対方面の電車がある
export const timetableToYamate = wrap({
  timetableItem: {
    stationName: '青葉台', railName: '架空本線', directionName: '山手方面', master,
    hourTimeTable: [{ hour: '8', minTimeTable: [T(5, '1', '3', 'y1', '4')] }],
  },
});

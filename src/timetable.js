import { extractNextData } from './yahoo.js';

// Yahoo!乗換案内の駅時刻表ページ（/timetable/駅コード/方面コード）から全列車を読む。
// ページに埋め込まれた JSON（__NEXT_DATA__）の timetableItem を使う。

const norm = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '');
const stripParen = (s) => norm(s).replace(/[(（][^)）]*[)）]/g, '');

// 駅の時刻表トップ：路線と方面の一覧
export function parseDirections(nd) {
  const pp = nd && nd.props && nd.props.pageProps;
  const infos = pp && pp.directionDetail && pp.directionDetail.directionItem && pp.directionDetail.directionItem.routeInfos;
  if (!Array.isArray(infos)) return [];
  return infos.map((r) => ({
    railName: norm(r.railName),
    groups: (r.railGroup || []).map((g) => ({ groupId: String(g.groupId), direction: norm(g.direction) })),
  }));
}

// 方面ごとの時刻表：その日の全列車
export function parseTimetable(nd) {
  const pp = nd && nd.props && nd.props.pageProps;
  const t = pp && pp.timetableItem;
  if (!t || !Array.isArray(t.hourTimeTable)) return null;
  const master = t.master || {};
  const kinds = Object.fromEntries((master.kind || []).map((k) => [String(k.id), norm(k.name)]));
  const dests = Object.fromEntries((master.destination || []).map((d) => [String(d.id), norm(d.name)]));
  const trains = [];
  for (const h of t.hourTimeTable) {
    const hour = Number(h.hour);
    for (const m of h.minTimeTable || []) {
      const min = hour * 60 + Number(m.minute);
      if (!Number.isFinite(min)) continue;
      trains.push({
        min, // その日の 0:00 からの分（24 時台は 1440 以上）
        time: `${String(hour % 24).padStart(2, '0')}:${String(Number(m.minute)).padStart(2, '0')}`,
        kind: kinds[String(m.kindId)] || norm(m.trainName) || '',
        destination: dests[String(m.destinationId)] || '',
        track: m.trackNumber ? String(m.trackNumber) : '',
        cars: m.numOfCar ? String(m.numOfCar) : '',
        trainId: m.trainId ? String(m.trainId) : '',
      });
    }
  }
  trains.sort((a, b) => a.min - b.min);
  return {
    railName: norm(t.railName),
    direction: norm(t.directionName),
    // 平日・土曜・休日の区別（列車ごとのページの URL に使う）
    kind: String(pp.kind || t.driveDayKind || ''),
    trains,
  };
}

// 経路の路線名（例「名鉄名古屋本線快速特急」）に合う路線の方面を、合いそうな順に返す
export function pickGroups(directions, line) {
  const l = norm(line);
  const matched = directions.filter((r) => {
    const base = stripParen(r.railName);
    return base && (l.startsWith(base) || base.startsWith(l));
  });
  const list = matched.length ? matched : directions;
  return list.flatMap((r) => r.groups.map((g) => ({ ...g, railName: r.railName }))).slice(0, 6);
}

// 時刻表の中から、経路で乗る電車（時刻・種別・行き先）を探す。
// { index, score }（見つからなければ index は -1）。score は時刻 2・行き先 1・種別 1 の合計
export function findTrain(trains, time, line, destination) {
  const l = norm(line);
  const dest = stripParen(destination).replace(/行$/, '');
  let best = -1;
  let bestScore = 0;
  trains.forEach((t, i) => {
    if (t.time !== time) return;
    let score = 2;
    if (dest && stripParen(t.destination) && dest.startsWith(stripParen(t.destination))) score += 1;
    if (t.kind && (l.endsWith(t.kind) || (t.kind === '普通' && !/(急|快|特|準)/.test(l.slice(-4))))) score += 1;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return { index: best, score: bestScore };
}

/**
 * 駅コード・日時・乗る電車の情報から、その方面の時刻表を探して返す。
 * fetchPage(path) は Yahoo のページの HTML を返す関数。
 */
export async function lookupTimetable({ code, date, time, line, destination }, fetchPage) {
  const [y, mo, d] = date.split('-');
  const dayQuery = `ym=${y}${mo}&d=${d}`;
  const top = extractNextData(await fetchPage(`/timetable/${code}?${dayQuery}`));
  const groups = pickGroups(parseDirections(top), line);
  if (!groups.length) return null;

  const hh = Number(time.split(':')[0]);
  let failed = false;
  const pages = await Promise.all(groups.map(async (g) => {
    try {
      const tt = parseTimetable(extractNextData(await fetchPage(`/timetable/${code}/${g.groupId}?${dayQuery}&hh=${hh}`)));
      return tt && { ...tt, groupId: g.groupId, direction: tt.direction || g.direction };
    } catch (e) {
      failed = true;
      return null;
    }
  }));
  if (failed && !pages.some(Boolean)) throw new Error('timetable pages failed');

  // 同じ時刻の電車が反対方面にもあることがあるので、一番よく合う方面を選ぶ
  let chosen = null;
  let matchedIndex = -1;
  let bestScore = 0;
  for (const p of pages) {
    if (!p) continue;
    const m = findTrain(p.trains, time, line, destination);
    if (m.score > bestScore) { chosen = p; matchedIndex = m.index; bestScore = m.score; }
  }
  if (!chosen) chosen = pages.find(Boolean) || null;
  if (!chosen) return null;
  // 読めなかった方面があるときは、時刻・行き先・種別がすべて合う電車が見つかったときだけ使う
  if (failed && bestScore < 4) return { failed: true };
  return { ...chosen, matchedIndex };
}

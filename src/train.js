import { extractNextData } from './yahoo.js';

// 列車ごとのページ（/timetable/駅/方面/列車ID）から停車駅と時刻を読む。
// ページの JSON の形が分からない部分があるので、
// 「駅名と時刻を持つ要素が並んだ配列」を探して読む。

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
const norm = (s) => (s || '').normalize('NFKC').trim();

// "09:47" 形式。時刻のキー（arrivalTime など）なら Yahoo の "947"・"1005"・"2410"（翌 0:10）形式も読む
function timeOf(v, isTimeKey) {
  if (typeof v === 'number' && isTimeKey) v = String(v);
  if (typeof v !== 'string') return '';
  const s = norm(v);
  let m = TIME_RE.exec(s);
  if (!m && isTimeKey) m = /^(\d{1,2})(\d{2})$/.exec(s);
  if (!m || Number(m[2]) > 59) return '';
  return `${String(Number(m[1]) % 24).padStart(2, '0')}:${m[2]}`;
}

// 1 つの要素から { name, arr, dep, code } を取り出す。駅らしくなければ null
export function stopFromItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  let name = '';
  let arr = '';
  let dep = '';
  let any = '';
  let code = '';
  for (const [k, v] of Object.entries(item)) {
    const key = k.toLowerCase();
    const isTimeKey = /time|arr|dep|着|発/.test(key);
    const t0 = timeOf(v, isTimeKey);
    if (typeof v === 'number' && t0) {
      if (/arr|着/.test(key)) arr = arr || t0;
      else if (/dep|発/.test(key)) dep = dep || t0;
      else any = any || t0;
      continue;
    }
    if (typeof v === 'string') {
      const t = t0;
      if (t) {
        if (/arr|着/.test(key)) arr = arr || t;
        else if (/dep|発/.test(key)) dep = dep || t;
        else any = any || t;
        continue;
      }
      if (!name && /name/.test(key) && !/yomi|kana|rail|line|train|dest|type|kind/.test(key) && norm(v)) name = norm(v);
      if (!code && /(code|id)$/.test(key) && /^\d{3,8}$/.test(v)) code = v;
    } else if (typeof v === 'number' && !code && /(code|id)$/.test(key) && v >= 100) {
      code = String(v);
    }
  }
  if (!arr && !dep) dep = any;
  if (!name || (!arr && !dep)) return null;
  return { name, arr, dep, code };
}

// JSON の中から、停車駅の並びとして一番それらしい配列を探す
export function findStops(root) {
  let best = [];
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 12 || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      if (o.length >= 2) {
        const stops = o.map(stopFromItem);
        const ok = stops.filter(Boolean);
        if (ok.length >= 2 && ok.length >= o.length * 0.6 && ok.length > best.length) best = ok;
      }
      o.forEach((x) => walk(x, depth + 1));
    } else {
      Object.values(o).forEach((x) => walk(x, depth + 1));
    }
  };
  walk(root, 0);
  return best;
}

// JSON が読めなかったときに、原因を調べるための形の要約（キーと値の型だけ）
export function outline(o, depth = 0) {
  if (depth > 8) return '…';
  if (Array.isArray(o)) return o.length ? [outline(o[0], depth + 1), `×${o.length}`] : [];
  if (o && typeof o === 'object') {
    return Object.fromEntries(Object.entries(o).slice(0, 40).map(([k, v]) => [k, outline(v, depth + 1)]));
  }
  if (typeof o === 'string') return TIME_RE.test(o) ? o : `str${o.length}`;
  return typeof o;
}

export function parseTrainPage(html) {
  const nd = extractNextData(html);
  const pp = nd && nd.props && nd.props.pageProps;
  // 分かっている場所（timetableStationTrainResult.timetable.stopStation）を先に見る
  const known = pp && pp.timetableStationTrainResult && pp.timetableStationTrainResult.timetable
    && pp.timetableStationTrainResult.timetable.stopStation;
  let stops = Array.isArray(known) ? known.map(stopFromItem).filter(Boolean) : [];
  if (stops.length < 2) stops = pp ? findStops(pp) : [];
  return { stops, outline: stops.length ? null : outline(pp || {}) };
}

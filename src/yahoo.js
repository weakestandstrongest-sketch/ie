import { parse } from 'node-html-parser';
import { parseAlternatives } from './suggest.js';

export const YAHOO_ORIGIN = 'https://transit.yahoo.co.jp';

// 検索モード → Yahoo の type パラメータ
const TYPE_CODE = { dep: '1', arr: '4', first: '3', last: '2' };

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * アプリからのクエリを検証して Yahoo!乗換案内の検索 URL を作る。
 * 受け付けるパラメータを限定しているので、任意の URL を取りに行く踏み台にはならない。
 */
export function buildSearchUrl(params, origin = YAHOO_ORIGIN) {
  const get = (k) => (params.get(k) || '').trim();
  const from = get('from');
  const to = get('to');
  if (!from || !to) throw new InputError('出発駅と到着駅を入力してください');
  if (from.length > 60 || to.length > 60) throw new InputError('駅名が長すぎます');

  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(get('date'));
  const time = /^(\d{1,2}):(\d{2})$/.exec(get('time'));
  if (!date || !time) throw new InputError('日時の形式が正しくありません');
  const [mo, dd, hh, mi] = [date[2], date[3], time[1], time[2]].map(Number);
  if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 24 || mi > 59) throw new InputError('日時の形式が正しくありません');

  const flag = (k) => (get(k) === '0' ? '0' : '1');
  const pick = (k, allowed, def) => (allowed.includes(get(k)) ? get(k) : def);

  const q = new URLSearchParams();
  q.set('from', from);
  q.set('to', to);
  for (const v of params.getAll('via').map((s) => s.trim()).filter(Boolean).slice(0, 3)) {
    q.append('via', v.slice(0, 60));
  }
  q.set('y', date[1]);
  q.set('m', date[2]);
  q.set('d', date[3]);
  q.set('hh', pad2(time[1]));
  q.set('m1', time[2][0]);
  q.set('m2', time[2][1]);
  q.set('type', Object.hasOwn(TYPE_CODE, get('type')) ? TYPE_CODE[get('type')] : TYPE_CODE.dep);
  q.set('ticket', pick('ticket', ['ic', 'normal'], 'ic'));
  q.set('expkind', pick('expkind', ['1', '2', '3'], '1'));
  q.set('userpass', '1');
  q.set('ws', pick('ws', ['1', '2', '3', '4'], '3'));
  q.set('s', pick('s', ['0', '1', '2'], '0'));
  for (const k of ['al', 'shin', 'ex', 'hb', 'lb', 'sr']) q.set(k, flag(k));
  // 2 ページ目以降（Yahoo は 1 ページ 3 ルート。fl〜tl 番目を表示）
  const page = Number(get('page'));
  if (Number.isInteger(page) && page >= 2 && page <= 3) {
    q.set('fl', String((page - 1) * 3 + 1));
    q.set('tl', String(page * 3));
  }

  return `${origin}/search/result?${q}`;
}

export class InputError extends Error {}

// ---------- HTML 解析 ----------

// 全角英数を半角に、連続する空白を 1 つに
const clean = (s) => (s == null ? '' : String(s)).normalize('NFKC').replace(/\s+/g, ' ').trim();
const text = (el) => (el ? clean(el.textContent) : '');
const hasClass = (el, name) => !!el.classList && el.classList.contains(name);
const elementChildren = (el) => el.childNodes.filter((n) => n.nodeType === 1);
const TIME_RE = /(\d{1,2}:\d{2})/;

function parseSummary(routeEl) {
  const sum = routeEl.querySelector('.routeSummary');
  if (!sum) return null;
  const timeText = text(sum.querySelector('li.time'));
  const dep = /(\d{1,2}:\d{2})発/.exec(timeText);
  const arr = /(\d{1,2}:\d{2})着/.exec(timeText);
  const duration = clean(timeText.split('着').slice(1).join('着'));
  const transfer = /(\d+)回/.exec(text(sum.querySelector('li.transfer')));
  const fareText = text(sum.querySelector('li.fare'));
  const fare = /([\d,]+)円/.exec(fareText);
  return {
    dep: dep ? dep[1] : '',
    arr: arr ? arr[1] : '',
    duration,
    transfers: transfer ? Number(transfer[1]) : null,
    fare: fare ? Number(fare[1].replace(/,/g, '')) : null,
    fareNote: clean(fareText.replace(/[\d,]+円/, '')),
    distance: text(sum.querySelector('li.distance')),
    tags: sum.querySelectorAll('ul.priority li span').map(text).filter(Boolean),
    alert: !!sum.querySelector('li.time .icnAlert'),
  };
}

function parseStation(el) {
  const link = el.querySelector('dl dt a');
  const name = text(link) || text(el.querySelector('dl dt'));
  // 駅ページへのリンクがあれば駅（住所や施設から検索したときの出発地点にはない）
  const isStation = !!(link && /\/station\//.test(link.getAttribute('href') || ''));
  let arr = '';
  let dep = '';
  for (const li of el.querySelectorAll('ul.time li')) {
    const t = text(li);
    const m = TIME_RE.exec(t);
    if (!m) continue;
    if (t.includes('着')) arr = m[1];
    else if (t.includes('発')) dep = m[1];
    else if (!dep) dep = m[1];
  }
  return { kind: 'station', name, arr, dep, isStation };
}

// Yahoo のページにあるリンクの文字（アプリでは使えない）
const JUNK_RE = /地図でルート表示|ルートを表示|地図を表示|地図を見る/g;

function parseWalk(el) {
  const all = text(el).replace(JUNK_RE, ' ');
  const min = /徒歩\s*(\d+)\s*分/.exec(all);
  const exit = /出口\s*[:：]?\s*(?!徒歩)([^\s:：]+?)(?=\s|徒歩|$)/.exec(all);
  return {
    walkMinutes: min ? Number(min[1]) : null,
    exit: exit ? exit[1] : '',
  };
}

function parseAccess(el) {
  const transport = el.querySelector('li.transport');
  const destination = text(transport && transport.querySelector('.destination'));
  let line = text(transport).replace(JUNK_RE, ' ');
  if (destination) line = line.replace(destination, '');
  line = clean(line);
  const walk = /徒歩/.test(line) && !destination;
  const status = el.querySelector('li.serviceStatus');
  if (walk) {
    const w = parseWalk(el);
    return {
      kind: 'access',
      line: w.walkMinutes != null ? `徒歩${w.walkMinutes}分` : '徒歩',
      destination: '',
      color: '',
      platform: w.exit ? `出口：${w.exit}` : '',
      stops: '',
      walk: true,
      walkMinutes: w.walkMinutes,
      exit: w.exit,
      alert: !!(status && status.querySelector('.icnAlert')),
      alertText: text(status),
    };
  }
  const lineEl = transport && transport.querySelector('.line');
  const style = (lineEl && lineEl.getAttribute('style')) || '';
  const color = /border-color:\s*(#[0-9a-fA-F]{3,8}|rgb\([^)]*\))/.exec(style);
  return {
    kind: 'access',
    line,
    destination,
    color: color ? color[1] : '',
    platform: clean(text(el.querySelector('li.platform')).replace(JUNK_RE, ' ')),
    stops: text(el.querySelector('li.stop')),
    walk: false,
    alert: !!(status && status.querySelector('.icnAlert')),
    alertText: text(status),
  };
}

// routeDetail の直下は station / access / fareSection（入れ子あり）が並ぶ
function flattenDetail(el, out) {
  for (const child of elementChildren(el)) {
    if (hasClass(child, 'station')) out.push(parseStation(child));
    else if (hasClass(child, 'access')) out.push(parseAccess(child));
    else if (hasClass(child, 'fareSection')) flattenDetail(child, out);
  }
  return out;
}

// ---------- ページに埋め込まれた JSON（__NEXT_DATA__）から読む ----------
// Yahoo の結果ページは Next.js で作られていて、経路のデータが JSON で入っている。
// HTML の見た目に左右されないので、こちらを優先して使う。

export function extractNextData(html) {
  const start = html.indexOf('<script id="__NEXT_DATA__"');
  if (start < 0) return null;
  const open = html.indexOf('>', start);
  const close = html.indexOf('</script>', open);
  if (open < 0 || close < 0) return null;
  try {
    return JSON.parse(html.slice(open + 1, close));
  } catch (e) {
    return null;
  }
}

const toNumber = (s) => {
  if (s == null || String(s).trim() === '') return null; // 数値の 0 は 0 のまま（乗換 0 回など）
  const n = Number(String(s).replace(/[,円]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const minutesBetween = (a, b) => {
  const m1 = /^(\d{1,2}):(\d{2})$/.exec(a || '');
  const m2 = /^(\d{1,2}):(\d{2})$/.exec(b || '');
  if (!m1 || !m2) return null;
  let d = (Number(m2[1]) * 60 + Number(m2[2])) - (Number(m1[1]) * 60 + Number(m1[2]));
  if (d < 0) d += 24 * 60;
  return d;
};

function platformText(pos) {
  if (!pos) return '';
  const side = (arr, label) => {
    if (!Array.isArray(arr) || !arr.length) return '';
    const [num, unit] = arr;
    if (num == null || num === '') return unit && unit !== '情報なし' ? `[${label}] ${unit}` : '';
    return `[${label}] ${num}${unit || ''}`;
  };
  return [side(pos.departure, '発'), side(pos.arrival, '着')].filter(Boolean).join(' → ');
}

function alertTextOf(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return list.map((x) => (typeof x === 'string' ? x : x && (x.title || x.text || x.message || x.status || x.name)) || '')
    .filter(Boolean).join(' ') || '運行情報あり';
}

function routeFromFeature(fi) {
  const s = fi.summaryInfo || {};
  const edges = fi.edgeInfoList || [];
  const steps = [];
  edges.forEach((e, i) => {
    const times = e.timeInfo || [];
    let arr = '';
    let dep = '';
    for (const t of times) {
      if (t.type === 2) arr = t.time;
      else if (t.type === 1) dep = t.time;
      else if (t.type === 3) {
        // 始点・終点
        if (i === edges.length - 1) arr = t.time;
        else dep = t.time;
      }
    }
    const link = e.linkInfo || {};
    steps.push({
      kind: 'station',
      name: clean(e.stationName),
      arr,
      dep,
      isStation: !!link.station,
      code: e.stationCode || '',
    });
    const access = e.accessInfo;
    if (!access || i === edges.length - 1) return;
    const next = edges[i + 1];
    const nextArr = ((next && next.timeInfo) || []).find((t) => t.type === 2 || t.type === 3);
    if (access.type === 1) {
      const min = minutesBetween(dep, nextArr && nextArr.time);
      const exit = clean([e.exitName && e.exitName.from, e.exitName && e.exitName.to].filter(Boolean).join(' '));
      steps.push({
        kind: 'access',
        line: min != null ? `徒歩${min}分` : '徒歩',
        destination: '',
        color: '',
        platform: exit ? `出口：${exit}` : '',
        stops: '',
        walk: true,
        walkMinutes: min,
        exit,
        alert: false,
        alertText: '',
      });
      return;
    }
    const stopCount = (e.stopStationList || []).length;
    steps.push({
      kind: 'access',
      line: clean(e.railNameExcludingDestination || e.railName),
      destination: clean(e.destination),
      color: access.color ? `#${access.color}` : '',
      platform: clean(platformText(e.ridingPositionInfo)),
      stops: `${stopCount + 1}駅`,
      // 途中で止まる駅・バス停（乗る駅と降りる駅は含まない）
      stopList: (e.stopStationList || []).map((x) => ({
        name: clean(x.name),
        time: x.departureTime || x.arrivalTime || '',
      })).filter((x) => x.name),
      // 運賃の区間（"0_1" なら 0 番目の駅から 2 番目の駅まで通しで price 円）
      fareGroup: (e.priceInfo && e.priceInfo.edgeGroup) || '',
      farePrice: e.priceInfo ? toNumber(e.priceInfo.price) : null,
      walk: false,
      alert: !!(e.diaInfoStatus && e.diaInfoStatus.length),
      alertText: alertTextOf(e.diaInfoStatus),
    });
  });

  const tags = [];
  if (s.isFast) tags.push('早');
  if (s.isCheap) tags.push('安');
  if (s.isEasy) tags.push('楽');
  return {
    summary: {
      dep: s.departureTime || '',
      arr: s.arrivalTime || '',
      duration: clean(s.totalTime) + (s.timeOnBoard ? `(乗車${clean(s.timeOnBoard)})` : ''),
      transfers: toNumber(s.transferCount),
      fare: toNumber(s.totalPrice),
      fareNote: '',
      distance: clean(s.distance),
      tags,
      alert: steps.some((x) => x.alert),
    },
    steps,
  };
}

export function parseNextData(nd) {
  const ns = nd && nd.props && nd.props.pageProps && nd.props.pageProps.naviSearchParam;
  if (!ns || !Array.isArray(ns.featureInfoList)) return null;
  const info = ns.resultInfo || {};
  return {
    routes: ns.featureInfoList.map(routeFromFeature).filter((r) => r.summary.dep || r.steps.length),
    total: toNumber(info.Total),
    fromName: clean(ns.displayInfo && ns.displayInfo.fromName),
    toName: clean(ns.displayInfo && ns.displayInfo.toName),
  };
}

export function parseResult(html) {
  const nd = extractNextData(html);
  const fromJson = parseNextData(nd);
  const out = fromJson && fromJson.routes.length ? fromJson : parseResultHtml(html);
  // 「出発地・到着地のほかの候補」（バス停など、入力どおりでない候補があるとき）
  const alt = parseAlternatives(nd);
  if (alt) out.alt = alt;
  return out;
}

// JSON がないときのために、HTML からも読めるようにしておく
export function parseResultHtml(html) {
  const root = parse(html);
  const routes = [];
  for (let i = 1; i <= 9; i++) {
    const routeEl = root.querySelector(`#route${pad2(i)}`);
    if (!routeEl) break;
    const summary = parseSummary(routeEl);
    const detailEl = routeEl.querySelector('.routeDetail');
    const steps = detailEl ? flattenDetail(detailEl, []) : [];
    if (summary && (summary.dep || steps.length)) routes.push({ summary, steps });
  }
  return { routes };
}

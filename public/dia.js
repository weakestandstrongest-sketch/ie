'use strict';

// ---------- 前後の便 ----------
// 乗る電車・バスのアイコンを押すと、その駅から家までの前後の便を一覧にする（のりかえの「前後のダイヤ」と同じ考え方）。
// 駅の時刻表が読めれば全部の電車を出し、1 本ずつ「その電車で行くと家に何時に着くか」を検索する。
// 読めなければ、経路検索を時刻をずらしながらつなげて一覧を作る。
// 乗換駅の便を変えたときは、そこまでの経路はそのままにして全体の経路を作る。

const MIN_MS = 60e3;
let dia = null;

const hmOf = (dt) => `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
const dateOf = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
const normText = (s) => (s || '').normalize('NFKC').replace(/\s+/g, '').replace(/[(（][^)）]*[)）]/g, '');
const fmtMin = (ms) => TimeShift.formatMinutes(ms / MIN_MS);

async function fetchRoutes({ from, to, at: when }) {
  try {
    const res = await fetch('api/search?' + new URLSearchParams({ from, to, type: 'dep', date: dateOf(when), time: hmOf(when), ...optParams() }));
    return await res.json();
  } catch (e) {
    return { routes: [] };
  }
}

function arrAfter(hhmm, dep) {
  let a = TimeShift.nearDate(hhmm, dep);
  if (a && a < dep) a = new Date(+a + 24 * 3600e3);
  return a;
}

function openDia(stepIndex) {
  const route = state.data && state.data.routes[state.index];
  if (!route) return;
  const st = route.steps[stepIndex];
  const train = route.steps[stepIndex + 1];
  const { depAt } = routeTimes(route);
  const stDep = depAt && TimeShift.nearDate(st.dep, depAt);
  if (!stDep) return;
  const walkOnly = stepIndex === 0 || TimeShift.isWalkOnlyBefore(route, stepIndex);
  const start = state.data.start || {};
  dia = {
    route,
    stepIndex,
    st,
    train,
    to: state.data.home,
    originName: start.station ? placeName(route.steps[0].name) : '現在地',
    originDep: depAt,
    stDep,
    walkOnly,
    // 乗換駅なら、そこに着く前に出る便には乗れない
    stArr: !walkOnly && st.arr ? TimeShift.nearDate(st.arr, depAt) : null,
    entries: new Map(),
    nextT: new Date(+stDep - 30 * MIN_MS),
    earlierFrom: null,
    loading: false,
    scrolled: false,
  };

  const head = $('diaHead');
  head.style.setProperty('--c', train.color || 'var(--accent)');
  $('diaIcon').innerHTML = ICONS[/バス/.test(train.line) ? 'bus' : 'train'];
  $('diaTitle').textContent = `${placeName(st.name)} から家まで`;
  $('diaNote').textContent = walkOnly
    ? `乗る便を選ぶと、${dia.originName}を出る時刻も合わせて変わります`
    : `${placeName(st.name)}に${st.arr}着。ここから先の便を選べます`;

  if (st.code && train && !train.walk) {
    dia.mode = 'timetable';
    renderDia();
    $('diaSheet').showModal();
    startTimetableDia(dia);
    return;
  }
  dia.mode = 'chain';
  renderDia();
  $('diaSheet').showModal();
  loadDiaLater(5, +stDep + 60 * MIN_MS);
}

// ---------- 駅の時刻表から ----------
async function startTimetableDia(d) {
  // 深夜 0〜3 時台は前日の時刻表（24 時台）に載っている
  const service = new Date(d.stDep);
  if (service.getHours() < 4) service.setDate(service.getDate() - 1);
  service.setHours(0, 0, 0, 0);
  d.serviceDay = service;
  d.stMin = Math.round((d.stDep - service) / MIN_MS);
  d.loading = true;
  renderDia();
  try {
    const res = await fetch('api/timetable?' + new URLSearchParams({
      code: d.st.code, date: dateOf(service), time: d.st.dep, line: d.train.line || '', dest: d.train.destination || '',
    }));
    const data = await res.json();
    if (dia !== d) return;
    if (!res.ok || !data.trains || !data.trains.length) throw new Error(data.error || 'no timetable');
    d.tt = data;
    d.rows = new Map();
    d.from = d.stMin - 30;
    d.to = d.stMin + 60;
    d.loading = false;
    fillTimetableRows(d);
  } catch (e) {
    if (dia !== d) return;
    d.mode = 'chain';
    d.loading = false;
    loadDiaLater(5, +d.stDep + 60 * MIN_MS);
  }
}

function fillTimetableRows(d) {
  for (const t of d.tt.trains) {
    if (t.min < d.from || t.min > d.to) continue;
    const key = `${t.trainId}|${t.min}`;
    if (d.rows.has(key)) continue;
    const dep = new Date(+d.serviceDay + t.min * MIN_MS);
    const row = { train: t, dep, state: 'pending', route: null, arr: null, exact: false };
    if (d.stArr && dep < d.stArr) row.state = 'tooEarly';
    d.rows.set(key, row);
  }
  renderDia();
  runTimetableSearches(d);
}

// 今の便に近いものから順に、3 本ずつ並行して検索
async function runTimetableSearches(d) {
  if (d.searching) return;
  d.searching = true;
  const next = () => [...d.rows.values()]
    .filter((r) => r.state === 'pending')
    .sort((a, b) => Math.abs(a.dep - d.stDep) - Math.abs(b.dep - d.stDep))[0];
  const worker = async () => {
    for (let row = next(); row && dia === d; row = next()) {
      row.state = 'loading';
      const data = await fetchRoutes({ from: d.st.name, to: d.to, at: row.dep });
      if (dia !== d) return;
      resolveTimetableRow(d, row, (data && data.routes) || []);
      renderDia();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  d.searching = false;
}

function isSameTrain(r, t) {
  const a = r.steps.find((s) => s.kind === 'access');
  if (!a || a.walk) return false;
  const line = normText(a.line);
  const dest = normText(t.destination);
  const kindOk = !t.kind || line.endsWith(normText(t.kind)) || (t.kind === '普通' && !/(急|快|特|準)/.test(line.slice(-4)));
  return kindOk && (!dest || normText(a.destination).startsWith(dest));
}

// 検索結果の中から「この電車で出るルート」を探す。なければ最短の到着を目安にする
function resolveTimetableRow(d, row, routes) {
  const t = row.train;
  const exact = routes.find((r) => r.steps[0] && r.steps[0].dep === t.time && isSameTrain(r, t));
  row.searchRoutes = routes;
  if (exact) {
    row.route = exact;
    row.arr = arrAfter(exact.summary.arr, row.dep);
    row.exact = true;
  } else {
    const arrs = routes
      .filter((r) => { const dep = TimeShift.nearDate(r.summary.dep, row.dep); return dep && dep >= row.dep; })
      .map((r) => arrAfter(r.summary.arr, row.dep)).filter(Boolean);
    row.arr = arrs.length ? new Date(Math.min(...arrs)) : null;
  }
  row.state = 'done';
}

// ---------- 時刻表の電車から経路を作る ----------
// Yahoo の検索ではその電車を使う経路が出なかったとき、列車の停車駅を調べ、
// どこかで乗り換えて家に一番早く着く経路を組み立てる。
async function mapLimit(items, limit, fn) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

const companyOf = (line) => normText(line).replace(/^(JR|名鉄|近鉄|京王|東急|小田急|京急|京成|西武|東武|南海|阪急|阪神|京阪|西鉄|東京メトロ|都営|大阪メトロ).*/, '$1').slice(0, 4);
const firstTrainLine = (r) => { const a = r.steps.find((s) => s.kind === 'access' && !s.walk); return a ? a.line : ''; };

// 検索結果の「運賃の区間」から、駅 A→駅 B の運賃の表を作る（キーは "A>B"）
function addFareSections(table, routes) {
  for (const r of routes || []) {
    const stations = r.steps.filter((x, i) => i % 2 === 0);
    r.steps.forEach((a, i) => {
      if (i % 2 !== 1 || !a.fareGroup || a.farePrice == null) return;
      const m = /^(\d+)_(\d+)$/.exec(a.fareGroup);
      if (!m) return;
      const from = stations[Number(m[1])];
      const to = stations[Number(m[2]) + 1];
      if (from && to) table.set(`${normText(from.name)}>${normText(to.name)}`, a.farePrice);
    });
  }
  return table;
}

function makeTail(row, steps, cont) {
  const last = steps[steps.length - 1];
  const arr = cont ? cont.summary.arr : last.arr;
  const arrDate = arrAfter(arr, row.dep);
  return {
    summary: {
      dep: row.train.time,
      arr,
      duration: arrDate ? fmtMin(arrDate - row.dep) : '',
      transfers: Math.max(0, steps.filter((s) => s.kind === 'access' && !s.walk).length - 1),
      fare: null,
      fareNote: '',
      distance: '',
      tags: [],
      alert: !!(cont && cont.summary.alert),
    },
    steps,
  };
}

async function buildTrainRoute(d, row) {
  if (row.building) return;
  row.building = true;
  row.error = '';
  d.picked = row;
  renderDia();
  try {
    const options = await buildTrainOptions(d, row);
    if (dia !== d) return;
    row.building = false;
    if (d.picked !== row) { renderDia(); return; }
    if (!options.length) throw new Error('この便を使う経路が見つかりませんでした');
    d.view = { row, options };
    renderDia();
    $('diaList').scrollTop = 0;
  } catch (e) {
    row.building = false;
    if (dia !== d) return;
    row.error = e.message || 'エラー';
    renderDia();
  }
}

async function buildTrainOptions(d, row) {
  const t = row.train;
  const options = [];
  const add = (route, fare, via, sameCompany = false) => {
    const arr = arrAfter(route.summary.arr, row.dep);
    if (!arr) return;
    route.summary.fare = fare;
    options.push({ route, arr, fare, sameCompany, transfers: route.summary.transfers == null ? 9 : route.summary.transfers, via });
  };

  // 1) 検索結果にそのままこの電車を使う経路があれば、それも候補に
  for (const r of row.searchRoutes || []) {
    if (r.steps[0] && r.steps[0].dep === t.time && isSameTrain(r, t)) add(r, r.summary.fare, '');
  }

  // 2) 列車の停車駅を調べ、途中の駅で乗り換えた場合をそれぞれ検索する
  const res = await fetch('api/train?' + new URLSearchParams({
    code: d.st.code, group: d.tt.groupId, train: t.trainId, kind: d.tt.kind || '',
    hh: Math.floor(t.min / 60), mm: t.min % 60,
  }));
  const data = await res.json().catch(() => ({ error: `列車の情報を取得できませんでした（${res.status}）` }));
  if (dia !== d) return [];
  if (!res.ok || !data.stops || !data.stops.length) {
    if (options.length) return rankOptions(options);
    throw new Error(data.error || '停車駅が分かりませんでした');
  }
  const stops = data.stops;
  let here = stops.findIndex((s) => normText(s.name) === normText(d.st.name));
  if (here < 0) here = stops.findIndex((s) => s.dep === t.time);
  const later = stops.slice(here + 1);

  // 検索結果での駅名（「金山(愛知県)」など）を覚えておき、検索にはそちらを使う
  const fullName = new Map();
  for (const r of [...(row.searchRoutes || []), ...state.data.routes]) {
    for (const st of r.steps) {
      if (st.kind !== 'station') continue;
      const k = normText(st.name);
      if (!fullName.has(k) || st.name.length > fullName.get(k).length) fullName.set(k, st.name);
    }
  }
  const known = new Set(fullName.keys());
  const nameOf = (S) => fullName.get(normText(S.name)) || S.name;
  const fares = addFareSections(new Map(), [...(row.searchRoutes || []), ...state.data.routes]);
  let cands = later.filter((s, k) => known.has(normText(s.name)) || k === later.length - 1);
  for (const s of later) {
    if (cands.length >= 6) break;
    if (!cands.includes(s)) cands.push(s);
  }
  cands = later.filter((s) => cands.includes(s)).slice(0, 8);

  const trainLine = d.tt.railName + (t.kind && t.kind !== '普通' ? t.kind : '');
  await mapLimit(cands, 3, async (S) => {
    const atS = arrAfter(S.arr || S.dep, row.dep);
    if (!atS) return;
    const nStops = stops.indexOf(S) - Math.max(here, 0);
    const sName = nameOf(S);
    const legSteps = [
      { kind: 'station', name: d.st.name, arr: '', dep: t.time, isStation: true, code: d.st.code },
      {
        kind: 'access', line: trainLine, destination: `${t.destination}行`, color: d.train.color || '',
        platform: t.track ? `[発] ${t.track}番線` : '', stops: `${nStops}駅`, walk: false, alert: false, alertText: '',
        stopList: stops.slice(Math.max(here, 0) + 1, stops.indexOf(S)).map((x) => ({ name: nameOf(x), time: x.dep || x.arr || '' })),
      },
    ];
    // この電車で S まで乗った場合の運賃（同じ会社の電車だけを使う経路の運賃）
    const company = companyOf(trainLine);
    const legKey = `${normText(d.st.name)}>${normText(sName)}`;
    const legFareP = fares.has(legKey) ? Promise.resolve(fares.get(legKey)) : fetchRoutes({ from: d.st.name, to: sName, at: row.dep })
      .then((r) => {
        const routes = (r && r.routes) || [];
        addFareSections(fares, routes);
        if (fares.has(legKey)) return fares.get(legKey);
        const sameCo = (x) => x.steps.every((st) => st.kind !== 'access' || st.walk || companyOf(st.line) === company);
        const one = routes.find((x) => x.summary.transfers === 0 && sameCo(x) && x.summary.fare != null)
          || routes.find((x) => sameCo(x) && x.summary.fare != null);
        return one ? one.summary.fare : null;
      });

    const [contData, legFare] = await Promise.all([fetchRoutes({ from: sName, to: d.to, at: atS }), legFareP]);
    for (const c of (contData && contData.routes) || []) {
      // 乗った電車にそのまま乗り続ける経路は、もっと先の駅の候補と同じなので除く
      const cLine = normText(firstTrainLine(c));
      if (c.steps[0] && c.steps[0].dep === (S.dep || '') && cLine === normText(trainLine)) continue;
      const steps = [
        ...legSteps,
        { kind: 'station', name: sName, arr: S.arr || S.dep, dep: c.steps[0] ? c.steps[0].dep : '', isStation: true, code: S.code || '' },
        ...c.steps.slice(1),
      ];
      const fare = legFare != null && c.summary.fare != null ? legFare + c.summary.fare : null;
      const sameCompany = companyOf(cLine) === companyOf(trainLine);
      add(makeTail(row, steps, c), fare, sName, sameCompany);
    }
  });
  return rankOptions(options);
}

// 重複を除いて到着順に並べ、早・安・楽の印を付ける
function rankOptions(options) {
  const byLook = new Map();
  for (const o of options) {
    const lines = o.route.steps.filter((x) => x.kind === 'access' && !x.walk).map((x) => normText(x.line)).join('>');
    const k = `${normText(o.via)}|${+o.arr}|${o.transfers}|${lines}`;
    const prev = byLook.get(k);
    if (!prev || (prev.fare == null && o.fare != null) || (o.fare != null && prev.fare != null && o.fare < prev.fare)) byLook.set(k, o);
  }
  const all = [...byLook.values()];
  const fareOf = (o) => (o.fare == null ? 1e9 : o.fare);
  // 到着・運賃・乗換回数のどれも他より良くないもの（意味のない乗り換えなど）は出さない
  const list = all.filter((o) => !o.sameCompany || !all.some((p) => p !== o
    && +p.arr <= +o.arr && p.transfers <= o.transfers && fareOf(p) <= fareOf(o)
    && (+p.arr < +o.arr || p.transfers < o.transfers || fareOf(p) < fareOf(o))));
  list.sort((a, b) => a.arr - b.arr || fareOf(a) - fareOf(b) || a.transfers - b.transfers);
  const minArr = Math.min(...list.map((o) => +o.arr));
  const fares = list.map((o) => o.fare).filter((f) => f != null);
  const minFare = fares.length ? Math.min(...fares) : null;
  const minTr = Math.min(...list.map((o) => o.transfers));
  for (const o of list) {
    const tags = [];
    if (+o.arr === minArr) tags.push('早');
    if (minFare != null && o.fare === minFare) tags.push('安');
    if (o.transfers === minTr) tags.push('楽');
    o.route.summary.tags = tags;
  }
  return list.slice(0, 10);
}

// ---------- 検索をつなげて一覧を作る（時刻表が使えないとき） ----------
function mainAccess(route) {
  return route.steps.find((s) => s.kind === 'access' && !s.walk) || route.steps.find((s) => s.kind === 'access') || null;
}

function addDiaEntries(d, routes, t) {
  for (const r of routes) {
    const dep = TimeShift.nearDate(r.summary.dep, t);
    const arr = dep && arrAfter(r.summary.arr, dep);
    if (!dep || !arr) continue;
    const a = mainAccess(r);
    const key = `${+dep}|${+arr}|${a ? a.line : ''}`;
    if (!d.entries.has(key)) d.entries.set(key, { route: r, dep, arr });
  }
}

async function loadDiaLater(maxRequests, until) {
  const d = dia;
  if (!d || d.loading) return;
  d.loading = true;
  renderDia();
  for (let i = 0; i < maxRequests; i++) {
    const t = d.nextT;
    const data = await fetchRoutes({ from: d.st.name, to: d.to, at: t });
    if (dia !== d) return;
    const routes = data.routes || [];
    addDiaEntries(d, routes, t);
    d.nextT = TimeShift.chainNext(routes.map((r) => r.summary), t);
    renderDia();
    if (until && +d.nextT > until) break;
  }
  d.loading = false;
  renderDia();
}

async function loadDiaEarlier() {
  const d = dia;
  if (!d || d.loading) return;
  const firstDep = d.entries.size ? Math.min(...[...d.entries.values()].map((e) => +e.dep)) : +d.stDep;
  const limit = Math.min(firstDep, d.earlierFrom || Infinity);
  let t = new Date(limit - 40 * MIN_MS);
  d.earlierFrom = +t;
  d.loading = true;
  renderDia();
  for (let i = 0; i < 3 && +t < limit; i++) {
    const data = await fetchRoutes({ from: d.st.name, to: d.to, at: t });
    if (dia !== d) return;
    const routes = data.routes || [];
    addDiaEntries(d, routes, t);
    t = TimeShift.chainNext(routes.map((r) => r.summary), t);
    renderDia();
  }
  d.loading = false;
  renderDia();
}

// ---------- 表示 ----------
// 「現在地を 06:31 に出発」または「全体 06:31発 → 07:40着」
function diaTotalText(d, dep, arr) {
  if (d.walkOnly) {
    const leave = new Date(+d.originDep + (dep - d.stDep));
    return `${d.originName}を ${hmOf(leave)} に出発`;
  }
  return `全体 ${hmOf(d.originDep)}発 → ${hmOf(arr)}着`;
}

function moreLink(text, onClick, disabled) {
  const b = el('button', 'dia-more', text);
  b.type = 'button';
  b.disabled = !!disabled;
  b.addEventListener('click', onClick);
  return b;
}

// 一覧の 1 行
function diaRow({ dep, arr, arrState, meta, line, color, total, note, current, disabled, onClick }) {
  const b = el('button', 'dia-row');
  b.type = 'button';
  if (current) b.classList.add('current');
  b.disabled = !!disabled;
  b.style.setProperty('--c', color || 'var(--accent)');

  const when = el('div', 'dia-when');
  when.append(el('b', null, dep));
  const a = el('span', `dia-arr ${arrState || ''}`);
  a.append(el('i', null, '→'), arr || '');
  when.append(a);

  const info = el('div', 'dia-info');
  const l = el('p', 'dia-line');
  l.append(el('span', 'dia-dot'), line);
  info.append(l);
  if (meta) info.append(el('p', 'dia-sub', meta));
  if (total) info.append(el('p', 'dia-total', total));
  if (note) info.append(el('p', 'dia-note-row', note));
  b.append(when, info);
  if (current) b.append(el('span', 'dia-badge', 'いまの便'));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function renderTimetableDia(d, list) {
  list.append(moreLink('さらに前', () => { d.from -= 60; fillTimetableRows(d); }));
  const rows = [...d.rows.values()].sort((a, b) => a.dep - b.dep);
  let currentRow = null;
  const lineOf = (t) => `${d.tt.railName}${t.kind && t.kind !== '普通' ? t.kind : ''} ${t.destination}行`;
  for (const r of rows) {
    const t = r.train;
    const isCurrent = !currentRow && t.time === d.st.dep && d.tt.matchedIndex >= 0 && d.tt.trains[d.tt.matchedIndex].trainId === t.trainId;
    const metaParts = [];
    let arr = '';
    let arrState = '';
    let note = '';
    if (r.state === 'done' && r.arr) {
      arr = hmOf(r.arr);
      arrState = r.exact ? '' : 'estimate';
      metaParts.push(fmtMin(r.arr - r.dep));
      if (r.exact && r.route.summary.transfers != null) metaParts.push(r.route.summary.transfers ? `乗換${r.route.summary.transfers}回` : '乗換なし');
      if (!r.exact) note = '到着は目安（押すとこの便を使う経路を探します）';
    } else if (r.state === 'tooEarly') {
      note = `乗り継げません（${placeName(d.st.name)} ${d.st.arr}着）`;
    } else if (r.state === 'done') {
      note = '経路なし';
    } else {
      arrState = 'pending';
      arr = '…';
    }
    if (t.track) metaParts.push(`${t.track}番線`);
    if (r.building) note = 'この便を使う経路を探しています…';
    if (r.error && !r.building) note = `経路を作れませんでした：${r.error}`;
    const row = diaRow({
      dep: t.time,
      arr,
      arrState,
      meta: metaParts.join(' · '),
      line: lineOf(t),
      color: d.train.color,
      total: r.state === 'done' && r.arr && r.exact ? diaTotalText(d, r.dep, r.arr) : '',
      note,
      current: isCurrent,
      disabled: r.state === 'tooEarly',
      onClick: () => {
        if (r.state !== 'done') return;
        if (r.exact) chooseDia(r.route);
        else buildTrainRoute(d, r);
      },
    });
    if (isCurrent) currentRow = row;
    list.append(row);
  }
  if (!rows.length) list.append(el('p', 'dia-empty', 'この時間帯の便はありません'));
  list.append(moreLink('さらに後', () => { d.to += 60; fillTimetableRows(d); }));
  scrollToCurrent(d, currentRow);
}

function renderTrainOptions(d, list) {
  const { row, options } = d.view;
  const t = row.train;
  list.append(moreLink('‹ 前後の便に戻る', () => { d.view = null; d.scrolled = false; renderDia(); }));
  list.append(el('p', 'dia-options-title', `${t.time}発 ${d.tt.railName}${t.kind && t.kind !== '普通' ? t.kind : ''} ${t.destination}行 を使う経路`));
  for (const o of options) {
    const s = o.route.summary;
    const lines = o.route.steps.filter((x) => x.kind === 'access' && !x.walk).map((x) => x.line);
    const meta = [s.duration, s.transfers ? `乗換${s.transfers}回` : '乗換なし', o.fare != null ? `約¥${o.fare.toLocaleString()}` : '', ...s.tags].filter(Boolean).join(' · ');
    list.append(diaRow({
      dep: t.time,
      arr: hmOf(o.arr),
      meta,
      line: lines.join(' → '),
      color: d.train.color,
      total: diaTotalText(d, row.dep, o.arr),
      note: o.via ? `${placeName(o.via)}で乗り換え` : '',
      onClick: () => chooseDia(o.route),
    }));
  }
}

function renderChainDia(d, list) {
  list.append(moreLink(d.loading ? '読み込み中…' : 'さらに前', loadDiaEarlier, d.loading));
  const entries = [...d.entries.values()].sort((a, b) => a.dep - b.dep || a.arr - b.arr);
  let currentRow = null;
  for (const e of entries) {
    const r = e.route;
    const a = mainAccess(r);
    const tooEarly = d.stArr && e.dep < d.stArr;
    const isCurrent = +e.dep === +d.stDep && !currentRow;
    const meta = [fmtMin(e.arr - e.dep), r.summary.transfers ? `乗換${r.summary.transfers}回` : '乗換なし'];
    const plat = a && departPlatform(a.platform);
    if (plat) meta.push(plat);
    const row = diaRow({
      dep: hmOf(e.dep),
      arr: hmOf(e.arr),
      meta: meta.join(' · '),
      line: a ? `${a.line}${a.destination ? ` ${a.destination}` : ''}` : '',
      color: (a && a.color) || d.train.color,
      total: tooEarly ? '' : diaTotalText(d, e.dep, e.arr),
      note: tooEarly ? `乗り継げません（${placeName(d.st.name)} ${d.st.arr}着）` : '',
      current: isCurrent,
      disabled: tooEarly,
      onClick: () => chooseDia(r),
    });
    if (isCurrent) currentRow = row;
    list.append(row);
  }
  if (!entries.length && !d.loading) list.append(el('p', 'dia-empty', '便が見つかりませんでした'));
  list.append(moreLink(d.loading ? '読み込み中…' : 'さらに後', () => loadDiaLater(3), d.loading));
  scrollToCurrent(d, currentRow);
}

function scrollToCurrent(d, row) {
  if (!row || d.scrolled) return;
  d.scrolled = true;
  requestAnimationFrame(() => row.scrollIntoView({ block: 'center' }));
}

function renderDia() {
  const d = dia;
  const list = $('diaList');
  list.textContent = '';
  if (!d) return;
  if (d.mode === 'timetable') {
    if (d.loading || !d.rows) list.append(el('p', 'dia-empty', '時刻表を読み込んでいます…'));
    else if (d.view) renderTrainOptions(d, list);
    else renderTimetableDia(d, list);
    return;
  }
  renderChainDia(d, list);
}

// 選んだ便で経路を差し替える
function chooseDia(tail) {
  const d = dia;
  if (!d) return;
  $('diaSheet').close();
  if (!state.data || state.data.routes[state.index] !== d.route) return; // 別の経路に変わっていたら使わない
  const combined = TimeShift.combineRoute(d.route, d.stepIndex, tail);
  if (d.walkOnly && d.stepIndex > 0) {
    // 出発地からの徒歩も含めて、全体の所要時間を計算し直す
    const leave = TimeShift.nearDate(combined.summary.dep, d.originDep);
    const arr = leave && arrAfter(combined.summary.arr, leave);
    if (arr) combined.summary.duration = fmtMin(arr - leave);
  }
  state.data.routes[state.index] = combined;
  expanded.clear();
  saveState();
  renderResult(true);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('diaSheet').addEventListener('close', () => { dia = null; });
$('diaSheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

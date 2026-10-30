'use strict';

const $ = (id) => document.getElementById(id);
const HOME_KEY = 'ie:home';
const LAST_KEY = 'ie:last';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

const ICONS = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  walk: '<svg viewBox="0 0 24 24"><circle class="solid" cx="13" cy="4.2" r="1.9"/><path d="M9.5 21l2.2-6.2M11.7 14.8l2.6 2.4.9 3.8M8 11.4l2.4-3.2 3.4.6 1.4 3 2.6 1.2M10.4 8.2l1.3 6.6"/></svg>',
  train: '<svg viewBox="0 0 24 24"><rect x="5.5" y="3.5" width="13" height="14" rx="4"/><path d="M5.5 10.5h13M9 14.3h.01M15 14.3h.01M8.5 21l1.8-3.5M15.5 21l-1.8-3.5"/></svg>',
  bus: '<svg viewBox="0 0 24 24"><rect x="4.5" y="3.5" width="15" height="14" rx="3"/><path d="M4.5 11h15M8.2 14.5h.01M15.8 14.5h.01M7.5 17.5V20M16.5 17.5V20"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path class="solid" d="M3.5 10.6 12 3.8l8.5 6.8V19a1.6 1.6 0 0 1-1.6 1.6h-4.1v-5.4H9.2v5.4H5.1A1.6 1.6 0 0 1 3.5 19z"/></svg>',
};

// 種類ごとの色（タイムラインのグラデーションに使う）
const COLOR = { start: 'var(--ink)', walk: 'var(--walk)', home: 'var(--accent)', ride: 'var(--accent)' };

// data: 検索結果 / index: 表示中のルート / searchedAt: 検索した時刻（ミリ秒）
let state = { data: null, index: 0, searchedAt: 0 };
let busy = false;
// 途中の駅を開いている乗り物（経路の何番目の駅から乗るか）
const expanded = new Set();

// ---------- 小さな道具 ----------
const pad2 = (n) => String(n).padStart(2, '0');
const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const toMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const diffMin = (a, b) => {
  const x = toMin(a);
  const y = toMin(b);
  if (x == null || y == null) return null;
  let d = y - x;
  if (d < -12 * 60) d += 24 * 60;
  return d;
};
// ref より後（slack 分だけ前まで許す）で最初の「時:分」の日時
function at(ref, t, slack = 0) {
  const m = toMin(t);
  if (m == null) return null;
  const d = new Date(ref);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  while (d < ref - slack * 60000) d.setDate(d.getDate() + 1);
  return d;
}
function dayLabel(d) {
  if (!d) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 86400000);
  if (days === 0) return '';
  if (days === 1) return '明日';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
const mix = (a, b) => `color-mix(in srgb, ${a} 50%, ${b})`;
// 「則武本郷/岐阜バス」→「則武本郷」
const placeName = (s) => String(s || '').replace(/\/[^/]*$/, '');
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function load(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* 保存できなくても今は使える */ }
}
let home = load(HOME_KEY) || '';

// 検索条件（のりかえの設定と同じ項目）
const OPTS_KEY = 'ie:opts';
const SELECT_OPTS = { s: 'optS', expkind: 'optExpkind', ws: 'optWs', ticket: 'optTicket' };
const TOGGLE_OPTS = ['shin', 'ex', 'al', 'hb', 'lb', 'sr'];
const DEFAULT_OPTS = { s: '0', expkind: '1', ws: '3', ticket: 'ic', shin: true, ex: true, al: true, hb: true, lb: true, sr: true };
let opts = (() => {
  try { return { ...DEFAULT_OPTS, ...JSON.parse(load(OPTS_KEY) || '{}') }; } catch (e) { return { ...DEFAULT_OPTS }; }
})();
// API に渡す形（使う乗り物は 1 / 0）
function optParams() {
  const out = {};
  Object.keys(SELECT_OPTS).forEach((k) => { out[k] = opts[k]; });
  TOGGLE_OPTS.forEach((k) => { out[k] = opts[k] ? '1' : '0'; });
  return out;
}

// ---------- 見出し ----------
function renderTop() {
  const now = new Date();
  $('date').textContent = `${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}曜日`;
  const h = now.getHours();
  $('greet').textContent = h < 4 ? '遅くまでおつかれさま' : h < 11 ? 'おはようございます' : h < 17 ? 'おつかれさま' : h < 22 ? 'おかえりの時間です' : '今日もおつかれさま';
}

function renderHomeLabel() {
  const label = $('homeLabel');
  label.textContent = '';
  if (home) {
    label.append('家 · ', el('b', null, placeName(home)));
  } else {
    label.textContent = '家の場所を設定する';
  }
}

function showMessage(title, body) {
  $('messageTitle').textContent = title;
  $('messageBody').textContent = body || '';
  $('message').hidden = false;
}
function hideMessage() { $('message').hidden = true; }

// ---------- 現在地 ----------
function getPosition(options) {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
}
async function locate() {
  if (!window.isSecureContext || !navigator.geolocation) throw Object.assign(new Error('このブラウザでは位置情報が使えません'), { code: 0 });
  // まずは速い測位（Wi-Fi など）、だめなら GPS で
  return getPosition({ enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 })
    .catch((e) => (e.code === 1 ? Promise.reject(e) : getPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 })));
}

// ---------- 帰る ----------
async function goHome() {
  if (busy) return;
  if (!home) { openSheet(); return; }
  busy = true;
  document.body.classList.add('loading');
  $('goText').textContent = '探しています';
  hideMessage();
  try {
    let pos;
    try {
      pos = await locate();
    } catch (e) {
      throw new Error(e.code === 1
        ? '位置情報が許可されていません|設定 › プライバシー › 位置情報サービス で Safari を「使用中のみ」にしてください'
        : '現在地がわかりませんでした|少し移動してから、もう一度押してください');
    }
    const now = new Date();
    const q = new URLSearchParams({
      lat: pos.coords.latitude.toFixed(6),
      lng: pos.coords.longitude.toFixed(6),
      home,
      date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
      time: hm(now),
      ...optParams(),
    });
    let data;
    try {
      const res = await fetch('api/home?' + q);
      data = await res.json();
    } catch (e) {
      throw new Error('つながりませんでした|電波のよいところで、もう一度押してください');
    }
    if (!data.routes || !data.routes.length) throw new Error(`経路が見つかりませんでした|${data.error || ''}`);
    state = { data, index: 0, searchedAt: now.getTime() };
    expanded.clear();
    saveState();
    document.body.classList.add('has-result');
    renderResult(true);
    window.scrollTo(0, 0);
  } catch (e) {
    const [title, body] = String(e.message).split('|');
    showMessage(title, body);
  } finally {
    busy = false;
    document.body.classList.remove('loading');
    $('goText').textContent = '帰る';
  }
}

// 「帰る」を押し直すまで、前の結果を覚えておく
function saveState() {
  save(LAST_KEY, JSON.stringify(state));
}
function restoreState() {
  try {
    const s = JSON.parse(load(LAST_KEY) || 'null');
    if (s && s.data && Array.isArray(s.data.routes) && s.data.routes.length) {
      state = { data: s.data, index: Math.min(s.index || 0, s.data.routes.length - 1), searchedAt: s.searchedAt || Date.now() };
      return true;
    }
  } catch (e) { /* 読めなければ最初から */ }
  return false;
}

// ---------- 経路をタイムラインにする ----------
function departPlatform(platform) {
  const m = /\[発\]\s*([^\s→]+)/.exec(platform || '');
  return m ? m[1] : '';
}

// 経路の手順を、タイムラインの項目と「つなぎ」（乗換の待ち時間など）にする
function buildItems(route, start, homeName) {
  const steps = route.steps || [];
  const last = steps.length - 1;
  const items = [];
  let note = '';
  const push = (it) => { it.note = note; note = ''; items.push(it); };
  steps.forEach((s, i) => {
    if (s.kind === 'station') {
      if (i === 0) {
        push({ type: 'start', time: s.dep, title: start && start.station ? `${placeName(s.name)}から` : '現在地を出発', sub: start && start.station ? '' : s.name });
      } else if (i === last) {
        push({ type: 'home', time: s.arr, title: '家に到着', sub: placeName(homeName) });
      } else {
        const wait = diffMin(s.arr, s.dep);
        note = wait > 0 ? `${placeName(s.name)} · ${wait}分待ち` : placeName(s.name);
      }
      return;
    }
    const prev = steps[i - 1] || {};
    const next = steps[i + 1] || {};
    const minutes = diffMin(prev.dep, next.arr);
    if (s.walk) {
      const n = s.walkMinutes != null ? s.walkMinutes : minutes;
      const exit = s.exit && s.exit !== '徒歩' ? s.exit : '';
      push({ type: 'walk', time: prev.dep, minutes: n, title: n != null ? `歩く ${n}分` : '歩く', sub: exit ? `${exit} から` : next.name && next.kind === 'station' && steps.indexOf(next) !== last ? `${placeName(next.name)}まで` : '' });
      return;
    }
    const meta = [];
    if (minutes != null) meta.push(`${minutes}分`);
    const plat = departPlatform(s.platform);
    if (plat) meta.push(plat);
    push({
      type: 'ride',
      stepIndex: i - 1,
      stops: s.stops,
      // 乗る駅・途中で止まる駅・降りる駅
      stopList: [
        { name: placeName(prev.name), time: prev.dep, edge: true },
        ...(s.stopList || []).map((x) => ({ name: placeName(x.name), time: x.time })),
        { name: placeName(next.name), time: next.arr, edge: true },
      ],
      bus: /バス/.test(s.line),
      time: prev.dep,
      end: next.arr,
      minutes,
      color: s.color,
      title: s.line,
      small: s.destination,
      sub: `${placeName(prev.name)} → ${placeName(next.name)}`,
      meta,
      alert: s.alert ? (s.alertText || '運行情報あり') : '',
    });
  });
  // 線の色：電車・バスはその路線の色、歩くところは前後の路線の色のあいだ
  const rideColor = (from, step) => {
    for (let j = from; j >= 0 && j < items.length; j += step) if (items[j].type === 'ride') return items[j].color || COLOR.ride;
    return null;
  };
  items.forEach((it, i) => {
    it.c = it.color || COLOR[it.type];
    if (it.type === 'ride' || it.type === 'home') it.lc = it.c;
    else {
      const before = rideColor(i - 1, -1);
      const after = rideColor(i + 1, 1) || COLOR.home;
      it.lc = before ? mix(before, after) : after;
    }
  });
  return items;
}

function renderItem(it, next) {
  const li = el('li', `item ${it.type}`);
  li.style.setProperty('--c', it.c);

  const pillHeight = it.type === 'ride' && it.minutes != null ? Math.max(72, Math.min(180, 40 + it.minutes * 3)) : 48;
  const t = el('div', 't');
  t.style.height = `${pillHeight}px`;
  t.append(el('span', null, it.time || ''));
  if (it.end && it.type === 'ride') t.append(el('span', 'end', it.end));

  const rail = el('div', 'rail');
  const pill = el(it.type === 'ride' ? 'button' : 'div', 'pill');
  if (it.type === 'ride') {
    // 乗り物のアイコンを押すと前後の便
    pill.type = 'button';
    pill.setAttribute('aria-label', `${it.title} の前後の便`);
    pill.addEventListener('click', () => openDia(it.stepIndex));
  }
  pill.innerHTML = ICONS[it.type === 'ride' ? (it.bus ? 'bus' : 'train') : it.type === 'start' ? 'pin' : it.type];
  pill.style.height = `${pillHeight}px`;
  rail.append(pill);
  if (next) {
    const tail = el('span', 'tail');
    tail.style.setProperty('--from', it.lc);
    tail.style.setProperty('--to', mix(it.lc, next.lc));
    rail.append(tail);
  }

  const body = el('div', 'body');
  const title = el('p', 'title', it.title);
  if (it.small) title.append(el('small', null, it.small));
  body.append(title);
  if (it.sub) body.append(el('p', 'sub', it.sub));
  if ((it.meta && it.meta.length) || it.alert || it.type === 'ride') {
    const ul = el('ul', 'meta');
    (it.meta || []).forEach((m) => ul.append(el('li', null, m)));
    if (it.alert) ul.append(el('li', 'warn', `⚠︎ ${it.alert}`));
    if (it.type === 'ride') {
      const hasStops = it.stopList.length > 2;
      if (it.stops || hasStops) {
        const chip = el('li', 'chip-btn stops-toggle', `${it.stops || `${it.stopList.length - 1}駅`}`);
        chip.append(el('span', 'chev', '⌄'));
        ul.append(chip);
      }
      const diaChip = el('li', 'chip-btn', '前後の便');
      diaChip.addEventListener('click', (e) => { e.stopPropagation(); openDia(it.stepIndex); });
      ul.append(diaChip);
    }
    body.append(ul);
  }
  if (it.type === 'ride') {
    // 本文を押すと、途中で止まる駅を開いたり閉じたりする
    const stops = el('ol', 'stops');
    it.stopList.forEach((x) => {
      const row = el('li', x.edge ? 'edge' : null);
      row.append(el('span', 'stop-time', x.time || ''), el('span', 'stop-name', x.name));
      stops.append(row);
    });
    body.append(stops);
    body.classList.add('tappable');
    const open = expanded.has(it.stepIndex);
    li.classList.toggle('open', open);
    body.setAttribute('role', 'button');
    body.setAttribute('aria-expanded', String(open));
    body.tabIndex = 0;
    const toggle = () => {
      const now = !li.classList.contains('open');
      li.classList.toggle('open', now);
      body.setAttribute('aria-expanded', String(now));
      if (now) expanded.add(it.stepIndex); else expanded.delete(it.stepIndex);
    };
    body.addEventListener('click', toggle);
    body.addEventListener('keydown', (e) => { if (e.key === 'Enter') toggle(); });
  }
  li.append(t, rail, body);
  return li;
}

function renderGap(prev, next) {
  const li = el('li', 'gap');
  li.append(el('span'));
  const dots = el('span', 'dots');
  dots.style.setProperty('--from', mix(prev.lc, next.lc));
  dots.style.setProperty('--to', next.lc);
  li.append(dots);
  if (next.note) li.append(el('p', 'note', next.note));
  return li;
}

const cleanDuration = (d) => (d || '').replace(/\(.*?\)/g, '').trim();

function routeTimes(route) {
  const depAt = at(state.searchedAt, route.summary.dep, 30);
  const arrAt = depAt ? at(depAt.getTime(), route.summary.arr) : null;
  return { depAt, arrAt };
}

function renderCountdown() {
  const { data, index } = state;
  if (!data) return;
  const { depAt } = routeTimes(data.routes[index]);
  const badge = $('countdown');
  badge.className = 'badge';
  if (!depAt) { badge.textContent = ''; return; }
  const left = Math.floor((depAt - Date.now()) / 60000);
  if (left < 0) {
    badge.textContent = '出発時刻を過ぎました';
    badge.classList.add('past');
  } else if (left === 0) {
    badge.textContent = '今すぐ出発';
    badge.classList.add('now');
  } else {
    badge.textContent = left >= 60 ? `あと${Math.floor(left / 60)}時間${left % 60}分` : `あと${left}分`;
    if (left <= 3) badge.classList.add('now');
  }
}

function renderResult(animate) {
  const { data, index } = state;
  const route = data.routes[index];
  const s = route.summary;
  const { depAt, arrAt } = routeTimes(route);
  const result = $('result');
  result.hidden = false;
  result.classList.remove('enter');
  if (animate) { void result.offsetWidth; result.classList.add('enter'); }

  $('arrTime').textContent = s.arr || '--:--';
  $('arrDay').textContent = dayLabel(arrAt);
  $('depTime').textContent = s.dep ? `${dayLabel(depAt)}${s.dep} に出発` : '';
  renderCountdown();

  const facts = $('facts');
  facts.textContent = '';
  const fact = (value) => { const li = el('li'); li.append(el('b', null, value)); facts.append(li); };
  if (s.duration) fact(cleanDuration(s.duration));
  if (s.fare != null) fact(`¥${s.fare.toLocaleString()}`);
  if (s.transfers != null) fact(s.transfers ? `乗換${s.transfers}回` : '乗換なし');
  if (s.tags && s.tags.length) fact(s.tags.join(' · '));

  const tl = $('timeline');
  tl.textContent = '';
  const items = buildItems(route, data.start, data.home);
  items.forEach((it, i) => {
    if (i > 0) tl.append(renderGap(items[i - 1], it));
    tl.append(renderItem(it, items[i + 1]));
  });
  [...tl.children].forEach((li, i) => li.style.setProperty('--i', i));

  const others = $('others');
  others.textContent = '';
  data.routes.forEach((r, i) => {
    if (i === index) return;
    const li = el('li', 'other');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const colors = r.steps.filter((x) => x.kind === 'access' && !x.walk).map((x) => x.color || 'var(--accent)');
    const stripe = el('span', 'stripe');
    if (colors.length) stripe.style.setProperty('--stripe', (colors.length > 1 ? colors : [colors[0], colors[0]]).join(', '));
    const time = el('div', 'other-time');
    time.append(r.summary.dep, el('span', null, '→'), r.summary.arr);
    const meta = el('div', 'other-meta');
    meta.textContent = [cleanDuration(r.summary.duration), r.summary.fare != null ? `¥${r.summary.fare.toLocaleString()}` : '', r.summary.transfers ? `乗換${r.summary.transfers}` : ''].filter(Boolean).join(' · ');
    li.append(stripe, time, meta);
    const pick = () => {
      state.index = i;
      expanded.clear();
      saveState();
      renderResult(true);
      window.scrollTo(0, 0);
    };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    others.append(li);
  });
  $('othersWrap').hidden = !others.children.length;
  $('yahooLink').href = data.yahooUrl || 'https://transit.yahoo.co.jp/';

  const when = new Date(state.searchedAt);
  $('saved').textContent = `${dayLabel(when) ? `${when.getMonth() + 1}月${when.getDate()}日 ` : ''}${hm(when)} に調べた経路`;
}

// ---------- 家の設定 ----------
let suggestTimer = 0;
let suggestSeq = 0;

function openSheet() {
  const dlg = $('homeSheet');
  $('homeInput').value = home;
  $('suggest').textContent = '';
  $('sheetNote').textContent = home ? '' : 'はじめに家の場所を入れてください';
  Object.entries(SELECT_OPTS).forEach(([k, id]) => { $(id).value = opts[k]; });
  TOGGLE_OPTS.forEach((k) => { $(`opt_${k}`).checked = !!opts[k]; });
  dlg.showModal();
  dlg.scrollTop = 0;
  // 家が決まっていないときだけ、すぐ入力できるようにする（キーボードで設定が隠れないように）
  if (!home) setTimeout(() => $('homeInput').focus(), 250);
}

function setHome(v) {
  home = v;
  save(HOME_KEY, v);
  renderHomeLabel();
  hideMessage();
}

function saveHome(v) {
  v = (v || '').trim();
  if (!v) { $('sheetNote').textContent = '駅名・バス停か住所を入れてください'; return; }
  setHome(v);
  $('homeSheet').close();
}

function saveOpts() {
  Object.entries(SELECT_OPTS).forEach(([k, id]) => { opts[k] = $(id).value; });
  TOGGLE_OPTS.forEach((k) => { opts[k] = $(`opt_${k}`).checked; });
  save(OPTS_KEY, JSON.stringify(opts));
}

async function loadSuggest(q) {
  const seq = ++suggestSeq;
  const list = $('suggest');
  if (!q) { list.textContent = ''; return; }
  let items = [];
  try {
    const res = await fetch('api/suggest?' + new URLSearchParams({ q }));
    items = (await res.json()).items || [];
  } catch (e) { /* 候補なしで続ける */ }
  if (seq !== suggestSeq) return;
  list.textContent = '';
  items.forEach((c) => {
    const li = el('li', null, c.name || c.value);
    li.append(el('small', null, c.kind === 'bus' ? `バス停${c.company ? ` · ${c.company}` : ''}` : '駅'));
    li.addEventListener('click', () => saveHome(c.value));
    list.append(li);
  });
}

async function useHere() {
  const note = $('sheetNote');
  note.textContent = '現在地の住所を調べています…';
  try {
    const pos = await locate();
    const res = await fetch('api/where?' + new URLSearchParams({ lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) }));
    const data = await res.json();
    if (!data.address) throw new Error(data.error);
    $('homeInput').value = data.address;
    note.textContent = 'この住所でよければ「完了」を押してください';
    $('homeInput').focus();
  } catch (e) {
    note.textContent = '住所がわかりませんでした。手で入れてください';
  }
}

// ---------- はじまり ----------
$('go').addEventListener('click', goHome);
$('settings').addEventListener('click', openSheet);
$('homeLabel').addEventListener('click', openSheet);
$('homeLabel').addEventListener('keydown', (e) => { if (e.key === 'Enter') openSheet(); });
$('useHere').addEventListener('click', useHere);
$('useHere').addEventListener('keydown', (e) => { if (e.key === 'Enter') useHere(); });
$('homeForm').addEventListener('submit', (e) => { e.preventDefault(); saveHome($('homeInput').value); });
$('homeInput').addEventListener('input', (e) => {
  clearTimeout(suggestTimer);
  const q = e.target.value.trim();
  suggestTimer = setTimeout(() => loadSuggest(q), 220);
});
$('homeSheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$('sheetDone').addEventListener('click', () => $('homeSheet').close());
// 閉じるときに、入力した家の場所も保存する
$('homeSheet').addEventListener('close', () => {
  const v = $('homeInput').value.trim();
  if (v && v !== home) setHome(v);
});
$('homeSheet').addEventListener('change', (e) => { if (e.target.id !== 'homeInput') saveOpts(); });

renderTop();
renderHomeLabel();
if (restoreState()) {
  document.body.classList.add('has-result');
  renderResult(true);
}
// 開いたときのアニメーション。終わったら、ふだんの動きに戻す
let introTimer = 0;
function endIntroLater() {
  clearTimeout(introTimer);
  introTimer = setTimeout(() => document.documentElement.classList.remove('intro'), 1600);
}
function playIntro() {
  if (busy || document.querySelector('dialog[open]')) return;
  const root = document.documentElement;
  root.classList.remove('intro');
  void root.offsetWidth; // いったん外してから付け直すと、最初から再生される
  root.classList.add('intro');
  if (state.data) renderResult(true);
  window.scrollTo(0, 0);
  endIntroLater();
}
endIntroLater();
// ホーム画面のアプリは、閉じても読み込み直さずに再開することが多いので、戻ってきたときにも流す
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (hiddenAt && Date.now() - hiddenAt > 3000) playIntro();
});
window.addEventListener('pageshow', (e) => { if (e.persisted) playIntro(); });
setInterval(() => { renderTop(); renderCountdown(); }, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderTop(); renderCountdown(); } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

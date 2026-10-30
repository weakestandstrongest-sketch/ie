'use strict';

const $ = (id) => document.getElementById(id);
const HOME_KEY = 'ie:home';
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

const ICONS = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>',
  walk: '<svg viewBox="0 0 24 24"><circle class="solid" cx="13" cy="4.2" r="1.9"/><path d="M9.5 21l2.2-6.2M11.7 14.8l2.6 2.4.9 3.8M8 11.4l2.4-3.2 3.4.6 1.4 3 2.6 1.2M10.4 8.2l1.3 6.6"/></svg>',
  train: '<svg viewBox="0 0 24 24"><rect x="5.5" y="3.5" width="13" height="14" rx="4"/><path d="M5.5 10.5h13M9 14.3h.01M15 14.3h.01M8.5 21l1.8-3.5M15.5 21l-1.8-3.5"/></svg>',
  bus: '<svg viewBox="0 0 24 24"><rect x="4.5" y="3.5" width="15" height="14" rx="3"/><path d="M4.5 11h15M8.2 14.5h.01M15.8 14.5h.01M7.5 17.5V20M16.5 17.5V20"/></svg>',
  station: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path class="solid" d="M3.5 10.6 12 3.8l8.5 6.8V19a1.6 1.6 0 0 1-1.6 1.6h-4.1v-5.4H9.2v5.4H5.1A1.6 1.6 0 0 1 3.5 19z"/></svg>',
};

let state = { data: null, index: 0, searchedAt: null };
let busy = false;

// ---------- 小さな道具 ----------
const pad2 = (n) => String(n).padStart(2, '0');
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
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function getHome() {
  try { return localStorage.getItem(HOME_KEY) || ''; } catch (e) { return ''; }
}
function setHome(v) {
  try { localStorage.setItem(HOME_KEY, v); } catch (e) { /* 保存できなくても今回は使う */ }
  memoryHome = v;
}
let memoryHome = getHome();

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
  if (memoryHome) {
    label.append('家 · ');
    label.append(el('b', null, memoryHome));
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
  if (!memoryHome) { openSheet(); return; }
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
      home: memoryHome,
      date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`,
      time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
    });
    let data;
    try {
      const res = await fetch('api/home?' + q);
      data = await res.json();
    } catch (e) {
      throw new Error('つながりませんでした|電波のよいところで、もう一度押してください');
    }
    if (!data.routes || !data.routes.length) throw new Error(`経路が見つかりませんでした|${data.error || ''}`);
    state = { data, index: 0, searchedAt: now };
    renderResult();
    document.body.classList.add('has-result');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) {
    const [title, body] = String(e.message).split('|');
    showMessage(title, body);
  } finally {
    busy = false;
    document.body.classList.remove('loading');
    $('goText').textContent = '帰る';
  }
}

// ---------- 経路をタイムラインにする ----------
function departPlatform(platform) {
  const m = /\[発\]\s*([^\s→]+)/.exec(platform || '');
  return m ? m[1] : '';
}

function buildItems(route, start, homeName) {
  const steps = route.steps || [];
  const last = steps.length - 1;
  const items = [];
  steps.forEach((s, i) => {
    if (s.kind === 'station') {
      if (i === 0) {
        items.push({ type: 'start', time: s.dep, title: start.station ? `${s.name}から` : '現在地を出発', sub: start.station ? '' : s.name });
      } else if (i === last) {
        items.push({ type: 'home', time: s.arr, title: '家に到着', sub: homeName });
      } else {
        const wait = diffMin(s.arr, s.dep);
        items.push({ type: 'gap', note: wait > 0 ? `${s.name} · ${wait}分待ち` : s.name });
      }
      return;
    }
    const prev = steps[i - 1] || {};
    const next = steps[i + 1] || {};
    const minutes = diffMin(prev.dep, next.arr);
    if (s.walk) {
      const n = s.walkMinutes != null ? s.walkMinutes : minutes;
      items.push({ type: 'walk', time: prev.dep, end: next.arr, minutes: n, title: n != null ? `歩く ${n}分` : '歩く', sub: s.exit ? `${s.exit} へ` : `${next.name || ''}まで` });
      return;
    }
    const meta = [];
    const plat = departPlatform(s.platform);
    if (plat) meta.push(plat);
    if (s.stops) meta.push(s.stops);
    items.push({
      type: 'ride',
      bus: /バス/.test(s.line),
      time: prev.dep,
      end: next.arr,
      minutes,
      color: s.color,
      title: s.line,
      small: s.destination,
      sub: `${prev.name || ''} → ${next.name || ''}`,
      meta,
      alert: s.alert ? (s.alertText || '運行情報あり') : '',
    });
  });
  // 前後に「つなぎ」がない所にも点線を入れる
  const out = [];
  items.forEach((it, i) => {
    if (i > 0 && it.type !== 'gap' && items[i - 1].type !== 'gap') out.push({ type: 'gap', note: '' });
    out.push(it);
  });
  return out;
}

function renderItem(it, delay) {
  if (it.type === 'gap') {
    const li = el('li', 'gap');
    li.style.animationDelay = `${delay}ms`;
    li.append(el('span'), el('span', 'dots'));
    if (it.note) li.append(el('p', 'note', it.note));
    return li;
  }
  const li = el('li', `item ${it.type}`);
  li.style.animationDelay = `${delay}ms`;
  if (it.color) li.style.setProperty('--c', it.color);

  const t = el('div', 't');
  t.append(el('span', null, it.time || ''));
  if (it.end && it.type === 'ride') t.append(el('span', null, it.end));
  const pill = el('div', 'pill');
  pill.innerHTML = ICONS[it.type === 'ride' ? (it.bus ? 'bus' : 'train') : it.type === 'start' ? 'pin' : it.type];
  if (it.type === 'ride' && it.minutes != null) pill.style.height = `${Math.max(64, Math.min(180, 40 + it.minutes * 3))}px`;

  const body = el('div', 'body');
  const title = el('p', 'title', it.title);
  if (it.small) title.append(el('small', null, it.small));
  body.append(title);
  if (it.sub) body.append(el('p', 'sub', it.sub));
  const metaItems = [...(it.meta || [])];
  if (it.minutes != null && it.type === 'ride') metaItems.unshift(`${it.minutes}分`);
  if (metaItems.length || it.alert) {
    const ul = el('ul', 'meta');
    metaItems.forEach((m) => ul.append(el('li', null, m)));
    if (it.alert) ul.append(el('li', 'warn', `⚠︎ ${it.alert}`));
    body.append(ul);
  }
  li.append(t, pill, body);
  return li;
}

function cleanDuration(d) {
  return (d || '').replace(/\(.*?\)/g, '').trim();
}

function renderCountdown() {
  const { data, index, searchedAt } = state;
  if (!data) return;
  const dep = data.routes[index].summary.dep;
  const badge = $('countdown');
  const now = new Date();
  const left = diffMin(`${now.getHours()}:${pad2(now.getMinutes())}`, dep);
  badge.className = 'badge';
  if (left == null) {
    badge.textContent = '';
  } else if (left <= 0) {
    badge.textContent = left === 0 ? '今すぐ出発' : '出発時刻を過ぎました';
    badge.classList.add(left === 0 ? 'now' : 'past');
  } else {
    badge.textContent = left >= 60 ? `あと${Math.floor(left / 60)}時間${left % 60}分` : `あと${left}分`;
    if (left <= 3) badge.classList.add('now');
  }
  // 1 時間以上たったら古い結果として下げる
  if (searchedAt && now - searchedAt > 60 * 60 * 1000) badge.classList.add('past');
}

function renderResult() {
  const { data, index } = state;
  const route = data.routes[index];
  const s = route.summary;
  $('result').hidden = false;
  $('arrTime').textContent = s.arr || '--:--';
  $('depTime').textContent = s.dep ? `${s.dep} に出発` : '';
  renderCountdown();

  const facts = $('facts');
  facts.textContent = '';
  const fact = (label, value) => {
    const li = el('li');
    li.append(el('b', null, value), ` ${label}`);
    facts.append(li);
  };
  if (s.duration) fact('', cleanDuration(s.duration));
  if (s.fare != null) fact('', `¥${s.fare.toLocaleString()}`);
  if (s.transfers != null) fact('', s.transfers ? `乗換${s.transfers}回` : '乗換なし');
  if (s.tags && s.tags.length) fact('', s.tags.join(' · '));

  const tl = $('timeline');
  tl.textContent = '';
  buildItems(route, data.start, data.home).forEach((it, i) => tl.append(renderItem(it, 60 + i * 45)));

  const others = $('others');
  others.textContent = '';
  data.routes.forEach((r, i) => {
    if (i === index) return;
    const li = el('li', 'other');
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    const stripe = el('div', 'stripe');
    r.steps.filter((x) => x.kind === 'access').forEach((x) => {
      const bar = el('i');
      if (!x.walk && x.color) bar.style.setProperty('--c', x.color);
      stripe.append(bar);
    });
    const time = el('div', 'other-time');
    time.append(r.summary.dep, el('span', null, '→'), r.summary.arr);
    const meta = el('div', 'other-meta');
    meta.textContent = [cleanDuration(r.summary.duration), r.summary.fare != null ? `¥${r.summary.fare.toLocaleString()}` : '', r.summary.transfers ? `乗換${r.summary.transfers}` : ''].filter(Boolean).join(' · ');
    li.append(stripe, time, meta);
    const pick = () => {
      state.index = i;
      renderResult();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    li.addEventListener('click', pick);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
    others.append(li);
  });
  $('othersWrap').hidden = !others.children.length;
  $('yahooLink').href = data.yahooUrl || 'https://transit.yahoo.co.jp/';
}

// ---------- 家の設定 ----------
let suggestTimer = 0;
let suggestSeq = 0;

function openSheet() {
  const dlg = $('homeSheet');
  $('homeInput').value = memoryHome;
  $('suggest').textContent = '';
  $('sheetNote').textContent = '';
  dlg.showModal();
  setTimeout(() => $('homeInput').focus(), 250);
}

function saveHome(v) {
  v = (v || '').trim();
  if (!v) { $('sheetNote').textContent = '駅名か住所を入れてください'; return; }
  setHome(v);
  renderHomeLabel();
  $('homeSheet').close();
  state = { data: null, index: 0, searchedAt: null };
  document.body.classList.remove('has-result');
  $('result').hidden = true;
  hideMessage();
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
    const kind = c.kind === 'bus' ? `バス停${c.company ? ` · ${c.company}` : ''}` : '駅';
    li.append(el('small', null, kind));
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

renderTop();
renderHomeLabel();
setInterval(() => { renderTop(); renderCountdown(); }, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderTop(); renderCountdown(); } });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

'use strict';

// ---------- Google ログインと、ひび手帳への経路の受け渡し ----------
// ログインは ひび手帳・move と同じく、乗換案内の Worker（/hibi-auth/）を通す（Google の秘密の鍵を iPhone に置けないため）。
// 同じ Google のアプリなので、ドライブの「アプリ専用の場所」も ひび手帳と同じところ。
// 「ひび手帳に追加」は、そこの hibi-inbox.json に経路を置くだけ。ひび手帳が開いたときに読んで予定に入れ、中から消す。

const GD_KEY = 'ie:gd';
const PENDING_KEY = 'ie:pendingAdd';
const IB_FILE = 'hibi-inbox.json';
const GD_API = 'https://www.googleapis.com/drive/v3/files';
const GD_UP = 'https://www.googleapis.com/upload/drive/v3/files';

let gd = (() => {
  try { return JSON.parse(load(GD_KEY) || '{}') || {}; } catch (e) { return {}; }
})();
function gdPut(o) {
  gd = { ...gd, ...o };
  save(GD_KEY, JSON.stringify(gd));
}
const gdOn = () => !!gd.rt;

// 乗換案内の Worker：同じアカウントなら、この URL の ie. を norikae. にしたところ
function authBase() {
  const m = /^ie\.([a-z0-9-]+\.workers\.dev)$/i.exec(location.hostname);
  return `https://norikae.${m ? m[1] : 'gohanoishi.workers.dev'}/hibi-auth`;
}

function gdLogin(withPending) {
  const s = Math.random().toString(36).slice(2, 12);
  save(GD_KEY + '.s', s);
  // ログインのあとに、押していた経路をそのまま送る
  if (withPending && state.data) save(PENDING_KEY, routeKey(state.data.routes[state.index]));
  location.href = `${authBase()}/start?ret=${encodeURIComponent(location.origin + location.pathname)}&s=${s}${gd.email ? '&hint=' + encodeURIComponent(gd.email) : ''}`;
}

// Google から戻ってきた：結果はアドレスの #gauth=… に入っている
function gdFromHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('gauth') && !h.has('gauth_err')) return false;
  const s0 = load(GD_KEY + '.s') || '';
  try { localStorage.removeItem(GD_KEY + '.s'); } catch (e) { /* 次のログインで上書きされる */ }
  history.replaceState(null, '', location.pathname + location.search);
  if (!s0 || h.get('s') !== s0) return false; // このアプリが始めたログインではない
  if (h.has('gauth_err')) {
    const e = h.get('gauth_err');
    showToast(e === 'access_denied' ? 'ログインを取りやめました' : e === 'setup' ? 'ログインの準備（Googleの登録）がまだ済んでいないようです' : 'Googleにログインできませんでした。もう一度お試しください');
    return false;
  }
  try {
    const p = JSON.parse(decodeURIComponent(escape(atob(h.get('gauth').replace(/-/g, '+').replace(/_/g, '/')))));
    if (!p.rt) throw new Error();
    gdPut({ rt: p.rt, at: p.at, exp: p.exp, email: p.email || '' });
    return true;
  } catch (e) {
    showToast('Googleにログインできませんでした。もう一度お試しください');
    return false;
  }
}

// ログアウトはこの端末で忘れるだけ（Google 側の許可を取り消すと、ひび手帳のログインまで切れてしまうため）
function gdLogout() {
  gd = {};
  save(GD_KEY, '{}');
}

async function gdToken() {
  if (gd.at && gd.exp - 60000 > Date.now()) return gd.at;
  const r = await fetch(authBase() + '/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rt: gd.rt }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { gd = { email: gd.email }; save(GD_KEY, JSON.stringify(gd)); throw new Error('revoked'); }
  if (!r.ok || !j.at) throw new Error('token');
  gdPut({ at: j.at, exp: j.exp });
  return j.at;
}
async function gdFetch(url, init = {}) {
  const go = async () => fetch(url, { ...init, cache: 'no-store', headers: { ...(init.headers || {}), authorization: 'Bearer ' + await gdToken() } });
  let r = await go();
  if (r.status === 401) { gdPut({ at: '', exp: 0 }); r = await go(); }
  if (!r.ok) throw new Error('drive ' + r.status);
  return r;
}
async function gdList(q) {
  const u = `${GD_API}?spaces=appDataFolder&pageSize=100&orderBy=createdTime&fields=files(id,name)&q=${encodeURIComponent(q)}`;
  return (await (await gdFetch(u)).json()).files || [];
}
async function gdWrite(name, body, id) {
  if (id) {
    const r = await gdFetch(`${GD_UP}/${id}?uploadType=media&fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body });
    return (await r.json()).id;
  }
  const b = 'home' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
  const r = await gdFetch(`${GD_UP}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${b}` }, body: `--${b}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\ncontent-type: application/json\r\n\r\n${body}\r\n--${b}--` });
  return (await r.json()).id;
}

// hibi-inbox.json に経路を足す（ふたつ同時に作られていたら、ひとつにまとめる。2 週間より前のものは捨てる）
async function sendToHibi(route) {
  const files = await gdList(`name='${IB_FILE}'`);
  const items = [];
  const seen = new Set();
  for (const f of files) {
    let o = {};
    try { o = await (await gdFetch(`${GD_API}/${f.id}?alt=media`)).json(); } catch (e) { if (e.message === 'revoked') throw e; }
    for (const it of Array.isArray(o.items) ? o.items : []) {
      if (!it || seen.has(it.id) || !(it.at > Date.now() - 14 * 86400000)) continue;
      seen.add(it.id);
      items.push(it);
    }
  }
  items.push({ id: `home-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, at: Date.now(), by: 'home', kind: 'route', route });
  await gdWrite(IB_FILE, JSON.stringify({ app: 'hibi-inbox', version: 1, savedAt: new Date().toISOString(), by: 'home', items }), files.length ? files[0].id : '');
  for (const f of files.slice(1)) await gdFetch(`${GD_API}/${f.id}`, { method: 'DELETE' }).catch(() => {});
}

// 経路を、のりかえの「ひび手帳に追加」と同じ形にする
function hibiPayload(route) {
  const s = route.summary;
  const { depAt } = routeTimes(route);
  const stations = route.steps.filter((x) => x.kind === 'station');
  return {
    v: 1,
    from: (stations[0] && stations[0].name) || '現在地',
    to: state.data.home || (stations[stations.length - 1] && stations[stations.length - 1].name) || '家',
    via: '',
    date: dateOf(depAt || new Date()),
    dep: s.dep,
    arr: s.arr,
    duration: cleanDuration(s.duration),
    transfers: s.transfers,
    fare: s.fare,
    fareNote: s.fareNote || '',
    tags: s.tags || [],
    steps: route.steps.map((st) => (st.kind === 'station'
      ? { k: 's', name: st.name, arr: st.arr || '', dep: st.dep || '', code: st.code || '' }
      : {
        k: 'a', line: st.line || '', dest: st.destination || '', color: st.color || '', walk: !!st.walk,
        platform: st.platform || '', stops: st.stops || '',
        stopList: (st.stopList || []).map((x) => ({ time: x.time, name: x.name })),
      })),
  };
}

// 同じ経路かどうか（追加済みの印に使う）
function routeKey(route) {
  const { depAt } = routeTimes(route);
  const lines = route.steps.filter((x) => x.kind === 'access' && !x.walk).map((x) => x.line).join('>');
  return [depAt ? dateOf(depAt) : '', route.summary.dep, route.summary.arr, lines].join('|');
}

// ---------- 画面 ----------
let hibiBusy = false;

function renderHibiBtn() {
  const btn = $('hibiAdd');
  if (!state.data) return;
  const added = (state.added || []).includes(routeKey(state.data.routes[state.index]));
  btn.classList.toggle('done', added);
  btn.disabled = hibiBusy;
  $('hibiAddText').textContent = hibiBusy ? 'ひび手帳に送っています…' : added ? 'ひび手帳に追加しました' : 'ひび手帳に追加';
  $('hibiAddSub').textContent = added ? 'ひび手帳を開くと予定に入ります' : gdOn() ? 'この経路を予定として入れます' : 'ひび手帳と同じGoogleアカウントでログインして使います';
}

async function addToHibi() {
  if (hibiBusy || !state.data) return;
  const route = state.data.routes[state.index];
  const key = routeKey(route);
  if ((state.added || []).includes(key)) { showToast('この経路はもう追加しています'); return; }
  if (!gdOn()) {
    showToast('ひび手帳と同じGoogleアカウントでログインします', 'ログイン', () => gdLogin(true), 8000);
    return;
  }
  hibiBusy = true;
  renderHibiBtn();
  try {
    await sendToHibi(hibiPayload(route));
    state.added = [...(state.added || []), key];
    saveState();
    showToast('ひび手帳に送りました。ひび手帳を開くと予定に入ります');
  } catch (e) {
    if (e.message === 'revoked') showToast('Googleのログインが切れました', 'ログイン', () => gdLogin(true), 8000);
    else showToast(navigator.onLine === false ? 'オフラインです。つながってからもう一度押してください' : '送れませんでした。少ししてからもう一度押してください');
  } finally {
    hibiBusy = false;
    renderHibiBtn();
    paintGd();
  }
}

// 設定の「ひび手帳」のところ
function paintGd() {
  $('gdStatus').textContent = gdOn() ? (gd.email || 'ログイン中') : 'ログインしていません';
  $('gdBtn').textContent = gdOn() ? 'ログアウト' : 'Googleでログイン';
  $('gdBtn').classList.toggle('primary', !gdOn());
  if (state.data) renderHibiBtn();
}

$('hibiAdd').addEventListener('click', addToHibi);
$('gdBtn').addEventListener('click', () => {
  if (gdOn()) { gdLogout(); paintGd(); showToast('この端末でログアウトしました'); } else gdLogin(false);
});

// Google のログインから戻ってきたとき
if (gdFromHash()) {
  showToast(`${gd.email || 'Google'} でログインしました`);
  const pending = load(PENDING_KEY);
  try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* 一度だけ使う */ }
  if (pending && state.data && routeKey(state.data.routes[state.index]) === pending) setTimeout(addToHibi, 2400); // 開いたときのアニメーションのあとで送る
}
paintGd();

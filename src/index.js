import { buildSearchUrl, parseResult, InputError, YAHOO_ORIGIN } from './yahoo.js';
import { parseCoords, findNearest, findAddress } from './nearest.js';
import { SUGGEST_SOURCES, parseSuggest } from './suggest.js';
import { lookupTimetable } from './timetable.js';
import { parseTrainPage } from './train.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

// Yahoo!乗換案内で 1 回検索する。経路がなければ routes は空
async function searchOnce(params, env) {
  const url = buildSearchUrl(params, env.UPSTREAM || YAHOO_ORIGIN);
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ja' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { routes } = parseResult(await res.text());
  return { routes, yahooUrl: buildSearchUrl(params, YAHOO_ORIGIN) };
}

// 現在地 → 家。住所から探し、だめなら近い駅から順に探す
async function handleHome(request, env) {
  const p = new URL(request.url).searchParams;
  const home = (p.get('home') || '').trim();
  if (!home) return json({ error: '家の場所が設定されていません' }, 400);
  const coords = parseCoords(p);
  if (!coords) return json({ error: '現在地を読み取れませんでした' }, 400);

  const [address, stations] = await Promise.allSettled([findAddress(coords), findNearest(coords)]);
  const starts = [];
  if (address.status === 'fulfilled' && address.value) starts.push({ from: address.value, label: '現在地' });
  if (stations.status === 'fulfilled') {
    for (const st of stations.value.slice(0, 2)) starts.push({ from: st.name, label: st.name, station: true });
  }
  if (!starts.length) return json({ error: '現在地の住所・最寄り駅が見つかりませんでした' }, 502);

  let lastError = '経路が見つかりませんでした';
  for (const start of starts) {
    const q = new URLSearchParams({ from: start.from, to: home, date: p.get('date') || '', time: p.get('time') || '', type: 'dep' });
    try {
      const { routes, yahooUrl } = await searchOnce(q, env);
      if (routes.length) {
        return json({ start, home, routes, yahooUrl, address: address.value || '' });
      }
    } catch (e) {
      if (e instanceof InputError) return json({ error: e.message }, 400);
      lastError = 'Yahoo!乗換案内に接続できませんでした';
    }
  }
  return json({ error: lastError }, 502);
}

// 家の場所を入れるときの候補（駅・バス停）
async function handleSuggest(request, env, ctx) {
  const q = (new URL(request.url).searchParams.get('q') || '').normalize('NFKC').trim();
  if (!q) return json({ items: [] });
  if (q.length > 30) return json({ error: '長すぎます', items: [] }, 400);

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.ie/suggest-v1?${new URLSearchParams({ q })}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const pages = await Promise.all(SUGGEST_SOURCES.map(async (f) => {
    try {
      const res = await fetch((env.UPSTREAM || YAHOO_ORIGIN) + f(q), {
        headers: { 'user-agent': UA, 'accept-language': 'ja' },
        cf: { cacheTtl: 86400, cacheEverything: true },
      });
      return res.ok ? res.text() : '';
    } catch (e) {
      return '';
    }
  }));
  const seen = new Set();
  const items = pages.flatMap((html) => parseSuggest(html, q))
    .filter((c) => (seen.has(c.value) ? false : seen.add(c.value)))
    .sort((a, b) => (a.name.startsWith(q) ? 0 : 1) - (b.name.startsWith(q) ? 0 : 1))
    .slice(0, 8);
  const ok = pages.some(Boolean);
  const out = json({ items }, 200, { 'cache-control': ok ? 'public, max-age=86400' : 'no-store' });
  if (ok) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// 「今いる場所を家にする」ための住所
async function handleWhere(request) {
  const coords = parseCoords(new URL(request.url).searchParams);
  if (!coords) return json({ error: '位置情報の値が正しくありません' }, 400);
  try {
    return json({ address: await findAddress(coords) });
  } catch (e) {
    return json({ error: '住所を取得できませんでした' }, 502);
  }
}

// ふつうの経路検索（前後の便を探すときに使う）
async function handleSearch(request, env, ctx) {
  const params = new URL(request.url).searchParams;
  let yahooUrl;
  try {
    yahooUrl = buildSearchUrl(params, env.UPSTREAM || YAHOO_ORIGIN);
  } catch (e) {
    if (e instanceof InputError) return json({ error: e.message }, 400);
    throw e;
  }
  // 同じ条件の検索は 1 分間キャッシュして Yahoo への負荷を減らす
  const cache = caches.default;
  const cacheKey = new Request(yahooUrl);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;
  let html;
  try {
    const res = await fetch(yahooUrl, { headers: { 'user-agent': UA, 'accept-language': 'ja' } });
    if (!res.ok) return json({ error: `Yahoo!乗換案内がエラーを返しました（${res.status}）`, routes: [] }, 502);
    html = await res.text();
  } catch (e) {
    return json({ error: 'Yahoo!乗換案内に接続できませんでした', routes: [] }, 502);
  }
  let routes;
  try {
    routes = parseResult(html).routes;
  } catch (e) {
    return json({ error: 'Yahoo!乗換案内の結果を読み取れませんでした', routes: [] }, 502);
  }
  const out = json({ routes }, 200, { 'cache-control': routes.length ? 'public, max-age=60' : 'no-store' });
  if (routes.length) ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// 駅の時刻表（前後の便で、普通・急行なども含めた全部の電車を出すため）
async function handleTimetable(request, env, ctx) {
  const p = new URL(request.url).searchParams;
  const code = p.get('code') || '';
  const date = p.get('date') || '';
  const time = p.get('time') || '';
  if (!/^\d{3,8}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return json({ error: 'パラメータが正しくありません' }, 400);
  }
  const line = (p.get('line') || '').slice(0, 60);
  const destination = (p.get('dest') || '').slice(0, 40);

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.ie/timetable-v1?${new URLSearchParams({ code, date, time, line, destination })}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const fetchPage = async (path) => {
    const res = await fetch((env.UPSTREAM || YAHOO_ORIGIN) + path, {
      headers: { 'user-agent': UA, 'accept-language': 'ja' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  };
  let result;
  try {
    result = await lookupTimetable({ code, date, time, line, destination }, fetchPage);
  } catch (e) {
    return json({ error: '時刻表を取得できませんでした' }, 502);
  }
  if (!result) return json({ error: 'この駅の時刻表は見つかりませんでした' }, 404);
  // 方面のページが 1 つでも読めなかったときは、反対方面の電車を選んでしまうおそれがあるので使わない
  if (result.failed) return json({ error: '時刻表を取得できませんでした' }, 502);
  const out = json(result, 200, { 'cache-control': 'public, max-age=3600' });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

// 列車ごとの停車駅と時刻（時刻表の電車を使う経路を作るため）
async function handleTrain(request, env, ctx) {
  const p = new URL(request.url).searchParams;
  const ids = ['code', 'group', 'train', 'hh', 'mm'].map((k) => p.get(k) || '');
  const kind = p.get('kind') || '';
  if (!ids.every((v) => /^\d{1,9}$/.test(v)) || !/^\d{0,2}$/.test(kind)) return json({ error: 'パラメータが正しくありません' }, 400);
  const [code, group, train, hh, mm] = ids;
  const path = `/timetable/${code}/${group}/${train}?${kind ? `kind=${kind}&` : ''}hh=${Number(hh)}&mm=${Number(mm)}`;

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.ie/train${path}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let html;
  try {
    const res = await fetch((env.UPSTREAM || YAHOO_ORIGIN) + path, { headers: { 'user-agent': UA, 'accept-language': 'ja' } });
    if (!res.ok) return json({ error: `列車の情報を取得できませんでした（${res.status}）` }, 502);
    html = await res.text();
  } catch (e) {
    return json({ error: '列車の情報を取得できませんでした' }, 502);
  }
  const { stops } = parseTrainPage(html);
  if (!stops.length) return json({ error: 'この電車の停車駅を読み取れませんでした' }, 422);
  const out = json({ stops }, 200, { 'cache-control': 'public, max-age=3600' });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/home') return handleHome(request, env);
    if (url.pathname === '/api/search') return handleSearch(request, env, ctx);
    if (url.pathname === '/api/timetable') return handleTimetable(request, env, ctx);
    if (url.pathname === '/api/train') return handleTrain(request, env, ctx);
    if (url.pathname === '/api/suggest') return handleSuggest(request, env, ctx);
    if (url.pathname === '/api/where') return handleWhere(request);
    if (url.pathname === '/api/health') return json({ ok: true });
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};

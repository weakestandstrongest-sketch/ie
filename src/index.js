import { buildSearchUrl, parseResult, InputError, YAHOO_ORIGIN } from './yahoo.js';
import { parseCoords, findNearest, findAddress } from './nearest.js';
import { SUGGEST_SOURCES, parseSuggest } from './suggest.js';

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/home') return handleHome(request, env);
    if (url.pathname === '/api/suggest') return handleSuggest(request, env, ctx);
    if (url.pathname === '/api/where') return handleWhere(request);
    if (url.pathname === '/api/health') return json({ ok: true });
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },
};

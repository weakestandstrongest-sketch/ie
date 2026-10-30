// 駅名・バス停名の入力候補。
// Yahoo!乗換案内の「駅・バス停の時刻表」検索ページ（/timetable/search?q=）から候補を取り出す。
// Yahoo の経路検索は、バス停を「則武本郷/岐阜バス」のように「名前/会社」で指定すると確実に使えるので、
// バス停はその形の value も返す。ページの形が変わっても空の候補を返すだけで、検索そのものは邪魔しない。

import { extractNextData } from './yahoo.js';

const PREF = /(北海道|東京都|京都府|大阪府|.{2,3}県)$/;
const BUSY = /バス|交通|運輸|自動車|観光|市営|町営|村営|コミュニティ/;

export function suggestPath(q) {
  return `/timetable/search?${new URLSearchParams({ q })}`;
}

// 候補が載っている Yahoo のページ（両方を同時に見る）
// /timetable/search は鉄道の駅だけ、/station/search はバス停（「則武本郷/岐阜バス」）も出る
export const SUGGEST_SOURCES = [
  (q) => suggestPath(q),
  (q) => `/station/search?${new URLSearchParams({ q })}`,
];
// 読み取り状況を調べるとき（debug=1）だけ、経路検索のページも見る（Yahoo が地名と判断したときの「ほかの候補」）
export const PROBE_SOURCES = [
  ...SUGGEST_SOURCES,
  (q) => `/search/result?${new URLSearchParams({ from: q, to: '岐阜' })}`,
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 調査用：ページの中で入力の文字が出てくる所と、埋め込み JSON の主なキー */
export function probePage(html, q) {
  const hits = new Set();
  if (q) {
    for (const m of String(html || '').matchAll(new RegExp(`[^"<>]{0,10}${escapeRe(q)}[^"<>]{0,24}`, 'g'))) {
      hits.add(m[0].trim());
      if (hits.size >= 8) break;
    }
  }
  const nd = extractNextData(html);
  const pp = nd && nd.props && nd.props.pageProps;
  const keys = pp && typeof pp === 'object' ? Object.keys(pp).slice(0, 16) : [];
  return { hits: [...hits], keys };
}

const norm = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
// ひらがな → カタカナ（読みでも照合できるように）
const kata = (s) => norm(s).replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

const stripTags = (s) => String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();

/**
 * 候補の名前を「表示名・検索に使う値・種類・会社」にそろえる。
 * 「則武本郷/岐阜バス」「則武本郷〔岐阜バス〕」「則武本郷（岐阜バス）」はどれもバス停、
 * 「金山(愛知県)」は同名の駅を区別しているだけなので駅のまま。
 */
export function normalizeCandidate(raw, extra = {}) {
  let name = stripTags(raw).normalize('NFKC').replace(/\s+/g, ' ').trim(); // 「則武本郷／岐阜バス」の全角／もそろえる
  if (!name || name.length > 60) return null;
  let company = String(extra.company || '').trim();
  let bus = !!extra.bus;
  const slash = /^(.+?)\s*\/\s*(.+)$/.exec(name);
  const brk = /^(.+?)\s*[〔［\[（(]([^〕］\]）)]+)[〕］\]）)]$/.exec(name);
  if (slash) {
    name = slash[1]; company = company || slash[2]; bus = true;
  } else if (brk && !PREF.test(brk[2]) && BUSY.test(brk[2])) {
    name = brk[1]; company = company || brk[2]; bus = true;
  }
  name = name.replace(/\s*(バス停|停留所)$/, '');
  if (company && BUSY.test(company)) bus = true;
  const keep = brk && !bus ? stripTags(raw).normalize('NFKC').trim() : name; // 「金山(愛知県)」はそのまま
  const value = bus && company ? `${name}/${company}` : keep;
  return { name: bus ? name : keep, value, kind: bus ? 'bus' : 'station', company: bus ? company : '' };
}

const NAME_KEYS = ['Name', 'name', 'stationName', 'StationName', 'poiName', 'title'];
const YOMI_KEYS = ['Yomi', 'yomi', 'ruby', 'Ruby', 'kana', 'Kana', 'reading'];
const CODE_KEYS = ['Code', 'code', 'stationCode', 'StationCode', 'Id', 'id'];

function pickStr(o, keys) {
  for (const k of keys) if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
  return '';
}

// pageProps の中から「名前を持つものの配列」を探す（キー名が変わっても拾えるように広めに見る）
function collectFromJson(node, out, depth = 0) {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) {
    for (const it of node) {
      if (it && typeof it === 'object' && !Array.isArray(it)) {
        const name = pickStr(it, NAME_KEYS);
        if (name) {
          let company = '';
          let bus = false;
          for (const [k, v] of Object.entries(it)) {
            if (typeof v === 'string' && /company|operator|corp|jigyo|agency/i.test(k)) company = company || v.trim();
            if (/type|kind|category/i.test(k) && /bus|バス/i.test(String(v))) bus = true;
            if (/^is_?bus/i.test(k) && v === true) bus = true;
          }
          out.push({ raw: name, yomi: pickStr(it, YOMI_KEYS), code: pickStr(it, CODE_KEYS), company, bus, from: 'json' });
        }
      }
      collectFromJson(it, out, depth + 1);
    }
    return;
  }
  if (typeof node === 'object') for (const v of Object.values(node)) collectFromJson(v, out, depth + 1);
}

// キー名が分からなくても拾えるように、入力を含む短い文字列も候補にする（見出し・説明文は除く）
const NOT_NAME = /時刻表|検索|結果|一覧|乗換|路線図|周辺|地図|について|ページ|https?:|[。、！？!?]/;
function collectStrings(node, qn, out, depth = 0) {
  if (node == null || depth > 10) return;
  if (typeof node === 'string') {
    const t = node.trim();
    // 入力そのもの（検索語の繰り返し）は候補にしない
    if (t.length <= 40 && !NOT_NAME.test(t) && kata(t).includes(qn) && kata(t) !== qn) out.push({ raw: t, from: 'json', loose: true });
    return;
  }
  if (typeof node === 'object') for (const v of Object.values(node)) collectStrings(v, qn, out, depth + 1);
}

/** 検索ページの HTML から候補（最大 limit 件）を取り出す */
export function parseSuggest(html, q, limit = 12) {
  const raw = [];
  // 1) 時刻表ページへのリンク（候補一覧そのもの）
  for (const m of String(html || '').matchAll(/<a\b[^>]*href="(?:https:\/\/transit\.yahoo\.co\.jp)?\/(?:timetable|station)\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    raw.push({ raw: m[2], code: m[1], from: 'link' });
  }
  // 2) ページに埋め込まれた JSON
  // どのページへのリンクでも、文字に入力を含むもの
  for (const m of String(html || '').matchAll(/<a\b[^>]*>([\s\S]{1,120}?)<\/a>/g)) {
    const t = stripTags(m[1]);
    if (t && t.length <= 40 && !NOT_NAME.test(t) && kata(t).includes(kata(q)) && kata(t) !== kata(q)) raw.push({ raw: t, from: 'json', loose: true });
  }
  const nd = extractNextData(html);
  if (nd && nd.props) {
    collectFromJson(nd.props.pageProps, raw);
    collectStrings(nd.props.pageProps, kata(q), raw);
    const alt = parseAlternatives(nd);
    if (alt) for (const c of [...alt.from, ...alt.to]) raw.push({ raw: c.value, from: 'json' });
  }

  const qn = kata(q);
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    const c = normalizeCandidate(r.raw, r);
    if (!c) continue;
    // JSON から拾ったものは、入力と関係のあるものだけ（見出しなどを拾わないように）
    const hit = kata(c.value).includes(qn) || kata(c.name).includes(qn) || (r.yomi && kata(r.yomi).includes(qn));
    if (r.from === 'json' && !hit) continue;
    if (r.from === 'link' && !hit && c.name.length > 30) continue;
    const key = c.value;
    if (seen.has(key)) {
      // 同じ候補がリンクと JSON の両方にあれば、会社名などの情報を足す
      const prev = out.find((x) => x.value === key);
      if (prev && !prev.code && r.code) prev.code = r.code;
      continue;
    }
    seen.add(key);
    out.push({ ...c, code: r.code && /^\d{1,9}$/.test(r.code) ? r.code : '', loose: !!r.loose });
  }
  // 文字列から拾っただけの名前が、会社名つきのバス停と同じなら、バス停のほうだけ残す
  const busNames = new Set(out.filter((c) => c.kind === 'bus').map((c) => c.name));
  const kept = out.filter((c) => !(c.loose && c.kind === 'station' && busNames.has(c.name))).map(({ loose, ...c }) => c);
  // 入力で始まるもの → 入力を含むもの の順。元の並び（Yahoo の順）は保つ
  const starts = (c) => kata(c.name).startsWith(qn) ? 0 : 1;
  return kept
    .map((c, i) => ({ c, i }))
    .sort((a, b) => starts(a.c) - starts(b.c) || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}

/** 経路検索ページに載る「出発地・到着地のほかの候補」 */
export function parseAlternatives(nd) {
  const pp = nd && nd.props && nd.props.pageProps;
  if (!pp) return null;
  const ns = pp.naviSearchParam || {};
  const other = ns.otherQueryInfo || pp.otherQueryInfo;
  if (!other) return null;
  const list = (arr) => (Array.isArray(arr) ? arr : [])
    .map((x) => (typeof x === 'string' ? x : x && (x.name || x.Name)))
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => normalizeCandidate(s))
    .filter(Boolean)
    .slice(0, 8);
  const from = list(other.fromList);
  const to = list(other.toList);
  return from.length || to.length ? { from, to } : null;
}

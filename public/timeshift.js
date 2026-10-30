'use strict';

// 前後の電車さがし・前後のダイヤ・ルートの組み合わせで使う計算
// （画面や通信に依存しない純粋な関数だけを置き、テストできるようにしている）
//
// Yahoo!乗換案内は 1 回の検索で「到着が早い順」に 3 ルートほどしか返さない。
// そのため「早く出るけど遅く着く電車」は結果に出てこない。前後の電車は
// この性質を前提に、次のように探す。
//   ・出発検索の 1 本前：いま見えている最も早い到着より前に着く電車を到着検索で探し、
//     その中で最も遅く出発する電車の時刻で出発検索し直す
//   ・到着検索の 1 本後：いま見えている最も遅い出発より後に出る電車を出発検索で探し、
//     その中で最も早く着く電車の時刻で到着検索し直す
const TimeShift = (() => {
  const MIN = 60e3;
  const HALF_DAY = 12 * 3600e3;

  // 結果の時刻（"HH:MM"）を日付に直すときの基準。
  // 始発・終電は入力時刻と関係なく早朝・深夜の結果が返るので、基準をずらす
  function anchorFor(type, base) {
    const d = new Date(base);
    if (type === 'first') d.setHours(6, 0, 0, 0);
    if (type === 'last') d.setHours(23, 0, 0, 0);
    return d;
  }

  // "HH:MM" を基準日時から ±12 時間以内の日時にする（日付またぎの補正）
  function nearDate(hhmm, anchor) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return null;
    const d = new Date(anchor);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (d - anchor > HALF_DAY) d.setDate(d.getDate() - 1);
    if (anchor - d > HALF_DAY) d.setDate(d.getDate() + 1);
    return d;
  }

  const times = (routes, key, anchor) =>
    routes.map((r) => nearDate(r[key], anchor)).filter(Boolean).map(Number);

  /**
   * 1 本前（direction=-1）／1 本後（direction=1）の検索計画。
   * type: 今の検索の種類、base: 今の検索の日時、routes: 結果の summary 配列
   *
   * 戻り値:
   *   { type, date }                         … そのまま検索すればよい
   *   { type, probe: {type, date, pick}, … } … probe で一度検索し、resolve() で日時を決める
   * 出発検索は出発のまま、到着検索は到着のまま（種類を勝手に変えない）。
   */
  function plan(direction, type, base, routes) {
    const anchor = anchorFor(type, base);
    const deps = times(routes, 'dep', anchor);
    const arrs = times(routes, 'arr', anchor);
    const at = (t) => new Date(t);

    if (type === 'arr') {
      if (!arrs.length || !deps.length) return { type, date: at(+base + direction * 30 * MIN) };
      const latestArr = Math.max(...arrs);
      if (direction < 0) {
        return { type, date: at(Math.min(latestArr, +base) - MIN) };
      }
      return {
        type,
        probe: { type: 'dep', date: at(Math.max(...deps) + MIN), pick: 'earliestArr' },
        min: latestArr + MIN,
        fallback: at(+base + 30 * MIN),
      };
    }

    // 出発・始発・終電は「出発」で前後を探す
    if (!deps.length || !arrs.length) return { type: 'dep', date: at(+base + direction * 30 * MIN) };
    const earliestDep = Math.min(...deps);
    if (direction > 0) {
      let t = earliestDep + MIN;
      if (type === 'dep') t = Math.max(t, +base + MIN); // 今の検索より前には戻らない
      return { type: 'dep', date: at(t) };
    }
    return {
      type: 'dep',
      probe: { type: 'arr', date: at(Math.min(...arrs) - MIN), pick: 'latestDep' },
      max: earliestDep - MIN,
      fallback: at(earliestDep - 30 * MIN),
    };
  }

  // probe の結果から、最終的に検索する日時を決める
  function resolve(p, probeRoutes) {
    const anchor = p.probe.date;
    if (p.probe.pick === 'latestDep') {
      const deps = times(probeRoutes, 'dep', anchor);
      if (!deps.length) return p.fallback;
      return new Date(Math.min(Math.max(...deps), p.max));
    }
    const arrs = times(probeRoutes, 'arr', anchor);
    if (!arrs.length) return p.fallback;
    return new Date(Math.max(Math.min(...arrs), p.min));
  }

  // 前後のダイヤ：結果を読み終えたら、次はどの時刻から検索するか
  function chainNext(routes, t) {
    const deps = times(routes, 'dep', t);
    const next = deps.length ? Math.max(...deps) + MIN : 0;
    return new Date(next > +t ? next : +t + 10 * MIN);
  }

  function formatMinutes(min) {
    if (!(min >= 0)) return '';
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    if (!h) return `${m}分`;
    return m ? `${h}時間${m}分` : `${h}時間`;
  }

  const transfersOf = (steps) => Math.max(0, steps.filter((s) => s.kind === 'access' && !s.walk).length - 1);

  // "HH:MM" を分単位でずらす
  function shiftTime(hhmm, minutes) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
    if (!m) return hhmm;
    const t = (((Number(m[1]) * 60 + Number(m[2]) + minutes) % 1440) + 1440) % 1440;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  // "HH:MM" a から b まで何分か（日付またぎを考えて -12〜+12 時間）
  function diffMinutes(a, b) {
    const da = nearDate(a, new Date(2000, 0, 1, 12));
    const db = da && nearDate(b, da);
    return da && db ? Math.round((db - da) / MIN) : 0;
  }

  /**
   * stepIndex 番目の駅より前が徒歩だけか（＝最初に乗る駅か）。
   * そうなら、乗る電車に合わせて家などを出る時刻もずらせる。
   */
  function isWalkOnlyBefore(route, stepIndex) {
    return stepIndex > 0 && route.steps.slice(0, stepIndex).every((s) => s.kind === 'station' || s.walk);
  }

  /**
   * route の stepIndex 番目の駅から先を、別の検索結果 tail に差し替えた「出発地からの全体ルート」を作る。
   * stepIndex が 0 なら tail そのもの。
   * その駅より前が徒歩だけなら、出発地を出る時刻も電車に合わせてずらす。
   */
  function combineRoute(route, stepIndex, tail) {
    if (stepIndex === 0) return tail;
    const walkOnly = isWalkOnlyBefore(route, stepIndex);
    const newDep = (tail.steps[0] && tail.steps[0].dep) || tail.summary.dep;
    const offset = walkOnly ? diffMinutes(route.steps[stepIndex].dep, newDep) : 0;
    const prefix = route.steps.slice(0, stepIndex + 1).map((s) => (s.kind === 'station'
      ? { ...s, arr: s.arr && shiftTime(s.arr, offset), dep: s.dep && shiftTime(s.dep, offset) }
      : { ...s }));
    const station = prefix[prefix.length - 1];
    station.dep = newDep;
    const steps = prefix.concat(tail.steps.slice(1));

    const originDep = shiftTime(route.summary.dep, offset);
    const depDate = nearDate(originDep, nearDate(station.dep, new Date(2000, 0, 1, 12)));
    const stDep = nearDate(station.dep, depDate);
    let arrDate = nearDate(tail.summary.arr, stDep);
    if (arrDate < stDep) arrDate = new Date(+arrDate + 24 * 3600e3);
    return {
      summary: {
        dep: originDep,
        arr: tail.summary.arr,
        duration: formatMinutes((arrDate - depDate) / MIN),
        transfers: transfersOf(steps),
        // 徒歩のあとに乗るだけなら運賃は差し替え先と同じ。乗り継ぎを変えた場合は分からないので出さない
        fare: walkOnly ? tail.summary.fare : null,
        fareNote: walkOnly ? tail.summary.fareNote || '' : '',
        distance: '',
        tags: [],
        alert: route.summary.alert || tail.summary.alert,
      },
      steps,
      changedAt: stepIndex,
    };
  }

  return { plan, resolve, chainNext, combineRoute, isWalkOnlyBefore, shiftTime, formatMinutes, nearDate, anchorFor };
})();

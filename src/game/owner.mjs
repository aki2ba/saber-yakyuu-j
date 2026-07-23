// ============================================================================
// H5-B: オーナー目標・信任・解任（phaseH_fun_spec H5-B / fun_design_evidence §4柱5）。
//
//   generateOwnerGoals(...)  … 開幕時にプレイヤー球団の目標1-2件を決定論生成（窓状態と整合）
//   evaluateOwnerGoals(...)  … シーズン末に純関数で達成判定
//   trustDelta(...)          … 判定→信任の加減（順位由来の小さな加減込み）
//   pickTransferOffer(...)   … 解任時のオファー元（前年最低勝率の他球団）を決定論選定
//
// 設計原則:
//   - エンジン非干渉: 効果は「表示＋playerTeamId切替（解任受諾時）」のみ。シム/成長/市場に触れない。
//     プレイヤー球団のみが対象（AI球団に信任は不要＝リーグ対称性を崩さない）。1年目（yearIndex=0）は
//     目標なし＝既存較正に非干渉。
//   - 決定論: 目標生成は hashSeed(masterSeed,'ownergoal',yearIndex,teamId) の独立シード。
//     判定は standings/careerStats/finance の純関数。解任時の選択は marketInterventions ログへ
//     {phase:'ownerFire'} で記録（履歴・ニュース素材。save は状態を直接持つため replay 不要）。
//   - OOTPの教訓（fun_design_evidence §1.3）: 目標は teamWindowState と整合させる
//     （rebuilding 期に優勝を要求する「理不尽な目標」を構造的に出さない）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { clamp } from '../model/util.mjs';
import { teamWindowState } from './market.mjs';
import { pendingDay } from './season_runtime.mjs';

/** 完了年 standings から自リーグ内順位(1起点)と勝率を返す。無ければ null。 */
export function ownerLeagueRankOf(standings, teamId) {
  if (!standings) return null;
  const me = standings.find((s) => s.teamId === teamId);
  if (!me) return null;
  const wp = (s) => { const d = (s.w ?? 0) + (s.l ?? 0); return d ? s.w / d : 0.5; };
  const mine = standings.filter((s) => s.league === me.league);
  const rank = 1 + mine.filter((s) => wp(s) > wp(me) || (wp(s) === wp(me) && s.teamId < me.teamId)).length;
  return { rank, of: mine.length, winPct: wp(me) };
}

/**
 * 開幕時の目標生成（プレイヤー球団のみ・決定論）。窓状態・予算状態と整合するテンプレ集合から
 * 1〜maxGoals 件を独立シードで引く。優先度は先頭=high・以降=low。
 * @param {{masterSeed:number, yearIndex:number, teamId:string, league:Object, teamHistory:Array, cfg:Object}} o
 * @returns {Array<{type:string, label:string, priority:'high'|'low', param?:number}>}
 */
export function generateOwnerGoals({ masterSeed, yearIndex, teamId, league, teamHistory, cfg }) {
  const og = cfg.tuning.ownerGoals;
  if (yearIndex < 1) return [];
  const win = teamWindowState(teamId, teamHistory, cfg);
  const team = league.teams.find((t) => t.id === teamId);
  const overBudget = !!(team?.finance && team.finance.payroll > team.finance.budget);
  const last = teamHistory.length ? teamHistory.reduce((a, b) => (b.year > a.year ? b : a)) : null;
  const lastRank = last ? ownerLeagueRankOf(last.standings, teamId) : null;

  // 窓状態と整合する候補プール（rebuilding に優勝/Aクラスを要求しない＝OOTPの失敗の回避）
  const pool = [];
  if (win === 'contending') {
    if (lastRank && lastRank.rank <= 2) pool.push({ type: 'champion', label: 'リーグ優勝' });
    pool.push({ type: 'rank', param: 3, label: 'Aクラス入り（リーグ3位以内）' });
    pool.push({ type: 'winPct', param: og.winPctMin, label: `勝率${og.winPctMin.toFixed(3).slice(1)}以上` });
  } else if (win === 'rebuilding') {
    pool.push({ type: 'youthPA', param: og.youthPAMin, label: `若手（${og.youthAgeMax}歳以下）野手に計${og.youthPAMin}打席以上` });
    pool.push({ type: 'winPct', param: og.rebuildWinPctMin, label: `勝率${og.rebuildWinPctMin.toFixed(3).slice(1)}以上（最下位脱出）` });
  } else {
    pool.push({ type: 'winPct', param: og.winPctMin, label: `勝率${og.winPctMin.toFixed(3).slice(1)}以上` });
    pool.push({ type: 'rank', param: 3, label: 'Aクラス入り（リーグ3位以内）' });
    pool.push({ type: 'youthPA', param: og.youthPAMin, label: `若手（${og.youthAgeMax}歳以下）野手に計${og.youthPAMin}打席以上` });
  }
  if (overBudget) pool.unshift({ type: 'payrollCap', label: '年俸総額を予算内へ圧縮' }); // 予算超過中は最優先で必ず出す

  const rng = makeRng(hashSeed(masterSeed, 'ownergoal', yearIndex, teamId));
  const n = Math.min(og.maxGoals, pool.length);
  const goals = [];
  const avail = pool.slice();
  for (let i = 0; i < n; i++) {
    const idx = i === 0 && overBudget ? 0 : rng.int(avail.length); // 予算圧縮は必ず採用
    goals.push({ ...avail.splice(idx, 1)[0], priority: i === 0 ? 'high' : 'low' });
  }
  return goals;
}

/**
 * シーズン末の達成判定（純関数・決定論）。
 * @param {Array} goals generateOwnerGoals の返値
 * @param {{standings:Array, teamId:string, league:Object, careerStats:Array, year:number, cfg:Object}} ctx
 * @returns {Array<{goal:Object, achieved:boolean, actual:string}>}
 */
export function evaluateOwnerGoals(goals, { standings, teamId, league, careerStats, year, cfg }) {
  const og = cfg.tuning.ownerGoals;
  const lr = ownerLeagueRankOf(standings, teamId);
  const results = [];
  for (const g of goals) {
    let achieved = false;
    let actual = '';
    if (g.type === 'champion') { achieved = !!lr && lr.rank === 1; actual = lr ? `リーグ${lr.rank}位` : '不明'; }
    else if (g.type === 'rank') { achieved = !!lr && lr.rank <= g.param; actual = lr ? `リーグ${lr.rank}位` : '不明'; }
    else if (g.type === 'winPct') { achieved = !!lr && lr.winPct >= g.param; actual = lr ? `勝率${lr.winPct.toFixed(3)}` : '不明'; }
    else if (g.type === 'youthPA') {
      const byId = new Map(league.players.map((p) => [p.id, p]));
      let pa = 0;
      for (const s of careerStats) {
        if (s.season !== year || s.teamId !== teamId) continue;
        const p = byId.get(s.playerId);
        if (p && p.role === 'fielder' && p.age <= og.youthAgeMax) pa += s.batting?.pa ?? 0;
      }
      achieved = pa >= g.param;
      actual = `${pa}打席`;
    } else if (g.type === 'payrollCap') {
      const t = league.teams.find((x) => x.id === teamId);
      achieved = !!(t?.finance && t.finance.payroll <= t.finance.budget);
      actual = t?.finance ? `年俸${t.finance.payroll.toLocaleString()}/予算${t.finance.budget.toLocaleString()}` : '不明';
    }
    results.push({ goal: g, achieved, actual });
  }
  return results;
}

/** 判定結果→信任の増減（目標の優先度別±＋順位由来の小さな加減）。 */
export function trustDelta(results, standings, teamId, cfg) {
  const og = cfg.tuning.ownerGoals;
  let d = 0;
  for (const r of results) {
    const w = r.goal.priority === 'high' ? og.high : og.low;
    d += r.achieved ? w.success : w.fail;
  }
  const lr = ownerLeagueRankOf(standings, teamId);
  if (lr) d += lr.rank <= 3 ? og.aClassDelta : og.bClassDelta;
  return d;
}

/** 解任時の移籍オファー元: 前年最低勝率の他球団（同率は teamId 昇順・決定論）。 */
export function pickTransferOffer(standings, currentTeamId) {
  const wp = (s) => { const d = (s.w ?? 0) + (s.l ?? 0); return d ? s.w / d : 0.5; };
  const cands = (standings ?? []).filter((s) => s.teamId !== currentTeamId)
    .sort((a, b) => wp(a) - wp(b) || (a.teamId < b.teamId ? -1 : 1));
  return cands.length ? cands[0].teamId : null;
}

// ============================================================================
// Q10: 開幕前「オーナー会見」演出（thyroxin/research/baseball_game_mechanics_research_20260723 Q10・
//   OOTP press conference 翻案）。既存 state.ownerGoals（H5-B）を「今季の球団方針」として会見調の
//   文章へ変換するだけ（新規判定/新規保存フィールド無し・表示層のみ）。
// ============================================================================

/** 信任状況の会見テンプレ（trust帯ごとに1つ・分岐のみで乱数不使用＝決定論）。 */
function ownerTrustLine(trust) {
  if (trust >= 70) return 'これまでの実績には満足している。今季も期待している。';
  if (trust >= 40) return '現状は及第点だが、更なる結果を求めたい。';
  return '正直、フロントの評価は厳しい状況にある。今季は結果で応えてほしい。';
}

/**
 * Q10: 開幕直後（yearIndex>=1・オーナー目標が生成済み・開幕からcfg.game.daysPerWeek日以内）のみ、
 * 「今季の球団方針」会見カードを1回分返す（純関数・新規保存フィールド無し＝毎回窓状態から判定）。
 * @param {Object} state GameState（playerTeamId/yearIndex/ownerGoals/ownerTrust/rt/cfg が必要）
 * @returns {{trust:number, lines:string[]}|null} 窓外/対象外は null
 */
export function ownerPressConference(state) {
  if (!state.playerTeamId || state.yearIndex < 1) return null;
  const og = state.ownerGoals;
  if (!og || og.yearIndex !== state.yearIndex || !og.goals.length) return null;
  const rt = state.rt;
  if (!rt) return null;
  if (pendingDay(rt) >= state.cfg.game.daysPerWeek) return null; // 開幕から daysPerWeek 日以内のみ
  const lines = [
    ownerTrustLine(state.ownerTrust),
    ...og.goals.map((g) => `${g.priority === 'high' ? '最優先事項として' : '今季の目標のひとつとして'}「${g.label}」を掲げる。`),
  ];
  return { trust: state.ownerTrust, lines };
}

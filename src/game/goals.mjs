// ============================================================================
// P3: 週次目標（短期目標の階層・fun_theory_research_20260720.md P3提案）。
//
//   generateWeeklyGoal(state, week)         … 決定論生成。週の文脈（自チームの週内日程/直近の
//     連敗/月境界）と整合するテンプレ集合から hashSeed 独立座標で1件選ぶ（H5-B「窓状態と整合」
//     と同じ思想＝理不尽な目標を構造的に出さない。例: 連敗していないのに「連敗を止めろ」は出さない）。
//   evaluateWeeklyGoal(state, goal, week)   … 週末に playerGameLog から純関数で達成判定。
//   recordCompletedWeeklyGoals(state)       … 週境界を跨いだ未評価週を state.weeklyGoalLog へ
//     確定する（game/index.mjs の advanceDay から cfg.game.weeklyGoals ゲート内でのみ呼ばれる）。
//   weeklyGoalTrustBonus(state)             … シーズン末のオーナー信任評価（owner.mjs trustDelta
//     の合流点）へ加算する達成率ボーナス（cfg.game.weeklyGoalTrustBonusMax・tuning非使用）。
//
// 設計原則（CLAUDE.md 鉄則・タスク仕様の厳守事項）:
//   - フラグゲート: cfg.game.weeklyGoals（既定false・GAME_DEFAULT「headless既定OFF・UIのみON」
//     第6例目）。本ファイル自体はフラグを見ない（呼び出し側=game/index.mjsがゲートする）純関数群。
//   - 決定論: テンプレ選択は hashSeed(masterSeed,'weeklygoal',year,week) の独立座標のみ。
//     既存の生成/進行ストリームを一切消費しない（storylines.mjs H1-2と同じ前例）。
//   - 週の境界: cfg.game.daysPerWeek（advanceTo('weekEnd')と同じ0始まりday境界）。
//   - 三層構造: rt.schedule/rt.playerGameLog（観測可能な公開情報）のみを参照。trueAbility非参照。
//   - tuning非改変: 閾値はすべて本ファイル内のモジュール定数（news.mjs/storylines.mjsの前例と同じ
//     作法）。cfg.game 配下に置くのはフラグと信任ボーナス上限の小定数のみ（タスク仕様指定）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { pendingDay } from './season_runtime.mjs';

const STREAK_MIN = 2; // 「連敗を止めろ」目標を出す最低連敗数（未満は理不尽な目標として出さない）

/** 自チーム視点の勝敗（'W'|'L'|'T'）。 */
function outcomeOf(rec, teamId) {
  if (rec.tie) return 'T';
  const isHome = rec.home === teamId;
  const my = isHome ? rec.homeScore : rec.awayScore;
  const opp = isHome ? rec.awayScore : rec.homeScore;
  return my > opp ? 'W' : 'L';
}

/** week（0始まり）の日範囲 [start, end)。 */
function weekRange(state, week) {
  const span = state.cfg.game.daysPerWeek;
  const start = week * span;
  return { start, end: start + span };
}

/** その週の自チーム試合日程（rt.schedule から・未消化ぶんも含めて先読みできる）。 */
function weekSchedule(state, week) {
  const rt = state.rt;
  if (!rt) return [];
  const { start, end } = weekRange(state, week);
  const teamId = state.playerTeamId;
  return rt.schedule.filter((g) => g.day >= start && g.day < end && (g.home === teamId || g.away === teamId));
}

/** その週に実際に消化済みの自チーム試合（playerGameLog から）。 */
function weekPlayedGames(state, week) {
  const { start, end } = weekRange(state, week);
  return state.rt.playerGameLog.filter((g) => g.day >= start && g.day < end);
}

/** week開始（その週の最初の日）より前の時点での連敗数。 */
function losingStreakBefore(state, week) {
  const { start } = weekRange(state, week);
  const teamId = state.playerTeamId;
  const log = state.rt.playerGameLog;
  let len = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const g = log[i];
    if (g.day >= start) continue; // この週より前の試合だけを見る
    if (outcomeOf(g, teamId) === 'L') len++;
    else break;
  }
  return len;
}

/** その週の対戦相手のうち最頻対戦（「カード」候補）。2試合以上あるときだけ返す（同数は teamId 昇順）。 */
function weekCardOpponent(state, week) {
  const games = weekSchedule(state, week);
  const teamId = state.playerTeamId;
  const counts = new Map();
  for (const g of games) {
    const opp = g.home === teamId ? g.away : g.home;
    counts.set(opp, (counts.get(opp) ?? 0) + 1);
  }
  let best = null;
  for (const [opp, n] of counts) {
    if (n < 2) continue;
    if (!best || n > best.n || (n === best.n && opp < best.opp)) best = { opp, n };
  }
  return best;
}

/** week が属する「月」の最終週か（この週の終わりが月境界に到達/交差する）。 */
function isMonthClosingWeek(state, week) {
  const cfg = state.cfg;
  const { start, end } = weekRange(state, week);
  const monthSpan = cfg.game.daysPerMonth;
  const monthEnd = (Math.floor(start / monthSpan) + 1) * monthSpan;
  return end >= monthEnd;
}

/** 今月初日から今週末までの自チーム消化試合（月間ペース目標の評価対象）。 */
function monthToDateGames(state, week) {
  const cfg = state.cfg;
  const { start, end } = weekRange(state, week);
  const monthStart = Math.floor(start / cfg.game.daysPerMonth) * cfg.game.daysPerMonth;
  return state.rt.playerGameLog.filter((g) => g.day >= monthStart && g.day < end);
}

function winLossOf(games, teamId) {
  let w = 0;
  let l = 0;
  for (const g of games) {
    const r = outcomeOf(g, teamId);
    if (r === 'W') w++;
    else if (r === 'L') l++;
  }
  return { w, l };
}

/**
 * 週次目標の決定論生成（週の文脈と整合するテンプレ集合から1件・hashSeed独立座標のみ）。
 * @param {Object} state GameState（state.rt/state.cfg/state.playerTeamId/state.masterSeed/state.year が必要）
 * @param {number} week 0始まりの週index（day = week*cfg.game.daysPerWeek 〜 +daysPerWeek-1）
 * @returns {{type:string, label:string, param?:Object}|null} その週に自チーム試合が1つも無ければ null
 */
export function generateWeeklyGoal(state, week) {
  if (!state.rt || !state.playerTeamId) return null;
  if (!weekSchedule(state, week).length) return null; // 自チーム試合の無い週は目標を出さない

  const pool = [{ type: 'weekWinning', label: '今週の対戦で勝ち越せ' }];

  const card = weekCardOpponent(state, week);
  if (card) {
    pool.push({ type: 'cardWinning', label: `今カード（${card.n}連戦）で勝ち越せ`, param: { opp: card.opp, games: card.n } });
  }

  const streak = losingStreakBefore(state, week);
  if (streak >= STREAK_MIN) {
    pool.push({ type: 'stopStreak', label: `連敗を${streak}で止めろ`, param: { streak } });
  }

  if (isMonthClosingWeek(state, week)) {
    pool.push({ type: 'monthPace', label: '今月を勝率.500以上で終えろ' });
  }

  const rng = makeRng(hashSeed(state.masterSeed, 'weeklygoal', state.year, week));
  return pool[rng.int(pool.length)];
}

/**
 * 週次目標の達成判定（週末・純関数）。playerGameLog（自チームの試合のみ）と rt.schedule から判定する。
 * @param {Object} state
 * @param {{type:string, param?:Object}} goal generateWeeklyGoal の返値
 * @param {number} week
 * @returns {{achieved:boolean, actual:string}}
 */
export function evaluateWeeklyGoal(state, goal, week) {
  const teamId = state.playerTeamId;
  const games = weekPlayedGames(state, week);
  if (goal.type === 'cardWinning') {
    const cardGames = games.filter((g) => g.home === goal.param.opp || g.away === goal.param.opp);
    const { w, l } = winLossOf(cardGames, teamId);
    return { achieved: w > l, actual: `${w}勝${l}敗` };
  }
  if (goal.type === 'stopStreak') {
    const won = games.some((g) => outcomeOf(g, teamId) === 'W');
    return { achieved: won, actual: won ? '週内で勝利し連敗を止めた' : '週内で勝利できず' };
  }
  if (goal.type === 'monthPace') {
    const { w, l } = winLossOf(monthToDateGames(state, week), teamId);
    const pct = w + l > 0 ? w / (w + l) : 0;
    return { achieved: pct >= 0.5, actual: `${w}勝${l}敗（勝率${pct.toFixed(3)}）` };
  }
  // 既定: 'weekWinning'
  const { w, l } = winLossOf(games, teamId);
  return { achieved: w > l, actual: `${w}勝${l}敗` };
}

/**
 * 週境界を跨いだら未評価の週を state.weeklyGoalLog へ確定する（game/index.mjs の advanceDay から
 * `if (state.cfg.game.weeklyGoals)` のゲート内でのみ呼ばれる想定＝本関数自体はフラグを見ない）。
 * シーズン終了（rt.finished）時は消化済みの最終（端数）週も確定する。決定論: 追加の乱数消費は
 * generateWeeklyGoal 内の hashSeed 独立座標のみ（既存ストリーム非干渉）。
 * @param {Object} state
 */
export function recordCompletedWeeklyGoals(state) {
  if (!state.playerTeamId || !state.rt) return;
  if (!state.weeklyGoalLog) state.weeklyGoalLog = [];
  const rt = state.rt;
  const span = state.cfg.game.daysPerWeek;
  const pending = pendingDay(rt);
  let week = 0;
  while (state.weeklyGoalLog.some((e) => e.year === state.year && e.week === week)) week++;
  while (rt.finished ? week * span < pending : (week + 1) * span <= pending) {
    const goal = generateWeeklyGoal(state, week);
    if (goal) {
      const result = evaluateWeeklyGoal(state, goal, week);
      state.weeklyGoalLog.push({
        year: state.year, week, type: goal.type, label: goal.label, achieved: result.achieved,
      });
    }
    week++;
  }
}

/**
 * シーズン末のオーナー信任評価へ加算する週次目標達成率ボーナス（owner.mjs trustDelta の合流点で
 * additive に加算する想定）。cfg.game.weeklyGoals=false、または完了年ぶんの記録が無ければ 0。
 * tuning には触れず cfg.game.weeklyGoalTrustBonusMax（小定数）だけを使う。
 * @param {Object} state
 * @returns {number} 0 〜 cfg.game.weeklyGoalTrustBonusMax の整数
 */
export function weeklyGoalTrustBonus(state) {
  if (!state.cfg.game.weeklyGoals) return 0;
  const rows = (state.weeklyGoalLog ?? []).filter((e) => e.year === state.year);
  if (!rows.length) return 0;
  const rate = rows.filter((e) => e.achieved).length / rows.length;
  return Math.round(rate * (state.cfg.game.weeklyGoalTrustBonusMax ?? 0));
}

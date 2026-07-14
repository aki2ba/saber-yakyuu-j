// ============================================================================
// H5-A: 経営レイヤー第1段階 — 年俸予算（phaseH_fun_spec H5-A / fun_design_evidence §4柱5）。
//
//   team.finance = {budget, payroll}。budget は generate.mjs teamFinanceProfile が生成時に
//   球団プロファイルから決定論付与する（§13 teamEvalProfile と同じ独立シード流儀・
//   H5-Cまでキャリア中不変）。payroll はオフシーズン処理の最終段（契約更改→市場移動が
//   すべて終わった後）で refreshTeamFinance が「現在の支配下ロスターの現行年俸合計」から
//   再計算する確定値（UI payroll バー・realism WATCH が読む）。
//
//   salaryOf/salaryFromValue は transactions.mjs の runFA/runTrades/runContractRenewal が
//   共有する（旧・純フレーバーだった salary 式を「実弾化」の判定に使い回す＝式自体は不変
//   ＝実装前後で契約更改の salary 分布は変わらない）。
// ============================================================================
import { teamFinanceProfile } from '../generate.mjs';
import { clamp } from '../model/util.mjs';

export { teamFinanceProfile };

/**
 * H5-C: ファン関心の毎オフ更新（OOTP実挙動パターン: 勝率分位への緩やかな回帰＋イベント修正値。
 * fun_design_evidence §1.3）。全12球団対称・決定論（乱数非使用＝standings/faMoves の純関数）。
 *   - 回帰: fanInterest += regress × (勝率分位[0..1] − fanInterest)
 *   - イベント: リーグ優勝（勝率1位）+championBonus ／ 高年俸スターのFA流出 −starLossHit
 *     （どちらも一過性＝回帰が自然減衰させる。OOTPの「翌季に消える修正値」と同じ形）
 * refreshTeamFinance より先に呼ぶこと（budget が fanInterest から再計算されるため）。
 */
export function updateFanEconomy(league, cfg, { standings, faMoves = [] }) {
  const eco = cfg.tuning.economy.fan;
  if (!eco || !standings || !standings.length) return;
  const wp = (s) => { const d = (s.w ?? 0) + (s.l ?? 0); return d ? s.w / d : 0.5; };
  const rows = standings.slice().sort((a, b) => wp(a) - wp(b) || (a.teamId < b.teamId ? -1 : 1));
  const pctl = new Map(rows.map((s, i) => [s.teamId, rows.length > 1 ? i / (rows.length - 1) : 0.5]));
  const champs = new Set();
  for (const lg of new Set(rows.map((s) => s.league))) {
    const mine = rows.filter((s) => s.league === lg);
    if (mine.length) champs.add(mine[mine.length - 1].teamId); // 昇順ソートの末尾＝リーグ勝率1位
  }
  const starLoss = new Map();
  for (const m of faMoves) {
    if ((m.salary ?? 0) >= eco.starSalary) starLoss.set(m.from, (starLoss.get(m.from) ?? 0) + eco.starLossHit);
  }
  for (const t of league.teams) {
    if (!t.finance) continue; // 未初期化は refreshTeamFinance が後で補完（init から開始）
    const fi = t.finance.fanInterest ?? eco.init;
    let next = fi + eco.regress * ((pctl.get(t.id) ?? 0.5) - fi);
    if (champs.has(t.id)) next += eco.championBonus;
    next -= starLoss.get(t.id) ?? 0;
    t.finance.fanInterest = clamp(next, eco.min, eco.max);
  }
}

/** 選手1人の現行年俸（p.contract 未設定＝一度も更改されていない選手は config の既定額）。 */
export function salaryOf(p, cfg) {
  return p.contract?.salary ?? cfg.tuning.economy.defaultSalary;
}

/**
 * 観測貢献量(v)→年俸（実弾化された契約更改の式）。runContractRenewal が全支配下選手の
 * 契約に、runFA が FA 選手の「提示salary」判定に使う（同一の式＝実弾化で分布は変えない）。
 */
export function salaryFromValue(v, cfg) {
  const eco = cfg.tuning.economy;
  return Math.max(eco.salaryFloor, Math.round(eco.salaryBase + eco.salaryPerValue * (v ?? 0)));
}

/** roster（=支配下選手配列）の現行年俸合計。 */
export function sumSalary(roster, cfg) {
  return roster.reduce((s, p) => s + salaryOf(p, cfg), 0);
}

/**
 * league.teams 全体の team.finance を「現在の支配下ロスター」から再計算して書き込む
 * （オフシーズン処理の最終段・stove UI の payroll バーが読む確定値）。旧セーブ補完（additive
 * save field）: finance が無いチームは teamFinanceProfile で budget を決定論再導出する
 * （personality の load 補完と同じ「後付け可能」構造）。league を in-place 更新する。
 * @param {Object} league {teams, players, farm}
 * @param {Object} cfg
 * @param {number} masterSeed budget backfill 用（既存 finance があれば未使用）
 */
export function refreshTeamFinance(league, cfg, masterSeed) {
  const byTeam = new Map();
  for (const t of league.teams) byTeam.set(t.id, []);
  for (const p of league.players) {
    if (p.rosterStatus !== 'active') continue;
    if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
    byTeam.get(p.teamId).push(p);
  }
  const eco = cfg.tuning.economy;
  for (const t of league.teams) {
    if (!t.finance) t.finance = { payroll: 0 };
    if (t.finance.fanInterest == null) t.finance.fanInterest = eco.fan.init; // H5-C: 旧セーブ補完
    // H5-C: budget = 市場規模（teamFinanceProfile の決定論値）× ファン係数（0.75〜1.25）。
    //   fanInterest=init(0.5) で係数1.0＝H5-A（固定帯）と同値の滑らかな拡張。帯clampで有界＝
    //   優勝/最下位の budget 比は構造的に (max×1.25)/(min×0.75) 以下に抑えられる（暴走防止ゲート）。
    const base = teamFinanceProfile(masterSeed, t.id, cfg).budget;
    const factor = eco.fan.budgetFloorMult + eco.fan.budgetSpanMult * t.finance.fanInterest;
    t.finance.budget = Math.round(clamp(base * factor, eco.budget.min, eco.budget.max));
    t.finance.payroll = sumSalary(byTeam.get(t.id) ?? [], cfg);
  }
}

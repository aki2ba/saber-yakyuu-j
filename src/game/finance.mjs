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

export { teamFinanceProfile };

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
  for (const t of league.teams) {
    if (!t.finance) t.finance = { budget: teamFinanceProfile(masterSeed, t.id, cfg).budget, payroll: 0 };
    t.finance.payroll = sumSalary(byTeam.get(t.id) ?? [], cfg);
  }
}

// ============================================================================
// パークファクター導出（D2・§11.2「文脈で化ける」）
//
// 集計（順位表の本拠地/敵地 得点スプリット）から球団ごとのパークファクター(PF)を導出する。
//   PF_runs(team) = 本拠地の得点/試合 ÷ 敵地の得点/試合
// 自チームの攻守力は本拠地/敵地の両方に等しく効くため、比で相殺され「球場の個性」だけが残る
// （古典的な1年PFの近似）。リーグ平均で正規化し PF平均=1（＝ゼロサム・§D2）にする。
//
// 打者/投手へ適用するPFは本拠地露出（≒半分の試合）ぶんに縮約:
//   pfBat(team) = 1 + (pfRuns(team) − 1) × batShare
// これを metrics の wRC+/ERA-/FIP- のパーク補正（park補正版フィールド）に接続する（leagueConstants）。
// ============================================================================

/**
 * 順位表の本拠地/敵地 得点スプリットから PF を導出する。
 * @param {Array} standings 各行に hpRuns/hpG（本拠地）・rpRuns/rpG（敵地）を含む（season.mjs が累積）
 * @param {Object} [cfg] batShare（PF→打者/投手縮約率）を含む設定。省略時 0.5
 * @returns {{pfRunsByTeam:Map, pfBatByTeam:Map, pfPitByTeam:Map, rawByTeam:Map}}
 *   pfRunsByTeam: 正規化済み run PF（平均1）。pfBat/pfPit: 本拠地露出ぶんに縮約したPF（wRC+/ERA-補正用）。
 */
export function deriveParkFactors(standings, cfg = null) {
  const batShare = (cfg && cfg.tuning && cfg.tuning.park && cfg.tuning.park.batShare) ?? 0.5;
  const rawByTeam = new Map();
  let sumRaw = 0;
  let n = 0;
  for (const t of standings) {
    const homeRPG = (t.hpG || 0) > 0 ? (t.hpRuns || 0) / t.hpG : 0;
    const roadRPG = (t.rpG || 0) > 0 ? (t.rpRuns || 0) / t.rpG : 0;
    const raw = roadRPG > 0 ? homeRPG / roadRPG : 1;
    rawByTeam.set(t.teamId, raw);
    sumRaw += raw;
    n++;
  }
  const meanRaw = n > 0 ? sumRaw / n : 1;
  const pfRunsByTeam = new Map();
  const pfBatByTeam = new Map();
  const pfPitByTeam = new Map();
  for (const [teamId, raw] of rawByTeam) {
    const pfRuns = meanRaw > 0 ? raw / meanRaw : 1; // 正規化（平均1＝ゼロサム）
    const pf = 1 + (pfRuns - 1) * batShare; // 本拠地露出ぶんに縮約
    pfRunsByTeam.set(teamId, pfRuns);
    pfBatByTeam.set(teamId, pf);
    pfPitByTeam.set(teamId, pf); // 投手も同じ本拠地PF（打高球場ほど ERA-/FIP- が優遇される）
  }
  return { pfRunsByTeam, pfBatByTeam, pfPitByTeam, rawByTeam };
}

/** PF散らばりの要約（較正/表示用）。max−min と mean。 */
export function parkFactorSpread(pfRunsByTeam) {
  const vals = [...pfRunsByTeam.values()];
  if (!vals.length) return { spread: 0, mean: 1, min: 1, max: 1 };
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
  return { spread: max - min, mean, min, max };
}

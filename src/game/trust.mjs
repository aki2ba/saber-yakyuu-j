// ============================================================================
// Q1（栄冠ナイン翻案・信頼度）: 起用の安定が選手に返ってくる双方向ループ
//   （thyroxin/research/baseball_game_mechanics_research_20260723.md Q1）
//
//   usageStabilityOf(seasonRow, teamGames) … 完了シーズンの観測statlineから
//     「起用の安定度」0..1を導出する純関数（三層構造の層2＝観測のみを見る）。
//   trustLabelOf(stability) … UI表示用の3段階ラベル。
//
// 設計方針（Q1・オーケストレータ決定）:
//   - 全球団に対称に適用できる観測データ（careerStats/playerSeason の
//     games・PA・登板数・outs）のみを使う。playerGameLog は自チームしか
//     持たないためリーグ対称性が崩れる＝使わない。
//   - 野手: 「出場した打席のフルシーズン比（出場比率）」×
//     「代打でなく先発起用された比率（役割の定着度）」の合成。
//   - 投手: 「役割（先発/救援）に応じた期待登板数に対する実登板数の比率」×
//     「その役割が想定するイニング消化（登板あたりouts）にどれだけ沿っているか」の合成。
//   両者とも「出場量が0に近づけば安定度も0に近づく」よう乗算形にする
//   （出場ゼロなのに役割定着度だけで高い値が出ないようにするため）。
// ============================================================================
import { clamp } from '../model/util.mjs';
import { qualifiedPA } from '../config.mjs';

// 投手側の役割期待値（§req_2三原則②近似・NPB慣行の代理値。tuningではなく本モジュール専用の
//   ローカル定数＝cfg.tuningを一切汚さない指示に従う）。
const ROTATION_SIZE = 6; // 6人ローテ想定（先発の期待登板数 = teamGames/ROTATION_SIZE）
const RELIEVER_APP_SHARE = 0.5; // ワークホース救援の期待登板シェア（teamGames×この値）
const STARTER_OUTS_PER_APP = 18; // 先発1登板の想定消化アウト（6回）
const RELIEVER_OUTS_PER_APP = 3; // 救援1登板の想定消化アウト（1回）

/**
 * 野手の起用安定度（出場比率×先発定着度）。
 * @param {Object} batting createBattingLine() 相当（pa/ph を参照）
 * @param {number} teamGames その season のチーム試合数
 * @returns {number} 0..1
 */
function batterStability(batting, teamGames) {
  const pa = batting?.pa ?? 0;
  if (pa <= 0 || teamGames <= 0) return 0;
  const paRate = clamp(pa / qualifiedPA(teamGames), 0, 1); // フルシーズン規定打席に対する比率
  const ph = batting?.ph ?? 0;
  const starterRate = clamp(1 - ph / pa, 0, 1); // 代打起用の少なさ＝先発定着度
  return clamp(paRate * (0.7 + 0.3 * starterRate), 0, 1);
}

/**
 * 投手の起用安定度（役割期待に対する登板比率×役割相応のイニング消化）。
 * @param {Object} pitching createPitchingLine() 相当（g/gs/outs を参照）
 * @param {number} teamGames その season のチーム試合数
 * @returns {number} 0..1
 */
function pitcherStability(pitching, teamGames) {
  const g = pitching?.g ?? 0;
  if (g <= 0 || teamGames <= 0) return 0;
  const gs = pitching?.gs ?? 0;
  const outs = pitching?.outs ?? 0;
  const startShare = clamp(gs / g, 0, 1); // 先発/救援の混合比（先発ローテ⇔救援の連続量として扱う）
  const expectedApps = startShare * (teamGames / ROTATION_SIZE) + (1 - startShare) * (teamGames * RELIEVER_APP_SHARE);
  const appRate = expectedApps > 0 ? clamp(g / expectedApps, 0, 1) : 0; // 期待登板数に対する実登板比率
  const expectedOutsPerApp = startShare * STARTER_OUTS_PER_APP + (1 - startShare) * RELIEVER_OUTS_PER_APP;
  const actualOutsPerApp = outs / g;
  // 役割相応のイニング消化にどれだけ沿っているか（0=乖離大 / 1=ぴったり）
  const outsFit = expectedOutsPerApp > 0 ? clamp(1 - Math.abs(actualOutsPerApp - expectedOutsPerApp) / expectedOutsPerApp, 0, 1) : 0;
  return clamp(appRate * (0.7 + 0.3 * outsFit), 0, 1);
}

/**
 * 完了シーズンの観測statline（playerSeason・careerStats の1行）から「起用の安定度」を導出する。
 * 乱数を消費しない純関数。全球団の全選手へ同一式で対称に適用できる（リーグ対称性・鉄則）。
 * @param {Object|null|undefined} seasonRow createPlayerSeason() 相当（batting/pitching を参照）。
 *   前季データが無い（新人等）場合は null/undefined 可＝0を返す。
 * @param {number} teamGames その season のチーム試合数（規定打席/期待登板数の分母）
 * @returns {number} 0（不安定・出場ほぼ無し）〜1（安定・フル出場/フル定着）
 */
export function usageStabilityOf(seasonRow, teamGames) {
  if (!seasonRow || !teamGames) return 0;
  const pitchG = seasonRow.pitching?.g ?? 0;
  if (pitchG > 0) return pitcherStability(seasonRow.pitching, teamGames);
  return batterStability(seasonRow.batting, teamGames);
}

// UI表示用ラベル境界（3等分・cfg.tuning非依存＝表示専用の閾値）。
const STABLE_MIN = 0.66;
const VOLATILE_MAX = 0.33;

/**
 * usageStabilityOf の値を3段階の表示ラベルへ変換する（コーチの見立て口調でUIが使う）。
 * @param {number} stability 0..1
 * @returns {'stable'|'normal'|'volatile'}
 */
export function trustLabelOf(stability) {
  if (stability >= STABLE_MIN) return 'stable';
  if (stability <= VOLATILE_MAX) return 'volatile';
  return 'normal';
}

/** trustLabelOf の3ラベル→日本語表示（UI用）。 */
export const TRUST_LABELS_JP = {
  stable: '安定',
  normal: '普通',
  volatile: '不安定',
};

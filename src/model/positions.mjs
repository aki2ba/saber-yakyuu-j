// ポジション・球種などの定数（§7 §9 §13 §4）。
// ⚠️ ここの数値（posAdj等）はMLB標準の初期値。143試合/NPBへの再スケールは
//    中央config(0-4)＋較正(2-9)で行う。定数の"出発点"としてのみ置く。

/** 守備位置（投手Pはroleで扱う。DHは守備なし打撃専念） */
export const POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];

/** 野手の守備位置のみ（DH除く） */
export const FIELD_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

/**
 * 位置補正（FanGraphs WAR の値）。§9 / 正典 sabermetrics_glossary.md §7.5・§10.3
 *
 * ⚠️ 単位は「**162守備試合 = 1,458守備イニング** あたりの run」。1350ではない。
 *   FanGraphs Library 原文:
 *     "Positional adjustments are calculated based on a full 162 games, which equates to
 *      1,458 defensive innings."
 *     "Positional Adjustment = ((Innings Played/9) / 162) * position specific run value"
 *   同ページの実例: 一塁手(−12.5)が1,214イニング → −10.4。
 *     −12.5 × 1214/1458 = −10.41 ✓ ／ −12.5 × 1214/1350 = −11.24 ✗
 *
 *   1,350イニングは **Baseball-Reference** の慣行で、しかも値のセット自体が別物
 *   （C +9 / SS +7 / 2B +3 / CF +2.5 / 3B +2 / LF・RF −7 / 1B −9.5 / DH −15）。
 *   FanGraphs の値に B-R の分母を掛けてはならない（旧実装のバグ）。
 */
export const POSITION_ADJUST_INNINGS_FULL = 1458; // 162守備試合 × 9イニング
export const POSITION_ADJUST_PER_162G = {
  C: 12.5,
  SS: 7.5,
  '2B': 2.5,
  '3B': 2.5,
  CF: 2.5,
  RF: -7.5,
  LF: -7.5,
  '1B': -12.5,
  DH: -17.5,
};

/** 守備難易度の序列（難→易）。§9/§13。コンバート成否・延命判定に流用。 */
export const POSITION_DIFFICULTY = ['C', 'SS', 'CF', '2B', '3B', 'RF', 'LF', '1B'];

// ============================================================================
// ポジション適性のスペクトラム距離（案B・thyroxin/research/position_versatility_research_20260724.md
// Part2「設計方針の共通基盤」「案B」節）。
//
// POSITION_DIFFICULTY の1次元序列をそのまま距離に流用しない（研究レポートPart1の実証:
// SS-2B-3Bは最頻出の共起トライアングルで、SSと2Bの間にCFが挟まる1次元順序ではその近さを
// 過小評価してしまう／CF-LF-RFの外野トライアングルもほぼ完全代替可能）。代わりに実証済みの
// 共起クラスタを**明示テーブル**で定義する（1次元順序の代数だけに頼らない・研究レポートの結論通り）。
//
//   距離0: 同一ポジション
//   距離1（相互適合）:
//     - 内野トライアングル: SS-2B / 2B-3B / SS-3B（最頻出の共起。肩の強さがSS-2B/3Bの分水嶺）
//     - 外野トライアングル: LF-CF / CF-RF / LF-RF（外野内はほぼ完全代替可能という定説）
//     - コーナー内野橋: 1B-3B（3B→1Bへの片道コンバートが典型的に頻出）
//     - コーナー外野橋: 1B-LF / 1B-RF（OF→1Bの加齢コンバートの典型経路）
//   距離Infinity（適合外）: 上記以外の全組み合わせ。Cが絡む組み合わせは常に適合外
//     （捕手は「代わりになれるのは捕手だけ」という孤立クラスタ＝実証1.5%程度の兼任率）。
//     DHは守備適格の概念自体が無い打撃専念枠のため同様に適合外。
// ============================================================================
const SPECTRUM_ADJACENT_PAIRS = [
  ['SS', '2B'],
  ['2B', '3B'],
  ['SS', '3B'],
  ['LF', 'CF'],
  ['CF', 'RF'],
  ['LF', 'RF'],
  ['1B', '3B'],
  ['1B', 'LF'],
  ['1B', 'RF'],
];
const SPECTRUM_ADJACENT = new Set();
for (const [a, b] of SPECTRUM_ADJACENT_PAIRS) {
  SPECTRUM_ADJACENT.add(`${a}|${b}`);
  SPECTRUM_ADJACENT.add(`${b}|${a}`);
}

/**
 * ポジション間のスペクトラム距離（純関数・決定論・引数順不同）。
 * 0=同一ポジション／1=相互適合（上記の明示クラスタ）／Infinity=適合外（C・DHはこの関数の中で
 * 常にInfinity・自分自身との比較を除く）。
 * @param {string} posA
 * @param {string} posB
 * @returns {number} 0 | 1 | Infinity
 */
export function spectrumDistance(posA, posB) {
  if (posA === posB) return 0;
  if (posA === 'C' || posB === 'C' || posA === 'DH' || posB === 'DH') return Infinity;
  return SPECTRUM_ADJACENT.has(`${posA}|${posB}`) ? 1 : Infinity;
}

/** 球種（§2.4）。各投手はこの一部を保有する。 */
export const PITCH_TYPES = [
  'fastball', // ストレート
  'sinker', // シンカー/ツーシーム
  'cutter', // カット
  'slider', // スライダー
  'curve', // カーブ
  'changeup', // チェンジアップ
  'fork', // フォーク/スプリット
];

/** 速球系（対速球/対変化球の2軸分類・§4段階1） */
export const FASTBALL_TYPES = new Set(['fastball', 'sinker', 'cutter']);

/** 球種を2クラス（速球/変化球）に分類 */
export function pitchClass(type) {
  return FASTBALL_TYPES.has(type) ? 'fastball' : 'breaking';
}

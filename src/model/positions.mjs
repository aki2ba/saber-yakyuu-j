// ポジション・球種などの定数（§7 §9 §13 §4）。
// ⚠️ ここの数値（posAdj等）はMLB標準の初期値。143試合/NPBへの再スケールは
//    中央config(0-4)＋較正(2-9)で行う。定数の"出発点"としてのみ置く。

/** 守備位置（投手Pはroleで扱う。DHは守備なし打撃専念） */
export const POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DH'];

/** 野手の守備位置のみ（DH除く） */
export const FIELD_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

/**
 * 位置補正（1350守備イニングあたりの Run 値・MLB標準の初期値）。§9。
 * 難ポジほど+、易ポジほど−。143試合較正で config から再スケールする。
 */
export const POSITION_ADJUST_PER_1350 = {
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

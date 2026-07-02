// ============================================================================
// 打球イベントオブジェクト＋球場ジオメトリ（§3.2）—「一粒五度おいしい」の単一入力
//
// 接触した瞬間に打球3要素(EV/LA/方向)を先に生成し、球場ジオメトリと突き合わせて
// 落下点・滞空時間を出す。この"1個の打球レコード"から、
//   スプレーチャート(§16) / OAA好守拙守(§7.2) / UBR進塁(§6) / 対球種成績(§4)
// が全部派生する。結果を先に決めてゾーンを後付けする旧来設計を逆転させる。
//
// 座標系: 本塁を原点、+y をセンター方向、x を横（−=三塁側/左, +=一塁側/右）。単位はメートル。
// 方向角 sprayAngle: 0=センター, −45=左翼線, +45=右翼線（度）。
// EV は km/h（NPB表記に合わせる）、LA は度。
// ============================================================================

/**
 * @typedef {Object} BattedBall
 * @property {number} evKmh       打球速度 km/h（§3.2: 打者EV適性×投球の質×芯度）
 * @property {number} laDeg       打球角度 度（§3.2: 打者LA適性×投手GB%相性）
 * @property {number} sprayDeg    方向角 度（§3.2: 引っ張り/流し×投球コース）
 * @property {number|null} landingX 落下点X(m)
 * @property {number|null} landingY 落下点Y(m)
 * @property {number|null} distanceM 飛距離(m)
 * @property {number|null} hangTimeS 滞空時間(秒)
 * @property {string|null} pitchType 対戦球種（§4集計の素）
 * @property {string|null} batterId
 * @property {string|null} pitcherId
 * @property {string|null} fielderPos 担当野手ポジション（OAAの主語）
 * @property {number} baseState   塁状況 0..7（bit0:一塁, bit1:二塁, bit2:三塁）
 * @property {number} outs        アウトカウント 0..2
 * @property {string|null} result 最終結果（'1B'|'2B'|'3B'|'HR'|'out'|'error'...）simが確定
 */

/** 打球イベントを生成（3要素は必須、幾何・結果は後段で埋める） */
export function createBattedBall(o = {}) {
  return {
    evKmh: o.evKmh ?? 0,
    laDeg: o.laDeg ?? 0,
    sprayDeg: o.sprayDeg ?? 0,
    landingX: o.landingX ?? null,
    landingY: o.landingY ?? null,
    distanceM: o.distanceM ?? null,
    hangTimeS: o.hangTimeS ?? null,
    pitchType: o.pitchType ?? null,
    batterId: o.batterId ?? null,
    pitcherId: o.pitcherId ?? null,
    fielderPos: o.fielderPos ?? null,
    baseState: o.baseState ?? 0,
    outs: o.outs ?? 0,
    result: o.result ?? null,
  };
}

/**
 * 球場ジオメトリ。中立球場は左右対称。フェンス距離は方向角の関数で表す（パークファクターはフェーズ4）。
 * NPB標準寄りの中立値: 両翼 100m / 中堅 122m / フェンス高 4m。
 */
export function createBallpark(o = {}) {
  return {
    name: o.name ?? 'Neutral Park',
    lineDistM: o.lineDistM ?? 100, // 両翼（ファウルライン上, |spray|=45）
    centerDistM: o.centerDistM ?? 122, // 中堅（spray=0）
    gapDistM: o.gapDistM ?? 116, // 左右中間の目安（|spray|≈20）
    fenceHeightM: o.fenceHeightM ?? 4,
  };
}

/** 中立球場（既定） */
export const NEUTRAL_PARK = createBallpark();

/**
 * 指定方向角のフェンスまでの距離(m)。ライン(100)〜中堅(122)を滑らかに補間。
 * cos ベースの単純近似（中堅で最大、ライン方向で最小）。パーク非対称はフェーズ4で拡張。
 */
export function fenceDistanceAt(sprayDeg, park = NEUTRAL_PARK) {
  const a = Math.min(Math.abs(sprayDeg), 45) / 45; // 0(中堅)..1(ライン)
  return park.centerDistM + (park.lineDistM - park.centerDistM) * a;
}

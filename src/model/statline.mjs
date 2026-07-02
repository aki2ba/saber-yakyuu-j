// ============================================================================
// 統一スタットライン・スキーマ（§5 §6 §7 §9）
//
// 集計器が場当たり的に肥大しないよう、per-(player,season) / per-(team,season) の
// 器をここで一括確定する（自己レビュー M5）。フィールドはフェーズをまたいで段階的に
// 埋めてよいが、"箱"は最初に固定する。特に posAdj/UZR の土台となる
// 「ポジション別 守備アウト(=イニング)」勘定を最初から持たせる。
//
// 指標値（AVG/wOBA/FIP/WAR…）はここには持たない。生カウントだけを保持し、
// 指標は集計後にリーグ定数(1-6)と合わせて算出する（2パス構造・M2/F2）。
// ============================================================================
import { FIELD_POSITIONS } from './positions.mjs';
import { addNumeric } from './util.mjs';

/** 打撃の生カウント（§5）。個人R(得点者)は保留、RBIのみ（§18）。 */
export function createBattingLine() {
  return {
    pa: 0,
    ab: 0,
    h: 0,
    b1: 0, // 単打
    b2: 0, // 二塁打
    b3: 0, // 三塁打
    hr: 0,
    bb: 0,
    ibb: 0, // 敬遠（wOBA/FIPで別扱いしうる）
    hbp: 0,
    so: 0,
    sf: 0, // 犠飛
    sh: 0, // 犠打
    ph: 0, // 代打打席数（S1で器を確定・計上はS2の代打導入で）
    gdp: 0, // 併殺打（wGDPの素, §6）
    sb: 0, // 盗塁（wSBの素, §6）
    cs: 0, // 盗塁死
    rbi: 0,
    // 対球種スプリット（§4段階1）。※通算集計では合算しない（最新シーズンの内訳表示用）
    vsFastball: { pa: 0, ab: 0, h: 0, hr: 0, so: 0, bb: 0 },
    vsBreaking: { pa: 0, ab: 0, h: 0, hr: 0, so: 0, bb: 0 },
  };
}

/** 投手の生カウント（§8 §9）。IPは outs で持つ（1/3イニングの丸め誤差回避）。 */
export function createPitchingLine() {
  return {
    g: 0, // 登板
    gs: 0, // 先発
    outs: 0, // 記録アウト（IP = outs/3）
    bf: 0, // 対戦打者
    h: 0,
    hr: 0,
    bb: 0,
    ibb: 0,
    hbp: 0,
    so: 0,
    r: 0, // 失点
    er: 0, // 自責点
    w: 0,
    l: 0,
    sv: 0, // セーブ
    hld: 0, // ホールド（監査B3で計上）
    bs: 0, // ブローンセーブ（監査B3で計上）
    cg: 0, // 完投（監査B4で計上）
    sho: 0, // 完封（監査B4で計上）
    pitches: 0, // 投球数
  };
}

/** 走塁（盗塁以外の進塁。§6 UBR/wGDPの素）。盗塁数自体は打撃側にも計上。 */
export function createBaserunningLine() {
  return {
    advOpp: 0, // 進塁機会（単打で2→本 / 二塁打で1→本 の判断が発生した回数。UBRの分母）
    advTaken: 0, // うち追加進塁（生還）を取った回数
    outsOnBase: 0, // 走塁死
    gdpOpp: 0, // 併殺機会（wGDPの分母）
  };
}

/** 守備（§7 §9）。posAdj/UZRの土台＝ポジション別 守備アウト勘定を必ず持つ。 */
export function createFieldingLine() {
  const positionOuts = {}; // ポジション -> 守備アウト数（イニング=outs/3）
  for (const p of FIELD_POSITIONS) positionOuts[p] = 0;
  return {
    positionOuts,
    chances: 0,
    po: 0, // 刺殺
    a: 0, // 補殺
    e: 0, // 失策
    oaaOuts: 0, // OAA（実アウト − 期待アウト、outs単位）§7.2。集計で加算
    framingRuns: 0, // フレーミング(捕手)。集計で加算
  };
}

/** 選手×シーズンの器（layer2 観測成績の実体） */
export function createPlayerSeason(playerId, season) {
  return {
    playerId,
    season,
    teamId: null,
    batting: createBattingLine(),
    pitching: createPitchingLine(),
    baserunning: createBaserunningLine(),
    fielding: createFieldingLine(),
  };
}

/** チーム×シーズンの器（順位表の実体）。RS/RAはチーム得点＝個人R保留とは別（§18・F6）。 */
export function createTeamSeason(teamId, season) {
  return {
    teamId,
    season,
    g: 0,
    w: 0,
    l: 0,
    t: 0, // 引分（NPBは延長規定あり）
    rs: 0, // 得点（チーム）
    ra: 0, // 失点（チーム）
  };
}

// --- 集計ヘルパー（2パス集計・通算集計で使用） -------------------------------

/** バッティングを加算（dst に src を足し込む） */
export function addBattingLine(dst, src) {
  return addNumeric(dst, src);
}

/** ピッチングを加算 */
export function addPitchingLine(dst, src) {
  return addNumeric(dst, src);
}

/** 走塁を加算 */
export function addBaserunningLine(dst, src) {
  return addNumeric(dst, src);
}

/** 守備を加算（positionOuts マップは個別に、他は数値加算） */
export function addFieldingLine(dst, src) {
  for (const p of Object.keys(src.positionOuts || {})) {
    dst.positionOuts[p] = (dst.positionOuts[p] || 0) + src.positionOuts[p];
  }
  for (const k of Object.keys(src)) {
    if (k !== 'positionOuts' && typeof src[k] === 'number') dst[k] = (dst[k] || 0) + src[k];
  }
  return dst;
}

/** 選手シーズンを別の器へ加算（通算/リーグ集計用） */
export function addPlayerSeason(dst, src) {
  addBattingLine(dst.batting, src.batting);
  addPitchingLine(dst.pitching, src.pitching);
  addBaserunningLine(dst.baserunning, src.baserunning);
  addFieldingLine(dst.fielding, src.fielding);
  return dst;
}

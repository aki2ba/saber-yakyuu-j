// ============================================================================
// 選手データモデル（§2）
//
// 三層構造（§1・本作の背骨）:
//   layer1 真の実力  = player.trueAbility        … 隠しパラメータ（本人の本当の能力）
//   layer2 観測成績  = player.career.seasons[...] … 真値+打席ノイズ（simで湧く。§5集計）
//   layer3 球団の評価 = 球団AI側が trueAbility+スカウト誤差 で持つ（フェーズ3）。
//                       ここでは誤差シードの器 player.scoutSeed のみ用意。
//
// 能力素材は登録(role)に依らず常時両方保持する（§2.1 転向で重要）。
// レーティングは 20–80 スカウティングスケール（50=リーグ平均）。球速のみ km/h 実数（§2.4）。
// 本ステップ(0-3)は"形"を確定するのが目的。分布からの生成は 0-6。
// ============================================================================
import { FIELD_POSITIONS } from './positions.mjs';

/**
 * @typedef {Object} PitchRating 1球種の能力（§2.4）
 * @property {string} type
 * @property {number} current   現在値(20-80)
 * @property {number} potential 潜在値(20-80)
 * @property {number} whiff     空振り寄与
 * @property {number} hrSuppress 被弾抑止（高いほど打たれにくい）
 * @property {number} contactQuality 被コンタクト質の抑止
 */

/** 1球種レーティングを生成（空振り率と被弾率は別能力＝別プロファイル。§4） */
export function createPitch(type, over = {}) {
  return {
    type,
    current: 50,
    potential: 50,
    whiff: 50,
    hrSuppress: 50,
    contactQuality: 50,
    ...over,
  };
}

/**
 * 真の実力（layer1）。全軸を常時保持。§2.2〜§2.7。
 */
export function createTrueAbility(over = {}) {
  const base = {
    // §2.2 共通素材（登録・ポジション非依存の本人の持ち物）
    common: {
      speed: 50, // 走力（走塁/守備範囲のスピード成分）— 早く落ちる
      arm: 50, // 肩（送球/投手なら球速の素地）— 中間
      hands: 50, // 手・確実性（エラー回避/コンタクト素地）— 安定
      reaction: 50, // 反応・初動（守備範囲の初動成分）— やや弱い
      power: 50, // 生体パワー（打球速度EVの素地）— 20代天井後 維持
    },
    // §2.3 打撃系
    batting: {
      ev: 50, // EV適性（打球速度ポテンシャル＝生体Power×スイング効率）
      la: 50, // LA適性（打球角度の最適化スキル）— 技術寄り・加齢に強い
      pull: 50, // 方向適性（>50 引っ張り / <50 流し）
      contact: 50, // コンタクト資質（芯を食う頻度）— 技術寄り
      eye: 50, // 選球眼 — 加齢でむしろ伸びる
      vsFastball: 50, // 対速球適性（§4段階1）
      vsBreaking: 50, // 対変化球適性（§4段階1）
      // hot/cold ゾーン（球種格子 段階2〜, §4）は後付け（フェーズ2以降）
    },
    // §2.4 投手系
    pitching: {
      velocityKmh: 145, // 球速（km/h 実数・レーティングとは別枠）
      control: 50, // 制球 — 技巧寄り・加齢に強い
      stamina: 50, // スタミナ（イニング耐性軸, §16）
      gbRate: 50, // ゴロ率（打たせて取るタイプ）
      hold: 50, // クイック/Hold（盗塁抑止・§6 wSBの入力。0-3で追加）
      pitches: [], // PitchRating[]（球種構成＝投手タイプ, §8）
    },
    // §2.5 野手守備系
    fielding: {
      positionProf: fielderProfInit(), // ポジション別習熟テーブル（経験で上下, §13）
      positioningIQ: 50, // ポジショニングIQ — 経験・技巧寄り・加齢に強い
      framing: 50, // フレーミング（捕手専用）
    },
    // §2.6 走塁系
    baserunning: {
      steal: 50, // 盗塁技術（スタート/スライディング）— 足の速さと別物
      baserunIQ: 50, // 走塁IQ（進塁判断）— 経験で伸び加齢に強い
    },
    // §2.7 キャリア・パラメータ（分布から引く: §10.2, §12.4。0-6/フェーズ3で使用）
    career: {
      peakAge: 27, // ピーク年齢
      declineRate: 0.5, // 衰え速度（能力タイプと相関, §10.2）
      injuryHistory: [], // 故障歴（最大リスク・再発, §10.5）
      breakEvents: [], // ブレイクイベント履歴（上下, §10.4）
    },
  };
  return deepMerge(base, over);
}

function fielderProfInit() {
  const m = {};
  for (const p of FIELD_POSITIONS) m[p] = 20; // 新ポジションは低スタート（§13）
  return m;
}

/**
 * 選手（三層のコンテナ）。
 * @param {Object} o
 * @param {string} o.id
 * @param {string} o.name  完全架空の名前（§0法的前提）。生成は0-6。
 * @param {'pitcher'|'fielder'} o.role 登録区分（能力素材は両方保持）
 */
export function createPlayer(o = {}) {
  return {
    id: o.id ?? null,
    name: o.name ?? '',
    role: o.role ?? 'fielder',
    bats: o.bats ?? 'R', // 'R'|'L'|'S'
    throws: o.throws ?? 'R', // 'R'|'L'
    age: o.age ?? 24,
    birthSeason: o.birthSeason ?? null,
    teamId: o.teamId ?? null,
    rosterStatus: o.rosterStatus ?? 'active', // active|minor(育成)|fa|retired（フェーズ3で活用）

    trueAbility: o.trueAbility ?? createTrueAbility(), // layer1（隠し）

    // layer3 の基盤: 球団評価はスカウト誤差で歪む（§1, §13）。
    // 誤差は球団×選手で決まるので、選手側は再現用シードのみ持つ（評価値は球団AIが算出, フェーズ3）。
    scoutSeed: o.scoutSeed ?? null,

    // layer2 観測成績: シーズン別スタットライン（simが埋める, §5）。season -> PlayerSeason
    career: { seasons: {} },
  };
}

/** 浅い階層のディープマージ（配列は置換） */
function deepMerge(base, over) {
  if (over == null) return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over)) {
    const bv = base[k];
    const ov = over[k];
    out[k] =
      bv && ov && typeof bv === 'object' && typeof ov === 'object' && !Array.isArray(bv)
        ? deepMerge(bv, ov)
        : ov;
  }
  return out;
}

/** 最低限のスキーマ検証（スキーマ・ドリフトの早期検出用） */
export function validatePlayer(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['player is not an object'];
  if (p.role !== 'pitcher' && p.role !== 'fielder') errors.push(`bad role: ${p.role}`);
  const t = p.trueAbility;
  if (!t) errors.push('missing trueAbility');
  else {
    for (const grp of ['common', 'batting', 'pitching', 'fielding', 'baserunning', 'career']) {
      if (!t[grp]) errors.push(`missing trueAbility.${grp}`);
    }
    if (t.pitching && typeof t.pitching.hold !== 'number') errors.push('missing pitching.hold');
  }
  return errors;
}

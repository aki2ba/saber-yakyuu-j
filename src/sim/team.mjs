// ============================================================================
// チーム編成（1-4a/b/d → フェーズA S1 で v2 化）— ロスターから編成表を組む
//
// buildDepthChart v2（§S1-3）:
//   守備配置:   positionRank（習熟×守備素材＋打撃考慮）の上位を難ポジ優先で割当。
//   打順:       アーキタイプ制。1番=OBP×俊足 / 2番=コンタクト・出塁 / 3番=最強総合 /
//               4番=最強パワー / 5番=次点パワー / 6-8番=残り降順 /
//               9番=DH無なら投手（プレースホルダ・S2が当日の先発を充填）/ DH有なら最弱野手。
//   ベンチ:     スタメン外野手の hitScore 降順（S2の代打/代走/守備固めの母集団）。
//   ローテ:     cfg.league.rotationSize 人（中6日=6人）。
//   ブルペン:   relieverScore 順に closer / setup8 / setup7 / middle[] / long（最下位）。
// ここは「編成の初期値」なので trueAbility を直接参照してよい（三層構造の原則。
// シーズン中の見直しは S3 usage.mjs が観測成績＋スカウトノイズで行う）。
// ============================================================================
import { FIELD_POSITIONS, POSITION_DIFFICULTY } from '../model/positions.mjs';
import { rangeRating } from './fielding.mjs';

/** 打撃スコア（総合打力。3番・DH・ベンチ序列に使用） */
export function hitScore(p) {
  const b = p.trueAbility.batting;
  const c = p.trueAbility.common;
  return b.ev + b.contact + b.eye + c.power + b.la * 0.5;
}

/** 出塁スコア（eye重視。1-2番アーキタイプの選抜に使用・§S1-3） */
export function obpScore(p) {
  const b = p.trueAbility.batting;
  return b.eye * 1.6 + b.contact + b.ev * 0.4;
}

/** パワースコア（4-5番アーキタイプの選抜に使用・§S1-3） */
export function powerScore(p) {
  const b = p.trueAbility.batting;
  const c = p.trueAbility.common;
  return c.power * 1.2 + b.ev + b.la * 0.6;
}

/** 先発スコア（スタミナ主・§16。球種数も加点） */
export function starterScore(p) {
  const pt = p.trueAbility.pitching;
  const whiff = pt.pitches.length ? pt.pitches.reduce((a, x) => a + x.whiff, 0) / pt.pitches.length : 40;
  return pt.stamina * 1.6 + pt.control + whiff + pt.pitches.length * 8 + (pt.velocityKmh - 140);
}

/** リリーフの質（クローザー/セットアッパー序列） */
export function relieverScore(p) {
  const pt = p.trueAbility.pitching;
  const whiff = pt.pitches.length ? pt.pitches.reduce((a, x) => a + x.whiff, 0) / pt.pitches.length : 40;
  return whiff + pt.control + (pt.velocityKmh - 140) * 1.2;
}

/** ポジション候補スコア（習熟＋守備素材(Range)＋打撃考慮。重みは config.tuning.depth） */
function posRankScore(p, pos, cfg) {
  const d = cfg.tuning.depth;
  const prof = p.trueAbility.fielding.positionProf[pos];
  // hitScore(平均≈225)を 50 中心のレーティング相当へスケール（/4.5）して混合
  return prof + d.posToolW * (rangeRating(p, cfg) - 50) + d.posBatW * (hitScore(p) / 4.5 - 50);
}

/**
 * ロスターから編成表を作る（v2）。
 * @param {Array} roster
 * @param {Object} cfg createConfig() の設定（rotationSize / tuning.depth を参照）
 * @param {{dh?:boolean}} opts dh=false でDH無し打順（9番=投手プレースホルダ）。既定 true。
 *   ※S1では season 側は常に dh:true（DH規則=ホーム球団リーグの適用は S2 initSide v2）。
 * @returns {{lineup:Array<{playerId:?string,pos:string}>, defense:Object, bench:string[],
 *   positionRank:Object, rotation:string[], bullpen:string[], bullpenRoles:Object, byId:Map}}
 */
export function buildDepthChart(roster, cfg, opts = {}) {
  const dh = opts.dh ?? true;
  const rotationSize = cfg.league.rotationSize;
  const pitchers = roster.filter((p) => p.role === 'pitcher');
  const fielders = roster.filter((p) => p.role === 'fielder');
  const byId = new Map(roster.map((p) => [p.id, p]));

  // positionRank: ポジションごとの候補ランキング（S3 usage.mjs の見直し対象の初期値）
  const positionRank = {};
  for (const pos of FIELD_POSITIONS) {
    positionRank[pos] = fielders
      .slice()
      .sort((a, b) => posRankScore(b, pos, cfg) - posRankScore(a, pos, cfg))
      .map((p) => p.id);
  }

  // 守備配置: 難ポジ優先（C→SS→CF→…）で positionRank 上位の未使用選手を割当
  const used = new Set();
  const defense = {};
  for (const pos of POSITION_DIFFICULTY) {
    const pid = positionRank[pos].find((id) => !used.has(id));
    used.add(pid);
    defense[pos] = pid;
  }

  // スタメン外の野手（hitScore降順）。DH有なら先頭がDH、残りがベンチ。
  const reserves = fielders.filter((f) => !used.has(f.id)).sort((a, b) => hitScore(b) - hitScore(a));
  const dhId = dh ? (reserves.length ? reserves[0].id : defense['1B']) : null;
  const bench = reserves.filter((f) => f.id !== dhId).map((f) => f.id);

  // --- 打順アーキタイプ（§S1-3） -------------------------------------------
  const pool = FIELD_POSITIONS.map((pos) => ({ playerId: defense[pos], pos }));
  if (dh && dhId) pool.push({ playerId: dhId, pos: 'DH' });
  const P = (e) => byId.get(e.playerId);
  const take = (scoreFn) => {
    let bi = -1;
    let bv = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const v = scoreFn(P(pool[i]));
      if (v > bv) {
        bv = v;
        bi = i;
      }
    }
    return pool.splice(bi, 1)[0];
  };

  const slots = new Array(9).fill(null);
  // 9番: DH無なら投手（当日の先発。S2 initSide v2 が playerId を充填）、DH有なら最弱野手
  slots[8] = dh ? take((p) => -hitScore(p)) : { playerId: null, pos: 'P' };
  slots[2] = take(hitScore); // 3番=最強総合
  slots[3] = take(powerScore); // 4番=最強パワー
  slots[4] = take(powerScore); // 5番=次点パワー
  slots[0] = take((p) => obpScore(p) + cfg.tuning.depth.leadoffSpeedW * (p.trueAbility.common.speed - 50)); // 1番=OBP×俊足
  slots[1] = take((p) => obpScore(p) + p.trueAbility.batting.contact); // 2番=コンタクト/出塁
  // 6-8番: 残りを hitScore 降順
  const rest = pool.slice().sort((a, b) => hitScore(P(b)) - hitScore(P(a)));
  slots[5] = rest[0];
  slots[6] = rest[1];
  slots[7] = rest[2];

  // --- ローテ＆ブルペン ------------------------------------------------------
  const sortedP = pitchers.slice().sort((a, b) => starterScore(b) - starterScore(a));
  const rotation = sortedP.slice(0, rotationSize).map((p) => p.id);
  const bullpen = sortedP
    .slice(rotationSize)
    .sort((a, b) => relieverScore(b) - relieverScore(a))
    .map((p) => p.id);
  // ブルペン役割（§S1-3）: relieverScore順に closer/setup8/setup7、long は最下位、残り middle
  const bullpenRoles = {
    closer: bullpen[0] ?? null,
    setup8: bullpen[1] ?? null,
    setup7: bullpen[2] ?? null,
    middle: bullpen.slice(3, Math.max(3, bullpen.length - 1)),
    long: bullpen.length >= 4 ? bullpen[bullpen.length - 1] : null,
  };

  return { lineup: slots, defense, bench, positionRank, rotation, bullpen, bullpenRoles, byId };
}

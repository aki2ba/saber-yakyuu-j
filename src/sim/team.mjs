// ============================================================================
// チーム編成（1-4a/b/d の一部）— ロスターから打順・守備配置・ローテ・ブルペンを組む
//
// 守備配置: 各ポジションに習熟が最も高い野手を割当（全球団DH有＝投手は打席に立たない）。
// 打順:     選抜9人を打撃スコア降順に並べる（Phase1簡略。OBP最適化等は後で）。
// ローテ:   先発スコア上位5人。残りをブルペン（最小投球回起用は game/season 側）。
// ============================================================================
import { FIELD_POSITIONS } from '../model/positions.mjs';

/** 打撃スコア（打順選抜・DH選抜に使用） */
export function hitScore(p) {
  const b = p.trueAbility.batting;
  const c = p.trueAbility.common;
  return b.ev + b.contact + b.eye + c.power + b.la * 0.5;
}

/** 先発スコア（スタミナ主・§16。球種数も加点） */
export function starterScore(p) {
  const pt = p.trueAbility.pitching;
  const whiff = pt.pitches.length ? pt.pitches.reduce((a, x) => a + x.whiff, 0) / pt.pitches.length : 40;
  return pt.stamina * 1.6 + pt.control + whiff + pt.pitches.length * 8 + (pt.velocityKmh - 140);
}

/** リリーフの質（クローザー/最良中継ぎ判定） */
export function relieverScore(p) {
  const pt = p.trueAbility.pitching;
  const whiff = pt.pitches.length ? pt.pitches.reduce((a, x) => a + x.whiff, 0) / pt.pitches.length : 40;
  return whiff + pt.control + (pt.velocityKmh - 140) * 1.2;
}

/**
 * ロスターから編成表を作る。
 * @returns {{lineup:Array<{playerId:string,pos:string}>, defense:Object, rotation:string[], bullpen:string[], byId:Map}}
 */
export function buildDepthChart(roster) {
  const pitchers = roster.filter((p) => p.role === 'pitcher');
  const fielders = roster.filter((p) => p.role === 'fielder');
  const byId = new Map(roster.map((p) => [p.id, p]));

  // 守備配置: 各ポジションの習熟最高の野手（重複なし）
  const used = new Set();
  const defense = {};
  for (const pos of FIELD_POSITIONS) {
    let best = null;
    let bestv = -1;
    for (const f of fielders) {
      if (used.has(f.id)) continue;
      const v = f.trueAbility.fielding.positionProf[pos];
      if (v > bestv) {
        bestv = v;
        best = f;
      }
    }
    used.add(best.id);
    defense[pos] = best.id;
  }
  // DH = 残りで最良打者
  const remaining = fielders.filter((f) => !used.has(f.id)).sort((a, b) => hitScore(b) - hitScore(a));
  const dhId = remaining.length ? remaining[0].id : defense['1B'];

  // 打順: 守備8＋DH の9人を打撃スコア降順
  const nine = [...FIELD_POSITIONS.map((pos) => ({ playerId: defense[pos], pos })), { playerId: dhId, pos: 'DH' }];
  nine.sort((a, b) => hitScore(byId.get(b.playerId)) - hitScore(byId.get(a.playerId)));

  // ローテ＆ブルペン
  const sortedP = pitchers.slice().sort((a, b) => starterScore(b) - starterScore(a));
  const rotation = sortedP.slice(0, 5).map((p) => p.id);
  const bullpen = sortedP
    .slice(5)
    .sort((a, b) => relieverScore(b) - relieverScore(a))
    .map((p) => p.id);

  return { lineup: nine, defense, rotation, bullpen, byId };
}

// ============================================================================
// フェーズC2b: 引退・世代交代（§10.6）
//
//   runRetirementAndDraft(league, cfg, { seed, draftSeed, yearIndex, debutYear })
//     … 能力・年齢・故障から各選手の引退を確率判定し、引退枠へ「同チーム・同role・同primaryPos」
//        の新人（ドラフト相当）を1:1で補充する。→ リーグ人口とロスター構成を恒常に保つ。
//        league.players / league.teams[].playerIds を in-place で張り替える。
//
// 設計原則（phaseC_spec・厳守）:
//   - 生存バイアス（§10.6）はそのままで正しい: 弱い個体が引退で消え、40代まで残るのは
//     「衰えなかった個体（低declineRate＝鉄人）」だけ → 鉄人が自動でレア化する。
//   - 決定論・順序非依存: 引退判定は id 基準 rng（配列順に依らない）。新人IDは
//     `${teamId}Y${yearIndex}N${k}`（チーム内の引退者をid昇順で採番）で live/replay 一致。
//   - 引退判定は「能力＋年齢＋故障歴」の純関数（観測成績/出場機会に依存しない）。
//     ＝ load の replay（過去年のオフを再走）で season 再シムなしに同一ロスターを再構築できる。
//     真の出場機会依存の戦力外/拾い上げ（§12.2）は C3 で導入する（本stageは能力を代理に使う）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { clamp } from '../model/util.mjs';
import { generateRookie } from '../generate.mjs';

/**
 * オフシーズンの引退判定＋新人補充を適用する（in-place）。
 * @param {{players:Array, teams:Array}} league
 * @param {Object} cfg createConfig()（cfg.tuning.retire / cfg.game.rookieAge* を参照）
 * @param {{seed:number, draftSeed:number, yearIndex:number, debutYear:number}} o
 * @returns {{retirees:Array, rookies:Array}} 引退者サマリと補充新人
 */
export function runRetirementAndDraft(league, cfg, { seed, draftSeed, yearIndex, debutYear }) {
  const survivors = [];
  const retirees = [];
  const goneByTeam = new Map(); // teamId → 引退選手[]（新人補充の枠）

  for (const p of league.players) {
    const prng = makeRng(hashSeed(seed, 'retire', p.id));
    if (decideRetire(p, cfg, prng)) {
      p.rosterStatus = 'retired';
      retirees.push(summarizeRetiree(p, debutYear - 1));
      if (!goneByTeam.has(p.teamId)) goneByTeam.set(p.teamId, []);
      goneByTeam.get(p.teamId).push(p);
    } else {
      survivors.push(p);
    }
  }

  // 新人補充（同チーム・同role・同primaryPos で1:1＝人口/構成恒常）。id は引退者をid昇順に採番。
  const rookies = [];
  for (const [teamId, gone] of goneByTeam) {
    gone.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    gone.forEach((old, k) => {
      const rid = `${teamId}Y${yearIndex}N${k}`;
      const rook = generateRookie(draftSeed, rid, {
        role: old.role,
        primaryPos: old.primaryPos,
        ageMin: cfg.game.rookieAgeMin,
        ageMax: cfg.game.rookieAgeMax,
        debutYear,
      });
      rook.teamId = teamId;
      rookies.push(rook);
    });
  }

  // league を張り替える（生存者＋新人）。順序は生存者（既存順）→新人（チーム走査順）で決定論。
  league.players = survivors.concat(rookies);
  const idsByTeam = new Map();
  for (const p of league.players) {
    if (!idsByTeam.has(p.teamId)) idsByTeam.set(p.teamId, []);
    idsByTeam.get(p.teamId).push(p.id);
  }
  for (const t of league.teams) t.playerIds = idsByTeam.get(t.id) ?? [];

  return { retirees, rookies };
}

/**
 * 引退判定（確率）。老いるほど・弱いほど・故障歴が多いほど引退圧が上がり、能力が高い（鉄人）ほど
 * 残る（生存バイアス）。minAge 未満は残し、hardAge 以上は必ず引退。
 */
function decideRetire(p, cfg, prng) {
  const rt = cfg.tuning.retire;
  const age = p.age;
  if (age < rt.minAge) return false;
  if (age >= rt.hardAge) return true;
  const ability = overallAbility(p); // ~20-80（弱い＝出場機会減の代理）
  let pr =
    rt.base +
    Math.max(0, age - rt.rampAge) * rt.agePerYear +
    Math.max(0, rt.abilityRef - ability) * rt.abilityPerPt +
    (p.trueAbility.career.injuryHistory?.length ?? 0) * rt.injuryPerHist;
  pr -= Math.max(0, ability - rt.abilityRef) * rt.eliteRetain; // 鉄人ほど残る
  return prng.chance(clamp(pr, 0, rt.cap));
}

/**
 * 総合力の粗い代理（~20-80）。role 別に主要な真値を平均する（引退圧の「出場機会」代理）。
 * 投手は球速を rating 換算（50 + (velo-145)×2）して制球/スタミナ/球種質と平均。
 */
function overallAbility(p) {
  const t = p.trueAbility;
  if (p.role === 'pitcher') {
    const veloR = clamp(50 + (t.pitching.velocityKmh - 145) * 2, 20, 80);
    const pitches = t.pitching.pitches;
    let stuff = 50;
    if (pitches.length) {
      let s = 0;
      for (const pi of pitches) s += (pi.current + pi.whiff) / 2;
      stuff = s / pitches.length;
    }
    return (veloR + t.pitching.control + t.pitching.stamina + stuff) / 4;
  }
  const b = t.batting;
  let bestProf = 20;
  for (const k of Object.keys(t.fielding.positionProf)) bestProf = Math.max(bestProf, t.fielding.positionProf[k]);
  return (b.ev + b.contact + b.la + b.eye + t.common.speed + t.fielding.positioningIQ + bestProf) / 7;
}

/** 引退者サマリ（記録/通算リーダーボード用・§17集計値。生イベントは持たない）。 */
function summarizeRetiree(p, retiredAfterYear) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    primaryPos: p.primaryPos,
    finalAge: p.age,
    birthSeason: p.birthSeason ?? null,
    retiredAfterYear,
    injuries: (p.trueAbility.career.injuryHistory ?? []).length,
    breakEvents: (p.trueAbility.career.breakEvents ?? []).length,
  };
}

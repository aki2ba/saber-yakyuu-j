// ============================================================================
// フェーズC2b: 引退・世代交代（§10.6） ／ C3a: 補充をドラフト＋育成昇格へ置換（§13/§15/§12.1）
//
//   runRetirement(league, cfg, { seed, yearIndex, debutYear })
//     … 能力・年齢・故障から各選手の引退を確率判定し（生存バイアス）、生存者を league.players へ
//        張り替え、引退で空いた枠(teamId,role,primaryPos)の一覧 vacancies を返す。
//        補充（ドラフト/育成昇格＝runMarket）と C3b の市場（FA/トレード/戦力外）は呼び出し側
//        （index.mjs の offseasonTransition）がこの後に順序立てて実行する。
//   rebuildTeamRosters(league)
//     … league.players から各 team.playerIds を張り直す（移動/補充の後に呼ぶ・構成の同期）。
//
// 設計原則（phaseC_spec・厳守）:
//   - 生存バイアス（§10.6）はそのままで正しい: 弱い個体が引退で消え、40代まで残るのは
//     「衰えなかった個体（低declineRate＝鉄人）」だけ → 鉄人が自動でレア化する。
//   - 決定論・順序非依存: 引退判定は id 基準 rng（配列順に依らない）。ウェーバー順は前年順位
//     （standings＝teamHistory 経由で load-replay も同一）。
//   - 引退判定は「能力＋年齢＋故障歴」の純関数（観測成績/出場機会に依存しない）。
//     ＝ load の replay（過去年のオフを再走）で season 再シムなしに同一ロスターを再構築できる。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { clamp } from '../model/util.mjs';

/**
 * 各 team.playerIds を league.players（現在の teamId）から張り直す（移動/補充後の同期）。
 * 育成（minor）は支配下ロスターに含めない。
 */
export function rebuildTeamRosters(league) {
  const idsByTeam = new Map();
  for (const p of league.players) {
    if (!idsByTeam.has(p.teamId)) idsByTeam.set(p.teamId, []);
    idsByTeam.get(p.teamId).push(p.id);
  }
  for (const t of league.teams) t.playerIds = idsByTeam.get(t.id) ?? [];
}

/**
 * オフシーズンの引退判定（in-place）。生存者を league.players へ張り替え、引退で空いた枠一覧を返す。
 * 補充（ドラフト/育成昇格）は呼び出し側が runMarket で行う（C3b で FA/トレードを引退と補充の間に
 * 挟むため、引退と補充を分離した）。
 *
 * @param {{players:Array, teams:Array}} league
 * @param {Object} cfg createConfig()（cfg.tuning.retire を参照）
 * @param {{seed:number, debutYear:number}} o
 * @returns {{retirees:Array, vacancies:Array}} 引退者サマリと空き枠(teamId,role,primaryPos)一覧
 */
export function runRetirement(league, cfg, { seed, debutYear }) {
  const survivors = [];
  const retirees = [];
  const gone = []; // 引退選手（枠 = teamId/role/primaryPos の供給源）

  for (const p of league.players) {
    const prng = makeRng(hashSeed(seed, 'retire', p.id));
    if (decideRetire(p, cfg, prng)) {
      p.rosterStatus = 'retired';
      retirees.push(summarizeRetiree(p, debutYear - 1));
      gone.push(p);
    } else {
      survivors.push(p);
    }
  }

  // 引退枠を id 昇順で確定（決定論・順序非依存）。同型(role:pos)は等価なので枠内順序は結果に無影響。
  gone.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const vacancies = gone.map((p) => ({ teamId: p.teamId, role: p.role, primaryPos: p.primaryPos }));

  league.players = survivors;
  rebuildTeamRosters(league);
  return { retirees, vacancies };
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
  // R2: 球団が見るのは「現在能力＋伸びしろ」。maturity 導入で若手の現在能力は構造的に低いため、
  //   peakAge までの残り年数ぶんの成長見込みを加算してから引退圧を測る（これが無いと将来のエースを
  //   「能力40の使えない選手」と見て切ってしまう）。伸びしろが尽きた中堅以降は素の能力で評価される。
  const growthCredit = Math.max(0, (p.trueAbility.career.peakAge ?? 27) - age) * (rt.youthCreditPerYear ?? 0);
  const ability = overallAbility(p) + growthCredit; // ~20-80（弱い＝出場機会減の代理）
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

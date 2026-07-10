// ============================================================================
// フェーズC3a: 編成市場（球団AI評価の球団差・ドラフト・育成/支配下二層）
//   §13/§15（球団AIをわざと現実的に間違わせる＝市場の非効率を仕込む）／§12.1（這い上がりの箱）。
//
//   teamEvalProfile(masterSeed, teamId, cfg)  … 球団ごとに固定の「評価の癖」を分布から引く
//   evaluateProspect(profile, prospect, cfg, ctx) … 観測ツール(真値+スカウトノイズ)×球団重みでの評価
//   trueValue(prospect, cfg)                  … 真価値の代理（テスト/宝の泉の可視化用・AIは見ない）
//   runMarket(league, cfg, {...})             … 引退枠を「育成昇格→ドラフト→育成獲得」で埋める
//
// 設計原則（phaseC_spec・厳守）:
//   - エンジンを壊さない: 本モジュールはオフシーズン遷移（2年目以降）でのみ呼ばれる。1年目
//     レギュラーシーズン（既存50較正）には一切効かない（generateLeague/シムは不変）。
//   - 三層構造: 球団AIは trueAbility を直接見ない。評価は「観測ツール(真値+球団固有ノイズ)」を
//     球団固有の重み（守備/位置の過小評価度・出塁重視度・年齢バイアス）で合成する＝わざと不完全。
//     歪んだ球団評価と真価値(trueValue)の差分こそ「宝の泉」。守備を正しく重める球団(wDef>1)を
//     混ぜると、他球団の捨てた守備型の宝を系統的に拾う（守備版マネーボール）。
//   - 決定論: 乱数は階層シード rng のみ（Date.now/Math.random 非使用）。ウェーバー順は前年順位
//     （teamHistory・save に含まれ replay 再構築される）、くじは lottery シードで解決＝再現可能。
//   - ロスター構成の恒常: 引退枠(teamId,role,primaryPos)を同型で1:1に埋める（人口/構成不変）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { clamp, clampRating } from '../model/util.mjs';
import { generateRookie, applyEraToRookie } from '../generate.mjs';
import { applyAging } from './aging.mjs';
import { observedWoba } from '../sim/manager.mjs';
import { POSITION_ADJUST_PER_162G } from '../model/positions.mjs';

/** id 昇順の安定比較（決定論・順序非依存の走査に使う）。 */
function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 球種の質（current/whiff の平均）。球種なしは 50。 */
function pitchStuff(t) {
  const ps = t.pitching.pitches;
  if (!ps.length) return 50;
  let s = 0;
  for (const pi of ps) s += (pi.current + pi.whiff) / 2;
  return s / ps.length;
}

/**
 * 総合力の粗い代理（~20-80・真値ベース）。育成の昇格判定と farm 剪定に使う内部指標。
 * roster.mjs の overallAbility と同型（役割別に主要真値を平均）。真値なので AI の「評価」ではない。
 */
export function overallRating(p) {
  const t = p.trueAbility;
  if (p.role === 'pitcher') {
    const veloR = clamp(50 + (t.pitching.velocityKmh - 145) * 2, 20, 80);
    return (veloR + t.pitching.control + t.pitching.stamina + pitchStuff(t)) / 4;
  }
  const b = t.batting;
  let bestProf = 20;
  for (const k of Object.keys(t.fielding.positionProf)) bestProf = Math.max(bestProf, t.fielding.positionProf[k]);
  return (b.ev + b.contact + b.la + b.eye + t.common.speed + t.fielding.positioningIQ + bestProf) / 7;
}

/**
 * 球団ごとの評価プロファイル（§13/§15）。masterSeed×teamId から固定で引く（キャリア中不変＝球団の癖）。
 *   wBat  打撃/投球コアの重み（球団差小）
 *   wEye  出塁(選球眼)重視度（球団差大）
 *   wDef  守備/位置価値の重み（多くが<1＝系統的な過小評価。稀に>1＝守備を正しく重める球団）
 *   ageBias 年齢バイアス（若手志向のペナルティ/歳）
 *   noiseSd スカウト観測ノイズSD（球団ごとの評価の荒さ）
 * @returns {{teamId:string, wBat:number, wEye:number, wDef:number, ageBias:number, noiseSd:number}}
 */
export function teamEvalProfile(masterSeed, teamId, cfg) {
  const pc = cfg.tuning.market.profile;
  const r = makeRng(hashSeed(masterSeed, 'evalprofile', teamId));
  return {
    teamId,
    wBat: clamp(r.normal(pc.wBatMean, pc.wBatSd), pc.wBatMin, pc.wBatMax),
    wEye: clamp(r.normal(pc.wEyeMean, pc.wEyeSd), pc.wEyeMin, pc.wEyeMax),
    wDef: clamp(r.normal(pc.wDefMean, pc.wDefSd), pc.wDefMin, pc.wDefMax),
    ageBias: clamp(r.normal(pc.ageBiasMean, pc.ageBiasSd), pc.ageBiasMin, pc.ageBiasMax),
    noiseSd: Math.max(pc.noiseSdMin, r.normal(pc.noiseSdMean, pc.noiseSdSd)),
  };
}

/** 観測ツール = 真値 + 球団固有スカウトノイズ（ctx 無し or noiseSd=0 なら真値そのまま＝テスト用）。 */
function obsTool(trueVal, profile, ctx, tool, pid) {
  if (!ctx || !profile.noiseSd) return trueVal;
  const r = makeRng(hashSeed(ctx.masterSeed, 'scout', ctx.yearIndex, ctx.teamId, pid, tool));
  return trueVal + r.normal(0, profile.noiseSd);
}

/**
 * 球団 profile による prospect の評価スカラー（§13）。観測ツール（真値+球団固有ノイズ）を
 * 球団固有の重みで合成する（trueAbility を直接は見ない＝三層構造）。守備/位置価値は wDef で重み、
 * 多くの球団は wDef<1 ＝守備/位置を過小評価する（宝を捨てる）。
 * @param {Object} profile teamEvalProfile() の返値（テストは noiseSd:0 の即席 profile を渡せる）
 * @param {Object} p prospect（Player）
 * @param {Object} cfg
 * @param {{masterSeed:number, yearIndex:number, teamId:string}|null} ctx ノイズ座標（null=無ノイズ）
 */
export function evaluateProspect(profile, p, cfg, ctx = null) {
  const m = cfg.tuning.market.eval;
  const t = p.trueAbility;
  const id = p.id;
  const ageK = profile.ageBias * Math.max(0, p.age - 18);
  if (p.role === 'pitcher') {
    const veloR = clamp(50 + (t.pitching.velocityKmh - 145) * 2, 20, 80);
    const velo = obsTool(veloR, profile, ctx, 'velo', id);
    const ctrl = obsTool(t.pitching.control, profile, ctx, 'control', id);
    const stam = obsTool(t.pitching.stamina, profile, ctx, 'stamina', id);
    const stuff = obsTool(pitchStuff(t), profile, ctx, 'stuff', id);
    return profile.wBat * (velo + ctrl + stam + stuff) - ageK;
  }
  const b = t.batting;
  const c = t.common;
  const f = t.fielding;
  const ev = obsTool(b.ev, profile, ctx, 'ev', id);
  const contact = obsTool(b.contact, profile, ctx, 'contact', id);
  const eye = obsTool(b.eye, profile, ctx, 'eye', id);
  const la = obsTool(b.la, profile, ctx, 'la', id);
  const power = obsTool(c.power, profile, ctx, 'power', id);
  const prof = obsTool(f.positionProf[p.primaryPos] ?? 20, profile, ctx, 'prof', id);
  const iq = obsTool(f.positioningIQ, profile, ctx, 'iq', id);
  const reaction = obsTool(c.reaction, profile, ctx, 'reaction', id);
  const arm = obsTool(c.arm, profile, ctx, 'arm', id);
  const batComp = ev + contact + power + m.laW * la;
  const defComp = prof + iq + reaction + m.armW * arm;
  const posVal = (POSITION_ADJUST_PER_162G[p.primaryPos] ?? 0) * m.posScale;
  return profile.wBat * batComp + profile.wEye * m.eyeScale * eye + profile.wDef * (defComp + posVal) - ageK;
}

/**
 * 真価値の代理（テスト/可視化用・AIは見ない）。守備・位置価値を「正しく」重めた全知評価
 * （wBat=wEye=wDef=1・ノイズ0・年齢バイアス0）。歪んだ球団評価との差分が「宝の泉」（§13）。
 */
export function trueValue(p, cfg) {
  return evaluateProspect({ wBat: 1, wEye: 1, wDef: 1, ageBias: 0, noiseSd: 0 }, p, cfg, null);
}

/** 前年順位からのウェーバー逆順（勝率の低い順＝弱いチームが先）。standings 無しは teams 順。 */
export function waiverOrder(standings, league) {
  if (!standings || !standings.length) return league.teams.map((t) => t.id);
  const winPct = (s) => {
    const dec = (s.w ?? 0) + (s.l ?? 0);
    return dec ? s.w / dec : 0.5;
  };
  return standings
    .slice()
    .sort((a, b) => winPct(a) - winPct(b) || (a.teamId < b.teamId ? -1 : 1))
    .map((s) => s.teamId);
}

/** 世代（高卒18/大卒22/社会人25）から新人の年齢を1つ引く（§15 世代生成）。 */
function pickCohortAge(rng, cohort) {
  const u = rng.next();
  if (u < cohort.hsShare) return cohort.hsAge;
  if (u < cohort.hsShare + cohort.colShare) return cohort.colAge;
  return cohort.corpAge;
}

/**
 * ドラフトプールを生成する。各(role,primaryPos)型で「空き数＋surplus」人の prospect を
 * スカウト観測（世代年齢・真値）付きで作る。surplus が選択肢を生み、球団評価差＝宝の源になる。
 * @returns {Map<string, Array>} typeKey('role:pos') → prospect[]
 */
function generatePool(vacancies, cfg, { draftSeed, yearIndex, debutYear, era = null }) {
  const mk = cfg.tuning.market;
  const byType = new Map();
  for (const v of vacancies) {
    const tk = `${v.role}:${v.primaryPos}`;
    if (!byType.has(tk)) byType.set(tk, { role: v.role, primaryPos: v.primaryPos, count: 0 });
    byType.get(tk).count++;
  }
  const pool = new Map();
  let gi = 0;
  for (const [tk, info] of byType) {
    const n = info.count + mk.surplusPerType;
    const arr = [];
    for (let i = 0; i < n; i++) {
      const id = `D${yearIndex}n${gi++}`;
      const age = pickCohortAge(makeRng(hashSeed(draftSeed, 'cohortage', id)), mk.cohort);
      // era（時代トレンド・D3）: 世代の波・球速の経年上昇を新人生成時に反映（王朝均衡 boost は draft 後）。
      const p = generateRookie(draftSeed, id, { role: info.role, primaryPos: info.primaryPos, ageMin: age, ageMax: age, debutYear, era });
      arr.push(p);
    }
    pool.set(tk, arr);
  }
  return pool;
}

/**
 * ドラフト（ウェーバー逆順×1位競合くじ・NPB風）。空き枠(vacancies)を pool から埋める。
 *   Round1: 各球団が自評価の最高 prospect を1位指名 → 競合はくじで解決（負けは再指名）。
 *   Round2+: ウェーバー順（弱い順）に残り枠を自評価の最高で1人ずつ埋める。
 * 各球団は自分の空き枠と同型(role:pos)の prospect しか獲れない（構成恒常）。
 * @returns {{rookies:Array, undrafted:Array, draftLog:Object}}
 */
function runDraft(vacancies, pool, profiles, order, cfg, { masterSeed, yearIndex }) {
  const teamVac = new Map(); // teamId → [{role,primaryPos}]（残り空き枠のキュー）
  for (const t of order) teamVac.set(t, []);
  for (const v of vacancies) {
    if (!teamVac.has(v.teamId)) teamVac.set(v.teamId, []);
    teamVac.get(v.teamId).push({ role: v.role, primaryPos: v.primaryPos });
  }
  const available = new Map(); // typeKey → prospect[]（獲得で減る）
  for (const [k, arr] of pool) available.set(k, arr.slice());
  const rookies = [];
  const draftLog = { order: order.slice(), picks: [], lotteries: [] };

  // 球団の「残り空き枠の型のうち、自評価が最高の available prospect」を返す。
  const bestFor = (teamId) => {
    const vac = teamVac.get(teamId);
    if (!vac || !vac.length) return null;
    const types = new Set(vac.map((v) => `${v.role}:${v.primaryPos}`));
    const profile = profiles.get(teamId);
    let best = null;
    let bestVal = -Infinity;
    let bestType = null;
    for (const tk of types) {
      const arr = available.get(tk) || [];
      for (const pr of arr) {
        const val = evaluateProspect(profile, pr, cfg, { masterSeed, yearIndex, teamId });
        if (val > bestVal || (val === bestVal && (best === null || pr.id < best.id))) {
          bestVal = val;
          best = pr;
          bestType = tk;
        }
      }
    }
    return best ? { prospect: best, typeKey: bestType } : null;
  };

  const assign = (teamId, prospect, typeKey, meta) => {
    const vac = teamVac.get(teamId);
    const vi = vac.findIndex((v) => `${v.role}:${v.primaryPos}` === typeKey);
    vac.splice(vi, 1);
    const arr = available.get(typeKey);
    arr.splice(arr.findIndex((p) => p.id === prospect.id), 1);
    prospect.teamId = teamId;
    prospect.rosterStatus = 'active';
    rookies.push(prospect);
    draftLog.picks.push({ teamId, prospectId: prospect.id, ...meta });
  };

  // --- Round1: 1位指名＋競合くじ ---
  const pendingR1 = new Set(order.filter((t) => (teamVac.get(t) || []).length));
  while (pendingR1.size) {
    const noms = new Map(); // prospectId → {prospect, byTeam:Map<teamId,typeKey>}
    for (const teamId of order) {
      if (!pendingR1.has(teamId)) continue;
      const b = bestFor(teamId);
      if (!b) { pendingR1.delete(teamId); continue; }
      if (!noms.has(b.prospect.id)) noms.set(b.prospect.id, { prospect: b.prospect, byTeam: new Map() });
      noms.get(b.prospect.id).byTeam.set(teamId, b.typeKey);
    }
    if (!noms.size) break;
    for (const [pid, nom] of noms) {
      const teams = [...nom.byTeam.keys()];
      let winner;
      let contested = false;
      if (teams.length === 1) {
        winner = teams[0];
      } else {
        contested = true;
        const r = makeRng(hashSeed(masterSeed, 'lottery', yearIndex, pid));
        winner = teams[r.int(teams.length)];
        draftLog.lotteries.push({ prospectId: pid, contenders: teams.slice(), winner });
      }
      assign(winner, nom.prospect, nom.byTeam.get(winner), { round: 1, via: contested ? 'lottery' : 'nominate', contested });
      pendingR1.delete(winner);
    }
  }

  // --- Round2+: ウェーバー順（弱い順）に残り枠を埋める ---
  for (let round = 2; round <= 200; round++) {
    let progress = false;
    for (const teamId of order) {
      if (!(teamVac.get(teamId) || []).length) continue;
      const b = bestFor(teamId);
      if (!b) continue;
      assign(teamId, b.prospect, b.typeKey, { round, via: 'waiver', contested: false });
      progress = true;
    }
    if (!progress) break;
  }

  const undrafted = [];
  for (const arr of available.values()) undrafted.push(...arr);
  return { rookies, undrafted, draftLog };
}

/**
 * ドラフト漏れ（undrafted＝球団評価に過小評価された surplus）を育成枠へ配る。
 * ウェーバー順ラウンドロビンで各球団 perTeamSignsPerYear 人まで。rosterStatus='minor' で farm へ。
 */
function signDevelopment(league, cfg, undrafted, order) {
  const mk = cfg.tuning.market.farm;
  const pool = undrafted.slice().sort(byId);
  const signed = new Map(order.map((t) => [t, 0]));
  let pi = 0;
  let any = true;
  while (pi < pool.length && any) {
    any = false;
    for (const teamId of order) {
      if (pi >= pool.length) break;
      if ((signed.get(teamId) ?? 0) >= mk.perTeamSignsPerYear) continue;
      const d = pool[pi++];
      d.teamId = teamId;
      d.rosterStatus = 'minor';
      league.farm.push(d);
      signed.set(teamId, (signed.get(teamId) ?? 0) + 1);
      any = true;
    }
  }
}

/**
 * 育成の二軍実成績ボーナス（F2-3・§12.1強化）: 昇格判定の「観測」へ当年の二軍statlineを加点する。
 * 二軍で打った/抑えた育成ほど昇格しやすい（三層構造: 観測statlineのみ・真値不参照）。
 * 標本が薄いほど信頼度加重で効きが弱まる（少PA/少IPの上振れに騙されない）。obs 無し（未出場・
 * 二軍リーグ不成立の旧構成）は 0＝従来の判定と同一。
 * @param {Object} d 育成選手
 * @param {?Object} obs 当年の二軍 statline（{batting,pitching}・careerFarmStats 由来）
 */
export function farmPerfBonus(d, obs, cfg) {
  if (!obs) return 0;
  const f = cfg.tuning.market.farm;
  if (d.role === 'fielder') {
    const b = obs.batting;
    if (!b || !(b.pa > 0)) return 0;
    const trust = b.pa / (b.pa + f.promotePerfTrustPA);
    return f.promoteWobaW * (observedWoba(b, cfg) - cfg.tuning.mgr.wobaPrior) * trust;
  }
  const pi = obs.pitching;
  if (!pi || !(pi.outs > 0)) return 0;
  const trust = pi.outs / (pi.outs + f.promotePerfTrustOuts);
  return f.promoteRa9W * (f.promoteRa9Ref - (pi.r * 27) / pi.outs) * trust;
}

/** 育成枠の剪定: 年齢超過は解雇、球団あたり perTeamMax 超は観測下位から解雇（箱を有限に保つ）。 */
function pruneFarm(league, cfg) {
  const mk = cfg.tuning.market.farm;
  const byTeam = new Map();
  for (const d of league.farm) {
    if (d.age > mk.maxAge) continue;
    if (!byTeam.has(d.teamId)) byTeam.set(d.teamId, []);
    byTeam.get(d.teamId).push(d);
  }
  const kept = [];
  for (const arr of byTeam.values()) {
    arr.sort((a, b) => overallRating(b) - overallRating(a) || byId(a, b));
    for (const d of arr.slice(0, mk.perTeamMax)) kept.push(d);
  }
  kept.sort(byId);
  league.farm = kept;
}

/**
 * 編成市場の中核（C3a）。引退枠 vacancies を「育成昇格 → ドラフト → 育成獲得」で埋める。
 *   1. 育成枠を加齢（発達）させる
 *   2. 昇格判定: 育成の観測成績が閾値超 かつ 自球団に同型の空き枠あり → 支配下登録（稀・§12.1）
 *   3. ドラフト: 残り空き枠をウェーバー逆順×くじで埋める（§15）
 *   4. 育成獲得: ドラフト漏れ（過小評価 surplus）を育成枠へ（安く獲れる箱・§12.1）
 *   5. 剪定: 育成枠を有限に保つ
 * 決定論・構成恒常（promoted+rookies == vacancies）。league.farm を in-place で更新する。
 * @returns {{promoted:Array, rookies:Array, draftLog:Object, promotions:Array}}
 */
export function runMarket(league, cfg, { vacancies, standings, masterSeed, yearIndex, debutYear, era = null, balanceBoost = null, farmObs = null }) {
  const mk = cfg.tuning.market;
  if (!league.farm) league.farm = [];
  const profiles = new Map();
  for (const t of league.teams) profiles.set(t.id, teamEvalProfile(masterSeed, t.id, cfg));

  // 1. 育成枠の発達（加齢）。独立シード座標＝支配下選手の加齢ストリームを一切乱さない。
  applyAging(league.farm, cfg, { seed: hashSeed(masterSeed, 'farmaging', yearIndex) });

  // 2. 昇格判定（§12.1・這い上がり／F2-3強化）。観測成績（真値+下振れバイアス+ノイズ＋
  //    **当年の二軍実成績ボーナス**）が閾値超 かつ 自球団に同型の空き枠がある育成選手を支配下登録
  //    する（枠が空くという「機会」に依存＝稀）。支配下70枠（roster.controlledPerTeam）の管理:
  //    昇格は枠の空きがある球団のみ（引退→空き枠の通常フローでは常に空くが、不変量として明示的に守る）。
  const cap = cfg.tuning.roster?.controlledPerTeam ?? Infinity;
  const controlledCount = new Map();
  for (const p of league.players) controlledCount.set(p.teamId, (controlledCount.get(p.teamId) ?? 0) + 1);
  const remainingVac = vacancies.slice();
  const promoted = [];
  const promotions = [];
  const stillFarm = [];
  for (const d of league.farm.slice().sort(byId)) {
    const tk = `${d.role}:${d.primaryPos}`;
    const r = makeRng(hashSeed(masterSeed, 'promote', yearIndex, d.id));
    const observed =
      overallRating(d) + mk.farm.promoteObsBias + r.normal(0, mk.farm.promoteObsNoiseSd) +
      farmPerfBonus(d, farmObs ? farmObs.get(d.id) : null, cfg);
    const vi = remainingVac.findIndex((v) => v.teamId === d.teamId && `${v.role}:${v.primaryPos}` === tk);
    const hasRoom = (controlledCount.get(d.teamId) ?? 0) < cap; // 支配下70枠の空き（F2-3枠管理）
    if (observed >= mk.farm.promoteThreshold && vi >= 0 && hasRoom) {
      remainingVac.splice(vi, 1);
      controlledCount.set(d.teamId, (controlledCount.get(d.teamId) ?? 0) + 1);
      d.rosterStatus = 'active';
      promoted.push(d);
      promotions.push({ playerId: d.id, teamId: d.teamId, role: d.role, primaryPos: d.primaryPos, age: d.age, observed: Math.round(observed) });
    } else {
      stillFarm.push(d);
    }
  }
  league.farm = stillFarm;

  // 3. ドラフト（残り枠）。era＝世代の波/球速上昇を pool 生成時に反映（D3・§11.3）。
  const pool = generatePool(remainingVac, cfg, { draftSeed: hashSeed(masterSeed, 'draft', yearIndex), yearIndex, debutYear, era });
  const order = waiverOrder(standings, league);
  const { rookies, undrafted, draftLog } = runDraft(remainingVac, pool, profiles, order, cfg, { masterSeed, yearIndex });
  // 王朝均衡（D3・§11.3）: 弱い球団に割り当たった新人へ再分配 boost を反映（戦力の平均回帰＝振り子）。
  //   pool 生成時は team 未確定ゆえ draft 割当後に適用（決定論・boost は standings 由来の純算術）。
  if (balanceBoost && balanceBoost.size) {
    for (const p of rookies) {
      const b = balanceBoost.get(p.teamId) || 0;
      if (b) applyEraToRookie(p, null, b);
    }
  }

  // 4. 育成獲得（ドラフト漏れ＝過小評価された surplus を安く箱へ）。5. 剪定。
  signDevelopment(league, cfg, undrafted, order);
  pruneFarm(league, cfg);

  return { promoted, rookies, draftLog, promotions };
}

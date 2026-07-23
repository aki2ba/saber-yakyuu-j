// ============================================================================
// フェーズC3b: 選手市場のトランザクション — FA・トレード・戦力外/拾い上げ（§15 / §12.2）。
//
//   runFA(league, cfg, ctx)            … 国内FA（宣言→球団AI入札→移籍＋人的補償）
//   runTrades(league, cfg, ctx)        … トレード（AI同士＝評価差で双方win成立／プレイヤー起案）
//   runReleaseAndPickup(league,cfg,ctx)… 戦力外→拾い上げ（少なく歪んだ観測で切られ、査定の違う球団が拾う）
//   runContractRenewal(league,cfg,ctx) … 契約更改（年俸=観測連動・34歳以降の長期はリスク＝フレーバー）
//   observedValueOf(p, obs, cfg)       … 当該シーズンの "実観測" 貢献量（放出判定の入力・出場機会依存）
//   regressedValueOf(p, obs, cfg)      … Wave D: observedValueOf の回帰調整版（BABIP平均回帰/少PA縮約/年齢割引）
//   subjectiveTradeValue(...)          … Wave D: トレードAIの主観価値（saberSavvy×regressed＋ポジション需要項）
//
// 設計原則（phaseC_spec・厳守）:
//   - エンジンを壊さない: すべてオフシーズン遷移（2年目以降）でのみ呼ばれる。1年目レギュラー
//     シーズン（既存50較正）には一切効かない（generateLeague/シム/1年目季は不変）。
//   - 決定論: 乱数は階層シード rng のみ（Date.now/Math.random 非使用）。処理順は id/teamId 昇順・
//     ウェーバー順で固定。プレイヤー操作（入札/トレード起案）は marketInterventions ログとして
//     save に含まれ、load の replay で同一結果に再現される。
//   - 三層構造: 入札・受諾・拾い上げの査定は evaluateProspect（観測ツール＋スカウトノイズ×球団の癖）。
//     放出（戦力外）判定だけは "実際の観測成績"（当該シーズンの生 statline）で下す＝出場機会に
//     依存して歪む（少PA→ショボく見える＝上林型／不振→板山型）。査定を違える他球団が拾って生き返る。
//   - 構成恒常: 全移動は同(role,primaryPos)の 1:1 スワップ／循環。球団あたりの役割・守備位置
//     構成が厳密に不変＝人口/構成恒常（引退→ドラフトの補充系と直交）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { evaluateProspect, waiverOrder } from './market.mjs';
import { observedWoba } from '../sim/manager.mjs';
import { rawRunValuePerPA, LINEAR_WEIGHTS } from '../sim/leagueConstants.mjs';
import { positionStrengthMap } from './gmBoard.mjs';
import { salaryOf, salaryFromValue, sumSalary } from './finance.mjs';

/** id 昇順の安定比較（決定論・順序非依存の走査に使う）。 */
function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** teamId 昇順のチームid列（決定論の走査順）。 */
function teamIds(league) {
  return league.teams.map((t) => t.id).sort();
}

/** 支配下（active）選手を球団ごとに束ねる（育成 minor は市場対象外）。 */
function activeByTeam(league) {
  const m = new Map();
  for (const t of league.teams) m.set(t.id, []);
  for (const p of league.players) {
    if (p.rosterStatus !== 'active') continue;
    if (!m.has(p.teamId)) m.set(p.teamId, []);
    m.get(p.teamId).push(p);
  }
  for (const arr of m.values()) arr.sort(byId);
  return m;
}

/** ロスターの (role,primaryPos) 型キー。 */
function typeKey(p) {
  return `${p.role}:${p.primaryPos}`;
}

/** 球団 profile による査定（ctx=スカウトノイズ座標）。evaluateProspect の薄いラッパ。 */
function assess(profiles, teamId, p, cfg, masterSeed, yearIndex) {
  return evaluateProspect(profiles.get(teamId), p, cfg, { masterSeed, yearIndex, teamId });
}

/**
 * 球団のプロテクトリスト（自評価の上位 count 人の id 集合）。非プロテクト＝残り。
 * 人的補償・トレード放出・戦力外の「出せる／狙える」母集団を非プロテクトに絞る（§12.2）。
 */
function protectSet(teamId, roster, profiles, cfg, count, masterSeed, yearIndex) {
  const ranked = roster
    .slice()
    .sort(
      (a, b) =>
        assess(profiles, teamId, b, cfg, masterSeed, yearIndex) -
          assess(profiles, teamId, a, cfg, masterSeed, yearIndex) || byId(a, b),
    );
  return new Set(ranked.slice(0, count).map((p) => p.id));
}

/**
 * 当該シーズンの "実観測" 貢献量（trueAbility を一切見ない・出場機会に依存して歪む）。
 *   野手 =（観測wOBA − 代替wOBA）× PA
 *   投手 =（代替FIP − 観測FIP）× IP/9（run単位）
 * 拾い上げ後の "観測改善"（PAが増えて貢献が表に出る＝余所では生きる）の物差しにも使う（§12.2）。
 * @param {Object} p 選手（{id, role}）
 * @param {Map<string,Object>} obs playerId → 当該シーズンの careerStats 行（{batting,pitching,...}）
 * @returns {number|null} 観測が無い（新人・当年未出場）なら null
 */
export function observedValueOf(p, obs, cfg) {
  const line = obs.get(p.id);
  if (!line) return null;
  const rel = cfg.tuning.market.release;
  if (p.role === 'pitcher') {
    const pt = line.pitching || {};
    const ip = (pt.outs || 0) / 3;
    if (ip <= 0) return null;
    const fip = (13 * (pt.hr || 0) + 3 * ((pt.bb || 0) - (pt.ibb || 0) + (pt.hbp || 0)) - 2 * (pt.so || 0)) / ip;
    return ((rel.replacementFip - fip) * ip) / 9;
  }
  const b = line.batting || {};
  const pa = b.pa || 0;
  if (pa <= 0) return null;
  return (observedWoba(b, cfg) - rel.replacementWoba) * pa;
}

// ============================================================================
// Wave D（gm_analytics_spec.md §Wave D）: トレードAI受諾のセイバー視点。
//   regressedValueOf … observedValueOf の回帰調整版（純関数・trueAbility非参照）。
//   posNeedMultiplier/subjectiveTradeValue … トレードAIの主観価値合成（saberSavvy×回帰＋需要項）。
// ============================================================================

/**
 * observedValueOf の回帰調整版（Wave D §2・純関数・trueAbility非参照）。当季の"生"観測から
 * 「平均回帰込みの、より真の実力に近い」貢献量を出す。observedValueOf 同様 obs に行が無い/
 * 出場が無ければ null（新人・当年未出場は対象外）。
 *   野手: ①BABIP乖離の平均回帰補正（定説: インプレー打球の結果=BABIPはリーグ平均へ回帰する。
 *     当季BABIPがリーグ平均±devThreshold超で乖離していれば乖離の半分をリーグ平均側へ戻す＝
 *     戻し分を単打換算でwOBAへ反映）②少PA縮約（PA/(PA+定数)でリーグ平均wOBAへ縮約＝簡易ベイズ）
 *     した「回帰調整wOBA」で価値換算。
 *   投手: FIP（DIPS準拠）を維持しつつ、K-BB%由来の推定ERA（kwERA式=既存 tuning.metrics.kwERA を
 *     流用・K-BB%はFIPよりHR/FB変動に強い先行指標という定説）を fipWeight:kbbWeight で合成し、
 *     少IP縮約（IP/(IP+定数)でリーグ平均FIPへ縮約）した上で価値換算。
 *   年齢割引: 30歳超は1歳ごとに残存価値を逓減（老化の定説・ageBiasとは独立の客観項）。
 * @returns {number|null}
 */
export function regressedValueOf(p, obs, cfg) {
  const line = obs.get(p.id);
  if (!line) return null;
  const rel = cfg.tuning.market.release;
  const sk = cfg.tuning.market.saber;
  const mgr = cfg.tuning.mgr;
  let value;
  if (p.role === 'pitcher') {
    const pt = line.pitching || {};
    const ip = (pt.outs || 0) / 3;
    if (ip <= 0) return null;
    const fip = (13 * (pt.hr || 0) + 3 * ((pt.bb || 0) - (pt.ibb || 0) + (pt.hbp || 0)) - 2 * (pt.so || 0)) / ip;
    const bf = pt.bf || 0;
    const kbbPct = bf > 0 ? (pt.so || 0) / bf - (pt.bb || 0) / bf : 0;
    const kw = cfg.tuning.metrics.kwERA;
    const kwImplied = kw.c0 - kw.k * kbbPct; // K-BB%由来のFIP相当（kwERA式の流用）
    const blended = sk.fipWeight * fip + sk.kbbWeight * kwImplied; // 例7:3でFIP:K-BB%換算
    const shrunk = (blended * ip + sk.leagueFip * sk.ipRegressConstant) / (ip + sk.ipRegressConstant); // 少IP縮約
    value = ((rel.replacementFip - shrunk) * ip) / 9;
  } else {
    const b = line.batting || {};
    const pa = b.pa || 0;
    if (pa <= 0) return null;
    const bip = (b.ab || 0) - (b.so || 0) - (b.hr || 0) + (b.sf || 0); // インプレー打球数
    let b1adj = b.b1 || 0;
    if (bip > 0) {
      const babip = ((b.h || 0) - (b.hr || 0)) / bip;
      const dev = babip - sk.leagueBabip;
      if (Math.abs(dev) > sk.babipDevThreshold) {
        // 定説どおり乖離の半分をリーグ平均側へ戻す（戻し分は単打の増減として扱う＝内訳が
        // 無い以上「でっち上げない」で最も単純な近似）。
        const hitsDelta = -dev * sk.babipRegressFactor * bip;
        b1adj = Math.max(0, b1adj + hitsDelta);
      }
    }
    const rawWoba = rawRunValuePerPA({ ...b, b1: b1adj }, LINEAR_WEIGHTS) * mgr.wobaScale;
    // 少PA縮約（簡易ベイズ）: mgr.wobaPriorPA(=60)は観戦AIのその場判断用の弱い縮約であり、
    //   市場評価にはより強い縮約定数(paRegressConstant)を使う。
    const shrunkWoba = (rawWoba * pa + mgr.wobaPrior * sk.paRegressConstant) / (pa + sk.paRegressConstant);
    value = (shrunkWoba - rel.replacementWoba) * pa;
  }
  const ageMult = p.age > sk.ageDiscountStartAge
    ? Math.max(sk.ageDiscountFloor, 1 - sk.ageDiscountPerYear * (p.age - sk.ageDiscountStartAge))
    : 1;
  return value * ageMult;
}

/**
 * ポジション需要項の乗数（Wave D §3・純関数）。gmBoard.positionStrengthMap の1セル（cell）を
 * 受け取り、弱点(weak)なら(1+posNeedBonus)倍・飽和(saturated)なら(1−posSurplusPenalty)倍・
 * どちらでもない/セル不明なら1（中立）を返す。
 * @param {?{weak:boolean, saturated:boolean}} cell
 */
export function posNeedMultiplier(cell, cfg) {
  const sk = cfg.tuning.market.saber;
  if (!cell) return 1;
  if (cell.weak) return 1 + sk.posNeedBonus;
  if (cell.saturated) return 1 - sk.posSurplusPenalty;
  return 1;
}

/**
 * teamId×league×obs×standings から gmBoard.positionStrengthMap を1回だけ構築し、
 * `${teamId}:${pos}` → cell のルックアップ表にする（runTrades が1回だけ呼ぶ・null許容の
 * 早期リターンで obs/standings 未提供の旧呼び出しは無効化＝既存挙動と bit 同一）。
 * gmBoard.positionStrengthMap(state) が要求する形へ league/obs/standings を仮の
 * state（{cfg, league, rt:{stats:{stats:obs}, standings:Map}}）として組み立てる。
 * @returns {?Map<string,Object>}
 */
function buildPosNeedMap(league, cfg, obs, standings) {
  if (!obs || !obs.size || !standings || !standings.length) return null;
  const state = { cfg, league, rt: { stats: { stats: obs }, standings: new Map(standings.map((s) => [s.teamId, s])) } };
  const { cells } = positionStrengthMap(state);
  const m = new Map();
  for (const c of cells) m.set(`${c.teamId}:${c.pos}`, c);
  return m;
}

/** posNeedMap から選手pの「受け手teamIdでの位置セル」を引く（投手はobsの当季役割でSP/RP判定）。 */
function lookupPosCell(posNeedMap, teamId, p, obs) {
  if (!posNeedMap) return null;
  let pos;
  if (p.role === 'pitcher') {
    const line = obs ? obs.get(p.id) : null;
    const pt = line && line.pitching;
    if (!pt || !(pt.outs > 0) || !(pt.g > 0)) return null;
    pos = pt.gs * 2 >= pt.g ? 'SP' : 'RP';
  } else {
    pos = p.primaryPos;
  }
  return posNeedMap.get(`${teamId}:${pos}`) ?? null;
}

/**
 * トレードAIの主観価値（Wave D §3）: `(1−saberSavvy)×従来評価 + saberSavvy×regressed評価`
 * ＋ポジション需要項。評価関数を直接ブレンドすると evaluateProspect（rating単位）と
 * regressedValueOf/observedValueOf（runs単位）でスケールが崩壊するため、regressed と
 * naive(observedValueOf) の**差分**を runToRatingScale で rating 相当へ変換し、savvy に応じて
 * 従来評価へ加算する（savvy=0で従来評価と完全一致・savvy=1でフル反映＝スケール整合させた
 * 上記式の等価な実装。savvyDeltaCapで暴走を防ぐ）。obs が無い/当季観測が無い選手は
 * 従来評価のみ（回帰の入力自体が無い＝新人等）。
 * 最後にポジション需要項（受け手teamIdの弱点/飽和）を乗じる。
 * @param {Map<string,Object>} profiles teamId→teamEvalProfile()
 * @param {string} teamId 評価する側（受け手）の球団id
 * @param {Object} p 評価対象の選手
 * @param {?Map<string,Object>} obs playerId→当季観測statline（省略時は従来評価のみ）
 * @param {?Map<string,Object>} posNeedMap buildPosNeedMap() の結果（省略時はポジション補正なし）
 */
export function subjectiveTradeValue(profiles, teamId, p, cfg, { masterSeed, yearIndex, obs = null, posNeedMap = null } = {}) {
  const profile = profiles.get(teamId);
  const trad = evaluateProspect(profile, p, cfg, { masterSeed, yearIndex, teamId });
  const savvy = profile?.saberSavvy ?? 0;
  let v = trad;
  if (savvy > 0 && obs) {
    const reg = regressedValueOf(p, obs, cfg);
    const naive = observedValueOf(p, obs, cfg);
    if (reg != null && naive != null) {
      const sk = cfg.tuning.market.saber;
      const rawDelta = (reg - naive) * sk.runToRatingScale;
      const delta = Math.max(-sk.savvyDeltaCap, Math.min(sk.savvyDeltaCap, rawDelta));
      v = trad + savvy * delta;
    }
  }
  const cell = lookupPosCell(posNeedMap, teamId, p, obs);
  return v * posNeedMultiplier(cell, cfg);
}

/**
 * 戦力外スコア（低いほど切られやすい・§12.2）＝ 観測貢献量 − 出場機会ペナルティ。
 * 少PA/少IP（未確立・渋滞の犠牲＝上林型）は不足ぶんのペナルティで負に沈む。高PAの不振（板山型）も
 * 貢献量自体が負。放出判定は "実観測" だけで下す（trueAbility 非参照）＝出場機会に依存して歪む。
 * ＝別球団（査定が違う＝スカウトが素材を見る）が拾えば生き返る余地が生まれる。
 * @returns {number|null} 観測が無ければ null（＝対象外・新人保護）
 */
export function releaseScore(p, obs, cfg) {
  const base = observedValueOf(p, obs, cfg);
  if (base == null) return null;
  const rel = cfg.tuning.market.release;
  const line = obs.get(p.id);
  if (p.role === 'pitcher') {
    const ip = (line.pitching?.outs || 0) / 3;
    return base - rel.ptPenaltyPit * Math.max(0, rel.fullIP - ip);
  }
  const pa = line.batting?.pa || 0;
  return base - rel.ptPenaltyBat * Math.max(0, rel.fullPA - pa);
}

// ============================================================================
// FA（§15）
// ============================================================================
/**
 * 国内FA。資格者（一定年齢帯・簡略）の一部が宣言→他球団が評価関数で入札→最高入札が現球団評価を
 * bidMargin 超で上回れば移籍。人的補償として移籍先の "非プロテクト同型" から1人を流出元へ戻す
 * （＝同(role,primaryPos)1:1スワップ＝構成恒常）。プレイヤーは marketInterventions で入札に介入できる。
 *
 * FA入札が "評価関数差で分かれる": 守備を重める球団は守備型FAに高く入札し、出塁重視の球団は
 * 選球眼型に高く入札する（evaluateProspect の球団の癖）。→ 宝を正しく評価する球団が競り勝つ。
 *
 * H5-A（phaseH_fun_spec）: 実弾化。winner が確定した後、以下の2条件を追加で満たさないと移籍しない
 * （AI/プレイヤー対称・winner=AIでもプレイヤーでも同じ判定）:
 *   1. 提示salary（当該FA選手の当季観測貢献量→salaryFromValue）が fa.salaryFloor 超
 *      （下限未満＝本気の入札ではない・格安の一言二言で獲れる程度の選手には金を払わない）
 *   2. winner の payroll（人的補償で出す comp の年俸を差し引き・p の年俸を足した後）が
 *      team.finance.budget 以内（finance 未設定の呼び出し元＝旧テスト等は budget=Infinity で無効化）
 * obs 省略時（旧呼び出し）は observedValueOf が null を返し salaryFromValue が salaryBase を返す
 * ＝全FA選手が同一の salary になるだけで判定自体は従来どおり機能する。
 * @returns {Array} 成立した移籍の記録
 */
export function runFA(league, cfg, { profiles, masterSeed, yearIndex, interventions, obs = new Map() }) {
  const fa = cfg.tuning.market.fa;
  const order = teamIds(league);
  const rosters = activeByTeam(league);
  const protects = new Map();
  for (const tid of order) {
    protects.set(tid, protectSet(tid, rosters.get(tid), profiles, cfg, fa.protectCount, masterSeed, yearIndex));
  }
  // H5-A: 球団の年俸予算（finance未設定＝旧テスト等は budget:Infinity で無効化）と、
  //   このFAパス内での払い出し累積（複数FAが同一球団に連続で決まる場合の逐次判定）。
  const financeByTeam = new Map(league.teams.map((t) => [t.id, t.finance]));
  const payrollByTeam = new Map(order.map((tid) => [tid, sumSalary(rosters.get(tid), cfg)]));
  const signings = [];

  // 資格判定＋宣言（決定論・年齢帯＝年数条件の簡略代理）。
  const declared = [];
  for (const p of league.players.slice().sort(byId)) {
    if (p.rosterStatus !== 'active') continue;
    if (p.age < fa.minAge || p.age > fa.maxAge) continue;
    if (makeRng(hashSeed(masterSeed, 'fa-declare', yearIndex, p.id)).chance(fa.declareRate)) declared.push(p);
  }

  const faIv = interventions.filter((iv) => iv.phase === 'fa');
  for (const p of declared) {
    const home = p.teamId;
    // 各球団の入札（現球団を除く）。最高入札を決める（同値は teamId 昇順）。
    let best = null;
    let bestVal = -Infinity;
    for (const tid of order) {
      if (tid === home) continue;
      const bid = assess(profiles, tid, p, cfg, masterSeed, yearIndex);
      if (bid > bestVal || (bid === bestVal && (best === null || tid < best))) {
        bestVal = bid;
        best = tid;
      }
    }
    if (!best) continue;
    const homeVal = assess(profiles, home, p, cfg, masterSeed, yearIndex);

    // プレイヤー介入: 自チームがこのFAへ入札（＝AIを上回る意思）→ 勝者を強制上書き（再現可能）。
    const pv = faIv.find((iv) => iv.playerId === p.id);
    let winner = null;
    let via = 'ai';
    if (pv && pv.teamId && pv.teamId !== home && rosters.has(pv.teamId)) {
      winner = pv.teamId;
      via = 'player';
    } else if (bestVal > homeVal + fa.bidMargin) {
      winner = best;
    }
    if (!winner) continue;

    // H5-A: 提示salary（実弾化）が下限未満なら本気の入札ではない＝不成立。
    const askSalary = salaryFromValue(observedValueOf(p, obs, cfg), cfg);
    if (askSalary <= fa.salaryFloor) continue;

    // 人的補償: 移籍先 winner の "非プロテクト同型" から、流出元 home が自評価で最良の1人を獲る。
    //   winner は自評価で最も惜しくない同型（＝最低評価の非プロテクト）を差し出す。無ければ不成立
    //   （＝構成恒常のガード。同(role,primaryPos)1:1が保てない移籍はしない）。
    const tk = typeKey(p);
    const pool = rosters
      .get(winner)
      .filter((q) => q.id !== p.id && typeKey(q) === tk && !protects.get(winner).has(q.id));
    if (!pool.length) continue;
    // winner が差し出す＝winner 自評価の最低（最も惜しくない）。
    pool.sort((a, b) => assess(profiles, winner, a, cfg, masterSeed, yearIndex) - assess(profiles, winner, b, cfg, masterSeed, yearIndex) || byId(a, b));
    const comp = pool[0];

    // H5-A: winner の予算内チェック（compの年俸が抜け・pの提示salaryが入る）。超過なら不成立
    //   （AI/プレイヤー対称＝winnerがプレイヤー球団でも同じ式で判定される）。
    const compSalary = salaryOf(comp, cfg);
    const winnerBudget = financeByTeam.get(winner)?.budget ?? Infinity;
    const winnerPayrollAfter = payrollByTeam.get(winner) - compSalary + askSalary;
    if (winnerPayrollAfter > winnerBudget) continue;

    // 契約年数（34歳以降の長期はリスク・§15）＝フレーバー記録。
    const years = Math.max(1, Math.min(fa.maxYears, p.age >= fa.longContractAge ? fa.maxYears - Math.floor((p.age - fa.longContractAge) / 2) : fa.maxYears - 1));
    // 移籍実行（同型1:1スワップ）。
    const homeSalaryOfP = salaryOf(p, cfg); // home 側の払い出し解放額＝pの"現行"契約（askSalaryは市場相場・別概念）
    p.teamId = winner;
    comp.teamId = home;
    // ロスター束を更新（後続FA処理が最新の在籍で判断できるように）。
    rosters.set(winner, rosters.get(winner).filter((q) => q.id !== comp.id).concat(p).sort(byId));
    rosters.set(home, rosters.get(home).filter((q) => q.id !== p.id).concat(comp).sort(byId));
    payrollByTeam.set(winner, winnerPayrollAfter);
    payrollByTeam.set(home, payrollByTeam.get(home) - homeSalaryOfP + compSalary);
    signings.push({ playerId: p.id, from: home, to: winner, comp: comp.id, via, years, age: p.age, role: p.role, primaryPos: p.primaryPos, salary: askSalary });
  }
  return signings;
}

// ============================================================================
// トレード（§15）
// ============================================================================
/**
 * R7（決定4）: 「今⇄将来」の意図的な非効率（窓状態バイアス）。Dayn Perry/Neil Painesの実証
 * （デッドライン補強の実際の貢献は総VORPの2.2%・WS制覇との相関はほぼ無/マイナス）に基づき、
 * contending は即戦力(veteranAge以上)を受け取る評価を、rebuilding は若手(youthAge以下)を
 * 受け取る評価を、それぞれ windowPremium だけ過大評価する（＝双方winのmargin判定を通りやすくし、
 * 買い手が将来を安く手放す/売り手が即戦力を安く手放す構造を作る）。windowByTeam 無し（旧テスト
 * 呼び出し）は常に0＝既存挙動と bit 同一。
 */
function windowPremium(teamId, incoming, windowByTeam, cfg) {
  if (!windowByTeam) return 0;
  const tc = cfg.tuning.market.trade;
  const w = windowByTeam.get(teamId);
  if (w === 'contending' && incoming.age >= tc.veteranAge) return tc.windowPremium;
  if (w === 'rebuilding' && incoming.age <= tc.youthAge) return tc.windowPremium;
  return 0;
}

/**
 * トレード。AI同士は "各自の評価関数の差" から双方が得だと見なせば成立（双方win）。同(role,primaryPos)の
 * 1:1スワップ（構成恒常）。プレイヤー起案は marketInterventions で受け、AIは自評価で受諾判定する。
 *
 * 双方win の直観: A の余剰選手 Xa（A評価で最低）と B の余剰選手 Xb を、A が「Xb>Xa（A評価）」かつ
 * B が「Xa>Xb（B評価）」と見なせば、評価関数の違いから両者とも純利得＝成立。宝の再分配が起きる。
 *
 * H5-A（phaseH_fun_spec）: 実弾化。双方winの評価差margin判定に加え、|salaryOf(a)-salaryOf(b)| が
 * tc.salaryDiffMax 以内でないと成立しない（AI/プレイヤー対称。高年俸選手を安い選手だけで釣る
 * 一方的な財布勝負を防ぐ）。p.contract 未設定の選手は economy.defaultSalary が使われる＝
 * 契約未更改の旧テスト/序盤は全員同額で判定が実質無効化（既存挙動に近い）。
 * @param {Map<string,string>|null} windowByTeam teamId→'contending'|'neutral'|'rebuilding'（決定3・§決定4で使用）
 * @param {Map<string,Object>} [obs] Wave D: playerId→当季観測statline（受諾判定の主観価値=
 *   subjectiveTradeValue の回帰/需要項入力。省略時は従来の evaluateProspect のみ＝既存挙動と bit 同一）
 * @param {Array} [standings] Wave D: 当季順位表（positionStrengthMap のポジション需要項の入力）
 * @returns {Array} 成立したトレードの記録
 */
export function runTrades(league, cfg, { profiles, masterSeed, yearIndex, interventions, windowByTeam = null, obs = null, standings = null }) {
  const tc = cfg.tuning.market.trade;
  const salaryOk = (a, b) => Math.abs(salaryOf(a, cfg) - salaryOf(b, cfg)) <= tc.salaryDiffMax;
  const order = teamIds(league);
  const rosters = activeByTeam(league);
  // Wave D: 受諾判定の主観価値（AI球団の評価地点）だけをここで subjectiveTradeValue に置換する。
  //   protectSet/候補選定（下の cand.set のソート）は「自分の中で誰が最も惜しくないか」という
  //   従来どおりの自己評価に留める（spec範囲=受諾判定/AI間トレードの評価関数のみ）。
  const posNeedMap = buildPosNeedMap(league, cfg, obs, standings);
  const subjective = (teamId, p) => subjectiveTradeValue(profiles, teamId, p, cfg, { masterSeed, yearIndex, obs, posNeedMap });
  const protects = new Map();
  for (const tid of order) {
    protects.set(tid, protectSet(tid, rosters.get(tid), profiles, cfg, tc.protectCount, masterSeed, yearIndex));
  }
  const moved = new Set(); // この年に既に動いた選手（二重移動を防ぐ）
  const trades = [];
  const byPid = new Map(league.players.map((p) => [p.id, p]));

  const swap = (a, b, via) => {
    const ta = a.teamId;
    const tb = b.teamId;
    a.teamId = tb;
    b.teamId = ta;
    rosters.set(tb, rosters.get(tb).filter((q) => q.id !== b.id).concat(a).sort(byId));
    rosters.set(ta, rosters.get(ta).filter((q) => q.id !== a.id).concat(b).sort(byId));
    moved.add(a.id);
    moved.add(b.id);
    trades.push({ aPlayer: a.id, aTeam: ta, bPlayer: b.id, bTeam: tb, via, role: a.role, primaryPos: a.primaryPos });
  };

  // プレイヤー起案トレードを先に適用（AIは自評価で受諾判定・再現可能）。
  for (const iv of interventions.filter((i) => i.phase === 'trade')) {
    const a = byPid.get(iv.aPlayer);
    const b = byPid.get(iv.bPlayer);
    if (!a || !b || moved.has(a.id) || moved.has(b.id)) continue;
    if (a.teamId !== iv.aTeam || b.teamId !== iv.bTeam) continue;
    if (typeKey(a) !== typeKey(b)) continue; // 同型のみ（構成恒常）
    // AI 相手（bTeam）の受諾判定: 受け取る a を、放出する b より margin 超で高評価なら受諾。
    //   Wave D: 主観価値=subjectiveTradeValue（(1-saberSavvy)×従来評価+saberSavvy×regressed評価
    //   相当＋ポジション需要項）。
    const aiTeam = iv.bTeam;
    const gain =
      subjective(aiTeam, a) + windowPremium(aiTeam, a, windowByTeam, cfg) -
      subjective(aiTeam, b);
    if (gain > tc.margin && salaryOk(a, b)) swap(a, b, 'player');
    else trades.push({ aPlayer: a.id, aTeam: iv.aTeam, bPlayer: b.id, bTeam: iv.bTeam, via: 'player', rejected: true });
  }

  // AI同士: 型ごとに、各球団の "最も惜しくない非プロテクト同型選手" を候補に、双方winの対を探す。
  const types = new Set();
  for (const p of league.players) if (p.rosterStatus === 'active') types.add(typeKey(p));
  outer: for (const tk of [...types].sort()) {
    // 各球団の候補＝その型の非プロテクトのうち自評価が最低（放出したい1人）。
    const cand = new Map();
    for (const tid of order) {
      const arr = rosters
        .get(tid)
        .filter((q) => typeKey(q) === tk && !protects.get(tid).has(q.id) && !moved.has(q.id));
      if (!arr.length) continue;
      arr.sort((a, b) => assess(profiles, tid, a, cfg, masterSeed, yearIndex) - assess(profiles, tid, b, cfg, masterSeed, yearIndex) || byId(a, b));
      cand.set(tid, arr[0]);
    }
    const teams = [...cand.keys()].sort();
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const A = teams[i];
        const B = teams[j];
        const Xa = cand.get(A);
        const Xb = cand.get(B);
        if (!Xa || !Xb || moved.has(Xa.id) || moved.has(Xb.id)) continue;
        // Wave D: 双方とも主観価値（subjectiveTradeValue）で評価する（同じ物差しでないと
        //   双方winのtwin-winロジックが崩れるため、受け取り側/放出側とも置換する）。
        const aGain =
          subjective(A, Xb) + windowPremium(A, Xb, windowByTeam, cfg) -
          subjective(A, Xa);
        const bGain =
          subjective(B, Xa) + windowPremium(B, Xa, windowByTeam, cfg) -
          subjective(B, Xb);
        if (aGain > tc.margin && bGain > tc.margin && salaryOk(Xa, Xb)) {
          swap(Xa, Xb, 'ai');
          if (trades.filter((t) => !t.rejected).length >= tc.maxPerYear) break outer;
          continue outer; // この型は1件成立で次の型へ（churn抑制）
        }
      }
    }
  }
  return trades;
}

// ============================================================================
// 戦力外 → 拾い上げ（§12.2）
// ============================================================================
/**
 * 戦力外→拾い上げ。各球団は "実際の観測成績"（当該シーズンの生 statline）が低い非プロテクト選手を
 * 戦力外候補に出す（少PA/不振でショボく見える＝上林/板山型）。候補を型ごとに集め、査定の違う球団間で
 * 再分配する（同型循環＝構成恒常）。切った球団は同型を1人受け取る（自分の候補が戻ることも、他球団の
 * 宝を拾うこともある）。拾い上げた選手は翌季に出場機会を得て観測が改善しうる（「余所では生きる」）。
 *
 * 三層の要: 放出判定＝実観測（歪む）／拾い上げ査定＝evaluateProspect（スカウトが素材を見る）。
 * 全球団同目だと復活は起きない → 球団ごとに評価関数が違うからこそ宝がこぼれ、別球団で生き返る。
 *
 * H5-A（phaseH_fun_spec）: forcedCuts（予算超過球団が更改で出す高salary非プロテクト選手・
 * transactions.mjs runContractRenewal の budgetCuts）を "同じ再分配プール" へ合流させる
 * （戦力外候補ルート＝同型循環に乗せる＝構成恒常を保ったまま予算超過を解消する）。
 * @param {Map<string,Object>} obs playerId → 当該シーズンの観測 statline 行
 * @param {Array<{teamId,player,cutVal}>} [forcedCuts] 予算超過による強制戦力外候補（H5-A）
 * @returns {Array} 拾い上げ（放出→別球団が獲得）の記録
 */
export function runReleaseAndPickup(league, cfg, { profiles, masterSeed, yearIndex, standings, obs, forcedCuts = [] }) {
  const rel = cfg.tuning.market.release;
  const order = teamIds(league);
  const rosters = activeByTeam(league);

  // 各球団の戦力外候補を型別に集める。放出判定は "実観測" の戦力外スコアだけ（trueAbility 非参照）＝
  //   出場機会に依存して歪む。査定（evaluateProspect）で守らない＝自球団の歪んだ査定で切った宝が
  //   別球団で拾われる余地を残す（全球団同目だと復活しない・§12.2）。若手（minAge未満）は保護。
  const cutByType = new Map(); // typeKey → [{teamId, player, cutVal}]
  for (const tid of order) {
    const cands = [];
    for (const p of rosters.get(tid)) {
      if (p.age < rel.minAge) continue;
      const v = releaseScore(p, obs, cfg);
      if (v == null || v >= rel.threshold) continue;
      cands.push({ player: p, val: v, obsVal: observedValueOf(p, obs, cfg) });
    }
    cands.sort((a, b) => a.val - b.val || byId(a.player, b.player)); // スコアが低い順
    for (const c of cands.slice(0, rel.maxCutsPerTeam)) {
      const tk = typeKey(c.player);
      if (!cutByType.has(tk)) cutByType.set(tk, []);
      cutByType.get(tk).push({ teamId: tid, player: c.player, cutVal: c.obsVal, reason: 'score' });
    }
  }
  // H5-A: 予算超過の強制戦力外を同じプールへ合流（スコア基準で既に候補の選手は二重計上しない）。
  for (const fc of forcedCuts) {
    const tk = typeKey(fc.player);
    if (!cutByType.has(tk)) cutByType.set(tk, []);
    const arr = cutByType.get(tk);
    if (arr.some((e) => e.player.id === fc.player.id)) continue;
    arr.push({ teamId: fc.teamId, player: fc.player, cutVal: fc.cutVal, reason: 'budget' });
  }

  const wOrder = waiverOrder(standings, league); // 弱い球団が先に拾える（ウェーバー順）
  const rank = new Map(wOrder.map((t, i) => [t, i]));
  const pickups = [];
  for (const [, entries] of [...cutByType].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (entries.length < 2) continue; // 同型が2件以上ないと再分配（＝拾い上げ）が起きない
    const cutMeta = new Map(entries.map((e) => [e.player.id, e]));
    const remaining = entries.map((e) => e.player);
    // 拾い上げ: 提出球団は "出した人数ぶん" の獲得枠を持つ（枠=提出票）。枠をウェーバー順（同順は teamId）
    //   に処理し、各枠が残プールから自評価で最良を1人ずつ引き当てる＝提出=獲得の全単射（構成恒常）。
    const tickets = entries
      .map((e) => e.teamId)
      .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
    for (const tid of tickets) {
      if (!remaining.length) break;
      let bi = 0;
      let bv = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const val = assess(profiles, tid, remaining[i], cfg, masterSeed, yearIndex);
        if (val > bv || (val === bv && remaining[i].id < remaining[bi].id)) {
          bv = val;
          bi = i;
        }
      }
      const claimed = remaining.splice(bi, 1)[0];
      if (claimed.teamId !== tid) {
        const meta = cutMeta.get(claimed.id);
        claimed.teamId = tid;
        pickups.push({ playerId: claimed.id, from: meta.teamId, to: tid, cutVal: Math.round(meta.cutVal * 10) / 10, age: claimed.age, role: claimed.role, primaryPos: claimed.primaryPos, reason: meta.reason ?? 'score' });
      }
    }
  }
  return pickups;
}

// ============================================================================
// 契約更改（§15・フレーバー）
// ============================================================================
/**
 * 契約更改。年俸を観測（当年 statline 貢献量、無ければ 0）に緩く連動させ、契約年数を年齢で決める
 * （34歳以降は長期＝リスク）。H5-A（phaseH_fun_spec）で実弾化: salary は
 * finance.mjs salaryFromValue（旧・同一式を独立関数化しただけ＝分布は不変）。
 *
 * H5-A: profiles/masterSeed/yearIndex を渡すと、更改後の球団payrollが team.finance.budget を
 * 超える球団について、非プロテクト選手のうち salary 上位から economy.maxBudgetCutsPerTeam 人までを
 * 「戦力外候補ルート」へ合流させる budgetCuts を返す（呼び出し側が runReleaseAndPickup の
 * forcedCuts へ渡し、同型循環の再分配に乗せる＝構成恒常を保ったまま予算超過を解消）。
 * profiles 省略（旧テスト呼び出し）は budgetCuts=[]＝既存挙動と bit 同一。
 * @returns {{count:number, totalSalary:number, budgetCuts:Array<{teamId,player,cutVal}>}}
 */
export function runContractRenewal(league, cfg, { obs, profiles = null, masterSeed, yearIndex }) {
  const fa = cfg.tuning.market.fa;
  const eco = cfg.tuning.economy;
  let total = 0;
  let count = 0;
  const byTeam = new Map();
  for (const p of league.players) {
    if (p.rosterStatus !== 'active') continue;
    const v = observedValueOf(p, obs, cfg);
    const salary = salaryFromValue(v, cfg);
    const years = p.age >= fa.longContractAge ? Math.max(1, fa.maxYears - 1) : Math.min(fa.maxYears, 2 + Math.floor(salary / 2000));
    p.contract = { salary, years };
    total += salary;
    count++;
    if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
    byTeam.get(p.teamId).push(p);
  }

  // H5-A: 予算超過球団 → 非プロテクトの高salary選手を戦力外候補ルートへ（呼び出し側が redistribute）。
  const budgetCuts = [];
  if (profiles) {
    for (const t of league.teams) {
      const roster = byTeam.get(t.id) ?? [];
      const budget = t.finance?.budget ?? Infinity;
      const payroll = roster.reduce((s, p) => s + p.contract.salary, 0);
      if (payroll <= budget) continue;
      const protect = protectSet(t.id, roster, profiles, cfg, eco.protectCount, masterSeed, yearIndex);
      const nonProt = roster
        .filter((p) => !protect.has(p.id))
        .sort((a, b) => b.contract.salary - a.contract.salary || byId(a, b));
      for (const p of nonProt.slice(0, eco.maxBudgetCutsPerTeam)) {
        budgetCuts.push({ teamId: t.id, player: p, cutVal: p.contract.salary });
      }
    }
  }
  return { count, totalSalary: total, budgetCuts };
}

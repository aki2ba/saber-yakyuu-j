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
import { generateRookie, applyEraToRookie, drawUniqueName, surnameCountsOf } from '../generate.mjs';
import { applyAging } from './aging.mjs';
import { observedWoba } from '../sim/manager.mjs';
import { uzrRuns, totalFieldInnings } from '../sim/fielding.mjs';
import { playerBaserunning } from '../sim/metrics.mjs';
import { deriveLeagueConstants } from '../sim/leagueConstants.mjs';
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
    // R7（決定5）: 救援過大評価の重み（多くが>1＝過大評価。稀に≈1の球団が救援に金をかけず勝つ）。
    wReliever: clamp(r.normal(pc.wRelieverMean, pc.wRelieverSd), pc.wRelieverMin, pc.wRelieverMax),
  };
}

/**
 * 観測ツール = 真値 + 球団固有スカウトノイズ（ctx 無し or noiseSd=0 なら真値そのまま＝テスト用）。
 * export: H2 draftScoutView が「トレード/評価と同じ観測座標」でスカウト表示用のツールも引くために使う
 * （真値そのものは渡らない・呼び出し側は trueVal をここでしか使わない＝表示にも trueAbility を直接出さない）。
 */
export function obsTool(trueVal, profile, ctx, tool, pid) {
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
    // R7（決定5）: 救援シェイプ（低スタミナ）の stuff/velo を球団が過大評価する癖（wReliever）。
    //   実際の勝利貢献はスタミナに比例して薄い（R²=0.051）のに、市場は「電光石火の球威」に
    //   引かれて過大な値を付ける＝救援を軽視する球団(wReliever≈1)が安く勝てる構造の土台。
    const shape = clamp(
      (m.relieverShapeFull - stam) / Math.max(1, m.relieverShapeFull - m.relieverShapeStamina),
      0,
      1,
    );
    const reliefBonus = shape * Math.max(0, (velo + stuff) / 2 - 50) * m.relieverOvervalueW * ((profile.wReliever ?? 1) - 1);
    return profile.wBat * (velo + ctrl + stam + stuff) - ageK + reliefBonus;
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

/**
 * R7（決定3）: 球団の「優勝の窓」を teamHistory だけから純関数で導出する（新規の永続状態は
 * 持たない＝save/loadに一切手を入れない）。SABR BRJ 2018（Jordan）の実測に整合させる:
 *   - contending: 直近年の勝率が contendWinPct 以上
 *   - rebuilding: 直近 lookbackYears 年が**すべて**非contending（＝2年連続で初めて閉じる時間的
 *     ヒステリシス。1年の不振だけでは閉じない）
 *   - neutral: 上記どちらでもない（履歴不足・混在シグナル）
 * @param {string} teamId
 * @param {Array<{year:number, standings:Array}>} teamHistory 完了年の順位（新しい順である必要はない）
 * @returns {'contending'|'neutral'|'rebuilding'}
 */
export function teamWindowState(teamId, teamHistory, cfg) {
  const wc = cfg.tuning.market.window;
  const winPct = (s) => { const d = (s.w ?? 0) + (s.l ?? 0); return d ? s.w / d : 0.5; };
  const rows = (teamHistory ?? [])
    .slice()
    .sort((a, b) => b.year - a.year)
    .map((h) => h.standings?.find((s) => s.teamId === teamId))
    .filter(Boolean)
    .slice(0, wc.lookbackYears);
  if (!rows.length) return 'neutral';
  if (winPct(rows[0]) >= wc.contendWinPct) return 'contending';
  if (rows.length >= wc.lookbackYears && rows.every((s) => winPct(s) < wc.contendWinPct)) return 'rebuilding';
  return 'neutral';
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
function generatePool(vacancies, cfg, { draftSeed, yearIndex, debutYear, era = null, usedNames = null }) {
  const mk = cfg.tuning.market;
  const byType = new Map();
  for (const v of vacancies) {
    const tk = `${v.role}:${v.primaryPos}`;
    if (!byType.has(tk)) byType.set(tk, { role: v.role, primaryPos: v.primaryPos, count: 0 });
    byType.get(tk).count++;
  }
  // 選手アイデンティティ: 新人の名前を世界の既出名（引退者含む台帳）と衝突しないよう抽選する。
  //   used はローカルコピー＝プール生成は league を書き換えない（H2の「プールはシードから毎回
  //   再生成して再開する」replay 決定論を維持。台帳への追記は draft 確定後の marketStage2）。
  const nameRng = makeRng(hashSeed(draftSeed, 'names'));
  const used = new Set(usedNames ?? []);
  const sur = surnameCountsOf(used);
  const pool = new Map();
  let gi = 0;
  for (const [tk, info] of byType) {
    const n = info.count + mk.surplusPerType;
    const arr = [];
    for (let i = 0; i < n; i++) {
      const id = `D${yearIndex}n${gi++}`;
      const name = drawUniqueName(nameRng, used, sur, {
        role: info.role,
        primaryPos: info.role === 'fielder' ? info.primaryPos : null,
      });
      // 出自（高卒/大卒/社会人＝ドラフト時年齢）も名前キー＝その人固有（どの世界でも同じ年齢で指名される）。
      const age = pickCohortAge(makeRng(hashSeed('togen-id-cohort', name)), mk.cohort);
      // era（時代トレンド・D3）: 世代の波・球速の経年上昇を新人生成時に反映（王朝均衡 boost は draft 後）。
      // R2: cfg を渡して applyMaturity を効かせる（新人＝年齢に応じた未成熟。旧実装は新人が
      //   いきなりリーグ平均能力を持ち、高卒18歳が即戦力レギュラーになっていた）。
      const p = generateRookie(draftSeed, id, { role: info.role, primaryPos: info.primaryPos, ageMin: age, ageMax: age, debutYear, era, cfg, name });
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
 *
 * H2（プレイヤー参加型ドラフト）: playerTeamId を渡すと、その球団の指名だけ bestFor（AI自動）を
 * 使わず pickLog（marketInterventions の phase:'draft' エントリ・提出順）から消費する。
 * pickLog が尽きた時点（＝プレイヤーがまだ選んでいない）で **即座に一時停止**し
 * `{paused:true, awaitingDraft}` を返す（AI11球団のロジックは一切変えない）。
 * 呼び出し側（src/game/index.mjs driveOffseasonDraft）は、プールを毎回シードから再生成し、
 * ここまでに確定した pickLog を渡して本関数を最初から再実行することで「再開」する
 * （決定論・pool の保存は不要。load-replay は蓄積済みログをそのまま渡すため一切 pause しない）。
 * playerTeamId が null（既定）なら旧来どおり完全自動＝既存呼び出し元と byte 同一。
 * @returns {{rookies:Array, undrafted:Array, draftLog:Object}|{paused:true, awaitingDraft:Object}}
 */
export function runDraft(vacancies, pool, profiles, order, cfg, { masterSeed, yearIndex, windowByTeam = null, playerTeamId = null, pickLog = [] }) {
  const teamVac = new Map(); // teamId → [{role,primaryPos}]（残り空き枠のキュー）
  for (const t of order) teamVac.set(t, []);
  for (const v of vacancies) {
    if (!teamVac.has(v.teamId)) teamVac.set(v.teamId, []);
    teamVac.get(v.teamId).push({ role: v.role, primaryPos: v.primaryPos });
  }
  const available = new Map(); // typeKey → prospect[]（獲得で減る）
  for (const [k, arr] of pool) available.set(k, arr.slice());
  // 全プロスペクト（獲得済みも含む・id→prospect）。H2会議室の「指名済みボード」表示用
  // （公開情報の名前/役割/守備位置/年齢のみを picksSoFar に付す＝trueAbility は含めない）。
  const allProspects = new Map();
  for (const arr of pool.values()) for (const pr of arr) allProspects.set(pr.id, pr);
  const rookies = [];
  const draftLog = { order: order.slice(), picks: [], lotteries: [] };
  const wc = cfg.tuning.market.window;
  const mk = cfg.tuning.market;
  let pickIdx = 0; // pickLog の消費カーソル（自チームの番が来るたび1つずつ進む）

  // R7（決定3）: 窓状態に応じた指名の傾き（即戦力=大社 vs 素材=高卒）。三層構造は崩さない
  //   （trueAbility 非参照・年齢は公開情報）。窓を持たない旧テスト呼び出し（windowByTeam無し）は
  //   ボーナス0＝既存挙動と bit 同一。
  const draftWindowBonus = (teamId, pr) => {
    if (!windowByTeam) return 0;
    const w = windowByTeam.get(teamId);
    if (w === 'contending' && pr.age >= mk.cohort.colAge) return wc.draftBonus;
    if (w === 'rebuilding' && pr.age <= mk.cohort.hsAge) return wc.draftBonus;
    return 0;
  };

  // 球団の「残り空き枠の型のうち、自評価が最高の available prospect」を返す（AI専用）。
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
        const val = evaluateProspect(profile, pr, cfg, { masterSeed, yearIndex, teamId }) + draftWindowBonus(teamId, pr);
        if (val > bestVal || (val === bestVal && (best === null || pr.id < best.id))) {
          bestVal = val;
          best = pr;
          bestType = tk;
        }
      }
    }
    return best ? { prospect: best, typeKey: bestType } : null;
  };

  /** teamId の残り空き枠のいずれかの型に available な prospect が1人でもいるか（AI/自チーム共通の存在確認）。 */
  const hasCandidate = (teamId) => {
    const vac = teamVac.get(teamId);
    if (!vac || !vac.length) return false;
    for (const v of vac) if ((available.get(`${v.role}:${v.primaryPos}`) || []).length) return true;
    return false;
  };

  /** 自チームが指名する prospectId を、残り空き枠の型に限定して available から探す（H2・介入ログの解決）。 */
  const resolvePick = (teamId, prospectId) => {
    const vac = teamVac.get(teamId);
    if (!vac) return null;
    const types = new Set(vac.map((v) => `${v.role}:${v.primaryPos}`));
    for (const tk of types) {
      const arr = available.get(tk) || [];
      const idx = arr.findIndex((p) => p.id === prospectId);
      if (idx >= 0) return { prospect: arr[idx], typeKey: tk };
    }
    return null;
  };

  /** 中断ペイロード（H2・src/ui/draft.mjs の会議室画面が表示する現在の状態）。 */
  const buildAwaitingDraft = (round, contested) => {
    const vac = teamVac.get(playerTeamId) || [];
    const poolNow = [];
    for (const arr of available.values()) poolNow.push(...arr);
    poolNow.sort(byId);
    return {
      round,
      contested,
      teamId: playerTeamId,
      vacTypes: vac.map((v) => ({ role: v.role, primaryPos: v.primaryPos })),
      order: order.slice(),
      // 指名済みボード（公開情報のみ denormalize: 名前/役割/守備位置/年齢。trueAbility は含めない）。
      picksSoFar: draftLog.picks.map((pk) => {
        const pr = allProspects.get(pk.prospectId);
        return { ...pk, name: pr?.name ?? null, role: pr?.role ?? null, primaryPos: pr?.primaryPos ?? null, age: pr?.age ?? null };
      }),
      lotteries: draftLog.lotteries.slice(),
      pool: poolNow,
    };
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
  let r1Renom = false; // 自チームが同ラウンド内で2回目以降の指名（＝前回くじ敗退）か
  while (pendingR1.size) {
    if (playerTeamId && pendingR1.has(playerTeamId) && hasCandidate(playerTeamId) && !pickLog[pickIdx]) {
      return { paused: true, awaitingDraft: buildAwaitingDraft(1, r1Renom) };
    }
    const noms = new Map(); // prospectId → {prospect, byTeam:Map<teamId,typeKey>}
    for (const teamId of order) {
      if (!pendingR1.has(teamId)) continue;
      if (teamId === playerTeamId) {
        if (!hasCandidate(teamId)) { pendingR1.delete(teamId); continue; }
        const entry = pickLog[pickIdx++];
        if (!entry || entry.round !== 1) throw new Error(`runDraft: round1の介入ログが不正（${JSON.stringify(entry)}）`);
        const picked = resolvePick(teamId, entry.prospectId);
        if (!picked) throw new Error(`runDraft: 介入ログの指名 ${entry.prospectId} が無効（round1・入手不可/型不一致）`);
        if (!noms.has(picked.prospect.id)) noms.set(picked.prospect.id, { prospect: picked.prospect, byTeam: new Map() });
        noms.get(picked.prospect.id).byTeam.set(teamId, picked.typeKey);
        continue;
      }
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
    r1Renom = playerTeamId ? pendingR1.has(playerTeamId) : false; // 敗退で残っていれば次回は再指名
  }

  // --- Round2+: ウェーバー順（弱い順）に残り枠を埋める ---
  for (let round = 2; round <= 200; round++) {
    let progress = false;
    for (const teamId of order) {
      if (!(teamVac.get(teamId) || []).length) continue;
      if (teamId === playerTeamId) {
        if (!hasCandidate(teamId)) continue;
        const entry = pickLog[pickIdx];
        if (!entry) return { paused: true, awaitingDraft: buildAwaitingDraft(round, false) };
        if (entry.round !== round) throw new Error(`runDraft: round${round}の介入ログが不正（${JSON.stringify(entry)}）`);
        pickIdx++;
        const picked = resolvePick(teamId, entry.prospectId);
        if (!picked) throw new Error(`runDraft: 介入ログの指名 ${entry.prospectId} が無効（round${round}・入手不可/型不一致）`);
        assign(teamId, picked.prospect, picked.typeKey, { round, via: 'waiver', contested: false });
        progress = true;
        continue;
      }
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
export function farmPerfBonus(d, obs, cfg, farmLc = null) {
  if (!obs) return 0;
  const f = cfg.tuning.market.farm;
  if (d.role === 'fielder') {
    const b = obs.batting;
    if (!b || !(b.pa > 0)) return 0;
    const trust = b.pa / (b.pa + f.promotePerfTrustPA);
    let v = f.promoteWobaW * (observedWoba(b, cfg) - cfg.tuning.mgr.wobaPrior) * trust;
    // ★R4: 二軍の守備(UZR)・走塁(BsR)の観測も昇格査定に入れる（旧実装は打撃だけを見ていた）。
    //   farmLc（二軍のリーグ定数）が渡された場合のみ作動（旧構成/二軍不成立では 0＝従来と同一）。
    if (farmLc && obs.fielding) {
      const inn = totalFieldInnings(obs.fielding);
      const uzr = inn > 0 ? uzrRuns(obs, cfg, farmLc) : 0;
      const bsr = playerBaserunning(obs, cfg, farmLc).bsr || 0;
      const dTrust = inn / (inn + f.promoteDefTrustInnings);
      v += f.promoteDefW * (uzr * dTrust + bsr);
    }
    return v;
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
 * 編成市場の前半（H2・runMarket のステップ1-2＋ドラフト準備）: 「育成昇格 → プール生成」まで。
 *   1. 育成枠を加齢（発達）させる
 *   2. 昇格判定: 育成の観測成績が閾値超 かつ 自球団に同型の空き枠あり → 支配下登録（稀・§12.1）
 * ドラフト本体（runDraft）は呼ばない＝プレイヤー参加型ドラフト（H2）が指名の合間に中断できるよう、
 * ここで止めて {remainingVac, pool, order, profiles, windowByTeam} を呼び出し側へ渡す。
 * league.players には promoted を足さない（呼び出し側が rookies と合わせて一括で足す＝既存 runMarket
 * と同じタイミング）。league.farm は in-place 更新（stillFarm）。
 * @returns {{promoted:Array, promotions:Array, remainingVac:Array, pool:Map, order:Array, profiles:Map, windowByTeam:?Map}}
 */
export function marketStage1(league, cfg, { vacancies, standings, masterSeed, yearIndex, debutYear, era = null, farmObs = null, teamHistory = null }) {
  const mk = cfg.tuning.market;
  if (!league.farm) league.farm = [];
  const profiles = new Map();
  for (const t of league.teams) profiles.set(t.id, teamEvalProfile(masterSeed, t.id, cfg));
  // R7（決定3）: 窓状態は teamHistory だけから毎年純関数で導出（新規の永続状態を持たない）。
  //   teamHistory 無し（旧テスト呼び出し）は null＝draftWindowBonus が常に0で既存挙動と bit 同一。
  const windowByTeam = teamHistory
    ? new Map(league.teams.map((t) => [t.id, teamWindowState(t.id, teamHistory, cfg)]))
    : null;

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
  // R4: 二軍のリーグ定数（当年の二軍観測から導出）。守備(UZR)・走塁(BsR)を得点換算して昇格査定に
  //   入れるために必要。farmObs が無い旧構成（二軍リーグ不成立）では null＝従来の判定と同一。
  const farmSeasons = farmObs ? [...farmObs.values()].filter((s) => s && s.fielding) : [];
  const farmLc = farmSeasons.length ? deriveLeagueConstants({ playerSeasons: farmSeasons, standings: [] }) : null;
  for (const d of league.farm.slice().sort(byId)) {
    const tk = `${d.role}:${d.primaryPos}`;
    const r = makeRng(hashSeed(masterSeed, 'promote', yearIndex, d.id));
    const observed =
      overallRating(d) + mk.farm.promoteObsBias + r.normal(0, mk.farm.promoteObsNoiseSd) +
      farmPerfBonus(d, farmObs ? farmObs.get(d.id) : null, cfg, farmLc);
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

  // ドラフトプール生成（era＝世代の波/球速上昇を反映・D3・§11.3）。ドラフト本体は呼ばない。
  // usedNames: 世界の名前台帳（無い旧セーブは現役+育成から即席再構築＝引退者ぶんだけ台帳が薄い後方互換）。
  const usedNames = league.usedNames ?? [...league.players, ...(league.farm ?? [])].map((p) => p.name);
  const pool = generatePool(remainingVac, cfg, { draftSeed: hashSeed(masterSeed, 'draft', yearIndex), yearIndex, debutYear, era, usedNames });
  const order = waiverOrder(standings, league);
  return { promoted, promotions, remainingVac, pool, order, profiles, windowByTeam };
}

/**
 * 編成市場の後半（H2・runMarket のステップ4-5）: ドラフト確定後の「育成獲得 → 剪定」。
 * 王朝均衡（balanceBoost）の適用もここで行う（draft 割当後＝team 確定後でないと適用できないため）。
 * league を in-place 更新する。戻り値なし。
 */
export function marketStage2(league, cfg, { undrafted, order, balanceBoost = null, rookies }) {
  // 選手アイデンティティ: この年のプール全員（指名済み＋漏れ）の名前を世界の台帳へ追記する。
  //   指名漏れの名前も記帳＝後年の新人が同名で再登場して「引退者/既出のドッペルゲンガー」になるのを防ぐ。
  //   ここ（draft確定後・1回だけ通る地点）で追記するので、H2 の「プール再生成 replay」とは干渉しない。
  if (league.usedNames) {
    const known = new Set(league.usedNames);
    for (const p of [...rookies, ...undrafted]) {
      if (!known.has(p.name)) {
        known.add(p.name);
        league.usedNames.push(p.name);
      }
    }
  }
  // 王朝均衡（D3・§11.3）: 弱い球団に割り当たった新人へ再分配 boost を反映（戦力の平均回帰＝振り子）。
  //   pool 生成時は team 未確定ゆえ draft 割当後に適用（決定論・boost は standings 由来の純算術）。
  if (balanceBoost && balanceBoost.size) {
    for (const p of rookies) {
      const b = balanceBoost.get(p.teamId) || 0;
      if (b) applyEraToRookie(p, null, b);
    }
  }
  // 育成獲得（ドラフト漏れ＝過小評価された surplus を安く箱へ）。剪定。
  signDevelopment(league, cfg, undrafted, order);
  pruneFarm(league, cfg);
}

/**
 * 編成市場の中核（C3a）。引退枠 vacancies を「育成昇格 → ドラフト → 育成獲得」で埋める。
 *   1. 育成枠を加齢（発達）させる
 *   2. 昇格判定: 育成の観測成績が閾値超 かつ 自球団に同型の空き枠あり → 支配下登録（稀・§12.1）
 *   3. ドラフト: 残り空き枠をウェーバー逆順×くじで埋める（§15）
 *   4. 育成獲得: ドラフト漏れ（過小評価 surplus）を育成枠へ（安く獲れる箱・§12.1）
 *   5. 剪定: 育成枠を有限に保つ
 * 決定論・構成恒常（promoted+rookies == vacancies）。league.farm を in-place で更新する。
 * H2: marketStage1 + runDraft（完全自動＝playerTeamId無し）+ marketStage2 の合成（byte 同一）。
 * プレイヤー参加型ドラフト（中断/再開）が要る場合は marketStage1/runDraft/marketStage2 を
 * 個別に呼ぶこと（src/game/index.mjs driveOffseasonDraft 参照）。
 * @returns {{promoted:Array, rookies:Array, draftLog:Object, promotions:Array}}
 */
export function runMarket(league, cfg, { vacancies, standings, masterSeed, yearIndex, debutYear, era = null, balanceBoost = null, farmObs = null, teamHistory = null }) {
  const s1 = marketStage1(league, cfg, { vacancies, standings, masterSeed, yearIndex, debutYear, era, farmObs, teamHistory });
  const { rookies, undrafted, draftLog } = runDraft(s1.remainingVac, s1.pool, s1.profiles, s1.order, cfg, { masterSeed, yearIndex, windowByTeam: s1.windowByTeam });
  marketStage2(league, cfg, { undrafted, order: s1.order, balanceBoost, rookies });
  return { promoted: s1.promoted, rookies, draftLog, promotions: s1.promotions };
}

// ============================================================================
// H2: プレイヤー参加型ドラフト会議 — スカウトレポート（draftScoutView）
//   真値(trueAbility)は絶対に参照しない。観測ツール(obsTool)・球団評価(evaluateProspect)・
//   公開情報(age)だけから「等級／ツール別5段階／伸びしろ／経歴タグ／世代内評判」を作る（§13三層構造）。
// ============================================================================

/** 経歴タグ（高卒/大卒/社会人）: 世代生成の年齢（公開情報・cohort と同じ年齢）から判定。 */
function cohortTag(age, cohort) {
  if (age <= cohort.hsAge) return '高卒';
  if (age <= cohort.colAge) return '大卒';
  return '社会人';
}

/** 分位点(0-1・大きいほど上位)→S/A/B/C/D。 */
function gradeFromPercentile(p, breaks) {
  if (p >= breaks.S) return 'S';
  if (p >= breaks.A) return 'A';
  if (p >= breaks.B) return 'B';
  if (p >= breaks.C) return 'C';
  return 'D';
}

/** 観測値(20-80相当)→1-5段階（breaksは昇順の3境界＝4段階の境目で計5段階）。 */
function toolLevel(v, breaks) {
  let lvl = 1;
  for (const b of breaks) if (v >= b) lvl++;
  return lvl;
}

/** vals内での x の分位点（0-1・x以下の割合＝大きいほど上位）。vals空なら1（安全側=最上位扱いしない用途では呼ばない）。 */
function percentileOf(x, vals) {
  if (!vals.length) return 1;
  let le = 0;
  for (const v of vals) if (v <= x) le++;
  return le / vals.length;
}

/** 全球団平均のプロスペクト評価（世代内評判の素・§13）。球団ごとの評価プロファイル＋観測ノイズ込み。 */
function consensusEval(state, prospect) {
  const cfg = state.cfg;
  const ctx0 = { masterSeed: state.masterSeed, yearIndex: state.yearIndex };
  let s = 0;
  for (const t of state.league.teams) {
    const prof = teamEvalProfile(state.masterSeed, t.id, cfg);
    s += evaluateProspect(prof, prospect, cfg, { ...ctx0, teamId: t.id });
  }
  return s / state.league.teams.length;
}

/**
 * H2: スカウトレポート。自球団 profile での evaluateProspect（ノイズ込み）をプールの分位点で
 * 相対化し、真値非参照の等級・ツール別評価・伸びしろ・経歴タグ・世代内評判にまとめる。
 * H3-1: personality だけは例外的に真値そのものを返す（trueAbility 内の能力レーティングとは異なり、
 * 「性格」は隠し能力ではなく表示用の個性タグ＝スカウトが直接観察できる設定・phaseH_fun_spec H3）。
 * @param {Object} state GameState（cfg/masterSeed/yearIndex/playerTeamId/league.teams を使う）
 * @param {Object} prospect スカウト対象（ドラフトプールの1人）
 * @param {Array} [pool] 比較母集団（省略時は state.awaitingDraft.pool。それも無ければ prospect 単体）
 * @returns {{grade:string, tools:Object, upside:string, cohort:string, hype:?string, myPercentile:number,
 *   consensusPercentile:number, personality:string|null}}
 */
export function draftScoutView(state, prospect, pool = null) {
  const cfg = state.cfg;
  const sr = cfg.tuning.market.scoutReport;
  const myProfile = teamEvalProfile(state.masterSeed, state.playerTeamId, cfg);
  const ctx = { masterSeed: state.masterSeed, yearIndex: state.yearIndex, teamId: state.playerTeamId };
  const comparisonPool = pool ?? (state.awaitingDraft && state.awaitingDraft.pool && state.awaitingDraft.pool.length ? state.awaitingDraft.pool : [prospect]);

  const myVal = evaluateProspect(myProfile, prospect, cfg, ctx);
  const poolVals = comparisonPool.map((p) => evaluateProspect(myProfile, p, cfg, ctx));
  const myPct = percentileOf(myVal, poolVals);
  const grade = gradeFromPercentile(myPct, sr.gradeBreaks);

  // ツール別5段階（evaluateProspect と同じハッシュ座標 'velo'/'control'/... で obsTool を引く＝一貫性）。
  const t = prospect.trueAbility;
  const id = prospect.id;
  let tools;
  if (prospect.role === 'pitcher') {
    const veloR = clamp(50 + (t.pitching.velocityKmh - 145) * 2, 20, 80);
    tools = {
      velo: toolLevel(obsTool(veloR, myProfile, ctx, 'velo', id), sr.toolBreaks),
      control: toolLevel(obsTool(t.pitching.control, myProfile, ctx, 'control', id), sr.toolBreaks),
      stamina: toolLevel(obsTool(t.pitching.stamina, myProfile, ctx, 'stamina', id), sr.toolBreaks),
      stuff: toolLevel(obsTool(pitchStuff(t), myProfile, ctx, 'stuff', id), sr.toolBreaks),
    };
  } else {
    tools = {
      contact: toolLevel(obsTool(t.batting.contact, myProfile, ctx, 'contact', id), sr.toolBreaks),
      power: toolLevel(obsTool(t.common.power, myProfile, ctx, 'power', id), sr.toolBreaks),
      speed: toolLevel(obsTool(t.common.speed, myProfile, ctx, 'speed', id), sr.toolBreaks),
      defense: toolLevel(obsTool(t.fielding.positionProf[prospect.primaryPos] ?? 20, myProfile, ctx, 'prof', id), sr.toolBreaks),
      arm: toolLevel(obsTool(t.common.arm, myProfile, ctx, 'arm', id), sr.toolBreaks),
    };
  }

  // 伸びしろ: 公開年齢と「典型的なピーク年齢」（config定数。個体の真の career.peakAge は不参照）の
  //   差＋スカウトノイズで3段階（大器/並/完成品）。実在のスカウティングと同じ「若さ＝伸びしろ」の代理。
  const gapRng = makeRng(hashSeed(state.masterSeed, 'scoutupside', state.yearIndex, state.playerTeamId, id));
  const gap = (sr.referencePeakAge - prospect.age) + gapRng.normal(0, sr.upsideNoiseSd);
  const upside = gap >= sr.upsideBigThreshold ? '大器' : gap <= sr.upsideDoneThreshold ? '完成品' : '並';

  // 経歴タグ（公開の年齢のみから判定）。
  const cohort = cohortTag(prospect.age, cfg.tuning.market.cohort);

  // 世代内評判: 全球団平均評価（consensus）のプール内分位点。目玉＝consensus上位。
  //   隠し玉＝自球団評価の分位がconsensus分位を大きく上回る（他球団が見落としている＝市場の非効率が発現）。
  const consensusVals = comparisonPool.map((p) => consensusEval(state, p));
  const myConsensusPct = percentileOf(consensusEval(state, prospect), consensusVals);
  let hype = null;
  if (myConsensusPct >= sr.hypeTopPct) hype = '目玉';
  else if (myPct - myConsensusPct >= sr.hiddenGemGapPct) hype = '隠し玉';

  // H3-1: 性格タグはスカウトが直接観察できる設定（真値ではなく表示用の個性・phaseH_fun_spec H3）。
  return { grade, tools, upside, cohort, hype, myPercentile: myPct, consensusPercentile: myConsensusPct, personality: prospect.personality ?? null };
}

/**
 * H2: ドラフト前ニュース「今年の目玉」（世代トップ数名を報道）。全球団平均評価(consensus)の
 * 降順で上位 previewCount 人を返す（真値非参照＝draftScoutView と同じ evaluateProspect ベース）。
 * state.awaitingDraft.pool が無ければ空配列（ドラフト会議室が開いていない）。
 * @returns {Array<{prospectId, role, primaryPos, age, cohort}>}
 */
export function draftPreviewHeadlines(state) {
  const aw = state.awaitingDraft;
  if (!aw || !aw.pool || !aw.pool.length) return [];
  const cfg = state.cfg;
  const sr = cfg.tuning.market.scoutReport;
  const ranked = aw.pool
    .map((p) => ({ p, consensus: consensusEval(state, p) }))
    .sort((a, b) => b.consensus - a.consensus || (a.p.id < b.p.id ? -1 : 1));
  return ranked.slice(0, sr.previewCount).map(({ p }) => ({
    prospectId: p.id, role: p.role, primaryPos: p.primaryPos, age: p.age,
    cohort: cohortTag(p.age, cfg.tuning.market.cohort),
  }));
}

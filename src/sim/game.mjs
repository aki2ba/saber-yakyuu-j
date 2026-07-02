// ============================================================================
// 試合状態機械（1-4c/e → フェーズA S2 でベンチ・采配・投手打席を導入）
//
// 打席は 1-1(規律層)→1-2/1-3(打球)で解決。走者は簡易進塁ルールで動かす（UBRの精緻化は2-5）。
// S2: initSide v2（当日スタメン/ベンチ/ブルペン可用リスト・lineupSlots・再出場不可）、
//     DH無し試合（9番=投手・投手交代で同スロット・投手への代打）、
//     代打/代走/守備固め、犠打、敬遠、盗塁の采配ゲート、役割ベース継投v2。
// 采配の判断ロジックは src/sim/manager.mjs に集約（本ファイルは状態遷移と記録に徹する。
// フェーズCで人間の采配に差し替えるフック＝判断関数の入替だけで済む構造）。
// 個人R(得点者)は保留、チーム得点(RS/RA)と投手失点のみ計上（§18・自己レビューF6）。
// ============================================================================
import { resolvePADiscipline } from './plateAppearance.mjs';
import { generateBattedBall } from './battedBall.mjs';
import { resolveBattedBall, battedType } from './battedBallResult.mjs';
import { rangeRating } from './fielding.mjs';
import { selectPitch } from './pitchGrid.mjs';
import { logit, expit, ratingDelta } from './rates.mjs';
import { pitchClass } from '../model/positions.mjs';
import { clamp } from '../model/util.mjs';
import {
  neutralManager,
  buildPregameEval,
  availableRelievers,
  observedWoba,
  stealLogitAdjust,
  buntAttemptProb,
  ibbProb,
  choosePinchHitter,
  choosePinchRunner,
  chooseDefensiveSub,
  chooseReliever,
  starterPitchLimit,
} from './manager.mjs';

const MAX_INNINGS = 12; // NPB延長規定（超えたら引分）

/**
 * 走者を進める。bases=[1B,2B,3B]（playerId or null）。得点数を返し bases を破壊的更新。
 * @param {boolean} isAirOut アウトが空中打球（犠飛判定用）
 */
export function advanceRunners(bases, result, batterId, isAirOut, outs, rng, cfg, ctx) {
  let runs = 0;
  const b1 = bases[0];
  const b2 = bases[1];
  const b3 = bases[2];

  if (result === 'BB' || result === 'HBP' || result === 'E') {
    // 押し出し（フォース）のみ。失策(E)も batter は一塁到達＝フォース進塁で近似
    if (b1) {
      if (b2) {
        if (b3) runs++; // 満塁押し出し
        bases[2] = b2;
      } else {
        bases[2] = b3; // 二塁が空なら三塁走者は残る
      }
      bases[1] = b1;
    } else {
      bases[1] = b2;
      bases[2] = b3;
    }
    bases[0] = batterId;
    return runs;
  }

  if (result === 'out') {
    // 犠飛: 空中アウト・2アウト未満・三塁走者 → 生還
    if (isAirOut && outs < 2 && b3) {
      runs++;
      bases[2] = null;
    }
    return runs; // それ以外は走者そのまま（併殺/進塁打は wGDP/UBR で後日）
  }

  if (result === '1B') {
    const nb = [null, null, null];
    if (b3) runs++; // 三塁は生還
    if (b2) {
      // 二塁走者の生還（走者Speed/IQ依存＝UBR, 2-5）
      if (resolveAdv(b2, cfg ? cfg.tuning.bb.singleScore2 : 0.55, ctx, cfg, rng)) runs++;
      else nb[2] = b2; // 三塁止まり
    }
    if (b1) nb[1] = b1; // 一塁→二塁（station to station）
    nb[0] = batterId; // 打者→一塁
    bases[0] = nb[0];
    bases[1] = nb[1];
    bases[2] = nb[2];
    return runs;
  }
  if (result === '2B') {
    const nb = [null, null, null];
    if (b3) runs++;
    if (b2) runs++;
    if (b1) {
      if (resolveAdv(b1, cfg ? cfg.tuning.bb.doubleScore1 : 0.45, ctx, cfg, rng)) runs++; // 一塁→生還
      else nb[2] = b1; // 三塁止まり
    }
    nb[1] = batterId; // 打者→二塁
    bases[0] = nb[0];
    bases[1] = nb[1];
    bases[2] = nb[2];
    return runs;
  }
  if (result === '3B') {
    if (b1) runs++;
    if (b2) runs++;
    if (b3) runs++;
    bases[0] = null;
    bases[1] = null;
    bases[2] = batterId;
    return runs;
  }
  if (result === 'HR') {
    if (b1) runs++;
    if (b2) runs++;
    if (b3) runs++;
    runs++; // 打者
    bases[0] = bases[1] = bases[2] = null;
    return runs;
  }
  return runs;
}

/**
 * 追加進塁（生還）の判定（§6 UBR, 2-5）。走者Speed/走塁IQで基準確率を上下し、
 * ctx があれば進塁機会(advOpp)と成否(advTaken)を走者に記録する。ctxなし=能力非依存（テスト互換）。
 */
function resolveAdv(pid, baseProb, ctx, cfg, rng) {
  let p = baseProb;
  if (ctx) {
    const t = ctx.byId.get(pid).trueAbility;
    const tool = (t.common.speed + t.baserunning.baserunIQ) / 2;
    p = clamp(baseProb + (tool - 50) * cfg.tuning.run.ubrSlope, 0.05, 0.95);
    const bs = ctx.statFor(pid, ctx.teamId).baserunning;
    bs.advOpp++;
    const took = (rng ? rng.next() : 1) < p;
    if (took) bs.advTaken++;
    return took;
  }
  return (rng ? rng.next() : 1) < baseProb;
}

/** 投球数の近似（除去判定用） */
function pitchesFor(outcome) {
  if (outcome === 'K') return 4.8;
  if (outcome === 'BB') return 5.2;
  if (outcome === 'HBP') return 3.5;
  return 3.6;
}

function baseBits(bases) {
  return (bases[0] ? 1 : 0) | (bases[1] ? 2 : 0) | (bases[2] ? 4 : 0);
}

/**
 * 盗塁の試行・成否（§6 wSB）。走者Steal/Speed × 投手Hold × 捕手Arm。outs を返す。
 * S2: 監督stealTend×状況の采配ゲート（大差では走らない・2死×強打者では自重）を乗せる。
 */
function attemptSteal(batting, fielding, bases, outs, statFor, cfg, rng) {
  if (!bases[0] || bases[1]) return outs; // 一塁走者かつ二塁が空いている時のみ
  const runner = batting.byId.get(bases[0]);
  const s = cfg.tuning.steal;
  const br = runner.trueAbility.baserunning;
  const sp = runner.trueAbility.common.speed;

  // 采配ゲート（§S2-6）: 打者の強弱は観測wOBA（三層構造: 真値は見ない）
  const batterId = batting.slots[batting.orderIdx].playerId;
  const situ = {
    scoreDiff: batting.score - fielding.score,
    outs,
    batterWoba: observedWoba(statFor(batterId, batting.teamId).batting, cfg),
  };

  // 試行判断: 走者のSteal/Speedが高いほど走る × 監督ゲート
  const aggr = expit(
    logit(s.attemptBase) +
      ratingDelta(br.steal, s.attemptSlope) +
      ratingDelta(sp, s.attemptSlope * 0.5) +
      stealLogitAdjust(batting.manager, situ, cfg),
  );
  if (rng.next() >= aggr) return outs;

  // 成功確率: 走者Steal/Speed↑、投手Hold↑・捕手Arm↑で↓
  const pitcher = fielding.byId.get(fielding.curPid);
  const catcher = fielding.byId.get(fielding.defense.C);
  const succ = expit(
    logit(s.successBase) +
      ratingDelta(br.steal, s.stealSlope) +
      ratingDelta(sp, s.stealSlope * 0.6) -
      ratingDelta(pitcher.trueAbility.pitching.hold, s.holdSlope) -
      ratingDelta(catcher ? catcher.trueAbility.common.arm : 50, s.armSlope),
  );

  const rStat = statFor(bases[0], batting.teamId);
  if (rng.next() < succ) {
    bases[1] = bases[0]; // 二塁へ
    bases[0] = null;
    rStat.batting.sb++;
  } else {
    bases[0] = null; // 盗塁死
    rStat.batting.cs++;
    // 盗塁死は投手在籍中の記録アウト＝投手IPに算入（監査A2: ΣpositionOuts==8·Σpitcher.outs を回復）。
    statFor(fielding.curPid, fielding.teamId).pitching.outs++;
    fielding.cur.outs++;
    return outs + 1;
  }
  return outs;
}

/**
 * 1試合をシミュレート。statFor(pid,teamId)=PlayerSeason を返す関数。
 * @param {Object} homeInit initSide v2 参照（旧 {teamId,depth,starterIdx} も後方互換で受ける）
 * @param {Function} [onBattedBall] (batterId, teamId, battedBall, result) スプレー収集用（任意）
 * @returns {{homeScore, awayScore, innings, tie, pitchers:{home,away}, subs:{home,away}}}
 *   pitchers: 投手使用ログ [{pid,pitches,outs,enterInning,enterDiff}]（S3疲労管理の素材）
 *   subs:     交代ログ [{type:'PH'|'PR'|'DEF'|'RP', inning, outPid, inPid}]
 */
export function simulateGame(homeInit, awayInit, cfg, rng, statFor, park, onBattedBall) {
  const home = initSide(homeInit, cfg);
  const away = initSide(awayInit, cfg);

  // 得点推移ログ（勝敗の正確な判定用）: 得点が入るたびに両軍のスコアと現投手を記録
  const runLog = [];
  const recordRun = () =>
    runLog.push({ homeScore: home.score, awayScore: away.score, homePid: home.curPid, awayPid: away.curPid });

  let inning = 1;
  while (true) {
    playHalf(away, home, cfg, rng, statFor, park, false, onBattedBall, recordRun, inning); // 表: away攻撃
    if (inning >= 9 && home.score > away.score) break; // 裏を省略（ホームリード）
    const bottomWalkoff = inning >= 9;
    playHalf(home, away, cfg, rng, statFor, park, bottomWalkoff, onBattedBall, recordRun, inning); // 裏: home攻撃
    if (inning >= 9 && home.score !== away.score) break;
    inning++;
    if (inning > MAX_INNINGS) break;
  }

  flushPitcher(home, away.score);
  flushPitcher(away, home.score);
  assignDecisions(home, away, statFor, runLog);

  const usage = (side) =>
    side.log.map((ap) => ({
      pid: ap.pid,
      pitches: Math.round(ap.pitches),
      outs: ap.outs,
      enterInning: ap.enterInning,
      enterDiff: ap.enterDiff,
    }));
  return {
    homeScore: home.score,
    awayScore: away.score,
    innings: inning,
    tie: home.score === away.score,
    pitchers: { home: usage(home), away: usage(away) }, // 投手使用ログ（S3の疲労管理素材）
    subs: { home: home.subs, away: away.subs },
  };
}

/**
 * サイド初期化 v2（§S2-1）。season から「今日のスタメン/ベンチ/ブルペン可用リスト/監督」を
 * 受ける。未指定フィールドは depth から既定生成（S3改修前の season でも動く後方互換）。
 * DH無し編成（9番 pos:'P' プレースホルダ）には当日先発を充填する。
 * @param {{teamId, depth, starterIdx, lineup?, starterPid?, bench?, availableRelievers?, manager?, dh?}} init
 */
function initSide(init, cfg) {
  const d = init.depth;
  const starterId = init.starterPid ?? d.rotation[init.starterIdx % d.rotation.length];
  // lineupSlots: 打順スロット→現在の選手。交代はスロット単位（一度退いた選手は再出場不可）
  const slots = (init.lineup ?? d.lineup).map((s) => ({ playerId: s.playerId, pos: s.pos }));
  const pitcherSlot = slots.findIndex((s) => s.pos === 'P'); // DH無し試合のみ >=0
  if (pitcherSlot >= 0) slots[pitcherSlot].playerId = starterId; // 9番=当日の先発
  const dhSlot = slots.findIndex((s) => s.pos === 'DH');
  const bullpen = (init.availableRelievers ?? d.bullpen).slice();
  const roles = d.bullpenRoles ?? {
    closer: bullpen[0] ?? null,
    setup8: bullpen[1] ?? null,
    setup7: bullpen[2] ?? null,
    middle: bullpen.slice(3, Math.max(3, bullpen.length - 1)),
    long: bullpen.length >= 4 ? bullpen[bullpen.length - 1] : null,
  };
  return {
    teamId: init.teamId,
    byId: d.byId,
    manager: init.manager ?? neutralManager(),
    slots,
    pitcherSlot,
    dhSlot, // 守備に就かないDH（守備位置補正=-17.5の主語）のスロット
    defense: { ...d.defense },
    orderIdx: 0,
    starterId,
    curPid: starterId,
    usedPitchers: new Set([starterId]),
    retired: new Set(), // 一度退いた選手（再出場不可・§S2-1）
    bench: (init.bench ?? d.bench).slice(), // 当日のベンチ（起用で減る）
    bullpen,
    roles, // ブルペン役割 closer/setup8/setup7/middle/long（継投v2）
    pendingPitcher: false, // 投手への代打→次の守備から新投手（§S2-2）
    pregame: buildPregameEval(d.byId, cfg), // 監督の当日メモ（編成時評価。以降trueAbilityは見ない）
    // enterDiff/enterInning: 登板時の投手側リード差と回（ホールド/BS判定・監査B3）
    cur: { pid: starterId, outs: 0, pitches: 0, runs: 0, bf: 0, enterDiff: 0, enterInning: 1 },
    log: [],
    subs: [], // 交代ログ {type,inning,outPid,inPid}（再出場不可の検証・S3素材）
    score: 0,
  };
}

function emptyCur() {
  return { pid: null, outs: 0, pitches: 0, runs: 0, bf: 0, enterDiff: 0, enterInning: 0 };
}

/** 半イニングを消化（batting=攻撃側, fielding=守備側） */
function playHalf(batting, fielding, cfg, rng, statFor, park, walkoff, onBattedBall, recordRun, inning) {
  // 守備側の投手整備: 投手への代打の後始末→回頭の役割ベース継投（§S2-2/§S2-7）
  halfStartPitching(fielding, batting.score, inning, statFor, cfg);
  // 守備固め（§S2-3: 8回以降・リード1-3・当日メモで優位時のみ）
  maybeDefensiveSub(fielding, batting.score, inning, cfg);

  const bases = [null, null, null];
  let outs = 0;
  let errorInInning = false; // 失策発生後の得点は非自責（§ERA整合）
  while (outs < 3) {
    // 盗塁機会（走者一塁・二塁空き）。§6 wSB×采配ゲート。PA解決の前に処理。
    outs = attemptSteal(batting, fielding, bases, outs, statFor, cfg, rng);
    if (outs >= 3) break;

    // 代打（§S2-3）: 打席に入る前に差し替える（判断は manager.mjs）
    maybePinchHit(batting, fielding, bases, inning, cfg, statFor);

    const batterId = batting.slots[batting.orderIdx].playerId;
    // 投手打席か（DH無し試合の9番スロット×現投手。代打後は該当しない）
    const batterIsPitcher = batting.orderIdx === batting.pitcherSlot && batterId === batting.curPid;
    const nextIdx = (batting.orderIdx + 1) % 9;
    const nextIsPitcher = nextIdx === batting.pitcherSlot && batting.slots[nextIdx].playerId === batting.curPid;
    batting.orderIdx = nextIdx;
    const batter = batting.byId.get(batterId);
    const pitcher = fielding.byId.get(fielding.curPid);

    const bStat = statFor(batterId, batting.teamId);
    const pStat = statFor(fielding.curPid, fielding.teamId);
    const batterWoba = observedWoba(bStat.batting, cfg); // 采配用の観測評価（真値は見ない）

    // 敬遠（§S2-5・守備側監督の判断）: PA解決の前に判断し、成立なら申告四球
    const pIBB = ibbProb(
      {
        manager: fielding.manager,
        bases,
        outs,
        inning,
        scoreDiff: fielding.score - batting.score,
        batterWoba,
        nextIsPitcher,
      },
      cfg,
    );
    const isIBB = pIBB > 0 && rng.next() < pIBB;

    // 犠打（§S2-4・攻撃側監督の判断）: PA解決の前に処理（敬遠時はなし）
    if (!isIBB) {
      const pBunt = buntAttemptProb(
        {
          manager: batting.manager,
          bases,
          outs,
          scoreDiff: batting.score - fielding.score,
          batterWoba,
          isPitcher: batterIsPitcher,
        },
        cfg,
      );
      if (pBunt > 0 && rng.next() < pBunt) {
        outs = resolveBunt(batting, fielding, bases, outs, cfg, rng, batterId, bStat, pStat);
        maybePinchRun(batting, fielding, bases, inning, cfg, statFor);
        if (outs < 3) maybeChangePitcher(fielding, statFor, batting.score, inning, cfg);
        continue;
      }
    }

    // 対戦巡目（この登板でこの投手が何度打線を通過したか。§3.3）
    const tto = Math.floor(fielding.cur.bf / 9);
    // 球種格子(§4段階1): この打席で投げる球種を1つ選ぶ（敬遠は勝負しない＝球種なし）
    const pitch = isIBB ? null : selectPitch(pitcher, rng, cfg);
    const outcome = isIBB ? 'BB' : resolvePADiscipline(batter, pitcher, cfg, rng, tto, pitch);
    const pc = isIBB ? cfg.tuning.ibb.pitches : pitchesFor(outcome);
    fielding.cur.pitches += pc;
    fielding.cur.bf++;
    pStat.pitching.pitches += Math.round(pc);
    pStat.pitching.bf++;
    bStat.batting.pa++;

    let result;
    let isAirOut = false;
    let bType = null;
    if (outcome === 'K') {
      result = 'out';
      bStat.batting.ab++;
      bStat.batting.so++;
      pStat.pitching.so++;
    } else if (outcome === 'BB') {
      result = 'BB';
      bStat.batting.bb++;
      pStat.pitching.bb++;
      if (isIBB) {
        bStat.batting.ibb++; // 敬遠はBBの部分集合（IBB⊆BB）
        pStat.pitching.ibb++;
      }
    } else if (outcome === 'HBP') {
      result = 'HBP';
      bStat.batting.hbp++;
      pStat.pitching.hbp++;
    } else {
      const bb = generateBattedBall(batter, pitcher, cfg, rng, { baseState: baseBits(bases), outs, tto, pitch });
      // 守備者個人のRangeを注入（2-7）: 担当ポジションの野手能力で被安打率を上下
      const r = resolveBattedBall(bb, cfg, rng, park, (pos) => {
        const fp = fielding.byId.get(fielding.defense[pos]);
        return fp ? rangeRating(fp, cfg) : 50;
      });
      result = r.result;
      bType = battedType(bb.laDeg);
      isAirOut = result === 'out' && bType !== 'GB';
      recordBattedBallStat(bStat, pStat, result);
      // 失策(ROE)判定: インプレーのアウトを Hands 依存で出塁に変える
      if (result === 'out') {
        const fPid = fielding.defense[r.fielderPos];
        const fielder = fielding.byId.get(fPid);
        const hands = fielder ? fielder.trueAbility.common.hands : 50;
        const pErr = clamp(cfg.tuning.bb.errBase - (hands - 50) * cfg.tuning.bb.errHandsW, 0.004, 0.06);
        if (rng.next() < pErr) {
          statFor(fPid, fielding.teamId).fielding.e++;
          errorInInning = true;
          result = 'E';
          isAirOut = false;
        }
      }
      // OAA累積: ポジション平均の期待アウトからの差分＝レンジ成分（§7.2）。
      // 失策前の r.result（アウト/安打）で判定＝OAAはリーグ平均0に中心化される。
      // 失策(Hands)は別成分（fielding.e→UZRで別途）として扱い、二重計上しない。
      const fielderPid = fielding.defense[r.fielderPos];
      if (fielderPid) {
        const actual = r.result === 'out' ? 1 : 0; // 失策前の判定: アウト=1, 安打=0
        statFor(fielderPid, fielding.teamId).fielding.oaaOuts += actual - r.expOut;
      }
      // スプレー収集（1-8, 任意）
      if (onBattedBall) onBattedBall(batterId, batting.teamId, bb, result);
    }

    // 対球種スプリット記録（§4段階1: 対ストレート成績等の素）
    if (pitch) {
      const sl = pitchClass(pitch.type) === 'fastball' ? bStat.batting.vsFastball : bStat.batting.vsBreaking;
      sl.pa++;
      if (outcome === 'BB') sl.bb++;
      else if (outcome !== 'HBP') {
        sl.ab++;
        if (outcome === 'K') sl.so++;
        else if (result === '1B' || result === '2B' || result === '3B' || result === 'HR') {
          sl.h++;
          if (result === 'HR') sl.hr++;
        }
      }
    }

    const ubrCtx = { byId: batting.byId, statFor, teamId: batting.teamId };
    const runs = advanceRunners(bases, result, batterId, isAirOut, outs, rng, cfg, ubrCtx);

    if (result === 'out') {
      if (isAirOut && runs > 0) {
        // 犠飛: ABを取り消してSF計上
        bStat.batting.ab--;
        bStat.batting.sf++;
      }
      const outsBefore = outs;
      outs++;
      fielding.cur.outs++;
      pStat.pitching.outs++;
      // 併殺（GB・走者一塁・2アウト未満）§6 wGDP。打者の足で回避。
      if (bType === 'GB' && bases[0] && outsBefore < 2) {
        bStat.baserunning.gdpOpp++;
        const gp = clamp(
          cfg.tuning.gdp.base - (batter.trueAbility.common.speed - 50) * cfg.tuning.gdp.speedW,
          0.02,
          0.45,
        );
        if (rng.next() < gp) {
          bases[0] = null; // 一塁走者もアウト
          bStat.batting.gdp++;
          outs++;
          fielding.cur.outs++;
          pStat.pitching.outs++;
        }
      }
    }
    if (runs > 0) {
      batting.score += runs;
      if (result !== 'E') bStat.batting.rbi += runs; // 失策の得点は打点なし
      pStat.pitching.r += runs;
      pStat.pitching.er += errorInInning ? 0 : runs; // 失策以降は非自責
      fielding.cur.runs += runs;
      if (recordRun) recordRun(); // 得点推移を記録（勝敗判定用）
    }

    // 代走（§S2-3）: PA解決後、塁上の鈍足走者をベンチ最速と交代
    maybePinchRun(batting, fielding, bases, inning, cfg, statFor);

    // 継投（球数/失点による途中降板。回頭の交代は halfStartPitching が担う）
    if (outs < 3) maybeChangePitcher(fielding, statFor, batting.score, inning, cfg);

    if (walkoff && batting.score > fielding.score) break; // サヨナラ
  }

  // 守備イニング計上（守備側の8人に outs を加算）
  for (const pos of Object.keys(fielding.defense)) {
    statFor(fielding.defense[pos], fielding.teamId).fielding.positionOuts[pos] += outs;
  }
  // 捕手フレーミング（監査B5・§7.3）: 当該イニング分の (framing-50) をrun換算して framingRuns に加算。
  // 死蔵していた捕手フレーミング能力を守備価値としてWARに接続する。
  const cPid = fielding.defense.C;
  if (cPid) {
    const framing = fielding.byId.get(cPid).trueAbility.fielding.framing;
    statFor(cPid, fielding.teamId).fielding.framingRuns += (framing - 50) * cfg.tuning.field.framePerInning * (outs / 3);
  }
  // DHの出場イニング相当を計上（守備に就かないDHにも守備位置補正 -17.5/1350 を効かせる。
  // 攻撃側ハーフのアウト数＝そのイニング数分の在籍。§9・監査A1）。
  const dhPid = batting.dhSlot >= 0 ? batting.slots[batting.dhSlot].playerId : null;
  if (dhPid) {
    const dl = statFor(dhPid, batting.teamId).fielding.positionOuts;
    dl.DH = (dl.DH || 0) + outs;
  }
}

function recordBattedBallStat(bStat, pStat, result) {
  bStat.batting.ab++;
  if (result === 'out') return;
  bStat.batting.h++;
  pStat.pitching.h++;
  if (result === '1B') bStat.batting.b1++;
  else if (result === '2B') bStat.batting.b2++;
  else if (result === '3B') bStat.batting.b3++;
  else if (result === 'HR') {
    bStat.batting.hr++;
    pStat.pitching.hr++;
  }
}

// --- 交代の適用（判断は manager.mjs / ここでは状態遷移と記録のみ） -------------

function removeFromBench(side, pid) {
  const i = side.bench.indexOf(pid);
  if (i >= 0) side.bench.splice(i, 1);
}

/** 代打（§S2-3）。同スロットに入り、守備位置も引き継ぐ（守備イニング計上の整合）。 */
function maybePinchHit(batting, fielding, bases, inning, cfg, statFor) {
  const slot = batting.slots[batting.orderIdx];
  const batterId = slot.playerId;
  const isPitcher = batting.orderIdx === batting.pitcherSlot && batterId === batting.curPid;
  const pick = choosePinchHitter(
    {
      side: batting,
      oppScore: fielding.score,
      bases,
      inning,
      batterId,
      isPitcher,
      oppPitcher: fielding.byId.get(fielding.curPid),
    },
    cfg,
  );
  if (!pick) return;
  batting.retired.add(batterId); // 退いた打者は再出場不可
  slot.playerId = pick;
  removeFromBench(batting, pick);
  if (isPitcher) {
    // 投手への代打（§S2-2）: 現投手の登板を確定し「次の守備から新投手」を予約。
    // curPid は投手記録（勝敗の pitcher of record）として新投手が入るまで保持する。
    flushPitcher(batting, fielding.score);
    batting.cur = emptyCur();
    batting.pendingPitcher = true;
  } else if (slot.pos !== 'DH' && slot.pos !== 'P' && batting.defense[slot.pos] === batterId) {
    batting.defense[slot.pos] = pick; // 守備位置を引き継ぐ
  }
  statFor(pick, batting.teamId).batting.ph++; // 代打打席数（§S1-5の器を消費）
  batting.subs.push({ type: 'PH', inning, outPid: batterId, inPid: pick });
}

/** 代走（§S2-3）。塁上の鈍足走者をベンチ最速と交代し、打順スロット・守備位置を引き継ぐ。 */
function maybePinchRun(batting, fielding, bases, inning, cfg, statFor) {
  const pick = choosePinchRunner({ side: batting, oppScore: fielding.score, bases, inning }, cfg);
  if (!pick) return;
  const outPid = bases[pick.baseIdx];
  const slot = batting.slots.find((s) => s.playerId === outPid);
  if (!slot) return; // 想定外（走者が打順にいない）は安全側で見送り
  batting.retired.add(outPid);
  slot.playerId = pick.pid;
  removeFromBench(batting, pick.pid);
  if (slot.pos !== 'DH' && slot.pos !== 'P' && batting.defense[slot.pos] === outPid) {
    batting.defense[slot.pos] = pick.pid; // 守備位置を引き継ぐ
  }
  bases[pick.baseIdx] = pick.pid;
  batting.subs.push({ type: 'PR', inning, outPid, inPid: pick.pid });
}

/** 守備固め（§S2-3）。守備側ハーフ開始時に適用。 */
function maybeDefensiveSub(side, oppScore, inning, cfg) {
  const pick = chooseDefensiveSub({ side, oppScore, inning }, cfg);
  if (!pick) return;
  const outPid = side.defense[pick.pos];
  const slot = side.slots.find((s) => s.playerId === outPid);
  side.retired.add(outPid);
  side.defense[pick.pos] = pick.pid;
  if (slot) slot.playerId = pick.pid;
  removeFromBench(side, pick.pid);
  side.subs.push({ type: 'DEF', inning, outPid, inPid: pick.pid });
}

// --- 犠打の解決（§S2-4） -----------------------------------------------------

/**
 * 犠打を解決して新しい outs を返す。成功=走者進塁・打者アウト・sh++（ABなし・PAあり）、
 * 失敗=先頭走者アウト・打者一塁（AB計上）、内野安打=全員セーフ（AB・H計上）。
 * 走者三塁は試行条件で除外済み＝犠打から得点は発生しない。
 */
function resolveBunt(batting, fielding, bases, outs, cfg, rng, batterId, bStat, pStat) {
  const t = cfg.tuning.bunt;
  const pc = t.pitches;
  fielding.cur.pitches += pc;
  fielding.cur.bf++;
  pStat.pitching.pitches += Math.round(pc);
  pStat.pitching.bf++;
  bStat.batting.pa++;

  const u = rng.next();
  if (u < t.successProb) {
    // 成功: 先頭から順に1つ進塁・打者アウト
    if (bases[1] && !bases[2]) {
      bases[2] = bases[1];
      bases[1] = null;
    }
    if (bases[0] && !bases[1]) {
      bases[1] = bases[0];
      bases[0] = null;
    }
    bStat.batting.sh++; // 犠打はABに計上しない
    fielding.cur.outs++;
    pStat.pitching.outs++;
    return outs + 1;
  }
  if (u < t.successProb + t.failProb) {
    // 失敗: 先頭走者が封殺（フィールダースチョイス＝AB計上・安打なし）
    if (bases[1]) bases[1] = null;
    else bases[0] = null;
    if (bases[0] && !bases[1]) {
      bases[1] = bases[0];
      bases[0] = null;
    }
    bases[0] = batterId;
    bStat.batting.ab++;
    fielding.cur.outs++;
    pStat.pitching.outs++;
    return outs + 1;
  }
  // 内野安打: 全走者1つ進塁・打者一塁
  if (bases[1] && !bases[2]) {
    bases[2] = bases[1];
    bases[1] = null;
  }
  if (bases[0]) bases[1] = bases[0];
  bases[0] = batterId;
  bStat.batting.ab++;
  bStat.batting.h++;
  bStat.batting.b1++;
  pStat.pitching.h++;
  return outs;
}

// --- 継投v2（§S2-7。選択は manager.chooseReliever） ---------------------------

/** 新しい投手を入れる（打順スロット'P'があれば同スロットへ・§S2-2）。 */
function installPitcher(side, pid, inning, lead) {
  const outPid = side.pitcherSlot >= 0 ? side.slots[side.pitcherSlot].playerId : side.curPid;
  if (outPid != null && outPid !== pid) side.retired.add(outPid);
  side.subs.push({ type: 'RP', inning, outPid, inPid: pid });
  side.curPid = pid;
  side.usedPitchers.add(pid);
  if (side.pitcherSlot >= 0) side.slots[side.pitcherSlot].playerId = pid;
  side.cur = { pid, outs: 0, pitches: 0, runs: 0, bf: 0, enterDiff: lead, enterInning: inning };
}

/**
 * 守備側ハーフ開始時の投手整備。
 * (1) 投手への代打の後始末: 予約済みなら新投手を必ず入れる（§S2-2）。
 * (2) 回頭の継投判断: 球数/失点で降板、セーブ機会は役割（7=setup7/8=setup8/9+=closer）へ。
 *     好投中の先発は7-8回を任せ、9回は完封継続中のみ続投（完投・完封を残す）。
 */
function halfStartPitching(fielding, oppScore, inning, statFor, cfg) {
  const pen = cfg.tuning.pen;
  const lead = fielding.score - oppScore;

  if (fielding.pendingPitcher) {
    const next =
      chooseReliever(fielding, statFor, inning, lead, cfg) ??
      availableRelievers(fielding).find((pid) => pid !== fielding.roles.closer) ??
      availableRelievers(fielding)[0];
    if (next) installPitcher(fielding, next, inning, lead);
    fielding.pendingPitcher = false;
    return;
  }

  const c = fielding.cur;
  const isStarter = c.pid === fielding.starterId;
  const saveSitu = lead >= 1 && lead <= pen.saveLeadMax && inning >= pen.leverageMinInning;
  let change;
  if (isStarter) {
    const limit = starterPitchLimit(fielding.manager, fielding.byId.get(c.pid), cfg);
    const due =
      c.pitches >= limit || c.runs >= pen.starterMaxRuns || (c.outs >= pen.tiredOuts && c.runs >= pen.tiredRuns);
    if (saveSitu) {
      const stay =
        inning <= 8
          ? c.runs <= pen.starterStayRuns && c.pitches < limit
          : c.runs === 0 && c.outs >= pen.cgMinOuts && c.pitches < limit; // 完封中のエースのみ9回続投
      change = due || !stay;
    } else {
      change = due;
    }
  } else {
    const maxOuts = c.pid === fielding.roles.long ? pen.longOuts : pen.relieverMaxOuts;
    const due = c.outs >= maxOuts || c.runs >= pen.relieverMaxRuns;
    change = due || saveSitu; // セーブ機会は回頭で適役へ繋ぐ（8回setup8→9回closer等）
  }
  if (!change) return;
  const next = chooseReliever(fielding, statFor, inning, lead, cfg);
  if (!next || next === c.pid) return;
  flushPitcher(fielding, oppScore);
  installPitcher(fielding, next, inning, lead);
}

/** イニング途中の降板判定（球数・失点）。回頭の交代は halfStartPitching が担う。 */
function maybeChangePitcher(fielding, statFor, oppScore, inning, cfg) {
  const pen = cfg.tuning.pen;
  const c = fielding.cur;
  if (c.pid == null) return;
  const isStarter = c.pid === fielding.starterId;
  let remove;
  if (isStarter) {
    const limit = starterPitchLimit(fielding.manager, fielding.byId.get(c.pid), cfg);
    remove =
      c.pitches >= limit || c.runs >= pen.starterMaxRuns || (c.outs >= pen.tiredOuts && c.runs >= pen.tiredRuns);
  } else {
    const maxOuts = c.pid === fielding.roles.long ? pen.longOuts : pen.relieverMaxOuts;
    remove = c.outs >= maxOuts || c.runs >= pen.relieverMaxRuns;
  }
  if (!remove) return;

  const lead = fielding.score - oppScore;
  const next = chooseReliever(fielding, statFor, inning, lead, cfg);
  if (!next || next === c.pid) return;
  flushPitcher(fielding, oppScore);
  installPitcher(fielding, next, inning, lead);
}

/** 現投手のゲーム成績を log に確定（bf>0の実登板のみ・幽霊リリーフ除外）。
 *  exitDiff=退場時の投手側リード差（ホールド/ブローンセーブ判定用・監査B3）。 */
function flushPitcher(side, oppScore) {
  if (side.cur.bf > 0) {
    side.cur.exitDiff = side.score - (oppScore ?? side.score);
    side.log.push({ ...side.cur });
  }
}

/**
 * 勝敗・セーブ（決勝点＝go-ahead run ベース。§18の簡易判定を精緻化）。
 * - 決勝点 = 勝者が最後にリードを取り以降維持した得点。
 * - 負け投手 = その決勝点を許した投手（敗者側の当時の投手）。
 * - 勝ち投手 = 決勝点時の勝者側の投手（先発は5回以上、さもなくば最多アウト救援）。
 * これにより「同点で降板」「リード継投」等で先発に無決着が自然に出る。
 */
function assignDecisions(home, away, statFor, runLog) {
  // 登板・先発は勝敗に関わらず付与（引分試合でも計上する。early-returnの前に置く）
  for (const side of [home, away]) {
    const seen = new Set();
    for (const ap of side.log) {
      if (seen.has(ap.pid)) continue;
      seen.add(ap.pid);
      const s = statFor(ap.pid, side.teamId);
      s.pitching.g++;
      if (ap.pid === side.starterId) s.pitching.gs++;
    }
  }

  // 完投・完封（監査B4）: そのチームの投手が先発1人のみで投げ切った＝完投。無失点なら完封。
  for (const side of [home, away]) {
    if (side.log.length === 1 && side.log[0].pid === side.starterId) {
      const s = statFor(side.starterId, side.teamId);
      s.pitching.cg++;
      if (side.log[0].runs === 0) s.pitching.sho++;
    }
  }

  if (home.score === away.score) return; // 引分は勝敗・セーブなし
  const homeWins = home.score > away.score;
  const winner = homeWins ? home : away;
  const loser = homeWins ? away : home;

  // 決勝点(go-ahead run)を特定: 勝者が「同点or負け」だった最後の得点イベントの、次の得点。
  const winSc = (e) => (homeWins ? e.homeScore : e.awayScore);
  const loseSc = (e) => (homeWins ? e.awayScore : e.homeScore);
  let goIdx = 0;
  for (let i = runLog.length - 1; i >= 0; i--) {
    if (winSc(runLog[i]) <= loseSc(runLog[i])) {
      goIdx = i + 1;
      break;
    }
  }
  const go = runLog[goIdx] || runLog[runLog.length - 1];

  // 負け投手 = 決勝点を許した敗者側の当時の投手
  const lossPid = homeWins ? go.awayPid : go.homePid;
  statFor(lossPid, loser.teamId).pitching.l++;

  // 勝ち投手 = 決勝点時の勝者側の投手（先発5回未満なら最多アウト救援）
  let wPid = homeWins ? go.homePid : go.awayPid;
  if (wPid === winner.starterId) {
    const st = winner.log.find((a) => a.pid === winner.starterId);
    if (!st || st.outs < 15) {
      let mx = -1;
      for (const a of winner.log) {
        if (a.pid === winner.starterId) continue;
        if (a.outs > mx) {
          mx = a.outs;
          wPid = a.pid;
        }
      }
    }
  }
  statFor(wPid, winner.teamId).pitching.w++;

  // セーブ: 3点差以内・最後に投げたリリーフ（勝ち投手と別）。抑え固定化(B2)でクローザーに集中。
  const last = winner.log[winner.log.length - 1];
  const margin = Math.abs(home.score - away.score);
  let savePid = null;
  if (last && last.pid !== wPid && margin <= 3 && last.outs >= 1) {
    statFor(last.pid, winner.teamId).pitching.sv++;
    savePid = last.pid;
  }

  // ホールド／ブローンセーブ（監査B3）: 救援の登板時/退場時リード差から判定。
  // リード1-3(セーブ機会)で7回以降に登板した救援が、リード保持で降板し勝ちでもセーブでもない→ホールド。
  // リードを吐き出して同点/逆転を許した→ブローンセーブ（敗退側・勝利側を問わず）。
  for (const side of [home, away]) {
    for (const ap of side.log) {
      if (ap.pid === side.starterId) continue; // 先発は対象外
      if (!(ap.enterDiff >= 1 && ap.enterDiff <= 3 && ap.enterInning >= 7)) continue; // セーブ機会で登板していない
      const s = statFor(ap.pid, side.teamId);
      if (ap.exitDiff <= 0) {
        s.pitching.bs++; // リードを吐き出した
      } else if (ap.pid !== wPid && ap.pid !== savePid && ap.outs >= 1) {
        s.pitching.hld++; // リード保持で降板
      }
    }
  }
}

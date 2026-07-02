// ============================================================================
// 試合状態機械（1-4c/e）— 9イニング/27アウト・塁状況・得点・投手交代・守備イニング計上
//
// 打席は 1-1(規律層)→1-2/1-3(打球)で解決。走者は簡易進塁ルールで動かす（UBRの精緻化は2-5）。
// 継投は「最小投球回起用」（§18）。SP勝敗は簡易判定（§18: 指標は近似）。
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

/** 盗塁の試行・成否（§6 wSB）。走者Steal/Speed × 投手Hold × 捕手Arm。outs を返す。 */
function attemptSteal(batting, fielding, bases, outs, statFor, cfg, rng) {
  if (!bases[0] || bases[1]) return outs; // 一塁走者かつ二塁が空いている時のみ
  const runner = batting.byId.get(bases[0]);
  const s = cfg.tuning.steal;
  const br = runner.trueAbility.baserunning;
  const sp = runner.trueAbility.common.speed;

  // 試行判断: 走者のSteal/Speedが高いほど走る
  const aggr = expit(
    logit(s.attemptBase) + ratingDelta(br.steal, s.attemptSlope) + ratingDelta(sp, s.attemptSlope * 0.5),
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
 * @param {Function} [onBattedBall] (batterId, teamId, battedBall, result) スプレー収集用（任意）
 */
export function simulateGame(homeInit, awayInit, cfg, rng, statFor, park, onBattedBall) {
  const home = initSide(homeInit);
  const away = initSide(awayInit);

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

  return { homeScore: home.score, awayScore: away.score, innings: inning, tie: home.score === away.score };
}

function initSide(init) {
  const d = init.depth;
  const starterId = d.rotation[init.starterIdx % d.rotation.length];
  const dhEntry = d.lineup.find((s) => s.pos === 'DH');
  return {
    teamId: init.teamId,
    byId: d.byId,
    order: d.lineup.map((s) => s.playerId),
    dhId: dhEntry ? dhEntry.playerId : null, // 守備に就かないDH（守備位置補正=-17.5の主語）
    defense: { ...d.defense },
    orderIdx: 0,
    starterId,
    closerId: d.bullpen.length ? d.bullpen[0] : null, // relieverScore最上位＝抑え（締め局面で固定起用・監査B2）
    curPid: starterId,
    used: new Set([starterId]),
    bullpen: d.bullpen.slice(),
    // enterDiff/enterInning: 登板時の投手側リード差と回（ホールド/BS判定・監査B3）
    cur: { pid: starterId, outs: 0, pitches: 0, runs: 0, bf: 0, enterDiff: 0, enterInning: 1 },
    log: [],
    score: 0,
  };
}

/** 半イニングを消化（batting=攻撃側, fielding=守備側） */
function playHalf(batting, fielding, cfg, rng, statFor, park, walkoff, onBattedBall, recordRun, inning) {
  // 継投(高レバレッジ): リード1-3の守備側に 8回=セットアッパー / 9回+=抑え を投入（監査B2/B3）。
  maybeBringLeverageReliever(fielding, batting.score, inning, statFor);
  const bases = [null, null, null];
  let outs = 0;
  let errorInInning = false; // 失策発生後の得点は非自責（§ERA整合）
  while (outs < 3) {
    // 盗塁機会（走者一塁・二塁空き）。§6 wSB。PA解決の前に処理。
    outs = attemptSteal(batting, fielding, bases, outs, statFor, cfg, rng);
    if (outs >= 3) break;

    const batterId = batting.order[batting.orderIdx];
    batting.orderIdx = (batting.orderIdx + 1) % 9;
    const batter = batting.byId.get(batterId);
    const pitcher = fielding.byId.get(fielding.curPid);

    const bStat = statFor(batterId, batting.teamId);
    const pStat = statFor(fielding.curPid, fielding.teamId);

    // 対戦巡目（この登板でこの投手が何度打線を通過したか。§3.3）
    const tto = Math.floor(fielding.cur.bf / 9);
    // 球種格子(§4段階1): この打席で投げる球種を1つ選ぶ
    const pitch = selectPitch(pitcher, rng, cfg);
    const outcome = resolvePADiscipline(batter, pitcher, cfg, rng, tto, pitch);
    const pc = pitchesFor(outcome);
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

    maybeChangePitcher(fielding, statFor, batting.score, inning);

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
  if (batting.dhId) {
    const dl = statFor(batting.dhId, batting.teamId).fielding.positionOuts;
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

/** 現投手を必要なら交代。先発は球数/失点ベースで好投時は完投まで届く（監査B4）。 */
function maybeChangePitcher(fielding, statFor, oppScore, inning) {
  const c = fielding.cur;
  const pitcher = fielding.byId.get(c.pid);
  const stamina = pitcher.trueAbility.pitching.stamina;
  const isStarter = c.pid === fielding.starterId;

  // B4: 一律21アウト上限を撤廃。球数(82+stamina*0.6)・失点・疲労で降板し、
  //     好投の高スタミナ先発は8-9回=完投/完封まで届く。
  const remove = isStarter
    ? c.pitches >= 82 + stamina * 0.6 || c.runs >= 6 || (c.outs >= 18 && c.runs >= 4)
    : c.outs >= 3 || c.runs >= 3;
  if (!remove) return;

  const lead = fielding.score - oppScore;
  const next = pickReliever(fielding, statFor, inning, lead);
  if (!next) return;

  flushPitcher(fielding, oppScore);
  fielding.curPid = next;
  fielding.used.add(next);
  fielding.cur = { pid: next, outs: 0, pitches: 0, runs: 0, bf: 0, enterDiff: lead, enterInning: inning };
}

/**
 * 高レバレッジ継投（監査B2/B3）: リード1-3の守備側に、9回+は抑え(closerId)、8回はセットアッパーを
 * 半イニング開始時に投入。締め投手を固定してセーブを集中させ、セットアッパーにホールドを生む。
 * 完封中の絶対的エース（自責0・21アウト以上）は続投を許し、稀な完投完封を残す。
 */
function maybeBringLeverageReliever(fielding, oppScore, inning, statFor) {
  if (inning == null || inning < 8) return;
  const lead = fielding.score - oppScore;
  if (lead < 1 || lead > 3) return; // 保護すべき僅差リードがない
  const c = fielding.cur;
  const isStarter = c.pid === fielding.starterId;
  if (isStarter && c.runs === 0 && c.outs >= 21) return; // 完封中のエースは続投
  const avail = fielding.bullpen.filter((pid) => !fielding.used.has(pid));
  if (!avail.length) return;
  const target = inning >= 9 ? avail[0] : avail.find((pid) => pid !== fielding.closerId) || avail[0];
  if (!target || target === c.pid) return;
  flushPitcher(fielding, oppScore);
  fielding.curPid = target;
  fielding.used.add(target);
  fielding.cur = { pid: target, outs: 0, pitches: 0, runs: 0, bf: 0, enterDiff: lead, enterInning: inning };
}

/** リリーバー選択（監査B2）: 締め局面は抑え/セットアッパーを固定、それ以外は投球回最少で負荷分散。 */
function pickReliever(fielding, statFor, inning, lead) {
  const avail = fielding.bullpen.filter((pid) => !fielding.used.has(pid));
  if (!avail.length) return null;
  if (lead >= 1 && lead <= 3 && inning != null) {
    if (inning >= 9) return avail[0]; // 抑え（relieverScore最上位の未使用）
    if (inning === 8) return avail.find((pid) => pid !== fielding.closerId) || avail[0]; // セットアッパー
  }
  let best = null;
  let bestOuts = Infinity;
  for (const pid of avail) {
    const s = statFor(pid, fielding.teamId);
    if (s.pitching.outs < bestOuts) {
      bestOuts = s.pitching.outs;
      best = pid;
    }
  }
  return best;
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

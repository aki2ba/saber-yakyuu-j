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
import { runPlateAppearance } from './plateAppearance.mjs';
import { resolveBattedBall, battedType } from './battedBallResult.mjs';
import { accumulateBatted } from './battedBallStats.mjs';
import { rangeRating } from './fielding.mjs';
import { IS_OUTFIELD, retrievingOutfielder } from './fieldingGeometry.mjs';
import { logit, expit, ratingDelta } from './rates.mjs';
import { effectiveBats } from '../model/player.mjs';
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
  chooseInjuryReplacement,
  chooseReliever,
  starterPitchLimit,
} from './manager.mjs';
import { exposureProb, rollInjurySeverity } from './injury.mjs';

const MAX_INNINGS = 12; // NPB延長規定（超えたら引分）
// ARM（外野送球）対象ポジションは fieldingGeometry の IS_OUTFIELD を使う（単一の真実）

/**
 * 走者を進める。bases=[1B,2B,3B]（playerId or null）。得点数を返し bases を破壊的更新。
 * @param {boolean} isAirOut アウトが空中打球（犠飛判定用）
 */
export function advanceRunners(bases, result, batterId, isAirOut, outs, rng, cfg, ctx) {
  let runs = 0;
  if (ctx) {
    ctx.outs = outs; // ARM補殺の可否判定（3アウト目は作らない）
    ctx.outsAdded = 0; // 外野補殺/走塁死/併殺で増えたアウト。呼び出し側が outs へ加算する
    // realism_r1_baserunning_spec: 毎打席リセットする出力フラグ（caller が読む）
    ctx.sacFly = false; // 犠飛が成立したか（§B・唯一の情報源）
    ctx.gbDp = false; // ゴロ併殺が成立したか（§A）
    ctx.fcBatterSafe = false; // ゴロがフィールダースチョイスで打者が生きたか（§A）
  }
  const b1 = bases[0];
  const b2 = bases[1];
  const b3 = bases[2];

  if (result === 'BB' || result === 'HBP') {
    // 押し出し（フォース）のみ。
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

  if (result === 'E') {
    // 失策時の進塁（realism_r1_baserunning_spec §C）: 外野失策=単打相当・内野失策=進塁打相当
    // （フォース走者は連鎖で1個進み、フォース対象外のR3のみゴロゴー判定の機会球）。
    // 旧実装はBB/HBPと同じ押し出しのみで、外野の落球でも非フォース走者が1個も進めなかった＝穴。
    return resolveErrorAdvance(bases, batterId, b1, b2, b3, ctx, cfg, rng);
  }

  if (result === 'out') {
    // 実質ライナー捕球（GB分類だが初バウンド前迎撃）: 走者は帰塁して自重。
    // ゴロ意味論（進塁打・FC・併殺）もタッグアップも適用しない（内野の目の前で捕られた
    // ライナーから走者は進めない。逆走(ダブルオフ)は未モデル・将来の拡張余地）。
    if (ctx && ctx.gbAirCatch) return runs;
    // 空中アウト（LD/FB/PU）: タッグアップは飛距離依存（realism_r1_baserunning_spec §B）。
    // 内野フライ/浅い飛球（本塁付近のポップ含む）では走者は自重し、犠飛は成立しない
    // （旧実装は深さ非依存で三塁走者が無条件生還し、内野フライでも犠飛が付いていた＝穴）。
    const bType = ctx && ctx.bType;
    if (bType === 'GB') {
      return resolveGroundOutAdvance(bases, batterId, outs, b1, b2, b3, ctx, cfg, rng);
    }
    if (isAirOut && outs < 2) {
      const bb = ctx && ctx.battedBall;
      if (!bb) {
        // ctxからbattedBallを渡さない呼び出し（ctxなしの単体テスト等）はレガシー挙動へ
        // フォールバック: 深さ非依存の無条件犠飛＋旧tagBase方式。
        if (b3) {
          runs++;
          bases[2] = null;
          if (ctx) ctx.sacFly = true;
        }
        if (b2 && !bases[2]) {
          const r = resolveAdv(b2, cfg ? cfg.tuning.bb.tagBase : 0.4, ctx, cfg, rng, 'tag');
          if (r === ADV_TAKEN) {
            bases[2] = b2;
            bases[1] = null;
          } else if (r === ADV_OUT) {
            bases[1] = null; // 三塁を狙って刺された（走塁死）
          }
        }
        return runs;
      }
      const run = cfg.tuning.run;
      if (bb.distanceM >= run.tagMinDistM) {
        // 本塁タッグアップ: 深いほど生還しやすい。浅くて還れなければ自重（犠飛不成立）、
        // 憤死もありうる（本塁補殺・§ARM実イベント化）。
        if (b3) {
          const p = clamp(run.sfBase + run.sfDistW * (bb.distanceM - run.sfPivotM), 0.05, 0.95);
          const r = resolveAdv(b3, p, ctx, cfg, rng, 'tag3h');
          if (r === ADV_TAKEN) {
            runs++;
            bases[2] = null;
            if (ctx) ctx.sacFly = true;
          } else if (r === ADV_OUT) {
            bases[2] = null; // 本塁憤死（犠飛不成立）
          }
          // ADV_HOLD: 三塁に残る（浅くて還れず・犠飛不成立）
        }
        // 三塁タッグアップ（二塁→三塁・§req_20260708 UBR強化）: 三塁が空いていれば狙う
        if (b2 && !bases[2]) {
          const r = resolveAdv(b2, cfg.tuning.bb.tagBase, ctx, cfg, rng, 'tag');
          if (r === ADV_TAKEN) {
            bases[2] = b2;
            bases[1] = null;
          } else if (r === ADV_OUT) {
            bases[1] = null;
          }
        }
      }
      // bb.distanceM < tagMinDistM: 内野フライ/浅い飛球・全走者自重・犠飛なし
      return runs;
    }
    return runs; // それ以外は走者そのまま（併殺/進塁打はA/Cで扱う）
  }

  if (result === '1B') {
    const nb = [null, null, null];
    if (b3) runs++; // 三塁は生還
    let thirdTaken = false;
    if (b2) {
      // 二塁走者の生還（走者Speed/IQ依存＝UBR, 2-5）
      const r = resolveAdv(b2, cfg ? cfg.tuning.bb.singleScore2 : 0.55, ctx, cfg, rng, 'adv2h1b');
      if (r === ADV_TAKEN) runs++;
      else if (r === ADV_HOLD) { nb[2] = b2; thirdTaken = true; } // 三塁止まり
      // ADV_OUT: 本塁で刺された（塁上から消える）
    }
    if (b1) {
      // 一塁走者の三塁進塁（UBR強化）: 三塁が空いていれば走者Speed/IQで狙う
      const r = thirdTaken ? ADV_HOLD : resolveAdv(b1, cfg ? cfg.tuning.bb.singleScore1to3 : 0.3, ctx, cfg, rng, 'adv1t3b');
      if (r === ADV_TAKEN) nb[2] = b1; // 一塁→三塁
      else if (r === ADV_HOLD) nb[1] = b1; // 一塁→二塁（station to station）
      // ADV_OUT: 三塁で刺された
    }
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
      const r = resolveAdv(b1, cfg ? cfg.tuning.bb.doubleScore1 : 0.45, ctx, cfg, rng, 'adv1h2b');
      if (r === ADV_TAKEN) runs++; // 一塁→生還
      else if (r === ADV_HOLD) nb[2] = b1; // 三塁止まり
      // ADV_OUT: 本塁で刺された
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
 * 追加進塁の判定（§6 UBR, 2-5／§req_20260708強化／realism_r1_baserunning_spec §D）。
 * 走者Speed/走塁IQで基準確率を上下し、ctx があれば進塁機会(advOpp)と成否(advTaken)を
 * 走者に記録する（ctxなし=能力非依存・テスト互換）。
 * @param {string} scenario シナリオ別内訳キー（'adv2h1b'|'adv1h2b'|'adv1t3b'|'tag'|'gbAdv3h'|'gbAdv2t3'|'tag3h'）。
 *   全シナリオ合算のadvOpp/advTakenに加え、statline.mjsの${scenario}Opp/${scenario}Takenへも計上し、
 *   UBRのリーグ基準をシナリオごとに正しく分離できるようにする（Fangraphs UBR/BP EqBRR準拠）。
 */
const ADV_TAKEN = 'adv'; // 追加進塁に成功
const ADV_HOLD = 'hold'; // 走らず（元の塁に留まる）
const ADV_OUT = 'out'; // 走って刺された（走塁死・塁からは消える）

/**
 * 3状態を返す。'hold' と 'out' を取り違えると、刺された走者がアウトに数えられた上で
 * 塁にも残る（幽霊走者）ため、呼び出し側は必ず ADV_OUT を分岐すること。
 */
function resolveAdv(pid, baseProb, ctx, cfg, rng, scenario) {
  // プレー死後（3アウト到達後）の進塁は発生しない。乱数を消費せず自重として扱う
  // （realism_r1_baserunning_spec §D-1）。
  if (ctx && ctx.outs + ctx.outsAdded >= 3) return ADV_HOLD;
  const def = ctx && ctx.def; // 打球を拾った外野手（ARMの主語）。内野処理なら null
  let p = baseProb;
  if (ctx) {
    const t = ctx.byId.get(pid).trueAbility;
    const tool = (t.common.speed + t.baserunning.baserunIQ) / 2;
    // 強肩の外野手ほど走者は自重する（進塁抑止・§ARM実イベント化）
    const armSup = def ? (def.arm - 50) * cfg.tuning.field.armAdvSuppress : 0;
    // 2死ボーナス（§D-2）: 打球と同時にスタートできるため2死は積極的に進塁を狙う
    const outBonus = ctx.outs === 2 ? cfg.tuning.run.adv2OutBonus : 0;
    p = clamp(baseProb + (tool - 50) * cfg.tuning.run.ubrSlope - armSup + outBonus, 0.05, 0.95);
    const bs = ctx.statFor(pid, ctx.teamId).baserunning;
    bs.advOpp++;
    bs[`${scenario}Opp`]++;
    const took = (rng ? rng.next() : 1) < p;
    if (def) def.line.armOpp++;
    if (took) {
      // 走った → 強肩なら刺せる（補殺）。3アウト目の走塁死（本塁突入死等）も許可する
      // （§D-3）: advanceRunnersは先頭走者から順に解決し、runsは解決済みぶんだけ数えるため、
      // 先に数えた得点は「アウトより先に本塁を踏んだ」＝公認野球規則の時間プレーと同義で正しい
      // （フォースの3アウト目による得点取り消しはここでは発生しない。killは常にタッグプレー）。
      // ctx.outsAdded を含めて数えることで、1打席で複数回刺して3アウトを超えることはない
      // （冒頭ガードで自動的に打ち切られる）。
      const outsSoFar = ctx.outs + ctx.outsAdded;
      // ゴロゴー（内野処理・外野手不在）でも本塁憤死は起こりうる（gbAdv3h・肩補正なし・§2.3）
      const canKill = outsSoFar < 3 && (def || scenario === 'gbAdv3h');
      const f = cfg.tuning.field;
      const r = cfg.tuning.run;
      // tag3h（本塁タッグアップ補殺）はヒット進塁系(adv2h1b等)より機会が桁違いに多いため
      // （深い犠飛はほぼ毎試合発生）、共有armKillBaseのままでは外野補殺リーダーが帯を大きく
      // 超過する（較正で確認）。既存シナリオのARM較正を壊さないよう専用の低い基準値を持つ。
      const pKill = !canKill
        ? 0
        : !def
          ? r.gbKillBase
          : scenario === 'tag3h'
            ? clamp(r.tag3hKillBase + (def.arm - 50) * r.tag3hKillSlope, 0, r.tag3hKillMax)
            : clamp(f.armKillBase + (def.arm - 50) * f.armKillSlope, 0, f.armKillMax);
      const killed = canKill && rng && rng.next() < pKill;
      if (killed) {
        if (def) {
          def.line.armKill++;
          def.line.a++; // 補殺
        }
        ctx.outsAdded++;
        bs.outsOnBase++; // 走塁死（§F-3・盗塁死csは含めない=定義どおり）
        return ADV_OUT;
      }
      bs.advTaken++;
      bs[`${scenario}Taken`]++;
      if (def) def.line.armAdv++;
      return ADV_TAKEN;
    }
    return ADV_HOLD;
  }
  return (rng ? rng.next() : 1) < baseProb ? ADV_TAKEN : ADV_HOLD;
}

/**
 * ゴロアウトの走者処理（DP/FC/進塁打の3分岐・realism_r1_baserunning_spec §A）。
 * outsBefore=打者アウト計上前のアウト数（caller側の outs++ はこの後に実行される）。
 * @param {number} outsBefore
 */
function resolveGroundOutAdvance(bases, batterId, outsBefore, b1, b2, b3, ctx, cfg, rng) {
  if (outsBefore >= 2) return 0; // 2アウト後は打者アウトで攻守交代・走者そのまま

  if (!b1) {
    // 走者一塁なし: フォース不成立。三塁走者のゴロゴー・二塁走者の三進のみ。
    let runs = 0;
    if (b3) {
      const r = resolveAdv(b3, cfg.tuning.run.gbScore3, ctx, cfg, rng, 'gbAdv3h');
      if (r === ADV_TAKEN) { runs++; bases[2] = null; }
      else if (r === ADV_OUT) { bases[2] = null; }
    }
    if (b2 && !bases[2]) {
      const r = resolveAdv(b2, cfg.tuning.run.gbAdv2t3, ctx, cfg, rng, 'gbAdv2t3');
      if (r === ADV_TAKEN) { bases[2] = b2; bases[1] = null; }
      else if (r === ADV_OUT) { bases[1] = null; }
    }
    return runs;
  }

  // 走者一塁あり（フォース状況）。ctx/fieldingDefense が無い呼び出し（ctxなしの単体テスト等）は
  // レガシー挙動（走者凍結）へフォールバックする（§2.1・既存テスト互換）。
  if (!ctx || !ctx.fieldingDefense) return 0;

  ctx.statFor(batterId, ctx.teamId).baserunning.gdpOpp++;
  // DPR（二遊間の併殺転換・§B3b）: 機会を2B/SS双方に計上（対平均runはmetrics側）。乱数非消費。
  const dp2 = ctx.fieldingDefense['2B'];
  const dpS = ctx.fieldingDefense.SS;
  if (dp2) ctx.statFor(dp2, ctx.fieldingTeamId).fielding.dpOpp++;
  if (dpS) ctx.statFor(dpS, ctx.fieldingTeamId).fielding.dpOpp++;

  const gdp = cfg.tuning.gdp;
  const runT = cfg.tuning.run;
  const batter = ctx.byId.get(batterId);
  const pDp = clamp(gdp.base - (batter.trueAbility.common.speed - 50) * gdp.speedW, 0.02, 0.45);
  const u = rng.next();

  if (u < pDp) {
    // 併殺: R1アウト＋打者アウト（打者アウトはcaller側で計上）。
    ctx.outsAdded++;
    ctx.gbDp = true;
    ctx.statFor(batterId, ctx.teamId).batting.gdp++;
    if (dp2) ctx.statFor(dp2, ctx.fieldingTeamId).fielding.dpTurned++;
    if (dpS) ctx.statFor(dpS, ctx.fieldingTeamId).fielding.dpTurned++;
    bases[0] = null; // R1除去（フォース）
    let runs = 0;
    // 時間プレー: 併殺が3アウト目にならない限り、先に本塁を踏んだ得点は数える（併殺が3アウト目＝
    // フォースの3アウト目は得点を無効化する公認野球規則5.08(b)と同義。それ以外は数える）。
    if (outsBefore + 2 < 3) {
      if (b3) runs++;
      bases[2] = null;
      if (b2) { bases[2] = b2; bases[1] = null; }
    }
    return runs;
  }

  if (u < pDp + runT.gbForceFc) {
    // FC（二塁封殺のみ）: R1のみアウト（force）。打者は一塁に生きる＝caller側の打者アウト計上
    // 1つで実際の総アウト数と整合する（打者は安全に1塁を占有・R1が除去される＝人数の出入りが
    // 一致する。ctx.outsAdded は加算しない）。
    ctx.fcBatterSafe = true;
    bases[0] = null;
    let runs = 0;
    if (b3) {
      const r = resolveAdv(b3, runT.gbScore3, ctx, cfg, rng, 'gbAdv3h');
      if (r === ADV_TAKEN) { runs++; bases[2] = null; }
      else if (r === ADV_OUT) { bases[2] = null; }
    }
    if (b2 && !bases[2]) { bases[2] = b2; bases[1] = null; }
    bases[0] = batterId;
    return runs;
  }

  // 進塁打: 打者は一塁で刺される（caller側で計上）。R3→ゴロゴー、R2→R3が空けば確定三進、
  // R1→R2が空けば確定二進（連鎖・三塁が塞がっていればR2もR1も動けない）。
  let runs = 0;
  if (b3) {
    const r = resolveAdv(b3, runT.gbScore3, ctx, cfg, rng, 'gbAdv3h');
    if (r === ADV_TAKEN) { runs++; bases[2] = null; }
    else if (r === ADV_OUT) { bases[2] = null; }
  }
  if (b2 && !bases[2]) { bases[2] = b2; bases[1] = null; }
  if (!bases[1]) { bases[1] = b1; bases[0] = null; }
  // bases[1]がまだ塞がっていれば(R2が動けなかった) R1は1塁に残る（bases[0]は未変更=b1のまま）
  return runs;
}

/**
 * 失策(E)時の走者進塁（realism_r1_baserunning_spec §C）。
 * 外野失策=単打相当の進塁（既存1B分岐と同型のUBR判断）。
 * 内野失策=進塁打相当: 打者は一塁に生きる（フォース発生）。R1/R2はBB/HBPと同型の押し出しで
 * 進み、R3はフォース連鎖が届く時（満塁）のみ確定生還、それ以外は機会球（resolveAdv gbAdv3h）。
 */
function resolveErrorAdvance(bases, batterId, b1, b2, b3, ctx, cfg, rng) {
  const errPos = ctx && ctx.errorFielderPos;
  if (errPos && IS_OUTFIELD.has(errPos)) {
    const nb = [null, null, null];
    let runs = 0;
    if (b3) runs++;
    let thirdTaken = false;
    if (b2) {
      const r = resolveAdv(b2, cfg ? cfg.tuning.bb.singleScore2 : 0.55, ctx, cfg, rng, 'adv2h1b');
      if (r === ADV_TAKEN) runs++;
      else if (r === ADV_HOLD) { nb[2] = b2; thirdTaken = true; }
    }
    if (b1) {
      const r = thirdTaken ? ADV_HOLD : resolveAdv(b1, cfg ? cfg.tuning.bb.singleScore1to3 : 0.3, ctx, cfg, rng, 'adv1t3b');
      if (r === ADV_TAKEN) nb[2] = b1;
      else if (r === ADV_HOLD) nb[1] = b1;
    }
    nb[0] = batterId;
    bases[0] = nb[0];
    bases[1] = nb[1];
    bases[2] = nb[2];
    return runs;
  }
  let runs = 0;
  const r3Forced = !!(b1 && b2 && b3); // フォース連鎖が3塁まで届く=満塁のみ
  if (r3Forced) {
    runs++;
    bases[2] = null;
  } else if (b3) {
    const r = resolveAdv(b3, cfg ? cfg.tuning.run.gbScore3 : 0.55, ctx, cfg, rng, 'gbAdv3h');
    if (r === ADV_TAKEN) { runs++; bases[2] = null; }
    else if (r === ADV_OUT) { bases[2] = null; }
    // ADV_HOLD: 3塁に残る（フォース対象外）
  }
  if (b1) {
    if (b2) bases[2] = b2; // フォースで3塁へ（3塁はr3Forced分岐で既に空済み）
    bases[1] = b1;
  } else {
    bases[1] = b2; // R1不在=フォース不成立。R2は現状維持（非フォースのR2は進まない）
  }
  bases[0] = batterId;
  return runs;
}

function baseBits(bases) {
  return (bases[0] ? 1 : 0) | (bases[1] ? 2 : 0) | (bases[2] ? 4 : 0);
}

/**
 * 盗塁の試行・成否（§6 wSB）。走者Steal/Speed × 投手Hold × 捕手Arm。outs を返す。
 * S2: 監督stealTend×状況の采配ゲート（大差では走らない・2死×強打者では自重）を乗せる。
 */
function attemptSteal(batting, fielding, bases, outs, statFor, cfg, rng, inning, half) {
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
  const catcherId = fielding.defense.C; // rSB（捕手盗塁阻止run・§B3b）の帰属先
  const stealRunner = bases[0];
  if (rng.next() < succ) {
    bases[1] = bases[0]; // 二塁へ
    bases[0] = null;
    rStat.batting.sb++;
    if (catcherId) statFor(catcherId, fielding.teamId).fielding.sbAllowed++; // 捕手が許したSB（乱数非消費）
    // inning/half を必ず載せる（観戦UIのハーフ境界判定が inning 情報を持つイベントに依存・§E2）
    if (batting.onEvent) batting.onEvent({ type: 'steal', success: true, runnerId: stealRunner, batTeam: batting.teamId, basesPids: bases.slice(), outsAfter: outs, inning, half });
  } else {
    bases[0] = null; // 盗塁死
    rStat.batting.cs++;
    if (batting.onEvent) batting.onEvent({ type: 'steal', success: false, runnerId: stealRunner, batTeam: batting.teamId, basesPids: bases.slice(), outsAfter: outs + 1, inning, half });
    if (catcherId) statFor(catcherId, fielding.teamId).fielding.csMade++; // 捕手が刺したCS（乱数非消費）
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
 * @param {{maxInnings?:number}} [opts] ポストシーズンは maxInnings:Infinity（延長は決着まで・§S3-3）
 * @returns {{homeScore, awayScore, innings, tie, pitchers:{home,away}, subs:{home,away}}}
 *   pitchers: 投手使用ログ [{pid,pitches,outs,enterInning,enterDiff}]（S3疲労管理の素材）
 *   subs:     交代ログ [{type:'PH'|'PR'|'DEF'|'RP', inning, outPid, inPid}]
 */
export function simulateGame(homeInit, awayInit, cfg, rng, statFor, park, onBattedBall, opts = {}) {
  const home = initSide(homeInit, cfg);
  const away = initSide(awayInit, cfg);
  const maxInnings = opts.maxInnings ?? MAX_INNINGS;
  // 観戦実況フック（フェーズC1・§16）: 存在するときのみ各プレー確定点で「構造化イベント」を発火する。
  // gc（文脈指標）と同じく乱数は一切消費しない＝onEvent の有無で試合結果は不変（決定論・較正50指標が不変）。
  // 言語化（EV/LA/落下点の実況文）はUI側の責務で、ここは素データだけを渡す（エンジンとUIの分離）。
  const onEvent = opts.onEvent ?? null;
  home.onEvent = onEvent;
  away.onEvent = onEvent;
  // 故障シンク（R3）: 試合中に発生した離脱を season 層へ渡す（usage.injuredUntil を立て、
  //   二軍から補充する＝roster_moves の IL補充が自然に動き出す）。乱数は消費しない。
  const onInjury = opts.onInjury ?? null;
  home.onInjury = onInjury;
  away.onInjury = onInjury;
  if (onEvent) {
    onEvent({
      type: 'start',
      home: home.teamId,
      away: away.teamId,
      homeStarter: home.starterId,
      awayStarter: away.starterId,
      homeLineup: home.slots.map((s) => ({ playerId: s.playerId, pos: s.pos })),
      awayLineup: away.slots.map((s) => ({ playerId: s.playerId, pos: s.pos })),
      homeBullpen: home.bullpen.slice(),
      awayBullpen: away.bullpen.slice(),
      homeBench: home.bench.slice(),
      awayBench: away.bench.slice(),
    });
  }
  // 文脈指標フック（§B2）: 存在するときのみ各プレー確定点で ΔRE/ΔWPA/LI を積む。
  // 乱数は一切消費しないため、gc の有無で試合結果は不変（決定論・較正30指標が不変）。
  const gc = opts.gameContext ?? null;
  if (gc) {
    gc.maxInnings = maxInnings;
    gc.startGame();
  }

  // 得点推移ログ（勝敗の正確な判定用）: 得点が入るたびに両軍のスコアと現投手を記録
  const runLog = [];
  const recordRun = () =>
    runLog.push({ homeScore: home.score, awayScore: away.score, homePid: home.curPid, awayPid: away.curPid });

  let inning = 1;
  while (true) {
    playHalf(away, home, cfg, rng, statFor, park, false, onBattedBall, recordRun, inning, false, gc); // 表: away攻撃
    if (inning >= 9 && home.score > away.score) break; // 裏を省略（ホームリード）
    const bottomWalkoff = inning >= 9;
    playHalf(home, away, cfg, rng, statFor, park, bottomWalkoff, onBattedBall, recordRun, inning, true, gc); // 裏: home攻撃
    if (inning >= 9 && home.score !== away.score) break;
    inning++;
    if (inning > maxInnings) break;
  }

  flushPitcher(home, away.score);
  flushPitcher(away, home.score);
  assignDecisions(home, away, statFor, runLog);
  if (onEvent) {
    onEvent({
      type: 'end',
      homeScore: home.score,
      awayScore: away.score,
      innings: Math.min(inning, maxInnings),
      tie: home.score === away.score,
    });
  }
  // シャットダウン/メルトダウン（§B2）: 救援の1登板WPAを閾値判定（加算パスのみ）。
  if (gc && gc.mode === 'accumulate') classifyShutdowns(home, away, statFor, cfg);

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
    innings: Math.min(inning, maxInnings), // 12回引分でループ脱出時 inning=13 になるためクリップ（off-by-one修正）
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
  // 守備配置は「当日のスタメン」から導く（S3 日次スタメンAI: depth の初期配置と異なりうる）
  const defense = {};
  for (const s of slots) {
    if (s.pos !== 'DH' && s.pos !== 'P') defense[s.pos] = s.playerId;
  }
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
    defense,
    orderIdx: 0,
    starterId,
    curPid: starterId,
    usedPitchers: new Set([starterId]),
    retired: new Set(), // 一度退いた選手（再出場不可・§S2-1）
    bench: (init.bench ?? d.bench).slice(), // 当日のベンチ（起用で減る）
    bullpen,
    roles, // ブルペン役割 closer/setup8/setup7/middle/long（継投v2）
    pendingPitcher: false, // 投手への代打→次の守備から新投手（§S2-2）
    injuryPending: new Set(), // R3: 負傷したが塁上に居るため退場を次のハーフへ持ち越す打者
    pregame: buildPregameEval(d.byId, cfg), // 監督の当日メモ（編成時評価。以降trueAbilityは見ない）
    // enterDiff/enterInning: 登板時の投手側リード差と回（ホールド/BS判定・監査B3）
    cur: { pid: starterId, outs: 0, pitches: 0, runs: 0, er: 0, bf: 0, enterDiff: 0, enterInning: 1, wpa: 0 },
    log: [],
    subs: [], // 交代ログ {type,inning,outPid,inPid}（再出場不可の検証・S3素材）
    score: 0,
  };
}

function emptyCur() {
  return { pid: null, outs: 0, pitches: 0, runs: 0, er: 0, bf: 0, enterDiff: 0, enterInning: 0, wpa: 0 };
}

/** 半イニングを消化（batting=攻撃側, fielding=守備側）。battingIsHome=攻撃側がホーム（裏）か・
 *  gc=文脈指標フック（§B2・任意）。 */
function playHalf(batting, fielding, cfg, rng, statFor, park, walkoff, onBattedBall, recordRun, inning, battingIsHome, gc) {
  // 守備側の投手整備: 投手への代打の後始末→回頭の役割ベース継投（§S2-2/§S2-7）
  halfStartPitching(fielding, batting.score, inning, statFor, cfg);
  // 守備固め（§S2-3: 8回以降・リード1-3・当日メモで優位時のみ）
  // 負傷退場の持ち越し（R3）: 塁上に居たため退けなかった選手をここで交代させる（両軍）。
  flushInjuryExits(fielding, inning, cfg);
  flushInjuryExits(batting, inning, cfg);
  maybeDefensiveSub(fielding, batting.score, inning, cfg);

  const bases = [null, null, null];
  let outs = 0;
  let errorInInning = false; // 失策発生後の得点は非自責（§ERA整合）
  while (outs < 3) {
    // 盗塁機会（走者一塁・二塁空き）。§6 wSB×采配ゲート。PA解決の前に処理。
    const stBase = baseBits(bases);
    const stOuts = outs;
    const stRunner = bases[0];
    outs = attemptSteal(batting, fielding, bases, outs, statFor, cfg, rng, inning, battingIsHome ? 'bottom' : 'top');
    // 文脈指標（§B2）: 盗塁/盗塁死で状態が動いたら ΔRE/ΔWPA を走者へ（投手は−側）。
    if (gc && stRunner != null && (baseBits(bases) !== stBase || outs !== stOuts)) {
      gc.onPlay({
        kind: 'steal',
        battingIsHome,
        inning,
        batSideStat: statFor(stRunner, batting.teamId).baserunning,
        pitStat: statFor(fielding.curPid, fielding.teamId).pitching,
        pitcherCur: fielding.cur,
        firstBatterOfApp: false,
        baseBefore: stBase,
        outsBefore: stOuts,
        baseAfter: baseBits(bases),
        outsAfter: outs,
        runsOnPlay: 0,
        batScoreBefore: batting.score,
        fldScore: fielding.score,
      });
    }
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

    // 観戦実況（E2・乱数非消費）: 打席開始＝「◇ 打者 対 投手」行と盤面（走者/アウト/カウント初期化）の素データ。
    if (fielding.onEvent) {
      fielding.onEvent({
        type: 'atbat',
        inning,
        half: battingIsHome ? 'bottom' : 'top',
        batTeam: batting.teamId,
        pitTeam: fielding.teamId,
        batterId,
        pitcherId: fielding.curPid,
        pitcherPitches: Math.round(fielding.cur.pitches), // この登板の球数（表示用）
        outs,
        basesPids: bases.slice(), // 塁上走者の playerId（走者名表示・E2）
        batScore: batting.score,
        fldScore: fielding.score,
      });
    }

    // 文脈指標（§B2）: 打席プレーの「状態前」（盗塁/代打反映後）と登板初打者フラグを控える。
    const paBase = baseBits(bases);
    const paOuts = outs;
    const paScore = batting.score;
    const firstBF = fielding.cur.bf === 0; // 登板初打者（gmLI用・bf++の前）

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
        const bunt = resolveBunt(batting, fielding, bases, outs, cfg, rng, batterId, bStat, pStat);
        outs = bunt.outs;
        // 観戦実況（E2・乱数非消費）: 犠打の結果（成功/バント安打/失敗）を素データで通知。
        if (fielding.onEvent) {
          fielding.onEvent({
            type: 'bunt',
            inning,
            half: battingIsHome ? 'bottom' : 'top',
            batTeam: batting.teamId,
            batterId,
            outcome: bunt.dh ? 'hit' : bunt.dab ? 'fail' : 'success',
            outsAfter: outs,
            basesPids: bases.slice(),
            batScore: batting.score,
            fldScore: fielding.score,
          });
        }
        // スプリット計上（§B3b）: 犠打も1打席＝vsL/vsR・得点圏・ホーム/ビジターへ配る（PA恒等の維持）。
        recordPaSplits(bStat.batting, pitcher.throws, battingIsHome, (paBase & 6) !== 0, bunt.dab, bunt.dh, bunt.d1, 0, 0, 0, 0, 0, 0, 0);
        creditPlay(gc, {
          kind: 'pa',
          battingIsHome,
          inning,
          batSideStat: bStat.batting,
          pitStat: pStat.pitching,
          pitcherCur: fielding.cur,
          firstBatterOfApp: firstBF,
          baseBefore: paBase,
          outsBefore: paOuts,
          baseAfter: baseBits(bases),
          outsAfter: outs,
          runsOnPlay: batting.score - paScore,
          batScoreBefore: paScore,
          fldScore: fielding.score,
        });
        maybePinchRun(batting, fielding, bases, inning, cfg, statFor);
        if (outs < 3) maybeChangePitcher(fielding, statFor, batting.score, inning, cfg, bases, outs);
        continue;
      }
    }

    // 対戦巡目（この登板でこの投手が何度打線を通過したか。§3.3）
    const tto = Math.floor(fielding.cur.bf / 9);
    // 一球ごとカウント状態機械（§B1）。敬遠(isIBB)は勝負しない＝機械を回さず4ボール扱い。
    // K=3ストライク/BB=4ボール/HBP=死球/inPlay=接触 を創発。per-pitch生カウントは機械が bStat/pStat へ直接加算。
    const catcherPid = fielding.defense.C;
    const catcher = catcherPid ? fielding.byId.get(catcherPid) : null;
    const cLine = catcherPid ? statFor(catcherPid, fielding.teamId).fielding : null;
    let outcome, decisiveClass = null, wpRuns = 0;
    let battedBall = null, paPitches, paBucket = 'even', paPassed02 = false, paPassed30 = false;
    if (isIBB) {
      outcome = 'BB';
      paPitches = cfg.tuning.ibb.pitches;
      // 敬遠は機械を通さない＝投球数を別途計上。§B1-2 の恒等（Σbatter.pitches==Σpitcher.pitches）を保つため打者側も同数加算（対称に）。
      // lumpedPitches にも計上し、一球swing模型の率(Zone%/CSW%/SwStr%)の分母から除外できるようにする。
      pStat.pitching.pitches += Math.round(paPitches);
      pStat.pitching.lumpedPitches += Math.round(paPitches);
      bStat.batting.pitches += Math.round(paPitches);
      bStat.batting.lumpedPitches += Math.round(paPitches);
    } else {
      const pa = runPlateAppearance({
        batter, pitcher, catcher, cfg, rng, tto,
        bLine: bStat.batting, pLine: pStat.pitching, cLine, bases, outs,
        // 一球速報（E2・乱数非消費）: 存在するときのみ各投球を構造化イベントで発火。
        // band=ロケーション帯（0=ゾーン内/1=ボーダー/2=明確ボール・既計算値）＝観戦コース図の実データ。
        onPitch: fielding.onEvent
          ? (n, pitchType, call, balls, strikes, wild, band) =>
              fielding.onEvent({ type: 'pitch', n, pitchType, call, balls, strikes, wild, band })
          : null,
      });
      outcome = pa.outcome; // 'K'|'BB'|'HBP'|'inPlay'
      battedBall = pa.battedBall;
      decisiveClass = pa.decisiveClass;
      wpRuns = pa.wpRuns; // 打席中の暴投/捕逸で入った得点（下で加点・投手失点へ）
      paPitches = pa.pitches;
      paBucket = pa.countBucket;
      paPassed02 = pa.passed02;
      paPassed30 = pa.passed30;
    }
    fielding.cur.pitches += paPitches;
    fielding.cur.bf++;
    pStat.pitching.bf++;
    bStat.batting.pa++;

    let result;
    let isAirOut = false;
    let bType = null;
    let hitFielderPos = null; // ARM（外野送球）用: 安打を処理した野手ポジション（§B3b）
    let gbAirCatch = false; // GB分類(LA<10°)だが初バウンド前迎撃＝実質ライナー捕球（表示は「直」・走者は帰塁）
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
      const bb = battedBall; // 機械が生成済み（EV/LA/方向パイプラインは不変）
      // 守備者個人のRangeを注入（2-7）: 担当ポジションの野手能力で被安打率を上下
      const r = resolveBattedBall(bb, cfg, rng, park, (pos) => {
        const fp = fielding.byId.get(fielding.defense[pos]);
        return fp ? rangeRating(fp, cfg) : 50;
      });
      result = r.result;
      bType = battedType(bb.laDeg);
      isAirOut = result === 'out' && bType !== 'GB';
      gbAirCatch = result === 'out' && r.airCatch === true;
      hitFielderPos = r.fielderPos; // 追加進塁機会での外野ARM帰属に使う（§B3b）
      recordBattedBallStat(bStat, pStat, result);
      // 追加系指標の打球集計（§B3a）: 期待out率/塁打分布(r)＋EV/LA/spray を積む。rng消費なし＝決定論不変。
      const pullSign = effectiveBats(batter, pitcher) === 'L' ? 1 : -1;
      accumulateBatted(bStat.batting, pStat.pitching, bb, r, pullSign, cfg);
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
          gbAirCatch = false; // 落球＝アウトでなくなったのでライナー捕球扱いも解除
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

    // 対球種スプリット記録（§4段階1: 対ストレート成績等の素）。決着球のクラスで分類（§B1）。
    if (decisiveClass) {
      const sl = decisiveClass === 'fastball' ? bStat.batting.vsFastball : bStat.batting.vsBreaking;
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
    // カウント別成績の圧縮版（§B1-2）: ahead/even/behind＋通過した 0-2/3-0 セルへ配る（IBBは除外）。
    if (!isIBB) recordByCount(bStat.batting.byCount, paBucket, paPassed02, paPassed30, outcome, result);

    // ARM（外野送球の対平均run・§B3b）: 単打×二塁走者 / 二塁打×一塁走者 の追加進塁機会に
    // ARM（外野送球）: 打球を「拾う」外野手を幾何で決め、resolveAdv に注入する。
    //   OAA の責任野手（argmax p）とは別概念: 三遊間を抜けたゴロの OAA 責任は SS だが、
    //   球を拾って返球するのは LF である（正典§11.6）。
    //   強肩は (a) 走者に自重させ (b) 走った走者を刺す。ARM run は armOpp/armAdv/armKill の
    //   生カウントからリーグ平均基準で創発させる（鉄則4: 指標を後付けしない）。
    let ubrDef = null;
    if (battedBall && (result === '1B' || result === '2B' || result === '3B' || (result === 'out' && isAirOut))) {
      const ofPos = retrievingOutfielder(battedBall, cfg);
      const ofPid = ofPos ? fielding.defense[ofPos] : null;
      const ofPlayer = ofPid ? fielding.byId.get(ofPid) : null;
      // 内野で処理された打球（内野ゴロアウト・内野フライ）では外野手は関与しない
      const reachedOF = battedBall.laDeg > 0 ? battedBall.distanceM >= cfg.tuning.field.ofReachM : result !== 'out';
      if (ofPlayer && reachedOF) {
        ubrDef = { arm: ofPlayer.trueAbility.common.arm, line: statFor(ofPid, fielding.teamId).fielding };
      }
    }

    const ubrCtx = {
      byId: batting.byId,
      statFor,
      teamId: batting.teamId,
      def: ubrDef,
      battedBall,
      bType, // ゴロアウト分岐の判定に使う（realism_r1 §A）
      gbAirCatch, // 実質ライナー捕球（GB分類）: 走者は帰塁＝ゴロ意味論(進塁打/併殺)を適用しない
      fieldingDefense: fielding.defense, // DP統計(2B/SS)の帰属先（§A）
      fieldingTeamId: fielding.teamId,
      errorFielderPos: result === 'E' ? hitFielderPos : null, // 失策を犯した野手（外野/内野の判定・§C）
      outs,
      outsAdded: 0,
    };
    const advRuns = advanceRunners(bases, result, batterId, isAirOut, outs, rng, cfg, ubrCtx);
    // 外野補殺で増えたアウト（走塁死）を反映する
    if (ubrCtx.outsAdded) {
      outs += ubrCtx.outsAdded;
      fielding.cur.outs += ubrCtx.outsAdded;
      pStat.pitching.outs += ubrCtx.outsAdded;
    }
    // 打席中の暴投/捕逸で入った得点(wpRuns)は打点対象外だが投手失点＝自責（失策後は非自責）。
    // 打席プレー全体の得点として一括計上し、文脈指標(gc)へも合算で渡す（RE24/WPAの telescoping を保つ）。
    const runs = advRuns + wpRuns;

    let gbDp = false;
    if (result === 'out') {
      if (ubrCtx.sacFly) {
        // 犠飛: ABを取り消してSF計上（ctx.sacFlyが唯一の情報源・realism_r1 §F-1。
        // 打席中の暴投/捕逸の得点(wpRuns)はここに混入しない＝偽犠飛の根絶）
        bStat.batting.ab--;
        bStat.batting.sf++;
      }
      outs++;
      fielding.cur.outs++;
      pStat.pitching.outs++;
      // 併殺/フィールダースチョイス/進塁打の分岐・gdpOpp/dpOpp/dpTurned等の統計計上は
      // advanceRunners内（resolveGroundOutAdvance・realism_r1 §A）に集約済み。
      gbDp = ubrCtx.gbDp;
    }
    if (runs > 0) {
      batting.score += runs;
      // 打点は打撃結果の得点(advRuns)のみ・失策と併殺ゴロ間の得点は打点なし（公式準拠・boxscore.mjsと同基準）。
      if (result !== 'E' && !gbDp) bStat.batting.rbi += advRuns;
      pStat.pitching.r += runs;
      pStat.pitching.er += errorInInning ? 0 : runs; // 失策以降は非自責
      fielding.cur.runs += runs;
      fielding.cur.er += errorInInning ? 0 : runs; // 登板ぶんの自責（QS判定用・§B3a）
      if (recordRun) recordRun(); // 得点推移を記録（勝敗判定用）
    }

    // スプリット計上（§B3b・乱数非消費）: 打席の最終結果からデルタを作り、対左右・得点圏・
    // ホーム/ビジターへ配る。トップレベルの生カウント（ab/h/…）と厳密に対応させる。
    {
      const sacFly = ubrCtx.sacFly;
      let dab = 0, dh = 0, d1 = 0, d2 = 0, d3 = 0, dhr = 0, dbb = 0, dhbp = 0, dso = 0, dsf = 0;
      if (result === 'BB') dbb = 1;
      else if (result === 'HBP') dhbp = 1;
      else if (result === '1B') { dab = 1; dh = 1; d1 = 1; }
      else if (result === '2B') { dab = 1; dh = 1; d2 = 1; }
      else if (result === '3B') { dab = 1; dh = 1; d3 = 1; }
      else if (result === 'HR') { dab = 1; dh = 1; dhr = 1; }
      else if (result === 'E') dab = 1; // 失策出塁はAB計上・安打なし（recordBattedBallStatと整合）
      else { // 'out'（三振・凡打・犠飛）
        if (sacFly) dsf = 1; else dab = 1;
        if (outcome === 'K') dso = 1;
      }
      recordPaSplits(bStat.batting, pitcher.throws, battingIsHome, (paBase & 6) !== 0, dab, dh, d1, d2, d3, dhr, dbb, dhbp, dso, dsf);
    }

    // 文脈指標（§B2）: 打席プレー確定＝状態前→状態後（進塁/併殺/得点込み）で ΔRE/ΔWPA/LI を付与。
    // サヨナラ break の前に置き、終端(決着)勝率を正しく計上する（ゼロサム＝勝者±0.5）。
    creditPlay(gc, {
      kind: 'pa',
      battingIsHome,
      inning,
      batSideStat: bStat.batting,
      pitStat: pStat.pitching,
      pitcherCur: fielding.cur,
      firstBatterOfApp: firstBF,
      baseBefore: paBase,
      outsBefore: paOuts,
      baseAfter: baseBits(bases),
      outsAfter: outs,
      runsOnPlay: runs,
      batScoreBefore: paScore,
      fldScore: fielding.score,
    });

    // 観戦実況（§16・乱数非消費）: 打席確定の素データをUIへ。EV/LA/落下点は battedBall から。
    if (fielding.onEvent) {
      fielding.onEvent({
        type: 'pa',
        inning,
        half: battingIsHome ? 'bottom' : 'top',
        batTeam: batting.teamId,
        pitTeam: fielding.teamId,
        batterId,
        pitcherId: fielding.curPid,
        outcome, // 'K'|'BB'|'HBP'|'inPlay'
        result, // 'out'|'1B'|'2B'|'3B'|'HR'|'BB'|'HBP'|'E'
        isIBB,
        battedType: bType, // 'GB'|'LD'|'FB'|'PU'|null
        outsBefore: paOuts,
        outsAfter: outs,
        runsOnPlay: runs,
        sacFly: ubrCtx.sacFly, // 犠飛の唯一の真実（realism_r1 §F-2・UI側の再導出を廃止）
        fc: ubrCtx.fcBatterSafe, // フィールダースチョイス（打者は一塁で生きたがabのみ・§F-2）
        airCatch: gbAirCatch, // GB分類だが実質ライナー捕球（表示は「遊直」等・§realism 2026-07-12）
        basesAfter: baseBits(bases),
        basesPids: bases.slice(), // 塁上走者の playerId（E2・走者名表示）
        batScore: batting.score,
        fldScore: fielding.score,
        bb: battedBall
          ? { evKmh: battedBall.evKmh, laDeg: battedBall.laDeg, sprayDeg: battedBall.sprayDeg, distanceM: battedBall.distanceM, hangTimeS: battedBall.hangTimeS }
          : null,
        // 守備帰属（UI観戦の指標変化表示用・§16）: 打球を処理した野手（hitFielderPosは既存のARM用と同一値を再利用）。
        // 三振/四球等（打球なし）は null。新規乱数消費なし・既存の担当ポジション/選手IDをそのまま渡すだけ。
        fielderPos: hitFielderPos,
        fielderId: hitFielderPos ? fielding.defense[hitFielderPos] : null,
      });
    }

    // 故障（R3・§10.5）: 打席で身体を使った選手（打者/投手/打球を処理した野手/捕手）に露出ハザード。
    //   壊れたら即退場（投手=降板・野手=ベンチと交代。塁上の走者は次のハーフへ持ち越し）。
    rollInGameInjuries(batting, fielding, {
      cfg, rng, statFor, inning, bases, outs,
      batterId,
      fielderPos: hitFielderPos,
    });

    // 代走（§S2-3）: PA解決後、塁上の鈍足走者をベンチ最速と交代
    maybePinchRun(batting, fielding, bases, inning, cfg, statFor);

    // 継投（球数/失点による途中降板。回頭の交代は halfStartPitching が担う）
    if (outs < 3) maybeChangePitcher(fielding, statFor, batting.score, inning, cfg, bases, outs);

    if (walkoff && batting.score > fielding.score) break; // サヨナラ
  }

  // 守備イニング計上（守備側の8人に outs を加算）
  for (const pos of Object.keys(fielding.defense)) {
    statFor(fielding.defense[pos], fielding.teamId).fielding.positionOuts[pos] += outs;
  }
  // 捕手フレーミング（§B1・§7.3）: per-inning 近似（旧 framePerInning）は廃止し、ボーダー球の見逃し判定を
  // 一球単位で創発させる（runPlateAppearance が cLine.frameCalls/framingRuns へ直接加算済み）。ここでは何もしない。
  // DHの出場イニング相当を計上（守備に就かないDHにも守備位置補正 -17.5/1350 を効かせる。
  // 攻撃側ハーフのアウト数＝そのイニング数分の在籍。§9・監査A1）。
  const dhPid = batting.dhSlot >= 0 ? batting.slots[batting.dhSlot].playerId : null;
  if (dhPid) {
    const dl = statFor(dhPid, batting.teamId).fielding.positionOuts;
    dl.DH = (dl.DH || 0) + outs;
  }
}

/** 文脈指標フックの呼び出し（§B2）。gc が無ければ何もしない（乱数非消費・結果不変）。 */
function creditPlay(gc, p) {
  if (gc) gc.onPlay(p);
}

/**
 * カウント別成績の圧縮版へ1打席を計上（§B1-2）。ahead/even/behind（決着直前カウント）＋
 * 通過した 0-2/3-0 の代表セルへ、{pa,ab,h,hr,bb,so} を配る（乱数非消費・最新シーズン内訳表示用）。
 */
function recordByCount(byCount, bucket, passed02, passed30, outcome, result) {
  const dab = outcome === 'BB' || outcome === 'HBP' ? 0 : 1;
  const dh = result === '1B' || result === '2B' || result === '3B' || result === 'HR' ? 1 : 0;
  const dhr = result === 'HR' ? 1 : 0;
  const dbb = outcome === 'BB' ? 1 : 0;
  const dso = outcome === 'K' ? 1 : 0;
  const bump = (c) => {
    c.pa++;
    c.ab += dab;
    c.h += dh;
    c.hr += dhr;
    c.bb += dbb;
    c.so += dso;
  };
  bump(byCount[bucket]);
  if (passed02) bump(byCount.c02);
  if (passed30) bump(byCount.c30);
}

/** スプリット器1つへ1打席ぶんのデルタを加算（§B3b）。 */
function bumpSplit(sl, dab, dh, db1, db2, db3, dhr, dbb, dhbp, dso, dsf) {
  sl.pa++;
  sl.ab += dab;
  sl.h += dh;
  sl.b1 += db1;
  sl.b2 += db2;
  sl.b3 += db3;
  sl.hr += dhr;
  sl.bb += dbb;
  sl.hbp += dhbp;
  sl.so += dso;
  sl.sf += dsf;
}

/**
 * 打席1回ぶんをスプリット器へ計上（§B3b・乱数非消費）。同一デルタを 対左右・得点圏・ホーム/ビジターへ配る。
 * 全打席（通常打席＋犠打）で呼ぶことで vsL.pa+vsR.pa=pa / home.pa+away.pa=pa の恒等が成立する。
 */
function recordPaSplits(bLine, pitcherThrows, isHome, risp, dab, dh, db1, db2, db3, dhr, dbb, dhbp, dso, dsf) {
  const sp = bLine.splits;
  bumpSplit(pitcherThrows === 'L' ? sp.vsL : sp.vsR, dab, dh, db1, db2, db3, dhr, dbb, dhbp, dso, dsf);
  bumpSplit(isHome ? sp.home : sp.away, dab, dh, db1, db2, db3, dhr, dbb, dhbp, dso, dsf);
  if (risp) bumpSplit(sp.risp, dab, dh, db1, db2, db3, dhr, dbb, dhbp, dso, dsf);
}

/** シャットダウン/メルトダウン（§B2）。救援の1登板WPAが ±閾値を超えたら sd/md を計上（加算パス）。 */
function classifyShutdowns(home, away, statFor, cfg) {
  const thr = cfg.tuning.context.sdThreshold;
  for (const side of [home, away]) {
    for (const ap of side.log) {
      if (ap.pid === side.starterId || !(ap.bf > 0)) continue; // 救援の実登板のみ
      const s = statFor(ap.pid, side.teamId).pitching;
      if (ap.wpa >= thr) s.sd++;
      else if (ap.wpa <= -thr) s.md++;
    }
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
  if (batting.onEvent) batting.onEvent({ type: 'sub', kind: 'PH', team: batting.teamId, inning, inPid: pick, outPid: batterId });
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
  if (batting.onEvent) batting.onEvent({ type: 'sub', kind: 'PR', team: batting.teamId, inning, inPid: pick.pid, outPid, basesPids: bases.slice() });
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
  if (side.onEvent) side.onEvent({ type: 'sub', kind: 'DEF', team: side.teamId, inning, inPid: pick.pid, outPid, pos: pick.pos });
}

// --- 犠打の解決（§S2-4） -----------------------------------------------------

/**
 * 犠打を解決。成功=走者進塁・打者アウト・sh++（ABなし・PAあり）、失敗=先頭走者アウト・打者一塁（AB計上）、
 * 内野安打=全員セーフ（AB・H計上）。走者三塁は試行条件で除外済み＝犠打から得点は発生しない。
 * @returns {{outs:number, dab:number, dh:number, d1:number}} 新outs＋スプリット計上用の打席デルタ（§B3b）。
 */
function resolveBunt(batting, fielding, bases, outs, cfg, rng, batterId, bStat, pStat) {
  const t = cfg.tuning.bunt;
  const pc = t.pitches;
  fielding.cur.pitches += pc;
  fielding.cur.bf++;
  // 犠打も機械を通さない＝投球数を別途計上。§B1-2 の恒等を保つため打者側も同数加算（対称に）。lumpedPitches にも計上（率の分母から除外用）。
  pStat.pitching.pitches += Math.round(pc);
  pStat.pitching.lumpedPitches += Math.round(pc);
  bStat.batting.pitches += Math.round(pc);
  bStat.batting.lumpedPitches += Math.round(pc);
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
    return { outs: outs + 1, dab: 0, dh: 0, d1: 0 };
  }
  if (u < t.successProb + t.failProb) {
    // 失敗: フォースが存在する時（打者が一塁へ生きて走者を押し出す＝R1あり）のみ
    // 先頭の強制走者を封殺（フィールダースチョイス＝AB計上・安打なし）。
    // R2単独（R1不在）はフォース不成立＝三塁へのフォースプレーは存在しないため、
    // 打者が普通にアウトになるだけ（走者は動かない・§F-4）。
    if (bases[0]) {
      if (bases[1]) bases[1] = null;
      else bases[0] = null;
      if (bases[0] && !bases[1]) {
        bases[1] = bases[0];
        bases[0] = null;
      }
      bases[0] = batterId;
    }
    bStat.batting.ab++;
    fielding.cur.outs++;
    pStat.pitching.outs++;
    return { outs: outs + 1, dab: 1, dh: 0, d1: 0 };
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
  return { outs, dab: 1, dh: 1, d1: 1 };
}

// --- 故障（R3・§10.5「試合中に壊れる」） -------------------------------------
//
// 打席が終わるたびに「その打席で身体を使った選手」へ露出ハザードを引く（sim/injury.mjs）:
//   打者=スイング・全力疾走 ／ 投手=1人と対戦した肩肘の消耗 ／ 打球を処理した野手=守備機会
//   ／ 捕手=ファウルチップ・ブロッキング（守備側の全打席が露出）。
// 壊れたら **その場で試合から退く**（投手は即降板・野手はベンチと交代）。塁上の走者だけは
// 走塁を終えるまで退場を持ち越す（次のハーフ開始時に交代＝ flushInjuryExits）。
// 真値（能力）はここでは動かさない。離脱の事実だけを onInjury で外へ出し、後遺と故障歴の
// 積み上げはオフシーズンが当季ログを消費して行う（game/injury.mjs・鉄則7の不変量を保つ）。

/** 1人ぶんの露出ハザードを引き、故障したら退場処理まで行う。 */
function tryInjure(side, pid, kind, ctx) {
  if (pid == null) return;
  const p = side.byId.get(pid);
  if (!p || side.retired.has(pid) || side.injuryPending.has(pid)) return;
  const { cfg, rng } = ctx;
  if (!rng.chance(exposureProb(p, kind, cfg))) return;
  const { severity, gamesLost } = rollInjurySeverity(p, cfg, rng);
  // 離脱の事実を外へ（season 層が usage.injuredUntil を立て、二軍から補充する）
  if (side.onInjury) {
    side.onInjury({ playerId: pid, teamId: side.teamId, severity, gamesLost, inning: ctx.inning, cause: kind });
  }
  if (side.onEvent) {
    side.onEvent({ type: 'injury', team: side.teamId, inning: ctx.inning, playerId: pid, severity, gamesLost, cause: kind });
  }
  if (pid === side.curPid) {
    injuryExitPitcher(side, pid, ctx);
    return;
  }
  // 塁上の走者は走塁を終えてから退く（次のハーフ開始時に交代）
  if (ctx.bases && ctx.bases.some((b) => b === pid)) {
    side.injuryPending.add(pid);
    return;
  }
  injuryExitPosition(side, pid, ctx.inning, cfg);
}

/** 負傷した投手を即降板させる（救援が枯れていれば痛みを押して続投＝翌日以降に抹消）。 */
function injuryExitPitcher(side, pid, ctx) {
  const lead = side.score - ctx.oppScore;
  const next = chooseReliever(side, ctx.statFor, ctx.inning, lead, ctx.cfg, {
    baseBits: baseBits(ctx.bases ?? [null, null, null]),
    outs: ctx.outs ?? 0,
  });
  if (!next || next === pid) return;
  flushPitcher(side, ctx.oppScore);
  installPitcher(side, next, ctx.inning, lead);
}

/** 負傷した野手/DHをベンチと交代させる（ベンチが枯れていれば出場継続＝翌日以降に抹消）。 */
function injuryExitPosition(side, pid, inning, cfg) {
  const slot = side.slots.find((s) => s.playerId === pid);
  if (!slot) return; // 既に退場済み（代打等）
  const pos = slot.pos;
  const pick = chooseInjuryReplacement(side, pos, cfg);
  if (!pick) return; // ベンチ枯れ: 痛みを押して出続ける（離脱は翌日以降）
  side.retired.add(pid);
  slot.playerId = pick;
  if (pos !== 'DH' && pos !== 'P') side.defense[pos] = pick;
  removeFromBench(side, pick);
  side.subs.push({ type: 'INJ', inning, outPid: pid, inPid: pick });
  if (side.onEvent) {
    side.onEvent({ type: 'sub', kind: 'INJ', team: side.teamId, inning, inPid: pick, outPid: pid, pos });
  }
}

/** 持ち越された負傷退場（塁上に居た走者）をハーフ開始時に片付ける。 */
function flushInjuryExits(side, inning, cfg) {
  if (!side.injuryPending.size) return;
  for (const pid of [...side.injuryPending]) {
    side.injuryPending.delete(pid);
    injuryExitPosition(side, pid, inning, cfg);
  }
}

/** 打席終了時の故障判定（打者・投手・打球を処理した野手・捕手）。 */
function rollInGameInjuries(batting, fielding, ctx) {
  if (!ctx.cfg.tuning.injury.inSeason.enabled) return;
  tryInjure(batting, ctx.batterId, 'perPA', { ...ctx, oppScore: fielding.score });
  tryInjure(fielding, fielding.curPid, 'perBF', { ...ctx, oppScore: batting.score });
  if (ctx.fielderPos) {
    tryInjure(fielding, fielding.defense[ctx.fielderPos], 'perFieldPlay', { ...ctx, bases: null, oppScore: batting.score });
  }
  tryInjure(fielding, fielding.defense.C, 'perCatcherPA', { ...ctx, bases: null, oppScore: batting.score });
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
  side.cur = { pid, outs: 0, pitches: 0, runs: 0, er: 0, bf: 0, enterDiff: lead, enterInning: inning, wpa: 0 };
  if (side.onEvent) side.onEvent({ type: 'sub', kind: 'RP', team: side.teamId, inning, inPid: pid, outPid });
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
    if (inning >= 9) {
      // 9回以降の続投＝完投狙いは、リード有無に依らず「完封継続中×球数余裕（cgMaxPitches）」
      // のみに絞る（完投の門番・S5較正。大差リード/同点の漫然続投で完投が溢れるのを防ぐ）
      const stay =
        c.runs === 0 && c.outs >= pen.cgMinOuts && c.pitches < Math.min(limit, pen.cgMaxPitches);
      change = due || !stay;
    } else if (saveSitu) {
      const stay = c.runs <= pen.starterStayRuns && c.pitches < limit; // 好投中の先発は7-8回を任せる
      change = due || !stay;
    } else {
      change = due;
    }
  } else {
    const due = c.outs >= relieverMaxOutsFor(fielding, c.pid, pen) || c.runs >= pen.relieverMaxRuns;
    change = due || saveSitu; // セーブ機会は回頭で適役へ繋ぐ（8回setup8→9回closer等）
  }
  if (!change) return;
  const next = chooseReliever(fielding, statFor, inning, lead, cfg);
  if (!next || next === c.pid) return;
  flushPitcher(fielding, oppScore);
  installPitcher(fielding, next, inning, lead);
}

/** 救援の役割別イニング上限（アウト数）。long=敗戦処理は長め・勝ちパターン役割は1イニング・
 *  middle（非役割）は複数イニング可＝同じ救援IPを少ない登板数で消化する（登板数王の圧縮・S5較正）。 */
function relieverMaxOutsFor(fielding, pid, pen) {
  const r = fielding.roles;
  if (pid === r.long) return pen.longOuts;
  if (pid === r.closer || pid === r.setup8 || pid === r.setup7) return pen.relieverMaxOuts;
  return pen.middleMaxOuts;
}

/** イニング途中の降板判定（球数・失点）。回頭の交代は halfStartPitching が担う。
 *  bases/outs を継投判断（レバレッジ駆動・§8.3 D4）へ渡す＝走者を背負った火消しで最良救援を投入。 */
function maybeChangePitcher(fielding, statFor, oppScore, inning, cfg, bases, outs) {
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
    remove = c.outs >= relieverMaxOutsFor(fielding, c.pid, pen) || c.runs >= pen.relieverMaxRuns;
  }
  if (!remove) return;

  const lead = fielding.score - oppScore;
  const next = chooseReliever(fielding, statFor, inning, lead, cfg, { baseBits: baseBits(bases), outs });
  if (!next || next === c.pid) return;
  flushPitcher(fielding, oppScore);
  installPitcher(fielding, next, inning, lead);
}

/** 現投手のゲーム成績を log に確定（実登板のみ・幽霊リリーフ除外）。
 *  実登板の判定は「対戦打者あり(bf>0) または 記録アウトあり(outs>0)」。
 *  後者は回頭で登板し打者と対戦する前に盗塁死で第3アウトを記録した投手を拾う
 *  （outs>0 だが bf=0 で log から欠落する幽霊登板を防止・IPと登板Gの整合）。
 *  exitDiff=退場時の投手側リード差（ホールド/ブローンセーブ判定用・監査B3）。 */
function flushPitcher(side, oppScore) {
  if (side.cur.bf > 0 || side.cur.outs > 0) {
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

  // クオリティスタート（§B3a）: 先発が6IP=18アウト以上を投げ、その登板の自責3以下。勝敗に依らず計上。
  for (const side of [home, away]) {
    const st = side.log.find((a) => a.pid === side.starterId);
    if (st && st.outs >= 18 && (st.er ?? st.runs) <= 3) statFor(side.starterId, side.teamId).pitching.qs++;
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

// ============================================================================
// 打席解決の規律層（1-1）— 2段パイプラインの第1段（§3.1 / 自己レビュー F29）
//
// ここでは打者能力 vs 投手能力を log5/オッズ比で合成し、打席の分岐だけを決める:
//   { K(三振) / BB(四球) / HBP(死球) / IN_PLAY(インプレー=打球化) }
// 安打/アウト/長打は決めない。IN_PLAY は第2段(1-2/1-3 EV/LA→球場→守備)へ渡す。
// 「結果を先に決めてゾーンを後付け」を避け、決定権をこの1箇所に閉じる。
// ============================================================================
import { logit, expit, ratingDelta } from './rates.mjs';
import { pitchClass } from '../model/positions.mjs';
import { isSameHand } from '../model/player.mjs';
import { clamp } from '../model/util.mjs';
import { selectPitchByCount } from './pitchGrid.mjs';
import { generateBattedBall } from './battedBall.mjs';

export const PA_OUTCOME = { K: 'K', BB: 'BB', HBP: 'HBP', IN_PLAY: 'inPlay' };

/** 投手の平均空振り資質（球種whiffの平均）。球種未設定なら平均50。 */
function meanWhiff(pit) {
  const arr = pit.pitches;
  if (!arr || arr.length === 0) return 50;
  let s = 0;
  for (const p of arr) s += p.whiff;
  return s / arr.length;
}

/**
 * 打席の分岐確率（pK, pBB, pHBP）を log5 合成で算出。IN_PLAY は残余。
 * @returns {{pK:number, pBB:number, pHBP:number, pInPlay:number}}
 */
export function paProbabilities(batter, pitcher, cfg, tto = 0, pitch = null) {
  const pa = cfg.tuning.pa;
  const b = batter.trueAbility.batting;
  const p = pitcher.trueAbility.pitching;

  // --- 左右プラトーン（S1・M7解消）: 同利き（スイッチは常に有利側=逆打席）で K↑ BB↓ ---
  const pl = cfg.tuning.platoon;
  const same = pl && isSameHand(batter, pitcher);

  // --- K: 打者のK傾向（コンタクト/選球眼＋対該当球種クラス適性）×投手の奪三振資質 ---
  // 球種格子(§4段階1): pitch があればその球種の whiff を使い、打者の対クラス適性で補正。
  const whiffVal = pitch ? pitch.whiff : meanWhiff(p);
  let aptAdj = 0;
  if (pitch) {
    const apt = pitchClass(pitch.type) === 'fastball' ? b.vsFastball : b.vsBreaking;
    aptAdj = pa.whiffAptW * (apt - 50); // 適性高い→Kしにくい
  }
  // 巡目(tto)が進むほど打者はK を回避しやすい（§3.3）。
  const kProne = 50 - pa.kContactW * (b.contact - 50) - pa.kEyeW * (b.eye - 50) - aptAdj;
  const kStuff = whiffVal + pa.kVeloPerKmh * (p.velocityKmh - 146);
  let pK = expit(
    logit(pa.kLeague) +
      ratingDelta(kProne, pa.kSlope) +
      ratingDelta(kStuff, pa.kSlope) -
      tto * cfg.tuning.tto.kPerTime +
      (same ? pl.kLogitSame : 0),
  );

  // --- BB: 打者選球眼（高→増）×投手制球（高→減） ---
  let pBB = expit(
    logit(pa.bbLeague) +
      ratingDelta(b.eye, pa.bbSlope) -
      ratingDelta(p.control, pa.bbSlope) +
      (same ? pl.bbLogitSame : 0),
  );

  // --- HBP: 小。投手制球が低いほどわずかに増 ---
  let pHBP = expit(logit(pa.hbpLeague) - ratingDelta(p.control, pa.hbpSlope));

  // 端の組み合わせで合計が1に近づき過ぎないようガード（IN_PLAY を最低限残す）
  const sum = pK + pBB + pHBP;
  const cap = 0.95;
  if (sum > cap) {
    const s = cap / sum;
    pK *= s;
    pBB *= s;
    pHBP *= s;
  }
  return { pK, pBB, pHBP, pInPlay: 1 - pK - pBB - pHBP };
}

/**
 * 打席の分岐を1回抽選（決定論・rng使用）。
 * @returns {'K'|'BB'|'HBP'|'inPlay'}
 */
export function resolvePADiscipline(batter, pitcher, cfg, rng, tto = 0, pitch = null) {
  const { pK, pBB, pHBP } = paProbabilities(batter, pitcher, cfg, tto, pitch);
  const u = rng.next();
  if (u < pK) return PA_OUTCOME.K;
  if (u < pK + pBB) return PA_OUTCOME.BB;
  if (u < pK + pBB + pHBP) return PA_OUTCOME.HBP;
  return PA_OUTCOME.IN_PLAY;
}

// ============================================================================
// B1: (balls, strikes) カウント状態機械（§B1-1）
//
// 1打席を1球ずつ回し、3ストライク=K / 4ボール=BB / 死球=HBP / 接触=インプレー を「創発」させる。
// 各一球で pitches/swings/whiffs/fouls/calledStrikes/zone/oZone/…/ballsInDirt を打者・投手の
// 生カウントへ直接加算する（使い捨てオブジェクトを作らない・§B1-4 性能）。
// インプレーが出たら既存の generateBattedBall を呼ぶ（EV/LA/方向パイプラインは不変）。
// ============================================================================

// 走者塁状態のビット化（0..7）。game.mjs と同義（重複定義・importを増やさない）。
function baseBits(bases) {
  return (bases[0] ? 1 : 0) | (bases[1] ? 2 : 0) | (bases[2] ? 4 : 0);
}

/** ワンバウンド球が抜けた時の走者進塁（全員1つ・三塁は生還）。得点数を返し bases を破壊更新。 */
function advanceOnWildPitch(bases) {
  let runs = 0;
  if (bases[2]) { runs++; bases[2] = null; } // 三塁→生還
  if (bases[1]) { bases[2] = bases[1]; bases[1] = null; } // 二塁→三塁
  if (bases[0]) { bases[1] = bases[0]; bases[0] = null; } // 一塁→二塁
  return runs;
}

// 一球ごとに使い捨てオブジェクトを作らないための、単一の再利用結果構造体（単スレッド・即時消費）。
const PA_RESULT = {
  outcome: null, // 'K'|'BB'|'HBP'|'inPlay'
  battedBall: null, // インプレー時の BattedBall（それ以外 null）
  decisiveClass: null, // 決着球のクラス（'fastball'|'breaking'）＝対球種スプリット計上用
  pitches: 0, // この打席の投球数
  wpRuns: 0, // 打席中の暴投/捕逸で入った得点（打者の得点機会外・game側で加点）
  countBucket: 'even', // byCount 圧縮分類（ahead/even/behind）
  passed02: false, // 0-2 を通過したか
  passed30: false, // 3-0 を通過したか
};

/**
 * 1打席をカウント状態機械で解決する（§B1-1）。
 * @param {Object} env {batter,pitcher,catcher, cfg,rng, tto, bLine,pLine,cLine, bases, outs}
 *   bLine=打者 battingLine / pLine=投手 pitchingLine / cLine=捕手 fieldingLine(なければnull)
 *   bases=[1B,2B,3B]（暴投判定・インプレー塁状態に使う。WPで破壊更新されうる）
 * @returns {typeof PA_RESULT} 再利用構造体（呼び出し側は即座に読み出すこと）
 */
export function runPlateAppearance(env) {
  const { batter, pitcher, catcher, cfg, rng, tto, bLine, pLine, cLine, bases } = env;
  // 観戦の一球速報フック（フェーズE2・§16）: 存在するときのみ各投球の確定点で
  // (n, 球種, 判定, ボール, ストライク, 暴投走者進塁) を通知する。gc/onEvent と同じ流儀で
  // 乱数は一切消費しない＝onPitch の有無で打席結果・シーズン結果は不変（決定論の門番は verify）。
  const onPitch = env.onPitch ?? null;
  const K = cfg.tuning.pitch;
  const bat = batter.trueAbility;
  const pit = pitcher.trueAbility.pitching;
  const same = cfg.tuning.platoon && isSameHand(batter, pitcher);
  const framing = catcher ? catcher.trueAbility.fielding.framing : 50;
  const blocking = catcher ? (catcher.trueAbility.fielding.blocking ?? 50) : 50;

  let balls = 0;
  let strikes = 0;
  let nPitches = 0;
  let wpRuns = 0;
  let passed02 = false;
  let passed30 = false;
  let firstPitchStrike = false; // 初球がストライク(見逃し/空振り/ファウル/インプレー)なら true

  const R = PA_RESULT;
  R.outcome = null;
  R.battedBall = null;
  R.decisiveClass = null;
  R.wpRuns = 0;

  while (true) {
    if (balls === 0 && strikes === 2) passed02 = true;
    if (balls === 3 && strikes === 0) passed30 = true;

    // (a) 球種選択（カウント依存）
    const pitch = selectPitchByCount(pitcher, rng, cfg, balls, strikes);
    const cls = pitch ? pitchClass(pitch.type) : 'fastball';
    const ptype = pitch ? pitch.type : 'fastball'; // 一球速報の球種表示（E2・乱数非消費）
    const whiffVal = pitch ? pitch.whiff : 50;
    const apt = cls === 'fastball' ? bat.batting.vsFastball : bat.batting.vsBreaking;
    nPitches++;
    bLine.pitches++;
    pLine.pitches++;

    // (b) ロケーション帯: ゾーン内率 = f(control, カウント)
    let zone = K.zoneBase + K.zoneControlW * (pit.control - 50);
    if (strikes === 2 && balls < 2) zone += K.zoneAheadW; // 0-2,1-2 → ボールで釣る
    else if (balls === 3) zone += K.zoneBehindW; // 3-x → ゾーンへ置きにいく
    else if (balls === 2 && strikes === 0) zone += K.zoneBehindW * 0.6; // 2-0
    else if (balls > strikes) zone += K.zoneEvenBehindW; // 軽いビハインド
    zone = clamp(zone, 0.15, 0.85);
    const border = (1 - zone) * K.borderShare;
    const u1 = rng.next();
    const band = u1 < zone ? 0 : u1 < zone + border ? 1 : 2; // 0=ゾーン,1=ボーダー,2=明確ボール

    if (band === 0) { bLine.zonePitches++; pLine.zonePitches++; }
    else if (band === 2) { bLine.oZonePitches++; pLine.oZonePitches++; }

    // (f) HBP: 明確ボール（内角外れ）の低確率イベント
    if (band === 2) {
      const pHbp = K.hbpPerClearBall * (1 + K.hbpControlW * (50 - pit.control));
      if (rng.next() < pHbp) {
        if (onPitch) onPitch(nPitches, ptype, 'hbp', balls, strikes, false);
        R.outcome = 'HBP'; R.decisiveClass = cls; break;
      }
    }

    // (c) スイング判断: Swing% = f(帯, eye, カウント)
    let pSwing;
    if (band === 0) pSwing = K.zSwingBase - K.swingZoneEyeW * (bat.batting.eye - 50);
    else if (band === 1) pSwing = K.bSwingBase - K.swingEyeW * (bat.batting.eye - 50);
    else pSwing = K.oSwingBase - K.swingEyeW * (bat.batting.eye - 50) + (same ? K.platoonOSwingSame : 0);
    if (strikes === 2) pSwing += K.twoStrikeSwingW; // 2ストライクの保護スイング
    if (balls === 3 && strikes === 0) pSwing -= K.threeOhTakeW; // 3-0は自重
    pSwing = clamp(pSwing, 0.01, 0.99);
    const swung = rng.next() < pSwing;

    if (swung) {
      bLine.swings++; pLine.swings++;
      if (band === 0) { bLine.zSwings++; pLine.zSwings++; }
      else if (band === 2) { bLine.oSwings++; pLine.oSwings++; }
      // (d) 空振り率 = f(球種whiff, contact, 帯, 適性)
      const base = band === 0 ? K.whiffZoneBase : band === 1 ? K.whiffBorderBase : K.whiffOBase;
      let pWhiff =
        base +
        K.whiffPitchW * (whiffVal - 50) -
        K.whiffContactW * (bat.batting.contact - 50) -
        K.whiffAptW * (apt - 50) +
        (same ? K.platoonWhiffSame : 0) -
        tto * K.ttoWhiff;
      // 2ストライクの「当てにいく」短縮スイング＝空振り減・コンタクト増（ファウルで粘り→投球数増・§B1-3）。
      if (strikes === 2) pWhiff -= K.whiffTwoStrikeW;
      pWhiff = clamp(pWhiff, 0.01, 0.95);
      if (rng.next() < pWhiff) {
        bLine.whiffs++; pLine.whiffs++;
        if (band === 0) { bLine.zWhiffs++; pLine.zWhiffs++; }
        else if (band === 2) { bLine.oWhiffs++; pLine.oWhiffs++; }
        if (nPitches === 1) firstPitchStrike = true;
        strikes++;
        if (onPitch) onPitch(nPitches, ptype, 'whiff', balls, strikes, false);
        if (strikes >= 3) { R.outcome = 'K'; R.decisiveClass = cls; break; }
      } else {
        // 接触: ファウル vs インプレー（2ストライクのファウルはカウント維持）
        let pFoul = K.foulBase + (strikes === 2 ? K.foulTwoStrikeW : 0);
        pFoul = clamp(pFoul, 0.05, 0.95);
        if (rng.next() < pFoul) {
          bLine.fouls++; pLine.fouls++;
          if (nPitches === 1) firstPitchStrike = true;
          if (strikes < 2) strikes++;
          if (onPitch) onPitch(nPitches, ptype, 'foul', balls, strikes, false);
        } else {
          // インプレー → 既存の打球パイプライン（不変）
          R.battedBall = generateBattedBall(batter, pitcher, cfg, rng, {
            baseState: baseBits(bases), outs: env.outs, tto, pitch,
          });
          R.outcome = 'inPlay';
          R.decisiveClass = cls;
          if (nPitches === 1) firstPitchStrike = true;
          if (onPitch) onPitch(nPitches, ptype, 'inplay', balls, strikes, false);
          break;
        }
      }
    } else {
      // (e) 見逃し: ゾーン内=ストライク / ボーダー=フレーミング判定 / 外=ボール
      if (band === 0) {
        bLine.calledStrikes++; pLine.calledStrikes++;
        if (nPitches === 1) firstPitchStrike = true;
        strikes++;
        if (onPitch) onPitch(nPitches, ptype, 'called', balls, strikes, false);
        if (strikes >= 3) { R.outcome = 'K'; R.decisiveClass = cls; break; }
      } else if (band === 1) {
        const pCS = clamp(K.borderCsBase + K.frameSlopePerPt * (framing - 50), 0.02, 0.98);
        const gotStrike = rng.next() < pCS;
        if (cLine) {
          const delta = (gotStrike ? 1 : 0) - K.borderCsBase; // 中立捕手(framing50)対比
          cLine.frameCalls += delta;
          cLine.framingRuns += delta * K.runPerCall; // per-inning近似の置換（§7.3）
        }
        if (gotStrike) {
          bLine.calledStrikes++; pLine.calledStrikes++;
          if (nPitches === 1) firstPitchStrike = true;
          strikes++;
          if (onPitch) onPitch(nPitches, ptype, 'called', balls, strikes, false);
          if (strikes >= 3) { R.outcome = 'K'; R.decisiveClass = cls; break; }
        } else {
          balls++;
          if (onPitch) onPitch(nPitches, ptype, 'ball', balls, strikes, false);
          if (balls >= 4) { R.outcome = 'BB'; R.decisiveClass = cls; break; }
        }
      } else {
        // 明確ボール: (g) ワンバウンド球×捕手blocking → 暴投/捕逸
        let wild = false; // 一球速報用（後逸で走者進塁したか・乱数非消費）
        if (cls === 'breaking' && rng.next() < K.dirtBaseBreaking) {
          bLine.ballsInDirt++; pLine.ballsInDirt++;
          if (bases[0] || bases[1] || bases[2]) {
            if (cLine) cLine.blockOpp++;
            const pPass = clamp(K.wildBase - K.blockSlopePerPt * (blocking - 50), 0.02, 0.9);
            if (rng.next() < pPass) {
              if (cLine) { if (rng.next() < K.wpShare) cLine.wp++; else cLine.pb++; }
              else rng.next(); // 捕手不在でも乱数消費数を一定に
              wpRuns += advanceOnWildPitch(bases);
              wild = true;
            }
          }
        }
        balls++;
        if (onPitch) onPitch(nPitches, ptype, 'ball', balls, strikes, wild);
        if (balls >= 4) { R.outcome = 'BB'; R.decisiveClass = cls; break; }
      }
    }
  }

  if (firstPitchStrike) { bLine.firstPitchStrikes++; pLine.firstPitchStrikes++; }
  R.pitches = nPitches;
  R.wpRuns = wpRuns;
  R.passed02 = passed02;
  R.passed30 = passed30;
  // byCount 圧縮分類（決着直前カウント balls vs strikes）
  R.countBucket = balls > strikes ? 'ahead' : balls < strikes ? 'behind' : 'even';
  return R;
}

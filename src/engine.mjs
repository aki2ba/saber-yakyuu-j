// ============================================================================
// 架空選手ペナント・シミュレーション — エンジン核（ESモジュール・単一エントリ）
//
// このファイルが「唯一の真実のソース」。
//   - Node（ヘッドレス実走 / テスト / 較正）  : そのまま import して使う
//   - ブラウザ（配布用の自己完結HTML）        : tools/build.mjs が本ファイルを
//                                               単一HTMLへインライン化して同梱する
// 開発中はブラウザも `import` で本ファイルを直接読み込んでよい（配布時のみ結合）。
//
// 決定論RNG（階層シード/Box-Muller/直列化）は src/rng.mjs（0-5）に集約。
// selfCheck は Node↔ブラウザ同一性の門番として据え置き（verify-identity.mjs が検証）。
// ============================================================================

import { mulberry32, makeRng, hashSeed, rngFor, serializeRng, deserializeRng } from './rng.mjs';
import { POSITIONS, FIELD_POSITIONS, POSITION_ADJUST_PER_1350, POSITION_DIFFICULTY, PITCH_TYPES, FASTBALL_TYPES, pitchClass } from './model/positions.mjs';
import { createPlayer, createTrueAbility, createPitch, validatePlayer, effectiveBats, isSameHand } from './model/player.mjs';
import { createBattedBall, createBallpark, NEUTRAL_PARK, fenceDistanceAt } from './model/battedball.mjs';
import { createPlayerSeason, createTeamSeason, addPlayerSeason, createSplitLine } from './model/statline.mjs';
import {
  CONFIG_VERSION, createConfig, createLeagueConstants, CALIBRATION_TARGETS,
  qualifiedPA, qualifiedIP, fieldingInningsFull, inRange,
} from './config.mjs';
import { generateLeague, generateTeam, generatePitcher, generateFielder, generateName, generateManager, generatePark, buildParkFromDeviations, generateFarmPlayers, devCountFor, TEAM_COLORS, TEAM_ABBR } from './generate.mjs';
import { logit, expit, ratingDelta, log5 } from './sim/rates.mjs';
import { PA_OUTCOME, paProbabilities, resolvePADiscipline, runPlateAppearance } from './sim/plateAppearance.mjs';
import { generateBattedBall } from './sim/battedBall.mjs';
import { battedType, computeGeometry, assignFielder, resolveBattedBall } from './sim/battedBallResult.mjs';
import {
  fieldingChances, neutralResponsible, outProb, smaxOf, fielderPositions, runnerToFirst,
  FIELD_POS, FG_INFIELD, FG_OUTFIELD, IS_OUTFIELD,
} from './sim/fieldingGeometry.mjs';
import { selectPitch, selectPitchByCount } from './sim/pitchGrid.mjs';
import { buildDepthChart, selectActiveRoster, hitScore, obpScore, powerScore, starterScore, relieverScore } from './sim/team.mjs';
import {
  neutralManager, buildPregameEval, availableRelievers, observedWoba, stealLogitAdjust,
  buntAttemptProb, ibbProb, choosePinchHitter, choosePinchRunner, chooseDefensiveSub,
  chooseReliever, starterPitchLimit,
} from './sim/manager.mjs';
import { simulateGame, advanceRunners } from './sim/game.mjs';
import { simulateSeason, buildSchedule, winPct, gamesBehind } from './sim/season.mjs';
import { makeDeriveContext, makeAccumulateContext, deriveTables, gameOverAfter } from './sim/context.mjs';
import {
  createUsageState, blendedWoba, selectStarter, selectLineup, bullpenAvailable,
  recordGameUsage, reviewAssignments,
} from './sim/usage.mjs';
import { simulatePostseason } from './sim/postseason.mjs';
import { leagueBatting, leaguePitching, leagueSummary, leagueSummaryByLeague } from './sim/leagueStats.mjs';
import { deriveLeagueConstants, fillLeagueConstants, rawRunValuePerPA, LINEAR_WEIGHTS } from './sim/leagueConstants.mjs';
import { deriveParkFactors, parkFactorSpread } from './sim/parkFactor.mjs';
import { playerBatting, playerPitching, playerBaserunning, battingSplits, playerFielding, pythag } from './sim/metrics.mjs';
import { rangeRating, mainPosition, uzrRuns, centeredOAAOuts, totalFieldInnings, errRunsAboveAvg, uzrComponents, armRunsAboveAvg, dprRunsAboveAvg, catcherRsbRuns } from './sim/fielding.mjs';
import { hitterWAR, pitcherWAR, playerWAR, posAdjRuns } from './sim/war.mjs';
import { isBarrel } from './sim/battedBallStats.mjs';

// F2-2: 出場登録29人（一軍デプスチャート=登録者のみ）＋二軍リーグ並走＝エンジン挙動が 0.9.1 から
//   変わる（verify-identity/smoke の新ベースラインは F2-5 の再較正確定後に取得する）。
export const ENGINE_VERSION = '0.10.0-farm';

// RNG・モデル層・config・生成器 を再エクスポート（Node/ブラウザ双方の単一エントリ）
export {
  mulberry32, makeRng, hashSeed, rngFor, serializeRng, deserializeRng,
  POSITIONS, FIELD_POSITIONS, POSITION_ADJUST_PER_1350, POSITION_DIFFICULTY, PITCH_TYPES, FASTBALL_TYPES, pitchClass,
  selectPitch, selectPitchByCount,
  createPlayer, createTrueAbility, createPitch, validatePlayer, effectiveBats, isSameHand,
  createBattedBall, createBallpark, NEUTRAL_PARK, fenceDistanceAt,
  createPlayerSeason, createTeamSeason, addPlayerSeason, createSplitLine,
  CONFIG_VERSION, createConfig, createLeagueConstants, CALIBRATION_TARGETS,
  qualifiedPA, qualifiedIP, fieldingInningsFull, inRange,
  generateLeague, generateTeam, generatePitcher, generateFielder, generateName, generateManager, generatePark, buildParkFromDeviations, generateFarmPlayers, devCountFor, TEAM_COLORS, TEAM_ABBR,
  logit, expit, ratingDelta, log5,
  PA_OUTCOME, paProbabilities, resolvePADiscipline, runPlateAppearance,
  generateBattedBall, battedType, computeGeometry, assignFielder, resolveBattedBall,
  fieldingChances, neutralResponsible, outProb, smaxOf, fielderPositions, runnerToFirst, FIELD_POS, FG_INFIELD, FG_OUTFIELD, IS_OUTFIELD,
  buildDepthChart, selectActiveRoster, hitScore, obpScore, powerScore, starterScore, relieverScore,
  neutralManager, buildPregameEval, availableRelievers, observedWoba, stealLogitAdjust,
  buntAttemptProb, ibbProb, choosePinchHitter, choosePinchRunner, chooseDefensiveSub,
  chooseReliever, starterPitchLimit,
  simulateGame, advanceRunners,
  simulateSeason, buildSchedule, winPct, gamesBehind,
  makeDeriveContext, makeAccumulateContext, deriveTables, gameOverAfter,
  createUsageState, blendedWoba, selectStarter, selectLineup, bullpenAvailable,
  recordGameUsage, reviewAssignments,
  simulatePostseason,
  leagueBatting, leaguePitching, leagueSummary, leagueSummaryByLeague,
  deriveLeagueConstants, fillLeagueConstants, rawRunValuePerPA, LINEAR_WEIGHTS,
  deriveParkFactors, parkFactorSpread,
  playerBatting, playerPitching, playerBaserunning, battingSplits, playerFielding, pythag,
  rangeRating, mainPosition, uzrRuns, centeredOAAOuts, totalFieldInnings, errRunsAboveAvg,
  uzrComponents, armRunsAboveAvg, dprRunsAboveAvg, catcherRsbRuns,
  hitterWAR, pitcherWAR, playerWAR, posAdjRuns,
  isBarrel,
};

// --- エンジン同一性の門番 ---------------------------------------------------
// 同一シードで固定長の決定論列を返す。Node出力と、build.mjs がHTMLへインライン化した
// ブラウザ相当の出力が完全一致することを verify-identity.mjs が機械検証する。
// （§17 決定論RNG / §19 全国対戦のチート突合 の再現性を、開発初日から担保するため）
export function selfCheck(seed = 20260701, n = 8) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) out.push(Math.round(rnd() * 1e9));
  return out;
}

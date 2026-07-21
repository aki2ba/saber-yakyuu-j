// ============================================================================
// フェーズC1a: ヘッドレス・ゲームループAPI（UI非依存・node --test でキャリアを回せる）
//
//   newGame(masterSeed, playerTeamId, options) → GameState
//   advanceDay(state)            … 1日（節）進める
//   advanceTo(state, until)      … until='nextPlayerGame'|'weekEnd'|'monthEnd'|'seasonEnd'
//   save(state) → JSON安全オブジェクト（schemaVersion付き・RNG座標込み）
//   load(blob)  → GameState（開幕から cursor まで replay して決定論復元）
//
// 設計原則（phaseC_spec）:
//   - エンジンとUIの分離: ここは表示を持たない。UI は本APIの状態を描くだけ。
//   - エンジンを壊さない: 1年目のレギュラーシーズンは seed=masterSeed で simulateSeason と bit 同一。
//   - 決定論維持: 乱数は階層シード rng のみ。人間介入は interventions ログに積む（C1a は空・構造のみ）。
//   - 三層構造: プレイヤーに真値は出さない（本APIは観測集計 stats と順位のみを返す）。
// ============================================================================
import { hashSeed } from '../rng.mjs';
import { createConfig } from '../config.mjs';
import { generateLeague, assignPersonality } from '../generate.mjs';
import { ENGINE_VERSION } from '../engine.mjs';
import { startSeasonRuntime, advanceRuntimeDay, pendingDay, carryOverInjuries } from './season_runtime.mjs';
import { applyAging } from './aging.mjs';
import { applySeasonInjuries } from './injury.mjs';
import { applyBreakouts } from './breakout.mjs';
import { runRetirement, rebuildTeamRosters } from './roster.mjs';
import { marketStage1, marketStage2, runDraft, teamEvalProfile, teamWindowState, draftScoutView, draftPreviewHeadlines } from './market.mjs';
import { applyFarmPromotionSwap } from './roster_moves.mjs';
import { encodeSeasons, decodeSeasons } from './statcodec.mjs';
import { runFA, runTrades, runReleaseAndPickup, runContractRenewal, releaseScore } from './transactions.mjs';
// H5-A: 経営レイヤー第1段階（年俸予算）。team.finance の再計算＋旧セーブ補完（phaseH_fun_spec H5-A）。
import { refreshTeamFinance, updateFanEconomy } from './finance.mjs';
import { computeEra, eraSeasonConfig, teamBalanceBoost } from './era.mjs';
// C4 演出: 表彰/記録/二つ名（awards.mjs）・ニュース/珍記録検出（news.mjs）。
//   advanceYear で完了シーズンの表彰を計算し off.awards として返す（ニュース素材）。
//   ここで import することでバンドル（build.mjs のグラフ）にも同梱され、UI から
//   グローバル参照できる（下段の re-export は開発時 Node 解決／UI import 用）。
import {
  computeSeasonAwards, playerAwardHistory, nicknameFor, evalSeason,
  leagueRecords, teamRecords, championCounts, milestones,
  careerBatting, careerPitching, careerEraPlus, DEF_AWARD_NAME, TITLE_LABELS,
  mediaReputation, REPUTATION_LABELS, careerRispEdge, careerBaserunning,
} from './awards.mjs';
import { detectGameNotables, notableHeadline, streakOf, weeklyDigest, rosterMoveHeadline } from './news.mjs';
// H1: ストーリーライン（連続ニュース・ライバル・引退ロード・phaseH_fun_spec H1）。表示層のみ
//   （エンジン非干渉）。advanceYear が transactionLog 追記＋引退セレモニー整形を行う。
import { appendTransactionLog, retirementCeremonies } from './storylines.mjs';
// H4: 育成方針・キャンプ（phaseH_fun_spec H4）。方針の意味論(parsePolicy)・AI自動方針・
//   「コーチの見立て」観測スカラー(coachOverallScore・キャンプ成果の前後差に使う)。
import { parsePolicy, coachOverallScore, TRAINING_LABELS, TRAINING_KINDS } from './training.mjs';
import { generateOwnerGoals, evaluateOwnerGoals, trustDelta, pickTransferOffer } from './owner.mjs'; // H5-B
import { clamp } from '../model/util.mjs';

/** セーブスキーマ版（構造/オフシーズン意味論の変更時にインクリメント。load の互換判定に使う）。
 *  v2（C2b）: オフシーズン遷移が加齢のみ→故障/ブレイク/引退/新人補充の完全版に拡張。
 *  真値/ロスターは §17 に従い save に含めず masterSeed から replay 再構築するため、v1 の
 *  「加齢のみ」replay とは復元結果が異なる。→ v1 セーブは明示的に弾く（誤復元を防ぐ）。
 *  v3（F2-2）: 出場登録29人＋二軍リーグ導入。一軍デプスチャートが70人全員→登録29人からの編成に
 *  変わり season replay の結果が v2 と非互換（＝v2 セーブは明示拒否）。セーブに二軍の順位/集計
 *  （seasonState.farm / farmPlayers / careerFarmStats）を追加。
 *  ★v4（R5・前史 burn-in 30年）: **復元方式を「過去オフの再計算」から「開幕時点のリーグを直接保存」へ変更**。
 *    理由: 前史30年を回すと、過去オフの再計算に必要な careerStats が30年ぶん（引退者含む全員）必要になり
 *    save が100MB級に膨らむ。ユーザー判断で「前史で引退した選手の記録は保持しない」としたため、
 *    再計算の入力そのものが失われる＝replay 方式が原理的に成立しない。
 *    真値をセーブに含めることになるが、**情報漏洩は増えない**（masterSeed が既にセーブにあり、
 *    そこから同じ真値を再生成できる）。むしろ replay 由来の復元ズレ（実際に2度踏んだ）が構造的に消える。 */
export const SCHEMA_VERSION = 4;

// --- 年ごとのシード（1年目=masterSeed で simulateSeason と同一。2年目以降は派生） -------
function seasonSeed(state) {
  return state.yearIndex === 0 ? state.masterSeed : hashSeed(state.masterSeed, 'season', state.yearIndex);
}

/** 年 y→y+1 のオフシーズン加齢シード（決定論・load の replay と live で同一）。 */
function offseasonSeed(masterSeed, yearIndex) {
  return hashSeed(masterSeed, 'offseason', yearIndex);
}

/**
 * オフシーズン遷移の中核（C2b＋C3a＋C3b）: 完了年 yearIndex の全選手に対し、決定論的な順序で
 * 状態遷移を適用し、league.players/farm/teams を翌年開幕の状態へ張り替える。live の advanceYear と
 * load の replay の両方から「同一 (masterSeed, yearIndex, year, careerStats, marketInterventions)」で
 * 呼ばれ bit 一致する（多年セーブの決定論）。
 *
 * 順序（phaseC_spec C3b）: 故障→ブレイク→加齢→**引退→FA→トレード→ドラフト/育成→戦力外/拾い上げ
 * →契約更改**。各フェーズは独立の階層シード座標（'injury'/'breakout'/'offseason'/'retire'/'draft'/
 * 'fa'/'trade'/'release' 等）を使う。FA/トレードは引退後の生存者を同型1:1でスワップ（構成恒常）し、
 * 補充ドラフトの空き枠（＝引退枠）には影響しない。戦力外/拾い上げはドラフト後の全支配下から同型循環で
 * 再分配する。三層構造: 入札/受諾/拾い上げの査定は evaluateProspect（観測＋スカウト＋球団の癖）、
 * 放出判定だけ "実観測"（当年 statline＝出場機会依存）で下す（§12.2）。
 *
 * @param {Array} careerStats 全完了シーズンの選手集計（当年 statline を season==year で絞って観測に使う）
 * @param {Array} marketInterventions プレイヤーの市場操作ログ（FA入札/トレード起案・当年ぶんを適用）
 * @returns {Object} オフシーズン要約（injuries/breakouts/retirees/rookies/promotions/draftLog/fa/trades/pickups/contracts）
 */
/**
 * R7（決定2・draft_timeline_evidence）: ドラフトを「大量に獲って淘汰する」構造にするための
 * 追加戦力外。引退枠だけでは NPB実態（支配下約10人/球団年の入れ替わり）に届かないため、
 * 伸び悩んだ若手（cullMinAge-cullMaxAge・真の新人/確立ベテランは対象外）を当季実観測の低い順に
 * 追加で戦力外にし、そのぶんの枠もドラフトで埋める（70人枠は不変＝1:1同型・淘汰が生まれる）。
 * 引退と違い trueAbility ではなく "当季の実観測成績"（releaseScore）で判定する三層構造（§12.2と同じ作法）。
 * 観測が無い（未出場）選手は最も切られやすい（-Infinity）＝出場機会すら得られなかった証拠として扱う。
 * @returns {Array<{teamId,role,primaryPos}>} 追加で生まれた空き枠（vacancies と同じ形）
 */
function runProspectCulling(league, cfg, { obs, retireVacancies }) {
  const dk = cfg.tuning.market.draft;
  if (!dk?.targetVacanciesPerTeam) return [];
  const retireCountByTeam = new Map();
  for (const v of retireVacancies) retireCountByTeam.set(v.teamId, (retireCountByTeam.get(v.teamId) ?? 0) + 1);
  const byTeam = new Map();
  for (const p of league.players) {
    if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, []);
    byTeam.get(p.teamId).push(p);
  }
  const culled = [];
  for (const t of league.teams) {
    const need = Math.max(0, dk.targetVacanciesPerTeam - (retireCountByTeam.get(t.id) ?? 0));
    if (!need) continue;
    const cands = (byTeam.get(t.id) ?? [])
      .filter((p) => p.age >= dk.cullMinAge && p.age <= dk.cullMaxAge)
      .map((p) => ({ p, score: releaseScore(p, obs, cfg) ?? -Infinity }))
      .sort((a, b) => a.score - b.score || (a.p.id < b.p.id ? -1 : 1));
    for (const c of cands.slice(0, need)) culled.push(c.p);
  }
  const cullSet = new Set(culled.map((p) => p.id));
  league.players = league.players.filter((p) => !cullSet.has(p.id));
  rebuildTeamRosters(league);
  return culled
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((p) => ({ teamId: p.teamId, role: p.role, primaryPos: p.primaryPos }));
}

/**
 * ★H2: オフシーズン遷移の前半（stage1）。「故障後遺→ブレイク→加齢→引退→淘汰→FA→トレード→窓
 * →プール生成」まで（phaseH_fun_spec H2 設計方針）。ドラフト本体（runDraft）は呼ばない＝
 * プレイヤー参加型ドラフトが指名の合間に中断できるよう、ここで止めて draft に要る一式
 * （remainingVac/pool/order/profiles/windowByTeam）を返す。
 *
 * 純関数性（H2「stage1が（リーグ状態・シード・ログ）の純関数であることを崩さない」）: league は
 * 呼び出し側が渡した参照を直接 in-place 変更する（この関数自体は league の複製をしない）。
 * driveOffseasonDraft（下記）は毎回クローンした league を渡すことで、中断中に何度呼んでも
 * 「開幕直前のリーグ」を汚さずに同じ結果を再導出できる。
 * @returns {Object} stage2/draft へ渡す一式＋要約（injuries/breakouts/retirees/fa/trades/obs/…）
 */
function offseasonStage1(league, cfg, {
  masterSeed, yearIndex, year, standings, teamHistory = null, careerStats = [], careerFarmStats = [],
  marketInterventions = [], seasonInjuries = [], playerTeamId = null, trainingPolicies = [],
}) {
  // 球団評価プロファイル（キャリア中固定・§13）。市場フェーズ共通で使う。
  //   H4: applyAging（下）の AI自動方針もこれを読むため、引退/FA等より前に確定させておく
  //   （純関数・(masterSeed,teamId,cfg)だけで決まるので、どの時点で呼んでも同じ値＝既存挙動と bit 同一）。
  const profiles = new Map();
  for (const t of league.teams) profiles.set(t.id, teamEvalProfile(masterSeed, t.id, cfg));

  // H4: 当年ぶんの育成方針ログ（人間介入のみ）と、特別指導枠選手の「キャンプ前」観測値を控える
  //   （applyAging が真値を動かす前のスナップショット・オフダイジェスト「キャンプの成果」用）。
  const trainIvs = trainingPolicies.filter((tp) => (tp.yearIndex ?? 0) === yearIndex);
  const specialIds = new Set(trainIvs.filter((tp) => tp.special).map((tp) => tp.playerId));
  const campBefore = new Map();
  for (const p of league.players) if (specialIds.has(p.id)) campBefore.set(p.id, coachOverallScore(p, cfg));

  // 故障（R3）: 発生は**試合中**（sim/injury.mjs）。オフは当季ログを消費して故障歴を積み・後遺を
  //   真値へ落とすだけ（旧実装のオフ1回ロールは撤去）。load の replay も同じログを渡せば同一に再構築。
  const injuries = applySeasonInjuries(league.players, seasonInjuries, cfg, year);
  const breakouts = applyBreakouts(league.players, cfg, { seed: hashSeed(masterSeed, 'breakout', yearIndex), year });
  applyAging(league.players, cfg, {
    seed: offseasonSeed(masterSeed, yearIndex), yearIndex, playerTeamId, profiles, policies: trainIvs,
  });

  // H4: 特別指導枠選手の「キャンプ後」観測値との差（前後差＋方針）。結果は乱数次第＝お祈り。
  const campResults = trainIvs.filter((tp) => tp.special).map((tp) => {
    const p = league.players.find((x) => x.id === tp.playerId);
    return {
      playerId: tp.playerId, policy: tp.policy,
      before: campBefore.get(tp.playerId) ?? null,
      after: p ? coachOverallScore(p, cfg) : null,
    };
  });

  // 当年（完了年）の "実観測" statline を playerId で引けるようにする（放出/契約更改の入力・§12.2）。
  //   careerStats は全年ぶんだが season==year に絞る＝live も load-replay も同一部分集合（決定論）。
  const obs = new Map();
  for (const s of careerStats) if (s.season === year) obs.set(s.playerId, s);
  // 当年の二軍観測 statline（F2-3: 育成→支配下の昇格判定を二軍実成績ベースへ強化・§12.1）。
  //   careerFarmStats も blob に永続される＝live と load-replay で同一部分集合（決定論）。
  const farmObs = new Map();
  for (const s of careerFarmStats) if (s.season === year) farmObs.set(s.playerId, s);
  // 当年ぶんのプレイヤー市場操作のみ適用（他年の介入は除外・再現可能）。
  const ivs = marketInterventions.filter((iv) => (iv.yearIndex ?? 0) === yearIndex);

  // 引退（生存者を league.players へ・空き枠 vacancies を得る）。
  const { retirees, vacancies: retireVac } = runRetirement(league, cfg, { seed: hashSeed(masterSeed, 'retire', yearIndex), debutYear: year + 1 });
  // R7（決定2）: 引退枠だけでは届かないぶんを追加淘汰し、ドラフトを「大量獲得→淘汰」構造にする。
  const cullVac = runProspectCulling(league, cfg, { obs, retireVacancies: retireVac });
  const vacancies = retireVac.concat(cullVac);
  // R7（決定3）: 球団の「優勝の窓」= teamHistory だけから毎年純関数で導出（新規の永続状態なし）。
  //   teamHistory 無し（旧テスト呼び出し）は null＝窓関連ボーナスは常に0＝既存挙動と bit 同一。
  const windowByTeam = teamHistory
    ? new Map(league.teams.map((t) => [t.id, teamWindowState(t.id, teamHistory, cfg)]))
    : null;
  // FA → トレード（引退後の生存者を同型1:1スワップ・構成恒常・ドラフト枠に非干渉）。
  //   H5-A: obs を渡す（提示salary=当季観測貢献量→salaryFromValue の実弾化判定に使う）。
  const fa = runFA(league, cfg, { profiles, masterSeed, yearIndex, interventions: ivs, obs });
  const trades = runTrades(league, cfg, { profiles, masterSeed, yearIndex, interventions: ivs, windowByTeam });
  rebuildTeamRosters(league);
  // 時代トレンド（D3・§11.3）: 翌年（debut年）の世代の波・球速の経年上昇＝computeEra(yearIndex+1)。
  //   ＋王朝均衡: 完了年順位から弱球団の新人再分配 boost（戦力の平均回帰＝振り子）。
  //   1年目（yearIndex=0）でも「翌年=2年目」の新人にはドリフトが乗る（＝2年目以降のみ変化。
  //   1年目レギュラーシーズン自体は startYear 側の era=identity で完全不変）。
  const rookieEra = computeEra(masterSeed, yearIndex + 1, cfg);
  const balanceBoost = teamBalanceBoost(standings, cfg);
  // 補充・前半: 育成昇格→プール生成まで（§13/§15/§12.1）。ドラフト本体（runDraft）は
  //   driveOffseasonDraft が別途呼ぶ（H2・プレイヤー参加型ドラフトの中断点）。
  const mkt = marketStage1(league, cfg, { vacancies, standings, masterSeed, yearIndex, debutYear: year + 1, era: rookieEra, farmObs, teamHistory });
  league.players = league.players.concat(mkt.promoted);
  rebuildTeamRosters(league);

  return {
    injuries, breakouts, retirees, fa, trades, obs, standings, balanceBoost, campResults,
    promotions: mkt.promotions, remainingVac: mkt.remainingVac, pool: mkt.pool,
    order: mkt.order, profiles: mkt.profiles, windowByTeam: mkt.windowByTeam,
  };
}

/**
 * ★H2: オフシーズン遷移の後半（stage2）。ドラフト確定後の「育成獲得→剪定→契約更改→戦力外/拾い上げ」
 * （phaseH_fun_spec H2 設計方針。★H5-A で契約更改と戦力外/拾い上げの順序を入れ替えた＝下記コメント）。
 * draftResult は runDraft の非中断な戻り値（{rookies, undrafted, draftLog}）であること
 * （呼び出し側が paused でないことを確認済み）。
 *
 * ★H5-A（phaseH_fun_spec）: 契約更改を戦力外/拾い上げより先に実行する（旧H2の順序を反転）。
 *   今年の salary（実弾化＝salaryFromValue）を先に確定させないと「どの球団が予算超過か」が
 *   判定できず、予算超過球団の高salary非プロテクト選手を戦力外候補ルート（runReleaseAndPickup の
 *   forcedCuts）へ合流させられないため。runContractRenewal は obs（当季観測。今年の売買では
 *   一切動かない）から salary を出すので、この入れ替えで契約更改自体の結果は変わらない
 *   （score基準の戦力外候補も obs 由来で不変＝影響するのは budgetCuts が追加される点だけ）。
 * @returns {{pickups:Array, contracts:Array}}
 */
function offseasonStage2(league, cfg, { s1, draftResult, masterSeed, yearIndex }) {
  league.players = league.players.concat(draftResult.rookies);
  rebuildTeamRosters(league);
  marketStage2(league, cfg, { undrafted: draftResult.undrafted, order: s1.order, balanceBoost: s1.balanceBoost, rookies: draftResult.rookies });
  // 契約更改（H5-A: 実弾化。予算超過球団の budgetCuts を算出する）。
  const contracts = runContractRenewal(league, cfg, { obs: s1.obs, profiles: s1.profiles, masterSeed, yearIndex });
  // 戦力外→拾い上げ（ドラフト後の全支配下から同型循環・§12.2）。新人は観測が無く対象外＝除外される。
  //   H5-A: 予算超過による強制戦力外（budgetCuts）を同じ再分配プールへ合流させる。
  const pickups = runReleaseAndPickup(league, cfg, {
    profiles: s1.profiles, masterSeed, yearIndex, standings: s1.standings, obs: s1.obs, forcedCuts: contracts.budgetCuts,
  });
  rebuildTeamRosters(league);
  // H5-C: ファン関心の更新（完了年の成績分位への回帰＋優勝/スター流出イベント）。
  //   refreshTeamFinance が fanInterest から翌年 budget を再計算するため必ずこの順で呼ぶ。
  updateFanEconomy(league, cfg, { standings: s1.standings, faMoves: s1.fa });
  // H5-A: release/pickupで個体が入れ替わった後の「最終」payrollを team.finance へ確定する
  //   （stove UI の payroll バー・realism WATCH が読む値）。
  refreshTeamFinance(league, cfg, masterSeed);
  return { pickups, contracts };
}

/** league（teams/players/farm）の独立クローン（H2: driveOffseasonDraft が state.league を直接
 *  汚さず何度でも stage1 を再導出できるようにする。プレーンデータのみ＝JSON複製で安全）。 */
function cloneLeague(league) {
  return JSON.parse(JSON.stringify({ masterSeed: league.masterSeed, teams: league.teams, players: league.players, farm: league.farm ?? [] }));
}

/** 当季に試合中発生した故障をオフ入力の形へ整形する（R3・純粋な読み取り。state.rt.injuryLog は不変）。 */
function deriveSeasonInjuries(rt) {
  return rt.injuryLog.map((e) => ({
    id: e.playerId, teamId: e.teamId, site: e.site, siteName: e.siteName,
    severity: e.severity, gamesLost: e.gamesLost, day: e.day, farm: !!e.farm,
  }));
}

/**
 * ★H2: オフシーズン遷移の駆動関数。advanceYear（初回）と submitDraftPick（再開）の両方から
 * 呼ばれる共通の入り口。state.league は **ドラフトが完全に解決するまで一切書き換えない**
 * （stage1 は毎回 state.league のクローン上で再実行＝state.league・masterSeed・yearIndex・
 * careerStats・marketInterventions だけに依存する純関数として振る舞う）。
 *
 * 自チームの指名番で pickLog（marketInterventions の phase:'draft' エントリ）が尽きていれば
 * runDraft が中断を返す → state.awaitingDraft/state.offseasonStage を立てて null を返す
 * （呼び出し側はこれで「まだ終わっていない」と判定する）。全ラウンド解決したら stage2 を実行し、
 * state.league を新ロスターへ確定（コミット）してから年送りの残り（表彰/ニュース/yearIndex++等）を行う。
 * @returns {Object|null} 完了時はオフシーズン要約（advanceYear の戻り値と同型）。中断中は null。
 */
function driveOffseasonDraft(state) {
  const completedYear = state.year;
  // ★H2バグ修正: state.offseasonStage は「この呼び出しに入る前から既に中断中だったか」を表す
  //   （load() が data.offseasonStage から復元した直後 or submitDraftPick からの再開）。
  //   これが 'awaitingDraft' なら、たとえ今回渡された state.cfg.game.interactiveDraft が false
  //   （例: UI の loadFromBlob が `createConfig()` を素で呼び、interactiveDraft:true の
  //   オーバーライドを付け忘れた場合）であっても、必ず対話継続として扱う。
  //   でなければ playerTeamId が null になり、①蓄積済みの pickLog（プレイヤーが既に指名した分）が
  //   一切消費されずに握りつぶされ、②全球団ぶん bestFor(AI自動)で即完了してしまい、
  //   中断状態が silently 失われる（load-replay が非対話で「ログから同一結果を再構築」する
  //   という設計方針4に違反する）。offseasonStage は playerTeamId が非null のときにしか
  //   'awaitingDraft' にならない（下の paused 分岐参照）ので、この判定は安全（誤って
  //   非対話ゲームを対話化することはない）。
  const wasAwaitingDraft = state.offseasonStage === 'awaitingDraft';
  const league = cloneLeague(state.league); // state.league は最終コミットまで不変
  const standings = standingsForYear(state, completedYear);
  const seasonInjuries = deriveSeasonInjuries(state.rt);
  const s1 = offseasonStage1(league, state.cfg, {
    masterSeed: state.masterSeed,
    yearIndex: state.yearIndex,
    year: completedYear,
    standings,
    teamHistory: state.teamHistory,
    careerStats: state.careerStats,
    careerFarmStats: state.careerFarmStats,
    marketInterventions: state.marketInterventions,
    seasonInjuries,
    playerTeamId: state.playerTeamId,
    trainingPolicies: state.trainingPolicies,
  });
  const pickLog = state.marketInterventions.filter(
    (iv) => iv.phase === 'draft' && (iv.yearIndex ?? 0) === state.yearIndex,
  );
  const interactive = state.cfg.game.interactiveDraft || wasAwaitingDraft;
  const draftResult = runDraft(s1.remainingVac, s1.pool, s1.profiles, s1.order, state.cfg, {
    masterSeed: state.masterSeed,
    yearIndex: state.yearIndex,
    windowByTeam: s1.windowByTeam,
    playerTeamId: interactive ? state.playerTeamId : null,
    pickLog,
  });
  if (draftResult.paused) {
    state.awaitingDraft = draftResult.awaitingDraft;
    state.offseasonStage = 'awaitingDraft';
    return null;
  }
  state.awaitingDraft = null;
  state.offseasonStage = null;
  // 表彰（C4）: 世代交代でロスターが動く前に「当年に出場した選手」の byId を控える（決定論・純関数）。
  //   ★league.farm も含める（R2 で顕在化した既存バグ）: 育成→支配下の季節中昇格（§req_20260708）は
  //   1:1 交換なので、押し出された支配下選手はシーズン途中で league.farm 側へ移る。その選手が
  //   一軍で出場していると careerStats には成績が残るのに byId から引けず、表彰の選定が
  //   undefined.role で落ちる。出場記録を持つ全選手を引けるようにする（支配下＋育成）。
  //   ★ここで state.league（=まだ当季終了時点のロスター）から組む＝下の commit で書き換わる前
  //   （従来の advanceYear が offseasonTransition 呼び出し前に組んでいたのと同じ対象集合）。
  const awardsById = new Map(state.league.players.map((p) => [p.id, p]));
  for (const d of state.league.farm ?? []) if (!awardsById.has(d.id)) awardsById.set(d.id, d);
  const s2 = offseasonStage2(league, state.cfg, { s1, draftResult, masterSeed: state.masterSeed, yearIndex: state.yearIndex });
  state.league = league; // ★最終コミット（ここまで state.league は不変）
  const off = {
    injuries: s1.injuries, breakouts: s1.breakouts, retirees: s1.retirees, rookies: draftResult.rookies,
    promotions: s1.promotions, draftLog: draftResult.draftLog, fa: s1.fa, trades: s1.trades,
    pickups: s2.pickups, contracts: s2.contracts, campResults: s1.campResults, // H4: キャンプの成果
  };
  finalizeOffseason(state, off, completedYear, awardsById);
  return off;
}

/**
 * ★H2: driveOffseasonDraft がドラフトを完全に解決した後の締め（従来の advanceYear 末尾を抽出）。
 * 表彰/マイルストーン/因縁ログ/引退セレモニー/永続ログの畳み込み/年送りを行う（一度だけ呼ばれる）。
 * @param {Map} awardsById 当季終了時点のロスター（driveOffseasonDraft が commit 直前に控えた もの）
 */
function finalizeOffseason(state, off, completedYear, awardsById) {
  // §req_20260708: 完了年ぶんの育成→支配下季節中昇格ログを永続配列へ畳み込む（load時はこのログから
  // replay適用し、league.players/farmを動かす day 単位の再シムを不要にする＝index.mjs load() 参照）。
  for (const m of state.rt.farmPromotionLog) state.farmPromotionLog.push({ year: state.yearIndex, ...m });
  // R3: 当季に試合中発生した故障を永続ログへ畳み込む（オフの後遺/故障歴の素・load の replay 入力）。
  const seasonInjuries = deriveSeasonInjuries(state.rt);
  for (const e of seasonInjuries) state.injuryLog.push({ year: state.yearIndex, ...e });
  // 癒えないままシーズンが終わった故障 → 翌季の開幕IL（「9月の大怪我で開幕に間に合わない」）
  const carried = carryOverInjuries(state.rt);
  // 完了シーズンの表彰（C4・§55）。当年 statline を careerStats から絞り、順位表は teamHistory 由来。
  off.awards = computeSeasonAwards({
    playerSeasons: state.careerStats.filter((s) => s.season === completedYear),
    standings: standingsForYear(state, completedYear),
    playersById: awardsById,
    cfg: state.cfg,
    allCareerStats: state.careerStats,
    year: completedYear,
  });
  off.milestones = milestones({ careerStats: state.careerStats, playersById: awardsById, cfg: state.cfg, year: completedYear });
  // H1-2: 確定した取引（FA/トレード/拾い上げ/ドラフト）をコンパクト行として永続ログへ追記
  //   （因縁ライバル追跡の素材・additive save field）。yearIndex はまだ完了年のもの（未インクリメント）。
  appendTransactionLog(state, off, completedYear, state.yearIndex);
  // H1-3: 確定した引退者のうち功労者を「引退セレモニー」カード用データへ整形（オフダイジェスト素材）。
  off.retirementCeremonies = retirementCeremonies(state, off, completedYear);
  state.retiredPlayers.push(...off.retirees); // 記録用の永続サマリ
  // R5: 確定した受賞をそのまま永続する（前史で成績を刈っても過去の受賞者が変わらないように）
  state.awardsHistory.push({ year: completedYear, awards: off.awards });
  state.pendingInjuries = carried; // R3: 癒えていない故障の残り日数→翌シーズン開幕の離脱(IL)（C2.4）
  compactCareerStats(state); // R4: 古いシーズンの表示専用内訳を落とす（save 肥大の防止・下記）
  state.yearIndex += 1;
  state.year += 1;
  startYear(state); // 新シーズンを開幕状態でセット（世代交代後の真値/ロスター・yearIndex 依存シード）
}

/**
 * ★R4: 古い完了シーズンから「表示専用の内訳」を落として save の肥大を防ぐ。
 *
 * 1シーズンの careerStats は約1.4MB（542行×2.6KB）で、その **6割が batting.splits（対左右/得点圏/
 * ホームビジター）と batting.byCount（カウント別）** ＝ どちらも選手モーダルで直近シーズンを表示する
 * ためだけの内訳。20年プレイすると save が数十MBに膨らむ（burn-in で顕在化したが、burn-in を
 * 使わずに20年遊んでも同じ）。指標の算出・表彰・記録・オフの査定は **トップレベルの生カウント**
 * （pa/ab/h/hr/bb/so, outs/r/er …）だけを使うので、直近 keepDetailYears 年より古い行からは
 * 内訳を落としてよい（battingSplits は欠損時に0行を返す＝表示が壊れない）。§17「集計値のみ保存」の趣旨に沿う。
 */
function compactCareerStats(state) {
  const keep = state.cfg.game.keepDetailYears ?? 2;
  const cutoff = state.year - keep; // これより古いシーズンの内訳を落とす
  for (const s of state.careerStats) {
    if (s.season >= cutoff) continue;
    if (s.batting) {
      delete s.batting.splits;
      delete s.batting.byCount;
    }
    if (s.pitching) delete s.pitching.byCount;
  }
  // 二軍（careerFarmStats）も表示専用の内訳だけを落とす。
  //   ★守備(fielding)・走塁(baserunning) は **絶対に落とさない**: R4 でこれらは
  //   二軍サブタブの指標表示にも、球団AIの昇格査定（UZR/BsR）にも使う（＝機能データ）。
  for (const s of state.careerFarmStats ?? []) {
    if (s.season >= cutoff) continue;
    if (s.batting) {
      delete s.batting.splits;
      delete s.batting.byCount;
    }
    if (s.pitching) delete s.pitching.byCount;
  }
}

/** 完了年 y（=firstSeason+y）の最終順位を teamHistory から取り出す（ウェーバー順の素）。 */
function standingsForYear(state, year) {
  const hist = state.teamHistory.find((h) => h.year === year);
  return hist ? hist.standings : null;
}

/** 現行 yearIndex のシーズンを開幕状態でセット（rt を張り替える）。 */
function startYear(state) {
  // H5-B: オーナー目標（プレイヤー球団のみ・yearIndex>=1・決定論）。旧セーブは ownerGoals 不在
  //   → 同式で再生成できる（generateOwnerGoals は (masterSeed,yearIndex,teamId,履歴,finance) の純関数）。
  if (state.playerTeamId && state.yearIndex >= 1 && state.ownerGoals?.yearIndex !== state.yearIndex) {
    state.ownerGoals = {
      yearIndex: state.yearIndex,
      goals: generateOwnerGoals({
        masterSeed: state.masterSeed, yearIndex: state.yearIndex, teamId: state.playerTeamId,
        league: state.league, teamHistory: state.teamHistory, cfg: state.cfg,
      }),
    };
  }
  // 時代トレンド（D3・§11.3）: 得点環境の緩やかな揺れ（投高打低↔打高投低）を bb.evBase に反映した
  //   シーズン用 config を作る。**yearIndex=0 は computeEra が identity ＝ eraSeasonConfig が
  //   state.cfg を同一参照で返す＝1年目レギュラーシーズンは D3 前と byte 一致**（既存50較正不変）。
  state.era = computeEra(state.masterSeed, state.yearIndex, state.cfg);
  const seasonCfg = eraSeasonConfig(state.cfg, state.era);
  // 破綻救援ガードの"前歴"（多年運用・原則2）: 前年(state.year-1)の観測投手ラインを pid→line で渡す。
  //   careerStats は live/load とも同一（blob 復元済み）＝決定論。1年目は前年が無く空 Map ＝ガード不作動
  //   （priorPitch が空なら createUsageState→bullpenAvailable のガードは全員 前歴なしで一切効かない）
  //   ＝1年目レギュラーシーズンは byte 不変（較正53指標・SV/HLD/登板数王が不動）。
  const prevYear = state.year - 1;
  const priorPitch = new Map();
  for (const s of state.careerStats) {
    if (s.season === prevYear && s.pitching && s.pitching.g > 0) priorPitch.set(s.playerId, s.pitching);
  }
  state.rt = startSeasonRuntime(state.league, seasonCfg, {
    season: state.year,
    seed: seasonSeed(state),
    playerTeamId: state.playerTeamId,
    priorPitch,
    // 出場登録入替（F2-3）: 1年目から作動させる（R2）。
    //   旧実装は yearIndex>0 に限定していた（鉄則7「1年目シム不変」の解釈として、ゲーム層1年目を
    //   simulateSeason と bit 同一に保つため）。だが結果として **プレイヤーが最初に遊ぶ1年目だけ、
    //   故障者が一軍登録に居座り続け、二軍で好成績を残しても誰も上がってこない** という破綻に
    //   なっていた（ユーザー報告「一軍や二軍の入れ替えが正常じゃない」）。
    //   鉄則7 の主旨は「多年要素（加齢・時代トレンド）を1年目に混ぜない」こと。登録入替はシーズン中の
    //   運用であって多年要素ではない。較正53指標は simulateSeason（sim層・farm 無し）で測るため
    //   **非干渉**（tools/calibrate.mjs 参照）＝ 1年目を現実化しても較正の土台は動かない。
    enableMoves: true,
    masterSeed: state.masterSeed,
    // 直前オフシーズンで確定した故障（gamesLost）を新シーズン開幕の離脱(IL)として持ち込む（C2.4/§10.5）。
    //   1年目（pendingInjuries 空）は IL 皆無＝既存50較正と bit 同一。live/replay とも同一 off から
    //   再構築されるため決定論（IL は真値でなく offseasonTransition の再計算で復元＝save に含めない）。
    injuries: state.pendingInjuries ?? [],
  });
  // 前年の采配介入は team.manager を in-place で書き換える（setManagerProfile/applyInterventionsForDay）。
  // rt を作り直しても team.manager は張り替わらないため、明示的に「素の監督」へ戻さないと前年の
  // プロファイルが翌年へリークし live/replay が分岐する（save→load が verifyStandings で例外）。
  const myTeam = state.rt.teamById.get(state.playerTeamId);
  if (myTeam) myTeam.manager = { ...state.baseManager };
  // 当該年の采配介入を rt に載せる（replay で同一 day に再適用＝決定論。他年の介入は除外）。
  state.rt.interventions = state.interventions.filter((iv) => (iv.yearIndex ?? 0) === state.yearIndex);
}

/** 自チームの「AI（生成時）監督プロファイル」を控える（介入UIが絶対値パッチを組む基準）。 */
function captureBaseManager(state) {
  const team = state.league.teams.find((t) => t.id === state.playerTeamId);
  state.baseManager = { ...team.manager };
}

/**
 * 新規ゲームを開始する。
 *
 * ★R4 burnInYears（世界の"前史"）: >0 なら、プレイ開始前に N 年ぶんのシーズンを自動消化してから
 *   プレイヤーに引き渡す（開幕年は firstSeason のまま。前史は firstSeason-N 〜 firstSeason-1 年）。
 *   生成直後のリーグは「誰も故障したことがなく・通算記録も引退者もドラフト歴も無い」冷えた世界で、
 *   ドラフト→成長→故障→引退のサイクルが一度も回っていない。burn-in はその履歴を作る。
 *   【計測（20年・2seed）】年齢/平均能力/得点環境は **1年目とほぼ同一**（R2 で生成と加齢を同一
 *   カーブにしたため母集団が既に定常）。差が出るのは履歴だけ:
 *     故障歴を持つ選手 0% → 58%／通算記録・引退者・ドラフト履歴・受賞歴が存在する
 *   所要は 1世界あたり約16秒（20年）。0 なら従来どおり生成直後から開始（＝較正の土台と同一）。
 *
 * @param {number} masterSeed リーグ生成＋進行のマスターシード（決定論の起点）
 * @param {string} playerTeamId 自チーム（'T1'..'T12'）
 * @param {{cfg?:Object, autoManage?:boolean, burnInYears?:number}} options
 * @returns {Object} GameState
 */
export function newGame(masterSeed, playerTeamId, options = {}) {
  const cfg = options.cfg ?? createConfig();
  const league = generateLeague(masterSeed, cfg);
  // 育成枠（C3a・§12.1）: F2-1 から初期生成で埋まる（generateLeague が league.farm を返す・支配下840とは別枠）
  if (!league.teams.some((t) => t.id === playerTeamId)) {
    throw new Error(`playerTeamId ${playerTeamId} がリーグに存在しない`);
  }
  const burnIn = Math.max(0, Math.floor(options.burnInYears ?? 0));
  const state = {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    masterSeed: masterSeed >>> 0,
    playerTeamId,
    settings: { autoManage: options.autoManage ?? true }, // C1a は全おまかせ（人間介入は後段UI）
    // burn-in（前史）を回す場合、初年度を N 年前へ巻き戻す＝プレイヤーの開幕は firstSeason のまま。
    firstSeason: cfg.game.firstSeason - burnIn,
    yearIndex: 0,
    year: cfg.game.firstSeason - burnIn,
    cfg,
    league,
    careerStats: [], // 完了シーズンの選手集計（永続・§17）
    careerFarmStats: [], // 完了シーズンの二軍選手集計（F2-2・一軍と分離して永続・§17）
    teamHistory: [], // 完了シーズンのチーム成績/優勝（永続。F2-2: farmStandings=二軍順位も持つ）
    retiredPlayers: [], // 引退者サマリ（記録/通算・§17集計値。replayで再構築するため save には含めない）
    interventions: [], // 人間介入ログ（采配プロファイル差し替え。save/replayで再現）
    marketInterventions: [], // 市場操作ログ（FA入札/トレード起案。オフシーズンで適用・save/replayで再現）
    // H1-2: 因縁ライバル追跡用のコンパクト取引ログ（additive・advanceYearで確定結果を追記）。
    //   §17 と同じ思想（集計値のみ・生イベントは持たない）。旧セーブは load 時に [] 補完。
    transactionLog: [],
    // H4: 育成方針・キャンプの人間介入ログ（additive・{yearIndex,playerId,policy,special}）。
    //   AI球団の方針はここに積まない（teamEvalProfile から毎回決定論的に再導出＝§17と同じ思想）。
    trainingPolicies: [],
    // R3: 前季の故障の「開幕時点の残り離脱 day 数」（開幕ILの素）。故障が試合由来になったため
    //   replay では再導出できない（season を再シムしない）→ save に永続する。
    pendingInjuries: [],
    // R3: 完了年ぶんの故障ログ（試合中に発生した離脱）。オフの後遺/故障歴の適用に使う。
    //   §17: 集計値のみ（生の打球ログは持たない）。load はこれを replay に渡して真値を再構築する。
    injuryLog: [],
    // R5: 確定した年度別受賞（MVP/タイトル/ベストナイン/守備賞）。前史で成績を刈っても
    //   「実際に誰が獲ったか」を失わないための永続記録（再計算に頼らない）。
    awardsHistory: [],
    // 育成→支配下の季節中昇格ログ（§req_20260708・完了年ぶんのみ蓄積。save/replayで再現。
    // 当年ぶんは state.rt.farmPromotionLog にあり、advanceYear で年ごとに畳み込む）。
    farmPromotionLog: [],
    // H2: オフシーズン中断状態（additive・既定 null）。'awaitingDraft' はプレイヤー参加型ドラフトの
    //   自チーム指名番で中断中を表す（driveOffseasonDraft/submitDraftPick が管理）。
    offseasonStage: null,
    // H2: 中断中のドラフト会議の現在状態（残りプール等・live限定＝save には含めない。load は
    //   offseasonStage から driveOffseasonDraft を再駆動して再構築する）。
    awaitingDraft: null,
    // H5-B: オーナー目標・信任（プレイヤー球団のみ・additive save）。goals は startYear が
    //   yearIndex>=1 で決定論生成。ownerPending は解任イベントの裁定待ち（resolveOwnerDecision）。
    ownerGoals: null,
    ownerTrust: cfg.tuning.ownerGoals.trustStart,
    ownerEvaluatedYear: null,
    pleaUsed: false,
    ownerPending: null,
    lastOwnerReport: null,
    rt: null, // 現行シーズンの日次ランタイム
  };
  captureBaseManager(state); // rt 構築・介入適用の前に「素の監督」を控える
  startYear(state);
  // ★R4 前史（burn-in）: プレイヤーに渡す前に N 年ぶんを自動消化する。決定論（同一 masterSeed なら
  //   同一の前史）。消化後の state は「20年ぶんの通算記録・引退者・故障歴・ドラフト履歴を持つ、
  //   firstSeason 開幕直前のリーグ」になる（yearIndex=burnIn / year=cfg.game.firstSeason）。
  //   H2: 前史には人間が居ない＝cfg.game.interactiveDraft の値によらず常に全自動で回す
  //   （一時的に false へ落として実行し、burn-in 終了後に元へ戻す＝以後のプレイは指定どおり対話的）。
  if (burnIn > 0) {
    const savedInteractive = cfg.game.interactiveDraft;
    const savedFiring = cfg.game.allowFiring; // H5-B: 前史に人間は居ない＝解任も無効で回す
    cfg.game.interactiveDraft = false;
    cfg.game.allowFiring = false;
    for (let y = 0; y < burnIn; y++) {
      while (!state.rt.finished) advanceDay(state);
      advanceYear(state);
    }
    cfg.game.interactiveDraft = savedInteractive;
    cfg.game.allowFiring = savedFiring;
    // H5-B: プレイヤー着任はここから＝前史で溜まった信任・評価履歴をリセットし、着任年の目標を
    //   現行 yearIndex で再生成する（startYear は前史最終 advanceYear 内で既に走っているため明示的に）。
    state.ownerTrust = cfg.tuning.ownerGoals.trustStart;
    state.ownerEvaluatedYear = null;
    state.lastOwnerReport = null;
    state.ownerGoals = null;
    if (state.playerTeamId && state.yearIndex >= 1) {
      state.ownerGoals = {
        yearIndex: state.yearIndex,
        goals: generateOwnerGoals({
          masterSeed: state.masterSeed, yearIndex: state.yearIndex, teamId: state.playerTeamId,
          league: state.league, teamHistory: state.teamHistory, cfg: state.cfg,
        }),
      };
    }
    pruneBurnInHistory(state);
  }
  return state;
}

/**
 * ★R5: 前史（burn-in）の履歴を刈る。**前史で引退した選手の記録は保持しない**（ユーザー判断）。
 * 30年ぶんの全選手の成績を抱えると save が100MB級に膨らむため、
 *   - 開幕時点でリーグに居る選手（支配下＋育成）の成績だけを残す（現役ベテランの通算記録は保つ）
 *   - 出場が無い行（PA=0かつBF=0）は落とす
 *   - 引退者サマリは空にする（前史の引退者は「居なかったこと」になる）
 * 受賞は awardsHistory に確定値を持っているので、成績を刈っても過去の受賞者は正しいまま
 * （careerStats からの再計算に頼ると、引退者が消えた名簿で別人が繰り上がってしまう）。
 */
function pruneBurnInHistory(state) {
  const alive = new Set([...state.league.players, ...(state.league.farm ?? [])].map((p) => p.id));
  const played = (s) => (s.batting?.pa ?? 0) > 0 || (s.pitching?.bf ?? 0) > 0;
  state.careerStats = state.careerStats.filter((s) => alive.has(s.playerId) && played(s));
  state.careerFarmStats = state.careerFarmStats.filter((s) => alive.has(s.playerId) && played(s));
  state.retiredPlayers = [];
  state.injuryLog = state.injuryLog.filter((e) => alive.has(e.id));
  state.farmPromotionLog = [];
}

/**
 * 采配介入を登録する（フェーズC1b）。自チーム監督プロファイルの人間差し替え。
 * 現在の day（次に処理する節）から効く絶対値パッチをログに積み、rt へ即時反映する。
 * @param {Object} state GameState
 * @param {{buntTend?:number,stealTend?:number,ibbTend?:number,quickHook?:number}} manager 絶対値（20-80）
 */
export function setManagerProfile(state, manager) {
  const day = pendingDay(state.rt); // この day 以降の試合に効く
  const team = state.rt.teamById.get(state.playerTeamId);
  // 現在の有効プロファイルに重ねる（同一日に複数フィールドを個別に変えても合成される）。
  // iv.manager は「絶対値の完全な監督オブジェクト」＝適用順に依らず一意（replay安全）。
  const abs = { ...(team ? team.manager : state.baseManager), ...manager };
  // 同 day の既存介入は上書き（ハブで何度いじっても最後の合成値だけが効く＝replayが一意）。
  const sameDay = (iv) => iv.yearIndex === state.yearIndex && iv.day === day && iv.teamId === state.playerTeamId;
  state.interventions = state.interventions.filter((iv) => !sameDay(iv));
  state.rt.interventions = state.rt.interventions.filter((iv) => !sameDay(iv));
  const iv = { yearIndex: state.yearIndex, day, teamId: state.playerTeamId, manager: abs };
  state.interventions.push(iv);
  state.rt.interventions.push(iv);
  if (team) team.manager = { ...abs }; // live 即時反映（replayでも同 day で再現）
  state.settings.autoManage = false;
  return iv;
}

/** 「おまかせ」に戻す（自チーム監督を生成時プロファイルへ復帰・現在の day から）。 */
export function clearManagerProfile(state) {
  setManagerProfile(state, state.baseManager);
  state.settings.autoManage = true;
}

// --- 市場介入（C3b・オフシーズンで適用・save/replay で再現） -------------------
// FA入札・トレード起案は「当年 yearIndex」のログとして marketInterventions に積む。次の
// advanceYear（＝当年オフシーズン）で offseasonTransition が当年ぶんを適用する。人間の意思は
// このログだけに載り、live も load-replay も同一結果を再現する（決定論・§介入ログ）。

/**
 * FA入札介入。自チームが FA宣言選手 playerId の獲得に動く意思をログする（当年オフで AI 入札を
 * 上回る勝者として扱われる・人的補償は同型で自動）。相手が実際に宣言し補償が成立する時のみ発火。
 * @returns {Object} 追加した介入
 */
export function bidFA(state, playerId) {
  const iv = { yearIndex: state.yearIndex, phase: 'fa', playerId, teamId: state.playerTeamId };
  state.marketInterventions = state.marketInterventions.filter(
    (m) => !(m.phase === 'fa' && m.yearIndex === state.yearIndex && m.playerId === playerId),
  );
  state.marketInterventions.push(iv);
  return iv;
}

/**
 * トレード起案介入。自チームの選手 aPlayer と、相手チームの選手 bPlayer（同 role/primaryPos）の
 * 交換を起案する。当年オフで相手 AI が自評価で受諾判定する（受諾＝成立・拒否＝ログのみ）。
 * @returns {Object} 追加した介入
 */
export function proposeTrade(state, aPlayer, bPlayer) {
  const a = state.league.players.find((p) => p.id === aPlayer);
  const b = state.league.players.find((p) => p.id === bPlayer);
  if (!a || !b) throw new Error('proposeTrade: 選手が見つからない');
  const iv = { yearIndex: state.yearIndex, phase: 'trade', aTeam: a.teamId, aPlayer, bTeam: b.teamId, bPlayer };
  state.marketInterventions = state.marketInterventions.filter(
    (m) => !(m.phase === 'trade' && m.yearIndex === state.yearIndex && m.aPlayer === aPlayer && m.bPlayer === bPlayer),
  );
  state.marketInterventions.push(iv);
  return iv;
}

// --- H4: 育成方針・キャンプ（phaseH_fun_spec H4・オフシーズンで applyAging が適用・save/replay で再現）
// bidFA/proposeTrade と同じ流儀: 人間の意思は state.trainingPolicies ログにだけ積む。AI球団の方針は
// ログに積まず、applyAging が teamEvalProfile から毎回決定論的に再導出する（personality と同じ思想）。

/**
 * 育成方針の設定・変更（自チーム選手のみ）。同一 (yearIndex, playerId) の既存ログは上書きする
 * （bidFA と同じ「最後の設定が効く」流儀）。特別指導枠（cfg.tuning.training.specialSlotsPerTeam）を
 * 超える special:true 指定は拒否する（UIが選択肢を切る前提の最終防衛線）。
 * @param {Object} state GameState
 * @param {string} playerId 自チームの選手
 * @param {string} policy 'batting'|'defense'|'speed'|'rest'|'balanced'|'convert:<POS>'
 * @param {{special?:boolean}} opts special=true で特別指導枠を消費（効果2倍）
 * @returns {Object} 追加したログ行
 */
export function setTrainingPolicy(state, playerId, policy, opts = {}) {
  if (!parsePolicy(policy)) throw new Error(`setTrainingPolicy: 不正な policy '${policy}'`);
  const p = state.league.players.find((x) => x.id === playerId);
  if (!p || p.teamId !== state.playerTeamId) throw new Error('setTrainingPolicy: 自チームの選手のみ設定可能');
  const special = !!opts.special;
  if (special) {
    const K = state.cfg.tuning.training.specialSlotsPerTeam;
    // trainingPolicies は本APIが自チーム選手のぶんしか積まない（上のガード）＝
    //   yearIndex一致だけで自チームの特別指導枠数を数えられる。
    const used = state.trainingPolicies.filter(
      (tp) => tp.yearIndex === state.yearIndex && tp.playerId !== playerId && tp.special,
    ).length;
    if (used >= K) throw new Error(`setTrainingPolicy: 特別指導枠は${K}人まで`);
  }
  state.trainingPolicies = state.trainingPolicies.filter(
    (tp) => !(tp.yearIndex === state.yearIndex && tp.playerId === playerId),
  );
  const iv = { yearIndex: state.yearIndex, playerId, policy, special };
  state.trainingPolicies.push(iv);
  return iv;
}

/** 育成方針の設定を取り消す（適用前のログ削除＝決定論に無害。設定していなければ何もしない）。 */
export function clearTrainingPolicy(state, playerId) {
  state.trainingPolicies = state.trainingPolicies.filter(
    (tp) => !(tp.yearIndex === state.yearIndex && tp.playerId === playerId),
  );
}

/** 完了したシーズンの集計値を永続領域へ退避（§17: 集計値のみ永続）。 */
function recordSeasonHistory(state) {
  const rt = state.rt;
  const packRow = (r) => ({
    teamId: r.teamId,
    name: r.name,
    league: r.league,
    g: r.g,
    w: r.w,
    l: r.l,
    t: r.t,
    rs: r.rs,
    ra: r.ra,
  });
  state.teamHistory.push({
    year: state.year,
    standings: rt.table.map(packRow),
    // 二軍の最終順位（F2-2・二軍リーグが成立した年のみ）。順位タブ/チームタブの履歴素材。
    farmStandings: rt.farm && rt.farm.table ? rt.farm.table.map(packRow) : null,
    champion: rt.postseason ? rt.postseason.champion : null,
  });
  const packSeason = (s) => ({
    playerId: s.playerId,
    season: s.season,
    teamId: s.teamId,
    batting: s.batting,
    pitching: s.pitching,
    baserunning: s.baserunning,
    fielding: s.fielding,
  });
  for (const s of rt.stats.stats.values()) state.careerStats.push(packSeason(s));
  // 二軍成績（farmStats）は一軍と分離して永続する（F2-2・選手詳細の一軍/二軍行の素材・§17集計値のみ）。
  if (rt.farm) for (const s of rt.farm.stats.stats.values()) state.careerFarmStats.push(packSeason(s));
}

/**
 * 1日（節）進める。自チーム試合日はその結果を step.playerGames で返す。
 * @returns {{day:number, games:Array, playerGames:Array, seasonEnded:boolean}}
 */
export function advanceDay(state, opts = {}) {
  const step = advanceRuntimeDay(state.rt, opts);
  if (step.seasonEnded) recordSeasonHistory(state);
  return step;
}

/**
 * まとめて進める。
 * @param {Object} state
 * @param {'nextPlayerGame'|'weekEnd'|'monthEnd'|'seasonEnd'} until
 * @returns {Array} 消化した各日の step
 */
export function advanceTo(state, until, opts = {}) {
  const rt = state.rt;
  const steps = [];
  if (until === 'seasonEnd') {
    while (!rt.finished) steps.push(advanceDay(state, opts));
    return steps;
  }
  if (until === 'nextPlayerGame') {
    while (!rt.finished) {
      const s = advanceDay(state, opts);
      steps.push(s);
      if (s.playerGames.length) break;
    }
    return steps;
  }
  if (until === 'weekEnd' || until === 'monthEnd') {
    const span = until === 'weekEnd' ? state.cfg.game.daysPerWeek : state.cfg.game.daysPerMonth;
    const boundary = (Math.floor(pendingDay(rt) / span) + 1) * span; // 次の週/月境界（含まない）
    while (!rt.finished && pendingDay(rt) < boundary) steps.push(advanceDay(state, opts));
    return steps;
  }
  throw new Error(`advanceTo: 未知の until '${until}'`);
}

/**
 * オフシーズン遷移（C2b・完全版）: 完了したシーズンから翌年開幕へ。全選手へ
 * 故障→ブレイク→加齢→引退/新人補充を適用し（真値を動かす・ロスターを世代交代・§10）、
 * yearIndex++・year++ したうえで翌シーズンを開幕状態でセットする。
 *
 * 決定論: すべて (masterSeed, yearIndex, year) 由来の階層シード（Date.now/Math.random 非使用）。
 *   load 側も同一 (masterSeed, yearIndex) で過去年のオフを replay するため、多年セーブの復元も
 *   bit 一致する（引退で消えた選手・補充新人まで完全再現）。
 * エンジン不変: 本関数は 1年目終了後に初めて呼ばれる。1年目レギュラーシーズン（既存50較正）は
 *   完全に不変（故障/ブレイク/加齢/引退は 2年目以降の真値・ロスターにのみ効く）。
 *
 * ★H2（プレイヤー参加型ドラフト）: cfg.game.interactiveDraft が true かつ自チームの指名番になると
 *   **中断リターン**する（driveOffseasonDraft が state.awaitingDraft/offseasonStage を立てて null を
 *   返す）。呼び出し側は戻り値が null なら「まだ終わっていない」と判定し、submitDraftPick で指名を
 *   送って解決を続ける。interactiveDraft=false（既定）なら常に完了して off 要約を返す＝既存呼び出し
 *   元は挙動不変（byte 同一）。
 * @param {Object} state GameState（シーズンが finished であること）
 * @returns {Object|null} オフシーズン要約（injuries/breakouts/retirees/rookies/…）。中断中は null
 */
export function advanceYear(state) {
  if (!state.rt || !state.rt.finished) {
    throw new Error('advanceYear: シーズン未終了（seasonEnd まで進めてから呼ぶこと）');
  }
  if (state.awaitingDraft) {
    throw new Error('advanceYear: ドラフト中断中（submitDraftPick で指名を解決してから呼ぶこと）');
  }
  if (state.ownerPending) {
    throw new Error('advanceYear: オーナー裁定中（resolveOwnerDecision で選択してから呼ぶこと）');
  }
  // H5-B: オーナー目標の評価（完了年・プレイヤー球団のみ・二重評価ガード）。表示＋信任のみに作用し、
  //   オフ処理（driveOffseasonDraft）本体には一切干渉しない。
  if (evaluateOwnerYear(state)) return null; // 解任イベント発生＝中断（state.ownerPending）
  return driveOffseasonDraft(state);
}

/**
 * H5-B: 完了年のオーナー評価。信任を更新し、解任条件を踏んだら state.ownerPending を立てて
 * true（中断）を返す。評価済み年は何もしない（再入安全）。
 */
function evaluateOwnerYear(state) {
  if (!state.playerTeamId || !state.ownerGoals || state.ownerGoals.yearIndex !== state.yearIndex) return false;
  if (state.ownerEvaluatedYear === state.yearIndex) return false;
  state.ownerEvaluatedYear = state.yearIndex;
  const og = state.cfg.tuning.ownerGoals;
  const standings = standingsForYear(state, state.year);
  const results = evaluateOwnerGoals(state.ownerGoals.goals, {
    standings, teamId: state.playerTeamId, league: state.league,
    careerStats: state.careerStats, year: state.year, cfg: state.cfg,
  });
  const before = state.ownerTrust;
  state.ownerTrust = clamp(state.ownerTrust + trustDelta(results, standings, state.playerTeamId, state.cfg), 0, 100);
  state.lastOwnerReport = { year: state.year, results, trustBefore: before, trustAfter: state.ownerTrust };
  if (state.cfg.game.allowFiring && state.ownerTrust < og.fireBelow) {
    const toTeam = pickTransferOffer(standings, state.playerTeamId);
    if (toTeam) {
      state.ownerPending = { yearIndex: state.yearIndex, toTeam, canPlea: !state.pleaUsed };
      state.lastOwnerReport.fired = true;
      return true;
    }
  }
  return false;
}

/**
 * H5-B: 解任イベントの裁定。choice='transfer'（オファー球団へ移籍・信任リセット）または
 * 'plea'（留任嘆願・キャリア1回限り・信任小回復）。選択は marketInterventions へ記録され、
 * 裁定後はオフ処理（driveOffseasonDraft）を続行する（ドラフト中断ならそのまま null 連鎖）。
 */
export function resolveOwnerDecision(state, choice) {
  const pend = state.ownerPending;
  if (!pend) throw new Error('resolveOwnerDecision: 裁定待ちの解任イベントが無い');
  const og = state.cfg.tuning.ownerGoals;
  if (choice === 'plea') {
    if (!pend.canPlea) throw new Error('resolveOwnerDecision: 留任嘆願は使用済み');
    state.pleaUsed = true;
    state.ownerTrust = clamp(state.ownerTrust + og.pleaBonus, 0, 100);
    state.lastOwnerReport.resolution = { choice: 'plea' };
  } else if (choice === 'transfer') {
    state.playerTeamId = pend.toTeam;
    state.ownerTrust = og.transferResetTrust;
    state.pleaUsed = false; // 新天地では嘆願権が戻る（球団との関係はリセット）
    captureBaseManager(state); // 采配介入の基準を新球団の監督へ張り替え
    state.lastOwnerReport.resolution = { choice: 'transfer', toTeam: pend.toTeam };
  } else {
    throw new Error(`resolveOwnerDecision: 不明な選択 ${choice}`);
  }
  state.marketInterventions.push({ yearIndex: state.yearIndex, phase: 'ownerFire', choice, toTeam: choice === 'transfer' ? pend.toTeam : null });
  state.ownerPending = null;
  return driveOffseasonDraft(state);
}

/**
 * ★H2: プレイヤー参加型ドラフトの指名を送る。中断中（state.awaitingDraft）に、選べる候補
 * （awaitingDraft.pool のうち、自チームの残り空き枠 vacTypes と同型）から1人を指名し、
 * marketInterventions に {phase:'draft', yearIndex, round, prospectId} を積んで解決を続行する
 * （bidFA/proposeTrade と同じ「介入ログを積む」流儀。runDraft がログを消費して同一結果を再構築＝
 * live/save-load replay で bit 一致）。
 * @param {Object} state GameState（state.awaitingDraft が立っていること）
 * @param {string} prospectId 指名する選手（awaitingDraft.pool の id）
 * @returns {Object|null} まだ指名が残っていれば null（次の中断へ）。全ラウンド完了なら off 要約。
 */
export function submitDraftPick(state, prospectId) {
  const aw = state.awaitingDraft;
  if (!aw) throw new Error('submitDraftPick: 中断中のドラフトが無い');
  const prospect = aw.pool.find((p) => p.id === prospectId);
  if (!prospect) throw new Error(`submitDraftPick: ${prospectId} は現在指名できない（プール外）`);
  const tk = `${prospect.role}:${prospect.primaryPos}`;
  if (!aw.vacTypes.some((v) => `${v.role}:${v.primaryPos}` === tk)) {
    throw new Error(`submitDraftPick: ${prospectId}（${tk}）は自チームの空き枠と型が一致しない`);
  }
  state.marketInterventions.push({ yearIndex: state.yearIndex, phase: 'draft', round: aw.round, prospectId });
  return driveOffseasonDraft(state);
}

// --- セーブ/ロード ----------------------------------------------------------

/**
 * GameState を JSON 安全なオブジェクトへ直列化する（RNG座標込み・決定論復元可能）。
 * players / seasonState.standings は集計値（§17: 集計のみ永続）。生打球は含めない。
 * @returns {Object} JSON.stringify 可能なセーブブロブ
 */
export function save(state) {
  const rt = state.rt;
  const seasonState = rt
    ? {
        season: rt.season,
        cursor: rt.cursor, // = 進行 gi（day 境界）。seed とあわせて RNG カーソルに相当
        pendingDay: pendingDay(rt),
        finished: rt.finished,
        standings: [...rt.standings.values()].map((s) => ({
          teamId: s.teamId,
          g: s.g,
          w: s.w,
          l: s.l,
          t: s.t,
          rs: s.rs,
          ra: s.ra,
          il: { ...s.il },
        })),
        runSplit: { dh: { ...rt.runSplit.dh }, noDh: { ...rt.runSplit.noDh } },
        playerGameLog: rt.playerGameLog,
        postseason: rt.finished ? rt.postseason : null,
        // 二軍リーグ（F2-2）: 順位/進行位置のスナップショット（load の replay 検証と UI 素材）。
        farm: rt.farm
          ? {
              cursor: rt.farm.cursor,
              finished: rt.farm.finished,
              standings: [...rt.farm.standings.values()].map((s) => ({
                teamId: s.teamId,
                g: s.g,
                w: s.w,
                l: s.l,
                t: s.t,
                rs: s.rs,
                ra: s.ra,
              })),
            }
          : null,
      }
    : null;
  return {
    schemaVersion: state.schemaVersion,
    engineVersion: state.engineVersion,
    masterSeed: state.masterSeed,
    playerTeamId: state.playerTeamId,
    settings: state.settings,
    firstSeason: state.firstSeason,
    yearIndex: state.yearIndex,
    year: state.year,
    // 現行シーズンの選手集計（§17集計値。UI表示/スキーマ準拠。復元は replay 由来で厳密再現）
    players: encodeSeasons(rt ? [...rt.stats.stats.values()] : []),
    // 現行シーズンの二軍選手集計（F2-2 farmStats・一軍と分離。復元は replay 由来で厳密再現）
    farmPlayers: encodeSeasons(rt && rt.farm ? [...rt.farm.stats.stats.values()] : []),
    // R5: 列指向の数値エンコード（キー名の繰り返しを落とす。値は丸めない＝決定論を壊さない）
    careerStats: encodeSeasons(state.careerStats),
    careerFarmStats: encodeSeasons(state.careerFarmStats),
    teamHistory: state.teamHistory,
    interventions: state.interventions,
    marketInterventions: state.marketInterventions, // 市場操作ログ（オフシーズンの replay に必要）
    transactionLog: state.transactionLog, // H1-2: 因縁ライバル追跡用のコンパクト取引ログ（additive）
    trainingPolicies: state.trainingPolicies, // H4: 育成方針の人間介入ログ（オフシーズンの replay に必要）
    // ★R5: 開幕時点のリーグ（真値/ロスター）そのものを保存する。旧 v3 は「過去オフを再計算して
    //   復元」していたが、前史30年ではその入力（30年ぶん全選手の成績）が save に必要になり破綻する。
    leagueSnapshot: seasonStartLeague(state),
    retiredPlayers: state.retiredPlayers, // 引退者サマリ（前史ぶんは pruneBurnInHistory で空）
    awardsHistory: state.awardsHistory, // 確定した年度別受賞（再計算に頼らない）
    injuryLog: state.injuryLog, // 故障歴の記録（復元には不要だが表示/記録用に保持）
    pendingInjuries: state.pendingInjuries,
    // H2: オフシーズン中断状態（additive）。'awaitingDraft' の中身（残りプール等）は保存しない
    //   （シードから決定論再生成できる＝pool不要。marketInterventions の phase:'draft' ログだけで
    //   load が driveOffseasonDraft を再駆動し、同じ中断点を再構築する）。
    offseasonStage: state.offseasonStage ?? null,
    // H5-B: オーナー信任（additive）。goals は startYear の純関数で再生成できるが、評価済みフラグ・
    //   信任・嘆願・裁定待ちは状態そのもの＝直接保存する（R5以降オフの replay は無いため単純永続でよい）。
    ownerTrust: state.ownerTrust,
    ownerEvaluatedYear: state.ownerEvaluatedYear ?? null,
    pleaUsed: !!state.pleaUsed,
    ownerPending: state.ownerPending ?? null,
    lastOwnerReport: state.lastOwnerReport ?? null,
    seasonState,
    rngCursors: { seed: rt ? rt.seed : null, cursor: rt ? rt.cursor : 0 },
  };
}

/**
 * ★R5: 「開幕時点」のリーグを作る（load はここから当季の日次 replay を始める）。
 * 当季に起きた育成→支配下の季節中昇格は **逆順に巻き戻して** 開幕時点のロスターへ戻す
 * （日次 replay がもう一度同じ昇格を再現するため、巻き戻さないと二重に適用される）。
 * 真値はシーズン中に動かない（鉄則7・R3で担保）ので、真値はそのまま保存してよい。
 */
function seasonStartLeague(state) {
  const clone = JSON.parse(JSON.stringify({
    masterSeed: state.masterSeed,
    teams: state.league.teams,
    players: state.league.players,
    farm: state.league.farm ?? [],
    // 選手アイデンティティ: 世界の名前台帳（引退者・指名漏れ含む既出フルネーム。ドラフト命名の衝突防止）
    usedNames: state.league.usedNames ?? [],
  }));
  // 当季の育成→支配下昇格を逆順に巻き戻す（日次 replay が同じ昇格をもう一度再現するため）。
  //   applyFarmPromotionSwap は配列の位置を保存する入替なので、逆スワップで厳密に元へ戻る。
  const log = state.rt ? state.rt.farmPromotionLog : [];
  for (let i = log.length - 1; i >= 0; i--) applyFarmPromotionSwap(clone, log[i].downId, log[i].upId);
  rebuildTeamRosters(clone);
  // 采配介入（人間の監督プロファイル差し替え）は interventions ログから日次 replay で再適用される。
  //   スナップショットには **介入前の素の監督** を入れる（介入後の監督を保存すると、
  //   介入日より前の試合まで介入後の采配で再走されてしまい、無セーブ通しと食い違う）。
  if (state.baseManager) {
    const my = clone.teams.find((t) => t.id === state.playerTeamId);
    if (my) my.manager = { ...state.baseManager };
  }
  return clone;
}

/** 復元した順位が保存 snapshot と一致するか検査（セーブ破損検出＋決定論の門番）。 */
function verifyStandings(rt, snapshot) {
  if (!snapshot) return;
  const by = new Map(snapshot.map((s) => [s.teamId, s]));
  for (const [tid, live] of rt.standings) {
    const s = by.get(tid);
    if (!s) throw new Error(`load: 順位snapshotに ${tid} が無い`);
    if (live.w !== s.w || live.l !== s.l || live.t !== s.t || live.rs !== s.rs || live.ra !== s.ra) {
      throw new Error(`load: 復元順位が保存値と不一致（${tid}）＝決定論破れ or セーブ破損`);
    }
  }
}

/**
 * セーブブロブから GameState を復元する。開幕状態からシーズンを組み直し、保存時点の
 * cursor まで日次で再走（replay）して usage/集計/順位を厳密に再現する。
 * → load 後に advance を続けた結果が、無セーブ通しと完全一致する（階層シードの帰結）。
 * @param {string|Object} blob save() の返値、または JSON文字列
 * @param {{cfg?:Object}} options
 * @returns {Object} GameState
 */
export function load(blob, options = {}) {
  const data = typeof blob === 'string' ? JSON.parse(blob) : blob;
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`load: 未対応のスキーマ版 ${data.schemaVersion}（現行 ${SCHEMA_VERSION}）`);
  }
  const cfg = options.cfg ?? createConfig();
  // ★R5: 開幕時点のリーグを save から直接復元する（旧 v3 の「過去オフを再計算して再構築」は撤去）。
  //   前史30年では再計算の入力（30年ぶん全選手の成績）が save に必要になり成立しないため。
  const snap = data.leagueSnapshot;
  if (!snap) throw new Error('load: leagueSnapshot が無い（v3以前のセーブ）');
  const league = {
    masterSeed: data.masterSeed >>> 0,
    teams: snap.teams,
    players: snap.players,
    farm: snap.farm ?? [],
    // 選手アイデンティティ: 名前台帳。台帳の無い旧セーブは現役+育成から再構築（引退者ぶんは
    //   復元不能＝以後の新人と稀に同名衝突しうるが、20,864通りの名前空間では実害なし）。
    usedNames: snap.usedNames ?? [...snap.players, ...(snap.farm ?? [])].map((p) => p.name),
  };
  // H3-1: 性格タグの後方互換補完（phaseH_fun_spec 全柱共通の鉄則6・H3-1）。personality は
  //   独立シードから決定論的に導出できるため、新規生成(generatePitcher/generateFielder)と
  //   同じ式(assignPersonality)を旧セーブにも適用すれば同一の結果になる＝「後付けできる」。
  //   2026-07-20 選手アイデンティティ: 新規生成は名前キー（同じ名前=同じ選手）になったため補完も
  //   名前キーで揃える（personality を保存済みの通常セーブはこの行を通らない＝影響は欠落補完のみ）。
  for (const p of league.players) if (p.personality == null) p.personality = assignPersonality(p.name ?? p.id);
  for (const p of league.farm) if (p.personality == null) p.personality = assignPersonality(p.name ?? p.id);
  // H5-A: team.finance の後方互換補完（phaseH_fun_spec 全柱共通の鉄則6）。budget は masterSeed×teamId
  //   の独立シードから決定論的に導出できる（personality と同じ「後付けできる」構造）ため、
  //   新規生成(generate.mjs teamFinanceProfile)と同じ式で欠けているチームだけ埋める。payroll は
  //   現在の支配下ロスターの現行年俸合計から再計算する（refreshTeamFinance が両方まとめて行う）。
  refreshTeamFinance(league, cfg, data.masterSeed >>> 0);
  const state = {
    schemaVersion: data.schemaVersion,
    engineVersion: data.engineVersion,
    masterSeed: data.masterSeed >>> 0,
    playerTeamId: data.playerTeamId,
    settings: data.settings ?? { autoManage: true },
    firstSeason: data.firstSeason,
    yearIndex: data.yearIndex ?? 0,
    year: data.year,
    cfg,
    league,
    careerStats: decodeSeasons(data.careerStats),
    careerFarmStats: decodeSeasons(data.careerFarmStats), // 完了シーズンの二軍集計（F2-2・blob から復元）
    teamHistory: data.teamHistory ?? [],
    retiredPlayers: data.retiredPlayers ?? [], // R5: 直接復元（前史ぶんは保持しない）
    awardsHistory: data.awardsHistory ?? [], // R5: 確定した年度別受賞
    interventions: data.interventions ?? [],
    marketInterventions: data.marketInterventions ?? [], // 市場操作ログ（過去オフの replay に使う）
    transactionLog: data.transactionLog ?? [], // H1-2: 旧セーブは [] 補完（additive save field）
    trainingPolicies: data.trainingPolicies ?? [], // H4: 旧セーブは [] 補完（additive save field）
    farmPromotionLog: data.farmPromotionLog ?? [], // 育成→支配下季節中昇格ログ（§req_20260708）
    injuryLog: data.injuryLog ?? [], // R3: 試合中に発生した故障のログ（過去年オフの replay 入力）
    pendingInjuries: data.pendingInjuries ?? [], // R3: 当年開幕ILの残り離脱 day 数（blob から復元）
    offseasonStage: data.offseasonStage ?? null, // H2: 旧セーブは null 補完（additive save field）
    awaitingDraft: null, // H2: 下で driveOffseasonDraft が再駆動して復元する（live限定・保存はしない）
    // H5-B: オーナー信任（additive・旧セーブは初期値補完）。ownerGoals は下の startYear 相当処理
    //   （restore後の rt 再構築フロー）で純関数再生成される（保存不要）。
    ownerGoals: null,
    ownerTrust: data.ownerTrust ?? cfg.tuning.ownerGoals.trustStart,
    ownerEvaluatedYear: data.ownerEvaluatedYear ?? null,
    pleaUsed: !!data.pleaUsed,
    ownerPending: data.ownerPending ?? null,
    lastOwnerReport: data.lastOwnerReport ?? null,
    rt: null,
  };
  // ★R5: 過去年のオフシーズン再計算（replay）は撤去した。開幕時点のリーグを save から直接
  //   復元しているので、真値もロスターも既に保存時点の姿になっている。
  //   （旧方式は「masterSeed から再生成 → 過去オフを全部やり直す」で、30年の前史では
  //     その入力である30年ぶん・引退者含む全選手の成績が save に必要になり成立しない。
  //     加えて replay 由来の復元ズレを実際に2度踏んでいる＝構造的な脆さでもあった）
  //   当季の日次 replay（下の seasonState 復元）は従来どおり行い、順位で検算する。
  captureBaseManager(state); // replay で team.manager が書き換わる前に素の監督を控える
  startYear(state); // seasonSeed は yearIndex 依存 → 保存時と同一シードで開幕
  const ss = data.seasonState;
  if (ss) {
    // 保存時 cursor まで日次 replay（advanceDay ではなく advanceRuntimeDay ＝ 履歴の二重記録を避ける。
    // 完了済みシーズンの careerStats/teamHistory は blob から復元済み）。
    while (state.rt.cursor < ss.cursor) advanceRuntimeDay(state.rt);
    verifyStandings(state.rt, ss.standings);
    // 二軍の復元検証（F2-2）: replay が再構築した farm の進行位置/順位が保存スナップショットと
    // 一致するか（一軍と同じ決定論の門番。farm 不成立構成では両方 null で素通り）。
    if (ss.farm && state.rt.farm) {
      if (state.rt.farm.cursor !== ss.farm.cursor) {
        throw new Error(`load: 二軍の復元cursorが保存値と不一致（${state.rt.farm.cursor} != ${ss.farm.cursor}）`);
      }
      verifyStandings(state.rt.farm, ss.farm.standings);
    }
  }
  // ★H2: ドラフト中断中のセーブから復元した場合、driveOffseasonDraft を1回再駆動して同じ中断点
  //   （state.awaitingDraft）を再構築する。pool は保存していない＝marketInterventions の
  //   phase:'draft' ログ（既に蓄積済み）を使って runDraft が最初から再生し、同じ pause に到達する
  //   （決定論）。ログが既に全ラウンドぶん揃っていれば pause せずそのまま完了まで進む
  //   （H2設計方針4「load-replay は非対話」＝蓄積済みログの再生であり新たな pause は生まない）。
  if (state.offseasonStage === 'awaitingDraft') {
    driveOffseasonDraft(state);
  }
  return state;
}

/**
 * 全時代の選手インデックス（記録/受賞履歴/マイルストーンの再計算用）。
 * 現役 league.players ＋ 引退者サマリ(retiredPlayers) を統合する。
 *
 * careerStats は全年ぶん永続する一方、引退選手は league.players から外れる。
 * leagueRecords/playerAwardHistory/milestones が careerStats を走査する際、
 * 引退選手を playersById から引けないと buildEvals がそのシーズンを丸ごと落とし、
 * 「引退したレジェンドが通算記録から消える」「過去年の表彰が当時の真の受賞者(引退済)を
 * 除外して現役選手へ誤帰属する」不具合になる（C4検証・§17）。
 * 引退者サマリは {id,name,role,primaryPos} を持ち、awards が使う
 * evalSeason(role)/ベストナイン(primaryPos)/表示(name) の必要項目を満たす。
 */
export function allPlayersById(state) {
  const m = new Map(state.league.players.map((p) => [p.id, p]));
  for (const d of state.league.farm ?? []) if (!m.has(d.id)) m.set(d.id, d); // 育成（季節中の昇降格で入替わる）
  for (const r of state.retiredPlayers) if (!m.has(r.id)) m.set(r.id, r);
  return m;
}

// --- C4 演出APIの再エクスポート（UI/テストが './game/index.mjs' 経由で使う。バンドルでは
//     各元関数が strip 後にグローバル化するため、この export 行は build.mjs で剥がれても機能する）。
export {
  computeSeasonAwards, playerAwardHistory, nicknameFor, evalSeason,
  leagueRecords, teamRecords, championCounts, milestones,
  careerBatting, careerPitching, careerEraPlus, DEF_AWARD_NAME, TITLE_LABELS,
  detectGameNotables, notableHeadline, streakOf, weeklyDigest, rosterMoveHeadline,
  mediaReputation, REPUTATION_LABELS, careerRispEdge, careerBaserunning,
};
// H1: ストーリーライン演出APIの再エクスポート（UI/テストが './game/index.mjs' 経由で使う）。
export {
  titleRaces, titleRaceHeadlines, rookieRace, rookieRaceHeadlines,
  recordPaces, recordPaceHeadlines, weeklyStorylineDigest,
  appendTransactionLog, rivalriesOf, rivalryGameHeadlines,
  retirementRoadCandidates, retirementRoadHeadlines,
  retirementCeremonies, retirementCeremonyText, ownTeamRetirementHeadlines,
  draftClassHeadlines, // P5: 「今年の逸材」ドラフト前ニュース（fun_theory_research P5）
} from './storylines.mjs';
// 時代トレンド（D3・§11.3）: era 計算を UI/テストが index 経由で使えるよう再エクスポート。
export { computeEra, eraSeasonConfig, teamBalanceBoost } from './era.mjs';
// H2: プレイヤー参加型ドラフト会議のスカウトレポートAPIを再エクスポート（UI/テストが
//   './game/index.mjs' 経由で使う。submitDraftPick は本ファイルで直接 export 済み）。
export { draftScoutView, draftPreviewHeadlines };
// H4: 育成方針・キャンプの意味論APIを再エクスポート（UI/テストが './game/index.mjs' 経由で使う。
//   setTrainingPolicy/clearTrainingPolicy は本ファイルで直接 export 済み）。
export { TRAINING_LABELS, TRAINING_KINDS, parsePolicy, coachOverallScore };

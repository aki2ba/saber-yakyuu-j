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
import { generateLeague } from '../generate.mjs';
import { ENGINE_VERSION } from '../engine.mjs';
import { startSeasonRuntime, advanceRuntimeDay, pendingDay } from './season_runtime.mjs';
import { applyAging } from './aging.mjs';
import { applyInjuries } from './injury.mjs';
import { applyBreakouts } from './breakout.mjs';
import { runRetirement, rebuildTeamRosters } from './roster.mjs';
import { runMarket, teamEvalProfile } from './market.mjs';
import { runFA, runTrades, runReleaseAndPickup, runContractRenewal } from './transactions.mjs';

/** セーブスキーマ版（構造/オフシーズン意味論の変更時にインクリメント。load の互換判定に使う）。
 *  v2（C2b）: オフシーズン遷移が加齢のみ→故障/ブレイク/引退/新人補充の完全版に拡張。
 *  真値/ロスターは §17 に従い save に含めず masterSeed から replay 再構築するため、v1 の
 *  「加齢のみ」replay とは復元結果が異なる。→ v1 セーブは明示的に弾く（誤復元を防ぐ）。 */
export const SCHEMA_VERSION = 2;

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
function offseasonTransition(league, cfg, { masterSeed, yearIndex, year, standings, careerStats = [], marketInterventions = [] }) {
  const injuries = applyInjuries(league.players, cfg, { seed: hashSeed(masterSeed, 'injury', yearIndex), year });
  const breakouts = applyBreakouts(league.players, cfg, { seed: hashSeed(masterSeed, 'breakout', yearIndex), year });
  applyAging(league.players, cfg, { seed: offseasonSeed(masterSeed, yearIndex), yearIndex });

  // 当年（完了年）の "実観測" statline を playerId で引けるようにする（放出/契約更改の入力・§12.2）。
  //   careerStats は全年ぶんだが season==year に絞る＝live も load-replay も同一部分集合（決定論）。
  const obs = new Map();
  for (const s of careerStats) if (s.season === year) obs.set(s.playerId, s);
  // 当年ぶんのプレイヤー市場操作のみ適用（他年の介入は除外・再現可能）。
  const ivs = marketInterventions.filter((iv) => (iv.yearIndex ?? 0) === yearIndex);
  // 球団評価プロファイル（キャリア中固定・§13）。市場フェーズ共通で使う。
  const profiles = new Map();
  for (const t of league.teams) profiles.set(t.id, teamEvalProfile(masterSeed, t.id, cfg));

  // 引退（生存者を league.players へ・空き枠 vacancies を得る）。
  const { retirees, vacancies } = runRetirement(league, cfg, { seed: hashSeed(masterSeed, 'retire', yearIndex), debutYear: year + 1 });
  // FA → トレード（引退後の生存者を同型1:1スワップ・構成恒常・ドラフト枠に非干渉）。
  const fa = runFA(league, cfg, { profiles, masterSeed, yearIndex, interventions: ivs });
  const trades = runTrades(league, cfg, { profiles, masterSeed, yearIndex, interventions: ivs });
  rebuildTeamRosters(league);
  // 補充: 育成昇格→ドラフト（ウェーバー逆順×くじ）→育成獲得（§13/§15/§12.1）。
  const { promoted, rookies, promotions, draftLog } = runMarket(league, cfg, { vacancies, standings, masterSeed, yearIndex, debutYear: year + 1 });
  league.players = league.players.concat(promoted, rookies);
  rebuildTeamRosters(league);
  // 戦力外→拾い上げ（ドラフト後の全支配下から同型循環・§12.2）。新人は観測が無く対象外＝除外される。
  const pickups = runReleaseAndPickup(league, cfg, { profiles, masterSeed, yearIndex, standings, obs });
  rebuildTeamRosters(league);
  // 契約更改（フレーバー・エンジン非干渉）。
  const contracts = runContractRenewal(league, cfg, { obs });

  return { injuries, breakouts, retirees, rookies, promotions, draftLog, fa, trades, pickups, contracts };
}

/** 完了年 y（=firstSeason+y）の最終順位を teamHistory から取り出す（ウェーバー順の素）。 */
function standingsForYear(state, year) {
  const hist = state.teamHistory.find((h) => h.year === year);
  return hist ? hist.standings : null;
}

/** 現行 yearIndex のシーズンを開幕状態でセット（rt を張り替える）。 */
function startYear(state) {
  state.rt = startSeasonRuntime(state.league, state.cfg, {
    season: state.year,
    seed: seasonSeed(state),
    playerTeamId: state.playerTeamId,
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
 * @param {number} masterSeed リーグ生成＋進行のマスターシード（決定論の起点）
 * @param {string} playerTeamId 自チーム（'T1'..'T12'）
 * @param {{cfg?:Object, autoManage?:boolean}} options
 * @returns {Object} GameState
 */
export function newGame(masterSeed, playerTeamId, options = {}) {
  const cfg = options.cfg ?? createConfig();
  const league = generateLeague(masterSeed, cfg);
  league.farm = []; // 育成枠（C3a・支配下396とは別枠）。1年目は空＝既存50較正に無影響
  if (!league.teams.some((t) => t.id === playerTeamId)) {
    throw new Error(`playerTeamId ${playerTeamId} がリーグに存在しない`);
  }
  const state = {
    schemaVersion: SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    masterSeed: masterSeed >>> 0,
    playerTeamId,
    settings: { autoManage: options.autoManage ?? true }, // C1a は全おまかせ（人間介入は後段UI）
    firstSeason: cfg.game.firstSeason,
    yearIndex: 0,
    year: cfg.game.firstSeason,
    cfg,
    league,
    careerStats: [], // 完了シーズンの選手集計（永続・§17）
    teamHistory: [], // 完了シーズンのチーム成績/優勝（永続）
    retiredPlayers: [], // 引退者サマリ（記録/通算・§17集計値。replayで再構築するため save には含めない）
    interventions: [], // 人間介入ログ（采配プロファイル差し替え。save/replayで再現）
    marketInterventions: [], // 市場操作ログ（FA入札/トレード起案。オフシーズンで適用・save/replayで再現）
    pendingInjuries: [], // 直前オフで確定した故障（新シーズン開幕ILの素・save非対象＝replayで再構築）
    rt: null, // 現行シーズンの日次ランタイム
  };
  captureBaseManager(state); // rt 構築・介入適用の前に「素の監督」を控える
  startYear(state);
  return state;
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

/** 完了したシーズンの集計値を永続領域へ退避（§17: 集計値のみ永続）。 */
function recordSeasonHistory(state) {
  const rt = state.rt;
  state.teamHistory.push({
    year: state.year,
    standings: rt.table.map((r) => ({
      teamId: r.teamId,
      name: r.name,
      league: r.league,
      g: r.g,
      w: r.w,
      l: r.l,
      t: r.t,
      rs: r.rs,
      ra: r.ra,
    })),
    champion: rt.postseason ? rt.postseason.champion : null,
  });
  for (const s of rt.stats.stats.values()) {
    state.careerStats.push({
      playerId: s.playerId,
      season: s.season,
      teamId: s.teamId,
      batting: s.batting,
      pitching: s.pitching,
      baserunning: s.baserunning,
      fielding: s.fielding,
    });
  }
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
 * @param {Object} state GameState（シーズンが finished であること）
 * @returns {{injuries:Array, breakouts:Array, retirees:Array, rookies:Array}} オフシーズン要約
 */
export function advanceYear(state) {
  if (!state.rt || !state.rt.finished) {
    throw new Error('advanceYear: シーズン未終了（seasonEnd まで進めてから呼ぶこと）');
  }
  const off = offseasonTransition(state.league, state.cfg, {
    masterSeed: state.masterSeed,
    yearIndex: state.yearIndex,
    year: state.year,
    standings: standingsForYear(state, state.year), // 完了年の最終順位＝ドラフトのウェーバー順
    careerStats: state.careerStats, // 当年 statline を放出/契約更改の "実観測" に使う（season==year で絞る）
    marketInterventions: state.marketInterventions, // 当年ぶんのFA入札/トレード起案を適用
  });
  state.retiredPlayers.push(...off.retirees); // 記録用の永続サマリ（replayでも同順に再構築される）
  state.pendingInjuries = off.injuries; // このオフの故障→翌シーズン開幕の離脱(IL)へ持ち込む（C2.4）
  state.yearIndex += 1;
  state.year += 1;
  startYear(state); // 新シーズンを開幕状態でセット（世代交代後の真値/ロスター・yearIndex 依存シード）
  return off;
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
    players: rt ? [...rt.stats.stats.values()] : [],
    careerStats: state.careerStats, // 完了シーズン集計（永続）
    teamHistory: state.teamHistory,
    interventions: state.interventions,
    marketInterventions: state.marketInterventions, // 市場操作ログ（オフシーズンの replay に必要）
    seasonState,
    rngCursors: { seed: rt ? rt.seed : null, cursor: rt ? rt.cursor : 0 },
  };
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
  const league = generateLeague(data.masterSeed >>> 0, cfg);
  league.farm = []; // 育成枠は save に含めず replay で再構築（§17: 集計のみ永続）
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
    careerStats: data.careerStats ?? [],
    teamHistory: data.teamHistory ?? [],
    retiredPlayers: [], // 過去年のオフを replay して再構築（save には含めない・§17）
    interventions: data.interventions ?? [],
    marketInterventions: data.marketInterventions ?? [], // 市場操作ログ（過去オフの replay に使う）
    pendingInjuries: [], // 直前オフの故障（replay の最終オフから再構築＝当年開幕ILの素）
    rt: null,
  };
  // 過去年（0..yearIndex-1）のオフシーズン遷移（故障/ブレイク/加齢/引退/新人補充）を決定論 replay で
  // 再適用し、真値もロスター（引退・補充）も保存時点へ復元する。trueAbility とロスター構成は §17
  // （集計のみ永続）に従い save に含めない＝masterSeed から再構築するのが正。
  // yearIndex=0（1年目セーブ）ではループ非実行＝既存の1年目セーブと完全に同一挙動（回帰安全）。
  let lastOff = null;
  for (let y = 0; y < state.yearIndex; y++) {
    const off = offseasonTransition(state.league, cfg, {
      masterSeed: state.masterSeed,
      yearIndex: y,
      year: state.firstSeason + y,
      // ウェーバー順の素 = 完了年の順位。teamHistory は blob から復元済み＝live と同一値（決定論）。
      standings: standingsForYear(state, state.firstSeason + y),
      // 放出/契約更改の "実観測" は careerStats（blob 復元済み）を season==year で絞る＝live と同一部分集合。
      careerStats: state.careerStats,
      marketInterventions: state.marketInterventions,
    });
    state.retiredPlayers.push(...off.retirees);
    lastOff = off;
  }
  // 保存時点シーズン（yearIndex）の開幕ILは「直前オフ（yearIndex-1）」の故障で決まる。
  // 上記 replay の最終反復がまさにそれ＝live の advanceYear と同一 off から再構築（決定論）。
  state.pendingInjuries = lastOff ? lastOff.injuries : [];
  captureBaseManager(state); // replay で team.manager が書き換わる前に素の監督を控える
  startYear(state); // seasonSeed は yearIndex 依存 → 保存時と同一シードで開幕
  const ss = data.seasonState;
  if (ss) {
    // 保存時 cursor まで日次 replay（advanceDay ではなく advanceRuntimeDay ＝ 履歴の二重記録を避ける。
    // 完了済みシーズンの careerStats/teamHistory は blob から復元済み）。
    while (state.rt.cursor < ss.cursor) advanceRuntimeDay(state.rt);
    verifyStandings(state.rt, ss.standings);
  }
  return state;
}

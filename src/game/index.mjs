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

/** セーブスキーマ版（構造変更時にインクリメント。load の互換判定に使う）。 */
export const SCHEMA_VERSION = 1;

// --- 年ごとのシード（1年目=masterSeed で simulateSeason と同一。2年目以降は派生） -------
function seasonSeed(state) {
  return state.yearIndex === 0 ? state.masterSeed : hashSeed(state.masterSeed, 'season', state.yearIndex);
}

/** 現行 yearIndex のシーズンを開幕状態でセット（rt を張り替える）。 */
function startYear(state) {
  state.rt = startSeasonRuntime(state.league, state.cfg, {
    season: state.year,
    seed: seasonSeed(state),
    playerTeamId: state.playerTeamId,
  });
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
    interventions: [], // 人間介入ログ（采配プロファイル差し替え。save/replayで再現）
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
    interventions: data.interventions ?? [],
    rt: null,
  };
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

// ============================================================================
// P2: 試合後の「勝因/敗因カード」（thyroxin/research/fun_theory_research_20260720.md 提案P2）
//
//   WPA（勝率貢献度）は src/sim/context.mjs に実装済みだが、その2パス構造（pass1でRE/WE/LI表を
//   大標本導出→pass2で同一試合を再走しΔWPAを選手の統計へ加算）は simulateSeason（一括シーズン
//   シム・calibrate.mjs 用）でのみ結線されており、ゲームシェル（日次進行・src/game/）は結線して
//   いない（=season_runtime.mjs の advanceRuntimeDay は opts.gameContext を渡さない）。
//   ゲームシェルへ結線し直す（シーズン全体を2回走らせる/選手のシーズン集計へ実WPAを加算する）と
//   ①日次進行の設計（day単位の逐次実行・save/loadのreplay）と根本的に相容れない
//   ②鉄則「集計値は一切変更しない」に触れる（bStat.wpa等の実集計を書き換えることになる）。
//
//   そこで本モジュールは:
//   - getWpaRefTables(): 実シーズンとは完全に独立の小規模「参照走行」（乱数系統も別根・
//     実ゲームの決定論に一切不干渉）で RE/WE/LI 表を一度だけ導出し league 単位でキャッシュする
//     （§B2 の pass1 と同じ導出ロジックをそのまま再利用＝指標を後付けで作らない・鉄則4）。
//   - computeWpaHighlights(): 自チーム試合の観戦イベント列（simulateGame onEvent・box生成に
//     使うのと同じもの・§17で当該試合限りの一時データ）を再生し、makeAccumulateContext の
//     ΔWPA計算をプレー単位で使い捨てのダミー集計行に流す（実選手の統計行には一切触れない＝
//     「集計値は一切変更しない」を厳守）。試合を通じて自チーム視点のWPAが最大/最小だった
//     プレーを1件ずつ拾い、box.wpaTop/wpaBottom という小さな要約（{pid,inning,half,desc,wpa}）
//     だけを返す。生イベント列自体は保存しない（§17）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { buildSchedule, buildTeamCharts, makeSeasonStats, playScheduledGame } from '../sim/season.mjs';
import { makeDeriveContext, deriveTables, makeAccumulateContext } from '../sim/context.mjs';
import { createUsageState } from '../sim/usage.mjs';
import { NEUTRAL_PARK } from '../model/battedball.mjs';

// league オブジェクト単位でキャッシュ（キャリア中は同一 league を使い回すので実質「1回だけ」）。
const tablesCache = new WeakMap();

/**
 * P2専用の参照文脈表（RE24/WE/LI）を導出する（無ければ作ってキャッシュ）。
 * 実際の試合スケジュール/シードとは完全に別系統（実ゲームの乱数消費・結果に一切影響しない）。
 * 精度よりも応答性を優先し、通常シーズンより小さいリーグ内対戦数で参照走行する
 * （階層平滑化 weSmoothK/weCoarseK/weDiffK が小標本でも破綻しない設計・context.mjs参照）。
 * @param {{teams:Array, players:Array, masterSeed?:number}} league
 * @param {Object} cfg
 * @returns {?Object} deriveTables() の戻り値（{re,we,li,innMax,diffClip,keyN,avgSwing,re0}）
 */
export function getWpaRefTables(league, cfg) {
  const cached = tablesCache.get(league);
  if (cached) return cached;
  if (!league?.teams?.length) return null;
  const refCfg = {
    ...cfg,
    league: { ...cfg.league, inLeagueGamesPerOpp: 4, interLeagueGamesPerOpp: 1 },
  };
  const seed = hashSeed(league.masterSeed ?? 1, 'wpaRefTables');
  const { leagueDh, teamById, chartsByTeam } = buildTeamCharts(league, refCfg);
  const schedule = buildSchedule(league.teams, makeRng(hashSeed(seed, 'schedule')), refCfg);
  if (!schedule.length) return null;
  const stats = makeSeasonStats(0);
  const dgc = makeDeriveContext(refCfg);
  const usageByTeam = new Map(league.teams.map((t) => [t.id, createUsageState(t, chartsByTeam.get(t.id), refCfg)]));
  const parkByTeam = new Map(league.teams.map((t) => [t.id, t.park ?? NEUTRAL_PARK]));
  const ctx = {
    seed,
    park: NEUTRAL_PARK,
    parkByTeam,
    cfg: refCfg,
    leagueDh,
    teamById,
    chartsByTeam,
    usageByTeam,
    pass: { statFor: stats.statFor, getBat: stats.getBat, getPitch: stats.getPitch, gameContext: dgc },
    dayScale: 1,
    season: 0,
  };
  schedule.forEach((g, gi) => playScheduledGame(ctx, g, gi));
  const tables = deriveTables(dgc, refCfg);
  tablesCache.set(league, tables);
  return tables;
}

/** basesPids（[1B,2B,3B]のplayerId配列）→ 塁状態ビット（1=1B,2=2B,4=3B）。game.mjs baseBits と同一規則。 */
function bitsFromPids(pids) {
  if (!pids) return 0;
  return (pids[0] ? 1 : 0) | (pids[1] ? 2 : 0) | (pids[2] ? 4 : 0);
}

/** プレーの日本語1語描写（打者/走者視点）。ourBatting=自チームの得（勝因側の文脈で語るか）。 */
function describePlay(cand, ourBatting) {
  if (cand.kind === 'steal') return cand.result === 'SB' ? '盗塁成功' : '盗塁死';
  if (cand.kind === 'bunt') {
    if (cand.outcome === 'hit') return ourBatting ? '犠打安打' : '犠打安打を許す';
    if (cand.outcome === 'success') return ourBatting ? '犠打成功' : '犠打を許す';
    return ourBatting ? 'バント失敗' : 'バント処理で仕留める';
  }
  const runs = cand.runsOnPlay ?? 0;
  if (cand.outcome === 'BB') return ourBatting ? '四球' : '四球を与える';
  if (cand.outcome === 'HBP') return ourBatting ? '死球' : '死球を与える';
  if (cand.result === 'HR') {
    const hrName = runs >= 4 ? '満塁本塁打' : runs === 3 ? '3ラン本塁打' : runs === 2 ? '2ラン本塁打' : 'ソロ本塁打';
    return ourBatting ? hrName : `${hrName}を被弾`;
  }
  if (cand.result === '1B' || cand.result === '2B' || cand.result === '3B') {
    const baseName = cand.result === '1B' ? '安打' : cand.result === '2B' ? '二塁打' : '三塁打';
    const name = runs > 0 ? (cand.result === '1B' ? '適時打' : `適時${baseName}`) : baseName;
    return ourBatting ? name : `${name}を許す`;
  }
  if (cand.result === 'E') return ourBatting ? '相手失策で出塁' : '失策で出塁を許す';
  if (cand.outcome === 'K') return ourBatting ? '三振' : '三振に仕留める';
  if (cand.result === 'out') {
    const dp = (cand.outsAfter - cand.outsBefore) >= 2;
    if (dp) return ourBatting ? '併殺打' : '併殺打に仕留める';
    if (cand.sacFly) return ourBatting ? '犠飛' : '犠飛に打ち取る';
    const bt = cand.battedType;
    const outName = bt === 'GB' ? 'ゴロアウト' : bt === 'LD' ? 'ライナーアウト' : bt === 'FB' ? 'フライアウト' : bt === 'PU' ? 'ポップアウト' : 'アウト';
    return ourBatting ? outName : `${outName}に打ち取る`;
  }
  return ourBatting ? 'プレー' : '出塁を許す';
}

function summarize(cand, playerTeamId) {
  const ourBatting = cand.batTeam === playerTeamId;
  const pid = cand.kind === 'steal' ? cand.batterId : ourBatting ? cand.batterId : (cand.pitcherId ?? cand.batterId);
  return {
    pid,
    inning: cand.inning,
    half: cand.half, // 'top'|'bottom'（表示側で日本語「表/裏」に変換・schedule.mjs参照）
    desc: describePlay(cand, ourBatting),
    wpa: cand.teamWpa, // 自チーム視点（符号込み）
  };
}

/**
 * 自チーム試合の観戦イベント列（simulateGame onEvent の構造化列。§17: 一時データ）を再生し、
 * 自チーム視点WPAが最大/最小だったプレーを1件ずつ拾う。
 * 実選手の統計行（statFor由来のオブジェクト）には一切触れない＝使い捨てのダミー集計行で
 * ΔWPAだけを読み出す（鉄則「集計値は一切変更しない」を厳守）。
 * @param {Array} events buildBoxScore と同じ入力（1試合ぶんの onEvent 構造化イベント列）
 * @param {?Object} tables getWpaRefTables() の戻り値
 * @param {Object} cfg
 * @param {string} playerTeamId 自チームID
 * @returns {?{top:Object, bottom:Object}} 旧セーブ/表が無ければ null（呼び出し側は additive に無視）
 */
export function computeWpaHighlights(events, tables, cfg, playerTeamId) {
  if (!tables || !events || !events.length) return null;
  const gc = makeAccumulateContext(tables, cfg);
  gc.startGame();
  let home = null;
  let away = null;
  const scores = { home: 0, away: 0 };
  let pending = null; // 直前の 'atbat' が示す「この打席の状態前」
  let curBases = [null, null, null];
  let curOuts = 0;
  let best = null; // 自チーム視点WPA最大
  let worst = null; // 自チーム視点WPA最小

  const sideOf = (teamId) => (teamId === home ? 'home' : 'away');

  const evaluate = (info) => {
    const dummyBat = { wpa: 0 };
    const dummyPit = { wpa: 0 };
    gc.onPlay({
      kind: 'pa',
      battingIsHome: info.battingIsHome,
      inning: info.inning,
      batSideStat: dummyBat,
      pitStat: dummyPit,
      pitcherCur: null,
      firstBatterOfApp: false,
      baseBefore: info.baseBefore,
      outsBefore: info.outsBefore,
      baseAfter: info.baseAfter,
      outsAfter: info.outsAfter,
      runsOnPlay: info.runsOnPlay,
      batScoreBefore: info.batScoreBefore,
      fldScore: info.fldScore,
    });
    const teamWpa = info.batTeam === playerTeamId ? dummyBat.wpa : -dummyBat.wpa;
    const cand = { ...info, teamWpa };
    if (!best || teamWpa > best.teamWpa) best = cand;
    if (!worst || teamWpa < worst.teamWpa) worst = cand;
  };

  for (const e of events) {
    if (e.type === 'start') {
      home = e.home;
      away = e.away;
    } else if (e.type === 'atbat') {
      curBases = e.basesPids ? e.basesPids.slice() : curBases;
      curOuts = e.outs;
      pending = {
        inning: e.inning,
        half: e.half,
        battingIsHome: e.half === 'bottom',
        batTeam: e.batTeam,
        pitTeam: e.pitTeam,
        batterId: e.batterId,
        pitcherId: e.pitcherId,
        baseBefore: bitsFromPids(curBases),
        outsBefore: curOuts,
      };
    } else if (e.type === 'steal') {
      const batSide = sideOf(e.batTeam);
      const fldSide = batSide === 'home' ? 'away' : 'home';
      evaluate({
        kind: 'steal',
        inning: e.inning,
        half: e.half,
        battingIsHome: e.half === 'bottom',
        batTeam: e.batTeam,
        pitTeam: fldSide === 'home' ? home : away,
        baseBefore: bitsFromPids(curBases),
        outsBefore: curOuts,
        baseAfter: bitsFromPids(e.basesPids),
        outsAfter: e.outsAfter,
        runsOnPlay: 0,
        batScoreBefore: scores[batSide],
        fldScore: scores[fldSide],
        result: e.success ? 'SB' : 'CS',
        outcome: 'steal',
        batterId: e.runnerId,
        pitcherId: null,
      });
      curBases = e.basesPids ? e.basesPids.slice() : curBases;
      curOuts = e.outsAfter;
    } else if (e.type === 'pa' || e.type === 'bunt') {
      if (!pending) continue; // 構造上必ず atbat が先行するが、安全弁として無視
      const batSide = sideOf(pending.batTeam);
      const fldSide = batSide === 'home' ? 'away' : 'home';
      const batScoreAfter = e.batScore;
      const runsOnPlay = e.type === 'pa' ? (e.runsOnPlay ?? 0) : batScoreAfter - scores[batSide];
      evaluate({
        kind: e.type,
        inning: pending.inning,
        half: pending.half,
        battingIsHome: pending.battingIsHome,
        batTeam: pending.batTeam,
        pitTeam: pending.pitTeam,
        baseBefore: pending.baseBefore,
        outsBefore: pending.outsBefore,
        baseAfter: bitsFromPids(e.basesPids),
        outsAfter: e.outsAfter,
        runsOnPlay,
        batScoreBefore: scores[batSide],
        fldScore: e.fldScore,
        result: e.result ?? null,
        outcome: e.outcome ?? null,
        sacFly: e.sacFly === true,
        battedType: e.battedType ?? null,
        batterId: pending.batterId,
        pitcherId: pending.pitcherId,
      });
      scores[batSide] = batScoreAfter;
      curBases = e.basesPids ? e.basesPids.slice() : curBases;
      curOuts = e.outsAfter;
      pending = null;
    }
  }

  if (!best || !worst) return null;
  return { top: summarize(best, playerTeamId), bottom: summarize(worst, playerTeamId) };
}

// ============================================================================
// P1-5（thyroxin/reviews/game_review_20260724.md 観点6/8）: WPA勝因/敗因プレー×介入ログの接続。
//
//   wpaIsAfterIntervention(highlight, gameInterventions, box) … computeWpaHighlights の
//     top/bottom 1件が、自分の采配指示（gameInterventions・P1）の直後の結果かどうかを判定する
//     純関数。判定材料はすべて既に永続化済みのデータのみ（新規の保存フィールドは追加しない・
//     §17生イベント非永続の原則を維持）:
//       - highlight.pid が、その試合の gameInterventions（kind='ph'|'relief'）の choice.pick と
//         一致する（＝そのプレーの選手は自分が明示的に指示して起用した選手そのもの。
//         「おまかせ」はログに積まれないため＝P1データモデル§1、AIが自律判断した交代は
//         この一致条件を満たさない）。
//       - box（rec.box・buildBoxScore の出力）で、その選手が実際にその起用経路で入った痕跡を
//         裏取りする（ph=打者行のpos==='打'＝代打で入った証跡／relief=試合の先発投手ではない
//         ＝救援で入った証跡）。
//     box には交代のイニングまでは残らない（§17）ため、判定の粒度は「その起用で入った選手自身の
//     プレーか」までであり、厳密な「同一イニング」までは見ない（継投で入った投手がその後何回か
//     投げ続けた末のプレーも対象に含みうる＝その継投判断が生んだ投手のプレーという帰属としては
//     成立するため誤りではない）。対応する介入ログが無い/box裏取りに失敗した場合は必ず false
//     （曖昧なら付けない・レビュー「誤タグは信頼を壊す」への配慮）。
// ============================================================================

/**
 * WPA勝因/敗因プレー（wpaTop/wpaBottomの1件）が、自分の采配指示の直後の結果かを判定する。
 * @param {?{pid:string,inning:number,half:string,desc:string,wpa:number}} highlight box.wpaTop/wpaBottomの1件
 * @param {Array} gameInterventions 当該試合ぶんに絞り込んだ介入ログ（呼び出し側で year/day一致フィルタ済みのもの）
 * @param {?Object} box rec.box（buildBoxScore の出力・starters/batters を使う）
 * @returns {boolean} true=⚡采配直後タグを付けてよい
 */
export function wpaIsAfterIntervention(highlight, gameInterventions, box) {
  if (!highlight || !box || !gameInterventions || !gameInterventions.length) return false;
  const hit = gameInterventions.find((iv) =>
    iv && iv.choice && iv.choice.pick === highlight.pid && (iv.kind === 'ph' || iv.kind === 'relief'));
  if (!hit) return false;
  if (hit.kind === 'ph') {
    const row = (box.batters?.home ?? []).find((b) => b.pid === highlight.pid)
      ?? (box.batters?.away ?? []).find((b) => b.pid === highlight.pid);
    return !!row && row.pos === '打'; // 代打で入った打者にのみ付く打順スロット表記（boxscore.mjs sub処理）
  }
  // kind==='relief': 先発投手（そのイニングの登板開始ではなく試合の先発）でなければ救援で入った証跡とみなす。
  return highlight.pid !== box.starters?.home && highlight.pid !== box.starters?.away;
}

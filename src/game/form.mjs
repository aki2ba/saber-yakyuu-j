// ============================================================================
// Wave B（thyroxin/specs/gm_analytics_spec.md「GM分析仕様」§Wave B）: フォーム判定（好調▲/不調▼）
//
//   playerFormOf(state, playerId) … 自チーム選手のみ、直近窓（rt.playerGameLog の box集計）と
//     シーズン累計の観測成績（rt.stats）を比較し、好調/不調の兆候を判定する純関数。
//   teamFormMap(state)            … 自チーム選手ぶんの tier だけを軽量に返すバルクAPI
//     （チーム一覧のバッジ表示用・playerFormOf を全選手に回すより lc/statsById を使い回して軽い）。
//
// 設計原則（CLAUDE.md鉄則・gm_analytics_spec.md §0・タスク仕様の厳守事項）:
//   - 観測のみ: rt.stats（シーズン累計・正確値）と rt.playerGameLog の box（直近窓・集計値のみ）
//     だけを使う。真値(trueAbility)・能力値レーティングは一切参照しない（三層構造・観測成績のみ）。
//   - 他球団は tier=null: playerGameLog は自チーム試合のみが残る（§17・game/boxscore.mjsコメント
//     参照）ため、他球団選手には直近窓のデータが存在しない。窓データの無いものは語らない。
//   - 窓の近似について: box の打者行（game/boxscore.mjs batterOf）は ab/h/hr/bb/k のみを持ち、
//     二塁打/三塁打/敬遠/犠飛の内訳が無い（§17: 生イベントはその場で捨てて集計行だけ残す設計）。
//     このため窓wOBAは「本塁打以外の安打はすべて単打として扱う」近似で計算する（本塁打以外の
//     安打は伸びるほど過小評価される片側バイアスだが、標準的な長短打配分ではその過小分は
//     wOBAスケールで高々0.01〜0.02程度に収まる。wobaGapHot/Cold=0.040 はこの誤差を吸収できる
//     余裕を持たせた値＝閾値選定の根拠）。同様に bb フィールドは死球を含む（boxscore.mjs
//     の仕様どおり）ため、四球単独の重みで代用する。
//   - セイバー定説準拠（各判定コメントに根拠定説を明記）:
//       打者: BABIP極端値は平均回帰する（定説）——窓BABIPが著しく高い/低いときは見かけの
//             好調/不調に注意を促す reason を追加する（analystColumn.mjs のxwOBA-wOBA乖離型と
//             同じ発想の応用）。
//       投手: K-BB%はDIPS理論（投手が自らコントロールできるのは主に奪三振/与四球/被本塁打の
//             比率）に基づき、防御率より投手の実力・将来のERAを予測しやすい先行指標とされる
//             （analystColumn.mjs のERA-SIERA乖離型と同じ定説）。
//   - 目安防御率: season側・window側とも「自責点」ではなく box の r（総失点・在板中の失点）を
//     ベースに揃える（box は自責/失策絡みの内訳を持たないため。coachReports.mjs の
//     pitchingTrend/pitchingDescr と同じ「目安防御率」ラベル・同じ近似方針を踏襲）。
//   - 決定論: 判定式そのものは乱数非使用（観測集計の比較のみ・hashSeedを消費しない）。
//   - 表示層のみ・純関数・保存フィールド追加なし・usage AI（起用判断）には一切触れない。
//   - 最低サンプルゲート: 窓20打席未満／窓6イニング(18アウト)未満は tier=null（憶測を書かない）。
// ============================================================================
import { deriveLeagueConstants } from '../sim/leagueConstants.mjs';
import { playerBatting } from '../sim/metrics.mjs';

// バンドルは全モジュールを同一スコープへconcatする（tools/build.mjs）ため、トップレベル名は
// 全モジュールで一意にする（analystColumn.mjs の ac 接頭辞と同じ流儀で fm 接頭辞に統一）。
const fmAvg3 = (v) => v.toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.');
const fmPct = (v) => `${(v * 100).toFixed(1)}%`;
const FM_NULL = { tier: null, reasons: [] };

/** playerGameLog の1試合分から、指定playerIdの打者/投手ボックス行を探す（無ければnull）。
 *  coachReports.mjs の findBatterLine/findPitcherLine と同型（同一バンドルスコープにつき別名）。 */
function fmFindBatterLine(rec, playerId) {
  const box = rec.box;
  if (!box) return null;
  return (box.batters?.home ?? []).find((b) => b.pid === playerId)
    ?? (box.batters?.away ?? []).find((b) => b.pid === playerId)
    ?? null;
}
function fmFindPitcherLine(rec, playerId) {
  const box = rec.box;
  if (!box) return null;
  return (box.pitchers?.home ?? []).find((p) => p.pid === playerId)
    ?? (box.pitchers?.away ?? []).find((p) => p.pid === playerId)
    ?? null;
}

/** 野手の窓集計（自チーム直近N試合・出場が無い試合は0のまま加算されない）。 */
function fmBatWindow(rt, playerId, nGames) {
  const recent = rt.playerGameLog.slice(-nGames);
  const w = { ab: 0, h: 0, hr: 0, bb: 0, k: 0, games: 0 };
  for (const rec of recent) {
    const line = fmFindBatterLine(rec, playerId);
    if (!line) continue;
    w.ab += line.ab || 0;
    w.h += line.h || 0;
    w.hr += line.hr || 0;
    w.bb += line.bb || 0;
    w.k += line.k || 0;
    w.games += 1;
  }
  return w;
}

/** 投手の窓集計（自チームのplayerGameLogを遡り、実際に登板した直近N登板を拾う）。 */
function fmPitWindow(rt, playerId, nApps, maxGamesBack) {
  const log = rt.playerGameLog;
  const w = { outs: 0, r: 0, bb: 0, k: 0, h: 0, hr: 0, apps: 0 };
  const start = Math.max(0, log.length - maxGamesBack);
  for (let i = log.length - 1; i >= start && w.apps < nApps; i--) {
    const line = fmFindPitcherLine(log[i], playerId);
    if (!line || !(line.outs > 0)) continue;
    w.outs += line.outs || 0;
    w.r += line.r || 0;
    w.bb += line.bb || 0;
    w.k += line.k || 0;
    w.h += line.h || 0;
    w.hr += line.hr || 0;
    w.apps += 1;
  }
  return w;
}

/** シーズン観測（rt.stats/rt.standings）からリーグ定数と playerId→PlayerSeason を作る（1回だけ）。 */
function fmBuildCtx(state) {
  const rt = state.rt;
  if (!rt || !rt.stats || !rt.playerGameLog || !rt.standings) return null;
  const seasons = [...rt.stats.stats.values()];
  const standRows = [...rt.standings.values()];
  if (!seasons.length || !standRows.length) return null;
  const lc = deriveLeagueConstants({ playerSeasons: seasons, standings: standRows });
  const statsById = new Map(seasons.map((s) => [s.playerId, s]));
  return { lc, statsById };
}

/**
 * 野手のフォーム判定。
 * 根拠(BABIP平均回帰): インプレー打球の結果はリーグ平均へ回帰する傾向がある、という定説に基づき、
 * 窓BABIPが極端（出来すぎ/出来なさすぎ）なときは見かけの好調/不調として reasons に注記する。
 */
function fmEvalBatter(state, ctx, playerId) {
  const s = ctx.statsById.get(playerId);
  if (!s || !s.batting || !(s.batting.pa > 0)) return FM_NULL;
  const cfgF = state.cfg.tuning.storylines.form;
  const w = fmBatWindow(state.rt, playerId, cfgF.batWindowGames);
  const pa = w.ab + w.bb; // 窓PA近似（box にHBP/SF内訳が無いため ab+bb=PA近似）
  if (pa < cfgF.batMinWindowPA) return FM_NULL;

  const seasonWoba = playerBatting(s, ctx.lc).woba;
  const W = ctx.lc.linearWeights;
  const rawWindow = (W.bb * w.bb + W.b1 * (w.h - w.hr) + W.hr * w.hr) / pa; // 非本塁打安打=単打近似
  const wobaWindow = ctx.lc.wobaScale ? ctx.lc.wobaScale * rawWindow : 0;
  const diff = wobaWindow - seasonWoba;
  const avgWindow = w.ab ? w.h / w.ab : 0;
  const bip = w.ab - w.k - w.hr; // インプレー打球近似（sf無視）
  const babipWindow = bip > 0 ? (w.h - w.hr) / bip : null;

  let tier = 'normal';
  if (diff >= cfgF.wobaGapHot) tier = 'hot';
  else if (diff <= -cfgF.wobaGapCold) tier = 'cold';

  const reasons = [];
  if (tier === 'hot') {
    reasons.push({
      text: `直近${cfgF.batWindowGames}試合は打率${fmAvg3(avgWindow)}・窓wOBA近似${fmAvg3(wobaWindow)}——シーズンwOBA${fmAvg3(seasonWoba)}を${fmAvg3(diff)}上回る当たり方`,
      kind: 'wobaGap',
    });
    if (babipWindow != null && bip >= cfgF.babipMinBip && babipWindow > cfgF.babipHotGuard) {
      reasons.push({
        text: `ただし窓BABIP${fmAvg3(babipWindow)}は出来すぎ水準——BABIPは平均回帰するという定説どおりなら、見かけの好調に注意`,
        kind: 'babipGuard',
      });
    }
  } else if (tier === 'cold') {
    reasons.push({
      text: `直近${cfgF.batWindowGames}試合は打率${fmAvg3(avgWindow)}・窓wOBA近似${fmAvg3(wobaWindow)}——シーズンwOBA${fmAvg3(seasonWoba)}を${fmAvg3(-diff)}下回る不振`,
      kind: 'wobaGap',
    });
    if (babipWindow != null && bip >= cfgF.babipMinBip && babipWindow < cfgF.babipColdGuard) {
      reasons.push({
        text: `窓BABIP${fmAvg3(babipWindow)}は低すぎる水準——BABIPは平均回帰するという定説どおりなら、この先は運も戻ってくる公算`,
        kind: 'babipGuard',
      });
    }
  }
  return { tier, reasons };
}

/**
 * 投手のフォーム判定。
 * 根拠(DIPS理論): K-BB%は防御率より投手の実力・将来の防御率を予測しやすい先行指標とされる定説。
 * K-BB%と目安防御率の2シグナルが逆方向を指すときは判定を割らず 'normal'（憶測を書かない）。
 */
function fmEvalPitcher(state, ctx, playerId) {
  const s = ctx.statsById.get(playerId);
  if (!s || !s.pitching || !(s.pitching.outs > 0)) return FM_NULL;
  const cfgF = state.cfg.tuning.storylines.form;
  const w = fmPitWindow(state.rt, playerId, cfgF.pitLookbackApps, cfgF.pitLookbackMaxGames);
  if (w.outs < cfgF.pitMinWindowOuts) return FM_NULL;

  const seasonIp = s.pitching.outs / 3;
  const seasonBf = s.pitching.bf;
  const seasonKbb = seasonBf ? (s.pitching.so - s.pitching.bb) / seasonBf : 0;
  const seasonEra = seasonIp ? (s.pitching.r * 9) / seasonIp : 0; // 「目安防御率」＝rベース（coachReports.mjsと同基準）

  const bfWindow = w.outs + w.h + w.bb; // 対戦打者の近似（analystColumn.mjs acGameHighlightCandidatesと同じ近似式）
  const kbbWindow = bfWindow ? (w.k - w.bb) / bfWindow : 0;
  const ipWindow = w.outs / 3;
  const eraWindow = ipWindow ? (w.r * 9) / ipWindow : 0;
  const kbbDiff = kbbWindow - seasonKbb;
  const eraDiff = eraWindow - seasonEra; // 負=改善（失点が少ないほど良い）

  const kbbHot = kbbDiff >= cfgF.kbbGapHot;
  const kbbCold = kbbDiff <= -cfgF.kbbGapCold;
  const eraHot = eraDiff <= -cfgF.eraGapHot;
  const eraCold = eraDiff >= cfgF.eraGapCold;

  let tier = 'normal';
  if ((kbbHot || eraHot) && !kbbCold && !eraCold) tier = 'hot';
  else if ((kbbCold || eraCold) && !kbbHot && !eraHot) tier = 'cold';

  const reasons = [];
  if (tier === 'hot') {
    if (kbbHot) reasons.push({
      text: `直近${w.apps}登板のK-BB%は${fmPct(kbbWindow)}——シーズンK-BB%${fmPct(seasonKbb)}を上回る。DIPS理論で防御率より先行するとされる指標が上向いている`,
      kind: 'kbbGap',
    });
    if (eraHot) reasons.push({
      text: `直近${w.apps}登板の目安防御率は${eraWindow.toFixed(2)}——シーズン目安防御率${seasonEra.toFixed(2)}より失点が少ない`,
      kind: 'runsGap',
    });
  } else if (tier === 'cold') {
    if (kbbCold) reasons.push({
      text: `直近${w.apps}登板のK-BB%は${fmPct(kbbWindow)}——シーズンK-BB%${fmPct(seasonKbb)}を下回る。DIPS理論で防御率より先行するとされる指標が下向いている`,
      kind: 'kbbGap',
    });
    if (eraCold) reasons.push({
      text: `直近${w.apps}登板の目安防御率は${eraWindow.toFixed(2)}——シーズン目安防御率${seasonEra.toFixed(2)}より失点が多い`,
      kind: 'runsGap',
    });
  }
  return { tier, reasons };
}

/**
 * フォーム判定（好調▲/不調▼）。自チーム選手のみ窓判定が可能（playerGameLog は自チーム試合のみ・
 * §17）。他球団選手・データ不足（最低サンプルゲート未達）は tier=null＝語らない。
 * @param {Object} state GameState（rt/cfg/playerTeamId/league.players が必要）
 * @param {string} playerId
 * @returns {{tier: 'hot'|'normal'|'cold'|null, reasons: Array<{text:string, kind:string}>}}
 */
export function playerFormOf(state, playerId) {
  if (!state.rt || !state.playerTeamId) return FM_NULL;
  const p = (state.league?.players ?? []).find((x) => x.id === playerId);
  if (!p || p.teamId !== state.playerTeamId) return FM_NULL; // 他球団=窓データ無し（語らない）
  const ctx = fmBuildCtx(state);
  if (!ctx) return FM_NULL;
  return p.role === 'pitcher' ? fmEvalPitcher(state, ctx, playerId) : fmEvalBatter(state, ctx, playerId);
}

/**
 * チーム一覧バッジ用の軽量バルクAPI。自チーム選手ぶんの tier だけを返す（lc/statsById を
 * 全選手で使い回すため playerFormOf を人数分呼ぶより軽い）。
 * @param {Object} state GameState
 * @returns {Map<string, 'hot'|'normal'|'cold'|null>} playerId → tier
 */
export function teamFormMap(state) {
  const out = new Map();
  if (!state.rt || !state.playerTeamId) return out;
  const ctx = fmBuildCtx(state);
  if (!ctx) return out;
  const myPlayers = (state.league?.players ?? []).filter((p) => p.teamId === state.playerTeamId);
  for (const p of myPlayers) {
    const { tier } = p.role === 'pitcher' ? fmEvalPitcher(state, ctx, p.id) : fmEvalBatter(state, ctx, p.id);
    out.set(p.id, tier);
  }
  return out;
}

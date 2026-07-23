// ============================================================================
// R1+R7+R8:「アナリストコラム」（thyroxin/research/data_storytelling_research_20260723.md）。
//   ニュースタブの新設節「🔬 アナリストの目」の素材を作る純関数モジュール。
//
//   analystColumnOf(state, names) … 現在の観測シーズン成績(rt.stats)から「語れるネタ」を検出し、
//     週替わりで最大 tuning.storylines.analyst.maxItems 本の一言コラムを返す。中身は5種類の候補を
//     1つのプールにまとめ、優先度順＋hashSeed決定論の抽選で選ぶ（同週同一選手の重複は排除）。
//       - 極端値型(R1-1)  : 規定到達者のBarrel%/O-Swing%/Z-Contact%/CSW%/K-BB%/SwStr%のリーグ
//                           1位・最下位（打率/HR等の表層スタッツ以外＝セイバー系の型）。
//       - 意外性型(R1-2)  : 表層(打率/防御率)と先行指標(xwOBA/SIERA)の乖離（不運/出来すぎ警報）。
//       - 比較型(R1-3)    : 若手（プロ3年目まで）の本塁打/勝利ペースが殿堂入り選手の同年目実績と
//                           同水準（gallery.mjs hallOfFamers参照）。
//       - 試合ハイライト(R7): 直近の自チーム試合（playerGameLog の box）から好投登板/複数本塁打。
//       - 隠れWPAリーダー(R8): 月境界の週にだけ、打撃成績が地味なのにWPAが高い選手を1名検出。
//
// 設計原則（CLAUDE.md鉄則・タスク仕様の厳守事項）:
//   - 表示層のみ・純関数・保存フィールド追加なし: rt.stats/rt.standings/rt.playerGameLog/
//     careerStats/retiredPlayers など既存の観測集計だけから毎回その場で導出する（§17準拠）。
//   - 能力値・真値(trueAbility)・スカウト内部値は一切参照しない（三層構造・観測成績のみ）。
//   - 決定論: 乱数は hashSeed(masterSeed,'analyst',...) の独立座標のみ（既存の生成/進行ストリーム
//     と非干渉）。候補の抽選もテンプレ選択も同じ作法（coachReports.mjs/storylines.mjsの前例）。
//   - サンプルが薄い（規定未到達・シーズン消化が浅い）うちは検出そのものを行わない（憶測を書かない）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { qualifiedPA, qualifiedIP } from '../config.mjs';
import { deriveLeagueConstants } from '../sim/leagueConstants.mjs';
import { playerBatting, playerPitching } from '../sim/metrics.mjs';
import { hallOfFamers } from './gallery.mjs';
import { pendingDay } from './season_runtime.mjs';

// バンドルは全モジュールを同一スコープへconcatする（tools/build.mjs）ため、トップレベル名は
// 全モジュールで一意にする（storylines.mjs の idAsc 等と衝突しないよう ac 接頭辞で統一）。
const idAscA = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const acDiv = (a, b) => (b ? a / b : 0);
const acPct = (v) => `${(v * 100).toFixed(1)}%`;
const acAvg3 = (v) => v.toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.');

// ============================================================================
// 週/月境界（coachReports.mjs/goals.mjs と同じ pendingDay + daysPerWeek/daysPerMonth の作法）。
// ============================================================================

/** 現在の週index（0始まり）。rt未生成なら null。 */
function acWeekOf(state) {
  const rt = state.rt;
  if (!rt || rt.finalDay == null) return null;
  return Math.floor(pendingDay(rt) / state.cfg.game.daysPerWeek);
}

/** この週の終わりが月境界に到達/交差するか（R8「月境界の週」判定）。 */
function acIsMonthBoundaryWeek(state, week) {
  const cfg = state.cfg;
  const span = cfg.game.daysPerWeek;
  const start = week * span;
  const end = start + span;
  const monthSpan = cfg.game.daysPerMonth;
  const monthEnd = (Math.floor(start / monthSpan) + 1) * monthSpan;
  return end >= monthEnd;
}

// ============================================================================
// 共通データ整形（rt.standings/rt.stats から league別母集団・計算済み指標キャッシュを作る）。
// ============================================================================

function acTeamLeagueMap(standRows) {
  return new Map(standRows.map((r) => [r.teamId, r.league]));
}

/** リーグ別の平均消化試合数（規定打席/規定投球回の換算に使う・titleRaces と同型）。 */
function acGamesPlayedByLeague(standRows) {
  const teamLg = acTeamLeagueMap(standRows);
  const leagueIds = [...new Set(standRows.map((r) => r.league))].sort();
  const gp = new Map();
  for (const lid of leagueIds) {
    const rows = standRows.filter((r) => r.league === lid);
    gp.set(lid, rows.length ? rows.reduce((a, r) => a + (r.g || 0), 0) / rows.length : 0);
  }
  return { teamLg, leagueIds, gp };
}

/** playerId → {battingM, pitchingM, teamId} の計算済み指標キャッシュ（1回だけ計算し使い回す）。 */
function acBuildMetricsCache(seasons, lc, cfg) {
  const byId = new Map();
  for (const s of seasons) {
    const battingM = s.batting && s.batting.pa > 0 ? playerBatting(s, lc) : null;
    const pitchingM = s.pitching && s.pitching.outs > 0 ? playerPitching(s, lc, cfg) : null;
    byId.set(s.playerId, { battingM, pitchingM, teamId: s.teamId });
  }
  return byId;
}

// --- 一球データ由来の率（statlineの生カウントから直接算出・§B1-2）。playerBatting/playerPitching
//     にはまだ無いため、ここで raw な batting/pitching ライン(ps.batting/ps.pitching)から導出する。
function acPitchesSeen(line) {
  return (line.pitches || 0) - (line.lumpedPitches || 0);
}
/** O-Swing%（打者=誘い球を振った率が低いほど良い。投手視点なら「誘い球を振らせた率」）。 */
function acOSwingPct(line) {
  return line.oZonePitches ? line.oSwings / line.oZonePitches : null;
}
/** Z-Contact%（ゾーン内スイングでバットに当てた率）。 */
function acZContactPct(line) {
  return line.zSwings ? (line.zSwings - line.zWhiffs) / line.zSwings : null;
}
/** SwStr%（見た球数に対する空振り率）。 */
function acSwStrPct(line) {
  const p = acPitchesSeen(line);
  return p ? line.whiffs / p : null;
}
/** CSW%（見逃し+空振りストライク率）。 */
function acCswPct(line) {
  const p = acPitchesSeen(line);
  return p ? (line.calledStrikes + line.whiffs) / p : null;
}

// ============================================================================
// R1-1: 極端値型（規定到達者のリーグ1位/最下位・打率/HR等の表層スタッツ以外）。
//
// 各テンプレの主張の根拠（セイバーメトリクスの定説。事実として確立した性質のみを断言する）:
//   - Barrel%: EV×LAが長打になりやすい帯に入った打球の割合（Statcast定義）。運の要素が薄い
//     「打球の質」そのものの指標で、シーズン内でも安定し長打力の再現性を反映する（定説）。
//   - O-Swing%（ボール球スイング率）: 選球眼系の指標は数ある打撃指標の中でも最も早く安定する
//     （Russell A. Carleton "The Stabilization of Statistics" 等の再現性研究で確立）。
//     少ないサンプルでも打率より「その選手の実力」を語りやすい（定説）。
//   - Z-Contact%（ゾーン内コンタクト率）: コンタクト系指標も打率より早期に安定する（同上研究）。
//     バットに当てる技術そのものを表す、結果（安打になったか）に依存しない指標（定説）。
//   - CSW%（見逃し+空振りストライク率）: 被打率や失点より変動が小さく、奪三振・制球・球威を
//     まとめて表す「投球内容」の指標として投手評価で広く使われる（定説）。
//   - K-BB%（奪三振率−与四球率）: DIPS理論（投手がコントロールできるのは奪三振/与四球/被本塁打の
//     比率が主で、インプレー打球の結果には守備・運の影響が大きい）に基づき、ERAより投手の実力・
//     将来のERAを予測する指標として確立している（定説）。
//   - SwStr%（見た球に対する空振り率）: K%と強い相関を持つ「球の質」の指標で、奪三振能力の
//     裏付けとして安定的に使われる（定説）。
// ============================================================================

const AC_EXTREME_TPL_LEADER = {
  barrelPct: [
    (n, v) => `${n}のBarrel%は規定到達者でリーグ1位（${v}）。強い打球を再現性高く生む`,
    (n, v) => `強い打球の代名詞——${n}のBarrel%は規定到達者中リーグトップ（${v}）`,
  ],
  oSwingPct: [
    (n, v) => `${n}のO-Swing%はリーグ最少（${v}）。ボール球を振らない選球眼は早期に安定する指標——打率より裏切らない`,
    (n, v) => `誘い球に手を出さない——${n}のO-Swing%は規定到達者で最少（${v}）`,
  ],
  zContactPct: [
    (n, v) => `${n}のZ-Contact%はリーグ1位（${v}）。ゾーン内スイングの高いコンタクト率——結果に左右されにくい技術指標で最上位`,
    (n, v) => `${n}はゾーン勝負に滅法強い。Z-Contact%は規定到達者でリーグトップ（${v}）`,
  ],
  cswPct: [
    (n, v) => `${n}のCSW%はリーグ1位（${v}）。奪三振・制球・球威をまとめて映す投球内容の指標で好投手陣随一`,
    (n, v) => `${n}、見逃し+空振りの合計CSW%は規定投球回到達者でリーグトップ（${v}）`,
  ],
  kbbPct: [
    (n, v) => `${n}のK-BB%はリーグ1位（${v}）。ERAより投手の実力を映すとされる指標で頭一つ抜けている`,
    (n, v) => `奪って歩かせない——${n}のK-BB%は規定投球回到達者で最高（${v}）`,
  ],
  swStrPct: [
    (n, v) => `${n}の空振り率(SwStr%)はリーグ1位（${v}）。バットに当てさせない球の質そのもの`,
    (n, v) => `${n}、見た球のうち空振りを奪う割合(SwStr%)が規定投球回到達者で最高（${v}）`,
  ],
};
const AC_EXTREME_TPL_TRAILER = {
  barrelPct: [(n, v) => `${n}のBarrel%は規定到達者でリーグ最下位（${v}）。パワーより巧さで勝負`],
  oSwingPct: [(n, v) => `${n}のO-Swing%はリーグワースト（${v}）。早打ちの誘惑と戦う一年`],
  zContactPct: [(n, v) => `${n}のZ-Contact%はリーグ最下位（${v}）。ゾーン勝負にまだ課題を残す`],
  cswPct: [(n, v) => `${n}のCSW%はリーグ最下位（${v}）。ここからの立て直しに注目`],
  kbbPct: [(n, v) => `${n}のK-BB%はリーグ最下位（${v}）。制球と奪三振の両面に課題`],
  swStrPct: [(n, v) => `${n}の空振り率(SwStr%)はリーグ最下位（${v}）。バットに当てられやすい一面`],
};

/** 極端値の対象指標（低いほど良いのは oSwingPct のみ・打者=fielder/投手=pitcher）。 */
const AC_EXTREME_METRICS = [
  { key: 'barrelPct', role: 'fielder', low: false, get: (m) => m.barrelPct },
  { key: 'oSwingPct', role: 'fielder', low: true, raw: true, get: (b) => acOSwingPct(b) },
  { key: 'zContactPct', role: 'fielder', low: false, raw: true, get: (b) => acZContactPct(b) },
  { key: 'cswPct', role: 'pitcher', low: false, raw: true, get: (p) => acCswPct(p) },
  { key: 'kbbPct', role: 'pitcher', low: false, get: (m) => m.kbbPct },
  { key: 'swStrPct', role: 'pitcher', low: false, raw: true, get: (p) => acSwStrPct(p) },
];

function acExtremeCandidates(state, seasons, standRows, metricsById, ac) {
  const { teamLg, leagueIds, gp } = acGamesPlayedByLeague(standRows);
  const out = [];
  for (const lid of leagueIds) {
    const qPA = qualifiedPA(gp.get(lid));
    const qIP = qualifiedIP(gp.get(lid));
    for (const metric of AC_EXTREME_METRICS) {
      const pool = [];
      for (const s of seasons) {
        if (teamLg.get(s.teamId) !== lid) continue;
        if (metric.role === 'fielder') {
          if (!s.batting || s.batting.pa < qPA) continue;
          const v = metric.raw ? metric.get(s.batting) : metric.get(metricsById.get(s.playerId).battingM);
          if (v == null || !Number.isFinite(v)) continue;
          pool.push({ playerId: s.playerId, value: v });
        } else {
          if (!s.pitching || s.pitching.outs / 3 < qIP) continue;
          const v = metric.raw ? metric.get(s.pitching) : metric.get(metricsById.get(s.playerId).pitchingM);
          if (v == null || !Number.isFinite(v)) continue;
          pool.push({ playerId: s.playerId, value: v });
        }
      }
      if (pool.length < ac.extremeMinPool) continue;
      pool.sort((a, b) => (metric.low ? a.value - b.value : b.value - a.value) || idAscA(a.playerId, b.playerId));
      const leader = pool[0];
      const trailer = pool[pool.length - 1];
      out.push({ type: 'extremeLeader', metricKey: metric.key, leagueId: lid, playerId: leader.playerId, value: leader.value, priority: 50 });
      if (trailer.playerId !== leader.playerId) {
        out.push({ type: 'extremeTrailer', metricKey: metric.key, leagueId: lid, playerId: trailer.playerId, value: trailer.value, priority: 40 });
      }
    }
  }
  return out;
}

function acRenderExtreme(state, c, names) {
  const { pnameOf = (id) => id } = names;
  const tplMap = c.type === 'extremeLeader' ? AC_EXTREME_TPL_LEADER : AC_EXTREME_TPL_TRAILER;
  const list = tplMap[c.metricKey];
  const r = makeRng(hashSeed(state.masterSeed, 'analyst', 'tpl', c.type, c.metricKey, c.playerId));
  const tpl = list[r.int(list.length)];
  return { ...c, text: tpl(pnameOf(c.playerId), acPct(c.value)), cls: c.type === 'extremeLeader' ? 'good' : 'info', kind: c.type };
}

// ============================================================================
// R1-2: 意外性型（表層(打率/防御率)と先行指標(xwOBA/SIERA)の乖離）。
//
// 根拠となる定説（平均回帰・DIPS理論）:
//   - xwOBA−wOBA: xwOBAは打球のEV/LAから期待される結果だけで作るため、守備・運の影響を除いた
//     「打球の質」を表す。実際のwOBAとの乖離が大きい選手は今後その差が縮む方向＝平均回帰する
//     傾向がある、というのがStatcast系分析で広く共有された定説（xwOBAが正なら今後の上振れが、
//     wOBAが正なら反動の下振れが見込まれる）。本文言は「回帰しやすい」という傾向の指摘に留め、
//     「必ず起こる」という断定はしない。
//   - ERA−SIERA: DIPS理論（投手が自らコントロールできるのは主に奪三振/与四球/被本塁打の比率で、
//     インプレー打球の結果は守備・運に大きく左右される）に基づき、SIERA（K/BB/GB等の構成要素の
//     みで作るERA推定式）は素のERAより投手の実力・将来のERAを予測しやすいとされる（定説）。
//     ERAがSIERAより大きく悪い投手は「内容の割に結果が悪い」、逆は「出来すぎ」の解釈が一般的。
// ============================================================================

function acDivergenceCandidates(state, seasons, metricsById, standRows, ac) {
  const { teamLg, leagueIds, gp } = acGamesPlayedByLeague(standRows);
  const out = [];
  for (const lid of leagueIds) {
    const qPA = qualifiedPA(gp.get(lid));
    const qIP = qualifiedIP(gp.get(lid));
    // --- 打者: xwOBA − wOBA ---
    const batters = [];
    for (const s of seasons) {
      if (teamLg.get(s.teamId) !== lid || !s.batting || s.batting.pa < qPA) continue;
      const m = metricsById.get(s.playerId).battingM;
      if (m) batters.push({ playerId: s.playerId, m });
    }
    if (batters.length >= ac.extremeMinPool) {
      const byXwoba = batters.slice().sort((a, b) => b.m.xwoba - a.m.xwoba || idAscA(a.playerId, b.playerId));
      const rankOf = new Map(byXwoba.map((x, i) => [x.playerId, i + 1]));
      let unlucky = null; // xwOBA >> wOBA
      let lucky = null; // wOBA >> xwOBA（出来すぎ警報）
      for (const b of batters) {
        const gap = b.m.xwoba - b.m.woba;
        if (gap >= ac.divergenceXwobaMin && (!unlucky || gap > unlucky.gap)) unlucky = { ...b, gap };
        if (-gap >= ac.divergenceXwobaMin && (!lucky || -gap > lucky.gap)) lucky = { ...b, gap: -gap };
      }
      if (unlucky) out.push({ type: 'divergenceUnlucky', role: 'fielder', leagueId: lid, playerId: unlucky.playerId, rank: rankOf.get(unlucky.playerId), avg: unlucky.m.avg, priority: 70 });
      if (lucky) out.push({ type: 'divergenceLucky', role: 'fielder', leagueId: lid, playerId: lucky.playerId, rank: rankOf.get(lucky.playerId), avg: lucky.m.avg, priority: 70 });
    }
    // --- 投手: ERA − SIERA ---
    const pitchers = [];
    for (const s of seasons) {
      if (teamLg.get(s.teamId) !== lid || !s.pitching || s.pitching.outs / 3 < qIP) continue;
      const m = metricsById.get(s.playerId).pitchingM;
      if (m) pitchers.push({ playerId: s.playerId, m });
    }
    if (pitchers.length >= ac.extremeMinPool) {
      const bySiera = pitchers.slice().sort((a, b) => a.m.siera - b.m.siera || idAscA(a.playerId, b.playerId));
      const rankOf = new Map(bySiera.map((x, i) => [x.playerId, i + 1]));
      let unlucky = null; // era >> siera
      let lucky = null; // era << siera（出来すぎ警報）
      for (const p of pitchers) {
        const gap = p.m.era - p.m.siera;
        if (gap >= ac.divergenceEraSieraMin && (!unlucky || gap > unlucky.gap)) unlucky = { ...p, gap };
        if (-gap >= ac.divergenceEraSieraMin && (!lucky || -gap > lucky.gap)) lucky = { ...p, gap: -gap };
      }
      if (unlucky) out.push({ type: 'divergenceUnlucky', role: 'pitcher', leagueId: lid, playerId: unlucky.playerId, rank: rankOf.get(unlucky.playerId), era: unlucky.m.era, priority: 70 });
      if (lucky) out.push({ type: 'divergenceLucky', role: 'pitcher', leagueId: lid, playerId: lucky.playerId, rank: rankOf.get(lucky.playerId), era: lucky.m.era, priority: 70 });
    }
  }
  return out;
}

const AC_DIVERGENCE_TPL = {
  fielder: {
    divergenceUnlucky: [
      (n, avg, rank) => `打率${avg}に騙されるな。${n}のxwOBAはリーグ${rank}位——打球の質は本物だ`,
      (n, avg, rank) => `${n}、見た目の数字（打率${avg}）より中身が良い。xwOBAはリーグ${rank}位につけている`,
    ],
    divergenceLucky: [
      (n, avg, rank) => `${n}の打率${avg}、xwOBAはリーグ${rank}位止まり。出来すぎ警報——反動に注意`,
      (n, avg, rank) => `${n}の好成績、xwOBA（リーグ${rank}位）は追いついていない。ここからは息切れも視野に`,
    ],
  },
  pitcher: {
    divergenceUnlucky: [
      (n, era, rank) => `${n}の防御率${era}は見た目ほど悪くない。SIERAはリーグ${rank}位——内容は投手陣随一`,
      (n, era, rank) => `${n}、防御率${era}に見合わない好内容。SIERA基準ならリーグ${rank}位`,
    ],
    divergenceLucky: [
      (n, era, rank) => `${n}の防御率${era}、SIERAはリーグ${rank}位止まり。出来すぎ警報——好調の反動に注意`,
      (n, era, rank) => `${n}、内容以上の結果が出ている。SIERA（リーグ${rank}位）は追いついておらず要注意`,
    ],
  },
};

function acRenderDivergence(state, c, names) {
  const { pnameOf = (id) => id } = names;
  const list = AC_DIVERGENCE_TPL[c.role][c.type];
  const r = makeRng(hashSeed(state.masterSeed, 'analyst', 'tpl', c.type, c.role, c.playerId));
  const tpl = list[r.int(list.length)];
  const statText = c.role === 'fielder' ? acAvg3(c.avg) : c.era.toFixed(2);
  return { ...c, text: tpl(pnameOf(c.playerId), statText, c.rank), cls: c.type === 'divergenceUnlucky' ? 'good' : 'info', kind: c.type };
}

// ============================================================================
// R1-3: 比較型（若手のペースが殿堂入り選手の同年目実績と同水準）。
//
// 根拠: 本カテゴリは統計的な将来予測（定説）ではなく、確定済みの通算成績（career行）同士の
//   「その年に記録したカウンティング数値のペースが同水準だった」という事実の比較に限定する
//   （MLB Pipelineの20-80スケールが実在の名選手を参照点に評価を伝える手法と同じ発想）。
//   「殿堂入り選手と同じ選手になる」という将来の実力を保証する断定はしない＝あくまで数字の
//   ペースが並んでいるという事実の指摘。
// ============================================================================

/** careerStats から playerId の career 通算N年目（1始まり）の生ラインを返す（無ければnull）。 */
function acNthSeasonLine(careerStats, playerId, n, isPitcher) {
  const rows = careerStats.filter((s) => s.playerId === playerId).sort((a, b) => a.season - b.season);
  if (rows.length < n) return null;
  return isPitcher ? rows[n - 1].pitching : rows[n - 1].batting;
}

/** その選手の現時点での「プロn年目」（careerStatsに残る過去シーズン数+1）。 */
function acCareerYearOf(state, playerId) {
  const years = new Set();
  for (const s of state.careerStats || []) if (s.playerId === playerId && s.season < state.year) years.add(s.season);
  return years.size + 1;
}

/** シーズン消化率（0-1）。teamId の rt.standings 行から。 */
function acSeasonProgressOf(standRows, cfg, teamId) {
  const row = standRows.find((r) => r.teamId === teamId);
  const fullG = cfg.league.gamesPerSeason;
  return row && fullG ? row.g / fullG : 0;
}

function acComparisonCandidates(state, seasons, standRows, ac) {
  const cfg = state.cfg;
  const hof = hallOfFamers(state);
  if (!hof.length) return [];
  const out = [];
  const tryRole = (isPitcher, statKey, label) => {
    let best = null;
    for (const s of seasons) {
      const line = isPitcher ? s.pitching : s.batting;
      if (!line) continue;
      const n = acCareerYearOf(state, s.playerId);
      if (n > ac.comparisonMaxCareerYear) continue;
      const progress = acSeasonProgressOf(standRows, cfg, s.teamId);
      if (progress < ac.comparisonMinProgress) continue;
      const cur = line[statKey] || 0;
      if (cur <= 0) continue;
      const pace = cur / progress;
      // 同じプロn年目の殿堂メンバーの実績と比較（最も見栄えのする一致を採用・決定論タイブレーク）。
      for (const h of hof) {
        if (h.role !== (isPitcher ? 'pitcher' : 'fielder')) continue;
        const hLine = acNthSeasonLine(state.careerStats, h.playerId, n, isPitcher);
        if (!hLine) continue;
        const hVal = hLine[statKey] || 0;
        if (hVal <= 0) continue;
        if (pace < hVal * ac.comparisonPaceRatio) continue;
        const cand = { playerId: s.playerId, hofId: h.playerId, n, pace, hVal, label, priority: 60 };
        if (!best || hVal > best.hVal || (hVal === best.hVal && idAscA(s.playerId, best.playerId) < 0)) best = cand;
      }
    }
    if (best) out.push({ type: 'comparison', ...best });
  };
  tryRole(false, 'hr', '本塁打');
  tryRole(true, 'w', '勝利');
  return out;
}

const AC_COMPARISON_TPL = [
  (n, hofName, year, pace, unit, hVal) => `${n}、プロ${year}年目のペースは${pace}${unit}——殿堂の${hofName}の${year}年目（${hVal}${unit}）に並ぶ`,
  (n, hofName, year, pace, unit, hVal) => `${hofName}を思わせる仕上がり。${n}はプロ${year}年目で${pace}${unit}ペース（${hofName}は同年目${hVal}${unit}）`,
];

function acRenderComparison(state, c, names) {
  const { pnameOf = (id) => id } = names;
  const r = makeRng(hashSeed(state.masterSeed, 'analyst', 'tpl', 'comparison', c.playerId));
  const tpl = AC_COMPARISON_TPL[r.int(AC_COMPARISON_TPL.length)];
  const text = tpl(pnameOf(c.playerId), pnameOf(c.hofId), c.n, Math.round(c.pace), c.label, c.hVal);
  return { ...c, text, cls: 'good', kind: 'comparison' };
}

// ============================================================================
// R7: 試合ハイライト（直近の自チーム試合・playerGameLog の box から「その日の一番」）。
//
// 根拠: ここは既に起きた1試合の生カウント（アウト/K/BB/HR/H）をそのまま descriptive に述べるだけ
//   で、将来予測や能力評価の断定はしない（「圧巻の内容だった」等は結果の形容であり、以後の
//   再現性を主張する文言ではない）。CSW%は一球データ(box)に残らないため代用せず、box.pitchers
//   にある outs/k/bb から算出できる「その試合のK-BB」「対戦打者数近似に対するK%」という取れる
//   範囲の実測値のみを使う（無理に新集計をシムへ足さない）。
// ============================================================================

function acGameHighlightCandidates(state, ac) {
  const rt = state.rt;
  if (!rt || !rt.playerGameLog || !rt.playerGameLog.length) return [];
  const teamId = state.playerTeamId;
  const recent = rt.playerGameLog.slice(-ac.gameHighlightLookback).reverse();
  const out = [];
  let pitchDone = false;
  let batDone = false;
  for (const rec of recent) {
    if (pitchDone && batDone) break;
    const box = rec.box;
    if (!box) continue;
    const mySide = rec.home === teamId ? 'home' : rec.away === teamId ? 'away' : null;
    if (!mySide) continue;
    if (!pitchDone) {
      const pitchers = box.pitchers[mySide] || [];
      let best = null;
      for (const p of pitchers) {
        if (p.outs < ac.gameHighlightMinOuts) continue;
        const kbb = p.k - p.bb;
        if (kbb < ac.gameHighlightMinKbb) continue;
        if (!best || kbb > best.kbb) best = { ...p, kbb };
      }
      if (best) {
        pitchDone = true;
        const bfApprox = best.outs + best.h + best.bb;
        out.push({ type: 'gameHighlightPitch', playerId: best.pid, day: rec.day, outs: best.outs, k: best.k, bb: best.bb, kPctDay: acDiv(best.k, bfApprox), priority: 100 });
      }
    }
    if (!batDone) {
      const batters = box.batters[mySide] || [];
      const hitter = batters.find((b) => b.hr >= ac.gameHighlightMinHr);
      if (hitter) {
        batDone = true;
        out.push({ type: 'gameHighlightBat', playerId: hitter.pid, day: rec.day, hr: hitter.hr, h: hitter.h, priority: 100 });
      }
    }
  }
  return out;
}

// 用語注意: kpct は「対戦打者に占める奪三振の割合」（K%）。日本語の「奪三振率」は通常 K/9 を
// 指すため、混同を避けて K% と明記する（セイバー用語の正確性・ユーザー指示）。
const AC_GAME_HL_PITCH_TPL = [
  (n, ip, k, bb, kpct) => `昨日の${n}、${ip}回を投げて${k}奪三振・与四球${bb}——対戦打者の${kpct}から三振を奪う（K%）圧巻の内容だった`,
  (n, ip, k, bb, kpct) => `${n}、直近の登板は${ip}回${k}奪三振・与四球${bb}。K%${kpct}の支配力を示した`,
];
const AC_GAME_HL_BAT_TPL = [
  (n, hr) => `${n}、1試合${hr}本塁打の固め打ち——長打力がひと際目立つ一日だった`,
  (n, hr) => `${n}、1試合で${hr}本塁打。この日は長打力が爆発した`,
];

function acRenderGameHighlight(state, c, names) {
  const { pnameOf = (id) => id } = names;
  if (c.type === 'gameHighlightPitch') {
    const r = makeRng(hashSeed(state.masterSeed, 'analyst', 'tpl', 'gh_p', c.playerId, c.day));
    const tpl = AC_GAME_HL_PITCH_TPL[r.int(AC_GAME_HL_PITCH_TPL.length)];
    const ip = (c.outs / 3).toFixed(1);
    return { ...c, text: tpl(pnameOf(c.playerId), ip, c.k, c.bb, acPct(c.kPctDay)), cls: 'good', kind: c.type };
  }
  const r = makeRng(hashSeed(state.masterSeed, 'analyst', 'tpl', 'gh_b', c.playerId, c.day));
  const tpl = AC_GAME_HL_BAT_TPL[r.int(AC_GAME_HL_BAT_TPL.length)];
  return { ...c, text: tpl(pnameOf(c.playerId), c.hr), cls: 'good', kind: c.type };
}

// ============================================================================
// R8: 隠れWPAリーダー（月境界の週にだけ・打撃成績が地味なのにWPAが高い選手を1名）。
//
// 根拠/注意: WPA(勝率貢献度)は「実際に起きた場面の勝率変化を積み上げた"結果の記録"」であり、
//   「クラッチ能力（此処ぞの場面に強い、という再現性のある実力）」の証明ではない——クラッチ
//   成績の年度間相関は低く、多くのセイバー研究で再現性の薄い指標とされているのが定説（例えば
//   FanGraphsのClutch指標も「観測された事実」であって「能力」とは切り離して解説される）。
//   本テンプレは「これまでの勝利への貢献度が高い」という確定済みの記録として述べるにとどめ、
//   「クラッチ能力がある」「今後も勝利に貢献し続ける」という実力・将来の断定はしない。
// ============================================================================

function acWpaHiddenCandidate(seasons, standRows, metricsById, ac) {
  const teamLg = acTeamLeagueMap(standRows);
  const gp = acGamesPlayedByLeague(standRows).gp;
  let best = null;
  for (const s of seasons) {
    const lid = teamLg.get(s.teamId);
    if (lid == null || !s.batting) continue;
    const qPA = qualifiedPA(gp.get(lid));
    if (s.batting.pa < qPA) continue;
    const m = metricsById.get(s.playerId).battingM;
    if (!m || m.wrcPlus >= ac.wpaHiddenWrcMax || m.wpa < ac.wpaHiddenMinWpa) continue;
    if (!best || m.wpa > best.m.wpa || (m.wpa === best.m.wpa && idAscA(s.playerId, best.playerId) < 0)) best = { playerId: s.playerId, m };
  }
  if (!best) return null;
  return { type: 'wpaHidden', playerId: best.playerId, wrcPlus: Math.round(best.m.wrcPlus), wpa: best.m.wpa, priority: 90 };
}

const AC_WPA_HIDDEN_TPL = [
  (n, wrc) => `${n}、打撃成績（wRC+${wrc}）は目立たないが、ここまでの勝利への貢献度（WPA）はリーグ屈指の記録を残している`,
  (n, wrc) => `数字の裏の働き者——${n}、打率だけでは見えない勝利への貢献(WPA)の積み上げがチーム屈指（wRC+${wrc}）`,
];

function acRenderWpaHidden(state, c, names) {
  const { pnameOf = (id) => id } = names;
  const r = makeRng(hashSeed(state.masterSeed, 'analyst', 'tpl', 'wpaHidden', c.playerId));
  const tpl = AC_WPA_HIDDEN_TPL[r.int(AC_WPA_HIDDEN_TPL.length)];
  return { ...c, text: tpl(pnameOf(c.playerId), c.wrcPlus), cls: 'good', kind: 'wpaHidden' };
}

// ============================================================================
// 選抜（優先度順＋hashSeed決定論の抽選・同週同一選手の重複排除）。
// ============================================================================

/** 抽選前の固定順（Map反復順に依存しない決定論的な並び）。 */
function acSortKey(c) {
  return `${c.type}|${c.metricKey || ''}|${c.leagueId || ''}|${c.day || 0}|${c.playerId}`;
}

function acFinalize(state, week, rendered) {
  const ordered = rendered.slice().sort((a, b) => (acSortKey(a) < acSortKey(b) ? -1 : acSortKey(a) > acSortKey(b) ? 1 : 0));
  const r = makeRng(hashSeed(state.masterSeed, 'analyst', state.year, week, 'pick'));
  const draws = ordered.map((c) => ({ c, draw: r.next() }));
  draws.sort((a, b) => (b.c.priority - a.c.priority) || (a.draw - b.draw));
  const maxItems = state.cfg.tuning.storylines.analyst.maxItems ?? 4;
  const used = new Set();
  const out = [];
  for (const { c } of draws) {
    if (out.length >= maxItems) break;
    if (used.has(c.playerId)) continue;
    used.add(c.playerId);
    out.push({ text: c.text, cls: c.cls, playerId: c.playerId, kind: c.kind });
  }
  return out;
}

/**
 * R1+R7+R8:「アナリストの目」— 現在の観測シーズン成績から週替わりで最大4本の一言コラムを返す。
 * シーズン消化が浅い/規定未到達の間は該当ネタが検出されず、自然と空配列（憶測を書かない）。
 * @param {Object} state GameState（rt/cfg/masterSeed/year/careerStats/retiredPlayers等が必要）
 * @param {{pnameOf?:Function}} names pnameOf: playerId→表示名（省略時は識別子そのまま）
 * @returns {Array<{text:string, cls:string, playerId:string, kind:string}>}
 */
export function analystColumnOf(state, names = {}) {
  const rt = state.rt;
  if (!rt || !rt.stats || !rt.standings) return [];
  const week = acWeekOf(state);
  if (week == null) return [];
  const standRows = [...rt.standings.values()];
  const seasons = [...rt.stats.stats.values()];
  if (!standRows.length || !seasons.length) return [];
  const cfg = state.cfg;
  const ac = cfg.tuning.storylines.analyst;
  const lc = deriveLeagueConstants({ playerSeasons: seasons, standings: standRows });
  const metricsById = acBuildMetricsCache(seasons, lc, cfg);

  const rendered = [];
  for (const c of acExtremeCandidates(state, seasons, standRows, metricsById, ac)) rendered.push(acRenderExtreme(state, c, names));
  for (const c of acDivergenceCandidates(state, seasons, metricsById, standRows, ac)) rendered.push(acRenderDivergence(state, c, names));
  for (const c of acComparisonCandidates(state, seasons, standRows, ac)) rendered.push(acRenderComparison(state, c, names));
  for (const c of acGameHighlightCandidates(state, ac)) rendered.push(acRenderGameHighlight(state, c, names));
  if (state.playerTeamId && acIsMonthBoundaryWeek(state, week)) {
    const wpa = acWpaHiddenCandidate(seasons, standRows, metricsById, ac);
    if (wpa) rendered.push(acRenderWpaHidden(state, wpa, names));
  }

  return acFinalize(state, week, rendered);
}

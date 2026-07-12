// ============================================================================
// フェーズE2: 試合観戦のスポナビ風刷新（ラインスコア・フィールド盤面・対戦カード・一球速報）
//
// ユーザーフィードバック（phaseE_spec）「試合は見れたものではない。スポナビの野球速報みたいなのがいい」対応。
// E2改: レビュー「試合がかなり見づらい」対応のスポナビ速報式再設計:
//   - 「現在の打席」ボックス（対戦カード直下）: 現打席の投球を1球目→N球目の正順で表示。
//     全投球にカウント(B-S)を統一表記。打席決着で結果を大きく表示（次打席で更新）。
//   - 実況フィードは既定で打席結果のみの1行（[N回表/裏] 打者: 結果）に畳む。
//     「全球表示」トグル（w.allPitches・UIのみ）で一球行込み表示へ切替。
//   - 結果行の色分け: 安打=ev-hit / 本塁打・得点=ev-hr,ev-score / 三振=ev-k /
//     四死球=ev-bb / 失策・盗塁死=ev-err。得点行の行末に現在スコアを付記。
//   - 対戦カードの打者行: 「今日 X打数Y安打」＋当日打席履歴チップ（三ゴロ・左安…の略記列）。
// E2ゾーニング改（「野球観戦アプリのように情報を整理してほしい」対応）:
//   - 判定の色体系を統一: ボール=白/見逃しS=緑/空振り=赤/ファウル=黄/インプレー=青（pc-*クラス）。
//     現打席リスト・実況の一球行（全球表示時）で共通。
// G1a改（phaseG_spec「スポナビ原則への全面改修」対応・タブ切替で1画面完結）:
//   - 常設はコンパクトスコアボード(.scorebar)のみ（▼でラインスコア.sblinescoreを展開）。
//     B-S-O/塁表示は v.ended で描画しない（残留点灯/残留表示バグの根治）。
//   - watch内サブタブ(.wtab)を「速報／対戦／ボックス／スタメン」の4種に分割し、
//     そのタブの内容だけを画面に出す（旧 .nowpanel/.duelpanel の常設パネルは廃止）。
//     速報=現在の打席(.curab・打者/投手名込み)→実況フィード。対戦=盤面→対戦カード→打球フィールド図。
//   - 進行バー(.watchctrl)は下部固定・全幅・1行。試合終了時は「ホームへ戻る」のみ
//     （最終スコアはスコアバーに一本化・珍記録は速報フィード先頭へ移設）。
// F2改（ユーザー要望）: コース図（ストライクゾーンプロット・打者の影・球種マーカー・凡例）は撤去。
//     現在の打席の1球ごとテキスト結果・実況フィード・対戦カードの利き腕タグ（右打/左打/右投/左投）は維持。
//   - 利き腕表示: 対戦カードに「右打/左打/両打(実効側)」「右投/左投」（bats/throws は公開情報）。
// 設計原則:
//   - エンジンとUIの分離: 描画は onEvent の構造化イベント列
//     （start/atbat/pitch/pa/bunt/steal/sub/end・すべて乱数非消費）の純再生（watchReconstruct）。
//     UI操作はイベント列上の再生位置(game.watch.idx)を動かすだけで、ゲーム状態を一切変えない
//     （決定論・セーブ再現に無関係）。
//   - 進行単位: 1球 / 1打席 / 1イニング ＋ 自動再生トグル（タイマーは再生位置を進めるだけ）。
//   - 自己完結: SVG/CSSのみ・外部依存なし。選手名クリックは playerLink（E1導線）→詳細モーダル。
//   - バンドル: build.mjs が src/ui/*.mjs を ui.mjs と同一<script>へ前置concat。ui.mjs のヘルパーは
//     deps オブジェクト u（ui.mjs の watchDeps()）で受け取る（トップレベル名衝突の回避・E1の流儀）。
// ============================================================================
import { playerBatting, playerPitching, effectiveBats, rawRunValuePerPA, isBarrel, neutralResponsible } from '../engine.mjs';
import { detectGameNotables, notableHeadline } from '../game/index.mjs';
import { buildBoxScore } from '../game/boxscore.mjs';

const WATCH_PITCH_JP = { fastball: 'ストレート', slider: 'スライダー', curve: 'カーブ', changeup: 'チェンジアップ', fork: 'フォーク', sinker: 'シンカー', cutter: 'カットボール' };
const WATCH_CALL_JP = { ball: 'ボール', called: '見逃しストライク', whiff: '空振り', foul: 'ファウル', inplay: '打った！', hbp: '死球' };
const WATCH_BATTED_JP = { GB: 'ゴロ', LD: 'ライナー', FB: 'フライ', PU: '小フライ' };
const WATCH_HITS = new Set(['1B', '2B', '3B', 'HR']);
const WATCH_OUTFIELD_POS = new Set(['LF', 'CF', 'RF']);

/** 打球方向（スプレー角→左中右）。負=左・正=右（sprayChart と同じ符号系）。安打の方向表記に使う。 */
function watchDirName(deg) {
  return deg < -12 ? 'レフト' : deg > 12 ? 'ライト' : 'センター';
}
function watchDirChar(deg) {
  return deg < -12 ? '左' : deg > 12 ? '右' : '中';
}

// アウトになった打球の「誰が処理したか」は、エンジンが決めた責任野手(fielderPos)を唯一の真実とする。
// 旧実装は打球種別とスプレー角だけでポジション名を推測していたため、
// たとえば「EV121km/h・LA47°・33m」の内野への高いポップフライ（責任野手=一塁手・捕球確率0.996）を
// 打球種別FB(25-50°)→外野方向→「ライトフライ」と表示していた（守備指標側は正しく一塁手に帰属していた）。
const WATCH_POS_JP = { P: 'ピッチャー', C: 'キャッチャー', '1B': 'ファースト', '2B': 'セカンド', '3B': 'サード', SS: 'ショート', LF: 'レフト', CF: 'センター', RF: 'ライト' };
const WATCH_POS_CHAR = { P: '投', C: '捕', '1B': '一', '2B': '二', '3B': '三', SS: '遊', LF: '左', CF: '中', RF: '右' };

/** 責任野手のポジション名。無ければスプレー角からの方向で代替する。 */
function watchFielderName(e) {
  return WATCH_POS_JP[e.fielderPos] || (e.bb ? watchDirName(e.bb.sprayDeg) : '');
}
function watchFielderChar(e) {
  return WATCH_POS_CHAR[e.fielderPos] || (e.bb ? watchDirChar(e.bb.sprayDeg) : '');
}
/** イニングハーフの和名（'bottom'→裏）。 */
function watchHalfJP(half) {
  return half === 'bottom' ? '裏' : '表';
}
/** 得点イベント行末に付ける現在スコア「（先攻 X-Y 後攻）」。 */
function watchScoreTxt(v, tname) {
  return `（${tname(v.away)} ${v.scoreA}-${v.scoreH} ${tname(v.home)}）`;
}
// ============================================================================
// 打席ごとの指標変化（ユーザー要望）: 「現在の打席」ボックスの結果直下に
// 「AVG .283→.285 (+.002)」のように、この1打席で変化した指標だけをぶら下げ表示する。
// エンジン(src/sim/*)は一切変更しない（pa イベントに追加された fielderPos/fielderId を
// 読むのみ）。乱数は一切消費しない・決定論/identity不変（表示専用の副読み計算）。
//
// 前提: state.res（refreshRes→resFromRt）はシーズン単位の累積であり、観戦対象の試合は
// advanceTo が既にシミュレート済み＝この試合の結果込みで統計に反映されている（watch.events は
// 再生用のログに過ぎない）。よって「この試合が始まる前」の値は、シーズン累積から
// この試合ぶんの生カウント（イベント列を1回フル再生して求める）を逆算して得る（w.beforeGame）。
// ============================================================================

/**
 * 打球の期待アウト率（＝Statcast の catch probability 相当）。
 * エンジンの Distance-Time モデル（neutralResponsible）をそのまま呼ぶ読み取り専用の再計算。
 * 以前はここに resolveBattedBall の pHit 計算を手写ししていたが、二重実装は乖離の温床なので撤去した。
 * 打球のない打席は null、本塁打はエンジンと同じく 0 を返す。
 */
function watchExpOut(e, cfg) {
  if (!e.bb || !e.battedType || !cfg) return null;
  if (e.result === 'HR') return 0;
  return neutralResponsible(e.bb, e.battedType, cfg).pOut;
}

/**
 * 1打席(pa/bunt)の打者側 生カウント差分（ab/h/b1/b2/b3/hr/bb/hbp/sf ＋ §16b wRC+/wRAA/Hard%用に
 * pa/so/ibb/hardHits/bbEvents を追加）。game.mjs のスプリット計上（§B3b bumpSplit 呼び出し箇所）と
 * 同じ分岐を再現する（乱数非消費・cfgはHardHit閾値の読み取りのみに使用）。
 */
function watchBattingDelta(e, cfg) {
  const d = { ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, sf: 0, pa: 1, so: 0, ibb: 0, hardHits: 0, bbEvents: 0 };
  if (e.type === 'bunt') {
    if (e.outcome === 'hit') { d.ab = 1; d.h = 1; d.b1 = 1; }
    else if (e.outcome === 'fail') { d.ab = 1; }
    return d; // 'success'（送りバント成功）は打数に含めない
  }
  const sacFly = e.sacFly === true; // エンジンのctx.sacFlyを唯一の真実とする（realism_r1 §F-2）
  if (e.outcome === 'BB') { d.bb = 1; if (e.isIBB) d.ibb = 1; }
  else if (e.outcome === 'HBP') d.hbp = 1;
  else if (e.result === '1B') { d.ab = 1; d.h = 1; d.b1 = 1; }
  else if (e.result === '2B') { d.ab = 1; d.h = 1; d.b2 = 1; }
  else if (e.result === '3B') { d.ab = 1; d.h = 1; d.b3 = 1; }
  else if (e.result === 'HR') { d.ab = 1; d.h = 1; d.hr = 1; }
  else if (e.result === 'E') d.ab = 1;
  else if (sacFly) d.sf = 1;
  else d.ab = 1;
  if (e.outcome === 'K') d.so = 1;
  if (cfg && e.bb && e.battedType) {
    d.bbEvents = 1;
    if (e.bb.evKmh >= cfg.tuning.metrics.hardHitKmh) d.hardHits = 1;
  }
  return d;
}

/** 守備帰属の1打席ぶんOAAデルタ（実アウト−期待アウト）。打球のない打席/守備帰属なしは null。 */
function watchFieldingDelta(e, cfg) {
  if (e.type !== 'pa' || !e.fielderId || !e.fielderPos) return null;
  const expOut = watchExpOut(e, cfg);
  if (expOut == null) return null;
  const actual = e.result === 'out' || e.result === 'E' ? 1 : 0; // 失策前判定=r.result相当（§7.2と同じ扱い）
  return { pid: e.fielderId, pos: e.fielderPos, oaaDelta: actual - expOut };
}

/** Map(pid -> 累積オブジェクト) へ差分を加算する（無ければ新規作成）。 */
function bumpCounts(map, pid, patch) {
  if (!pid) return;
  let m = map.get(pid);
  if (!m) { m = {}; map.set(pid, m); }
  for (const k of Object.keys(patch)) m[k] = (m[k] || 0) + (patch[k] || 0);
}

/** pa/bunt イベントの得点(この打席で入った点)。pa は runsOnPlay 直読み、bunt はチーム得点の直前比較。 */
function watchRunsOnPlay(e, lastScoreByTeam) {
  if (e.type === 'pa') return e.runsOnPlay || 0;
  const prev = lastScoreByTeam.has(e.batTeam) ? lastScoreByTeam.get(e.batTeam) : e.batScore;
  return Math.max(0, e.batScore - prev);
}

/**
 * 試合全体（idx非依存・全イベントをフル再生）の打者/投手/守備 生カウント合計。
 * w.beforeGame（シーズン累積からこの試合ぶんを逆算する基準）作成の下ごしらえ。
 */
function computeGameEventTotals(events, cfg) {
  const bat = new Map(); const pit = new Map(); const fld = new Map();
  const lastScore = new Map();
  let curPitcherId = null; let curOuts = 0;
  for (const e of events) {
    if (e.type === 'atbat') { curPitcherId = e.pitcherId; curOuts = e.outs; }
    else if (e.type === 'pa' || e.type === 'bunt') {
      const bd = watchBattingDelta(e, cfg);
      bumpCounts(bat, e.batterId, bd);
      const runs = watchRunsOnPlay(e, lastScore);
      lastScore.set(e.batTeam, e.batScore);
      const outsAfter = e.outsAfter != null ? e.outsAfter : curOuts;
      bumpCounts(pit, curPitcherId, {
        outs: outsAfter - curOuts, h: bd.h, bb: bd.bb, er: runs,
        so: bd.so, ibb: bd.ibb, hbp: bd.hbp, hr: e.result === 'HR' ? 1 : 0, bf: 1, bbFB: e.battedType === 'FB' ? 1 : 0,
      });
      curOuts = outsAfter;
      const fd = watchFieldingDelta(e, cfg);
      if (fd) bumpCounts(fld, fd.pid, { oaaOuts: fd.oaaDelta });
    }
  }
  return { bat, pit, fld };
}

/**
 * w.beforeGame の構築（観戦開始時に1回だけ・renderWatchScreen が w.beforeGame 未設定時に呼ぶ）。
 * state.res.statsById のシーズン累積（この試合込み・advanceTo が先に解決済み）から、
 * computeGameEventTotals で求めたこの試合ぶんの生カウントを差し引き「試合開始前」を逆算する。
 */
function computeBeforeGame(events, state) {
  const before = new Map();
  const cfg = state && state.cfg;
  if (!cfg) return before;
  const { bat, pit, fld } = computeGameEventTotals(events, cfg);
  const pids = new Set([...bat.keys(), ...pit.keys(), ...fld.keys()]);
  const statsById = state.res && state.res.statsById;
  for (const pid of pids) {
    const ps = statsById ? statsById.get(pid) : null;
    const gb = bat.get(pid) || {}; const gp = pit.get(pid) || {}; const gf = fld.get(pid) || {};
    const sb = ps ? ps.batting : null; const sp = ps ? ps.pitching : null; const sfl = ps ? ps.fielding : null;
    before.set(pid, {
      batting: {
        ab: (sb ? sb.ab : 0) - (gb.ab || 0), h: (sb ? sb.h : 0) - (gb.h || 0),
        b1: (sb ? sb.b1 : 0) - (gb.b1 || 0), b2: (sb ? sb.b2 : 0) - (gb.b2 || 0), b3: (sb ? sb.b3 : 0) - (gb.b3 || 0),
        hr: (sb ? sb.hr : 0) - (gb.hr || 0), bb: (sb ? sb.bb : 0) - (gb.bb || 0),
        hbp: (sb ? sb.hbp : 0) - (gb.hbp || 0), sf: (sb ? sb.sf : 0) - (gb.sf || 0),
        pa: (sb ? sb.pa : 0) - (gb.pa || 0), so: (sb ? sb.so : 0) - (gb.so || 0), ibb: (sb ? sb.ibb : 0) - (gb.ibb || 0),
        hardHits: (sb ? sb.hardHits : 0) - (gb.hardHits || 0), bbEvents: (sb ? sb.bbEvents : 0) - (gb.bbEvents || 0),
      },
      pitching: {
        outs: (sp ? sp.outs : 0) - (gp.outs || 0), h: (sp ? sp.h : 0) - (gp.h || 0),
        bb: (sp ? sp.bb : 0) - (gp.bb || 0), er: (sp ? sp.er : 0) - (gp.er || 0),
        so: (sp ? sp.so : 0) - (gp.so || 0), ibb: (sp ? sp.ibb : 0) - (gp.ibb || 0), hbp: (sp ? sp.hbp : 0) - (gp.hbp || 0),
        hr: (sp ? sp.hr : 0) - (gp.hr || 0), bf: (sp ? sp.bf : 0) - (gp.bf || 0), bbFB: (sp ? sp.bbFB : 0) - (gp.bbFB || 0),
      },
      fielding: { oaaOuts: (sfl ? sfl.oaaOuts : 0) - (gf.oaaOuts || 0) },
    });
  }
  return before;
}

/**
 * 生カウント→AVG/OBP/SLG/OPS＋wRAA/wRC+/Hard%（打者側）。lc（リーグ定数）が無ければ
 * wRAA/wRC+は0/100・Hard%は0のまま返す（観戦開始直後などlc未確定時のフォールバック）。
 */
function watchSlash(b, lc) {
  const tb = b.b1 + 2 * b.b2 + 3 * b.b3 + 4 * b.hr;
  const avg = b.ab ? b.h / b.ab : 0;
  const obpDen = b.ab + b.bb + b.hbp + b.sf;
  const obp = obpDen ? (b.h + b.bb + b.hbp) / obpDen : 0;
  const slg = b.ab ? tb / b.ab : 0;
  const pa = b.pa || obpDen;
  let wraa = 0; let wrcPlus = 100;
  if (lc) {
    const raw = rawRunValuePerPA(b, lc.linearWeights);
    wraa = (raw - (lc.lgRawPerPA || 0)) * pa;
    wrcPlus = lc.lgRunsPerPA && pa ? ((wraa / pa + lc.lgRunsPerPA) / lc.lgRunsPerPA) * 100 : 100;
  }
  const hardHitPct = b.bbEvents ? b.hardHits / b.bbEvents : 0;
  return { avg, obp, slg, ops: obp + slg, wraa, wrcPlus, hardHitPct };
}
/**
 * 生カウント→ERA/WHIP＋xFIP/kwERA/K-BB%（投手側）。xFIPはlc（lgHRFB/fipConstant）必須、
 * 未確定時は0を返す（watchSlash同様のフォールバック）。
 */
function watchPitchLine(p, lc, cfg) {
  const ip = p.outs / 3;
  const era = ip ? (p.er * 9) / ip : 0;
  const whip = ip ? (p.h + p.bb) / ip : 0;
  const kPct = p.bf ? p.so / p.bf : 0;
  const bbPct = p.bf ? p.bb / p.bf : 0;
  const kbbPct = kPct - bbPct;
  let xfip = 0;
  if (ip && lc) {
    const uBBhbp = p.bb - (p.ibb || 0) + p.hbp;
    const xHRexp = p.bbFB * (lc.lgHRFB || 0);
    xfip = (13 * xHRexp + 3 * uBBhbp - 2 * p.so) / ip + (lc.fipConstant || 0);
  }
  const m = cfg && cfg.tuning && cfg.tuning.metrics;
  const kwera = m ? m.kwERA.c0 - m.kwERA.k * kbbPct : 0;
  return { era, whip, xfip, kwera, kbbPct };
}
/** OAA(アウト単位)→UZR概算（内野0.75/外野0.90・fielding.mjs の uzrRuns と同じ run/out定数を流用）。 */
function watchUzrOf(oaaOuts, pos, cfg) {
  const rpo = WATCH_OUTFIELD_POS.has(pos) ? cfg.tuning.field.runPerOutOutfield : cfg.tuning.field.runPerOutInfield;
  return oaaOuts * rpo;
}

const fmt1Abs = (v) => v.toFixed(1);
const fmtIntAbs = (v) => Math.round(v).toString();
const fmtPct1Abs = (v) => (v * 100).toFixed(1) + '%';
const fmtSigned3 = (v) => (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(3).replace(/^0/, '');
const fmtSigned2 = (v) => (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(2);
const fmtSigned1 = (v) => (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(1);
const fmtSignedInt = (v) => (v >= 0 ? '+' : '-') + Math.round(Math.abs(v)).toString();
const fmtSignedPct1 = (v) => (v >= 0 ? '+' : '-') + Math.abs(v * 100).toFixed(1) + '%';

/** 指標1行（絶対値が変化していなければ null）。invert=true は「低いほど良い」指標(ERA/WHIP)の色反転。 */
function mdRow(label, before, after, fmtAbs, fmtDelta, invert) {
  const delta = after - before;
  if (Math.abs(delta) < 1e-9) return null;
  const good = invert ? -delta : delta;
  return { label, cls: good > 0 ? 'mdup' : 'mddown', text: `${label} ${fmtAbs(before)}→${fmtAbs(after)}（${fmtDelta(delta)}）` };
}

/**
 * 1つの pa/bunt イベントの指標変化一式（打者/投手/守備）を組み立てつつ、ctx の累積Mapを更新する。
 * 変化した(非ゼロ)行だけを積む（§16 ユーザー要望）。何も変化がなければ null。
 * @param {number} outsBeforeThis この打席が始まる前のアウト数（bunt には outsBefore フィールドが無いため呼び出し側の v.outs スナップショットを渡す）
 * @param {string|null} pitcherId この打席で投げている投手（呼び出し側の v.curPitcherId・atbatで既に更新済み）
 */
function metricDeltaForEvent(e, outsBeforeThis, pitcherId, ctx) {
  const { cfg, beforeGame, gameBat, gamePit, gameFld, u, lastScore } = ctx;
  const lc = u.state && u.state.lc;
  const rows = { batting: [], pitching: [], fielding: [], batterId: e.batterId, pitcherId, fielderId: null };
  // --- 打者 ---
  const bZero = { ab: 0, h: 0, b1: 0, b2: 0, b3: 0, hr: 0, bb: 0, hbp: 0, sf: 0, pa: 0, so: 0, ibb: 0, hardHits: 0, bbEvents: 0 };
  const bg = (beforeGame.get(e.batterId) || {}).batting || bZero;
  const before = {}; const soFarBefore = gameBat.get(e.batterId) || {};
  for (const k of Object.keys(bZero)) before[k] = (bg[k] || 0) + (soFarBefore[k] || 0);
  const bd = watchBattingDelta(e, cfg);
  bumpCounts(gameBat, e.batterId, bd);
  const after = {}; const soFarAfter = gameBat.get(e.batterId) || {};
  for (const k of Object.keys(bZero)) after[k] = (bg[k] || 0) + (soFarAfter[k] || 0);
  const sBefore = watchSlash(before, lc); const sAfter = watchSlash(after, lc);
  for (const [label, key] of [['AVG', 'avg'], ['OBP', 'obp'], ['SLG', 'slg'], ['OPS', 'ops']]) {
    const r = mdRow(label, sBefore[key], sAfter[key], u.fmt3, fmtSigned3, false);
    if (r) rows.batting.push(r);
  }
  const rWraa = mdRow('wRAA', sBefore.wraa, sAfter.wraa, fmt1Abs, fmtSigned1, false);
  if (rWraa) rows.batting.push(rWraa);
  const rWrcPlus = mdRow('wRC+', sBefore.wrcPlus, sAfter.wrcPlus, fmtIntAbs, fmtSignedInt, false);
  if (rWrcPlus) rows.batting.push(rWrcPlus);
  const rHard = mdRow('Hard%', sBefore.hardHitPct, sAfter.hardHitPct, fmtPct1Abs, fmtSignedPct1, false);
  if (rHard) rows.batting.push(rHard);
  // --- 投手（この打席の対戦投手・失点は簡易に自責点扱い＝失策絡みの非自責化までは近似しない） ---
  const runs = watchRunsOnPlay(e, lastScore);
  lastScore.set(e.batTeam, e.batScore);
  if (pitcherId) {
    const pZero = { outs: 0, h: 0, bb: 0, er: 0, so: 0, ibb: 0, hbp: 0, hr: 0, bf: 0, bbFB: 0 };
    const bgP = (beforeGame.get(pitcherId) || {}).pitching || pZero;
    const beforeP = {}; const soFarPBefore = gamePit.get(pitcherId) || {};
    for (const k of Object.keys(pZero)) beforeP[k] = (bgP[k] || 0) + (soFarPBefore[k] || 0);
    const outsAfter = e.outsAfter != null ? e.outsAfter : outsBeforeThis;
    bumpCounts(gamePit, pitcherId, {
      outs: outsAfter - outsBeforeThis, h: bd.h, bb: bd.bb, er: runs,
      so: bd.so, ibb: bd.ibb, hbp: bd.hbp, hr: e.result === 'HR' ? 1 : 0, bf: 1, bbFB: e.battedType === 'FB' ? 1 : 0,
    });
    const afterP = {}; const soFarPAfter = gamePit.get(pitcherId) || {};
    for (const k of Object.keys(pZero)) afterP[k] = (bgP[k] || 0) + (soFarPAfter[k] || 0);
    const lBefore = watchPitchLine(beforeP, lc, cfg); const lAfter = watchPitchLine(afterP, lc, cfg);
    const rEra = mdRow('ERA', lBefore.era, lAfter.era, u.f2, fmtSigned2, true);
    if (rEra) rows.pitching.push(rEra);
    const rWhip = mdRow('WHIP', lBefore.whip, lAfter.whip, u.f2, fmtSigned2, true);
    if (rWhip) rows.pitching.push(rWhip);
    const rXfip = mdRow('xFIP', lBefore.xfip, lAfter.xfip, u.f2, fmtSigned2, true);
    if (rXfip) rows.pitching.push(rXfip);
    const rKwera = mdRow('kwERA', lBefore.kwera, lAfter.kwera, u.f2, fmtSigned2, true);
    if (rKwera) rows.pitching.push(rKwera);
    const rKbb = mdRow('K-BB%', lBefore.kbbPct, lAfter.kbbPct, fmtPct1Abs, fmtSignedPct1, false);
    if (rKbb) rows.pitching.push(rKbb);
  }
  // --- 守備（打球を処理した野手のみ・§16手順1で追加した fielderPos/fielderId） ---
  const fd = watchFieldingDelta(e, cfg);
  if (fd) {
    rows.fielderId = fd.pid;
    const bgF = (beforeGame.get(fd.pid) || {}).fielding || { oaaOuts: 0 };
    const oaaBefore = (bgF.oaaOuts || 0) + ((gameFld.get(fd.pid) || {}).oaaOuts || 0);
    bumpCounts(gameFld, fd.pid, { oaaOuts: fd.oaaDelta });
    const oaaAfter = oaaBefore + fd.oaaDelta;
    const uzrBefore = watchUzrOf(oaaBefore, fd.pos, cfg); const uzrAfter = watchUzrOf(oaaAfter, fd.pos, cfg);
    const rOaa = mdRow('OAA', oaaBefore, oaaAfter, fmt1Abs, fmtSigned1, false);
    if (rOaa) rows.fielding.push(rOaa);
    // ラベルを「UZR概算」とし、チームタブの正式UZR（リーグ平均センタリング済み・fielding.mjs）とは
    // 値が一致しない簡易近似であることを明示する（§16・レビュー指摘対応）。
    const rUzr = mdRow('UZR概算', uzrBefore, uzrAfter, fmt1Abs, fmtSigned1, false);
    if (rUzr) rows.fielding.push(rUzr);
  }
  return rows.batting.length || rows.pitching.length || rows.fielding.length ? rows : null;
}

/** 「▼ 指標の変化」セクション（現在の打席で変化した指標のみ・既定で開いた折りたたみ）。何も無ければ null。 */
function watchMetricDeltaBox(v, u) {
  const { el, pname } = u;
  const md = v.metricDelta;
  if (!md) return null;
  const rowEl = (r) => el('div', { class: 'mdrow ' + r.cls }, r.text);
  const groups = [];
  if (md.batting.length) groups.push(el('div', { class: 'mdgroup' }, [el('span', { class: 'mdname' }, pname(md.batterId)), ...md.batting.map(rowEl)]));
  if (md.pitching.length) groups.push(el('div', { class: 'mdgroup' }, [el('span', { class: 'mdname' }, `投 ${pname(md.pitcherId)}`), ...md.pitching.map(rowEl)]));
  if (md.fielding.length) groups.push(el('div', { class: 'mdgroup' }, [el('span', { class: 'mdname' }, `守 ${pname(md.fielderId)}`), ...md.fielding.map(rowEl)]));
  if (!groups.length) return null;
  return el('details', { class: 'metricdelta', open: '' }, [el('summary', {}, '▼ 指標の変化'), ...groups]);
}

/** 観戦画面本体。u = ui.mjs の共有ヘルパー束（watchDeps()）。 */
export function renderWatchScreen(u) {
  const { el, game, tname } = u;
  const w = game.watch;
  if (!w) { u.renderHub(); return; }
  if (!w.tab) w.tab = 'live'; // watch内サブタブ（'live'=速報/'box'=ボックス/'lineup'=スタメン・UIのみ）
  u.refreshRes(); // 対戦カードのシーズン成績（観測値）を最新化
  // 打席ごとの指標変化（§16）: 「試合開始前」の基準値は観戦開始時に1回だけ計算してキャッシュする。
  if (!w.beforeGame) w.beforeGame = computeBeforeGame(w.events, u.state);
  const v = watchReconstruct(w, u);
  const done = w.idx >= w.events.length;
  const root = document.getElementById('app');
  root.innerHTML = '';
  root.append(el('div', { class: 'header' }, [
    el('h2', {}, ['観戦　', el('span', { class: 'muted' }, `${tname(v.away)} vs ${tname(v.home)}`)]),
    el('div', { class: 'row' }, [
      el('button', { class: 'link', onclick: () => { w.auto = false; game.watch = null; u.renderHub(); } }, 'ホームへ戻る'),
      // G10: タッチ端末では th の title ツールチップが出せない→用語集モーダルへの導線
      el('button', { class: 'link', onclick: () => u.renderGlossary() }, '?'),
    ]),
  ]));
  // G1a: ① コンパクトスコアボード（sticky・常設はこれだけ。▼でラインスコア展開）
  root.append(watchScorebar(v, u, w));
  // G1a: ② 観戦タブ（速報/対戦/ボックス/スタメンの4種・既定=速報）
  root.append(el('div', { class: 'wtabs' }, [['live', '速報'], ['duel', '対戦'], ['box', 'ボックス'], ['lineup', 'スタメン']].map(([k, label]) =>
    el('button', { class: 'wtab' + (w.tab === k ? ' active' : ''), onclick: () => { w.tab = k; renderWatchScreen(u); } }, label))));
  // G1a: ③ タブ本体（そのタブの内容だけ）
  if (w.tab === 'box') watchBoxTab(root, u, w);
  else if (w.tab === 'lineup') watchLineupTab(root, v, u);
  else if (w.tab === 'duel') {
    // 対戦タブ: 盤面（走者名付き）→ 対戦カード → 打球フィールド図（F3）
    root.append(el('div', { class: 'dueltab' }, [watchDiamond(v, u), watchMatchup(v, u), watchFieldChart(v, u)]));
  } else {
    // 速報タブ（既定）: 現在の打席（打者/投手名込み・球列・結果・指標変化）→ 実況フィード
    root.append(watchCurrentAb(v, u));
    watchFeedTab(root, v, u, w);
  }
  // G1a: ④ 進行バー（下部固定・全幅・1行。ボタン文言は既存のまま＝§0ルール8）
  root.append(watchControls(v, u, done));
  // 自動再生（UIのみ・状態不変）: タイマーは再生位置(idx)を1単位進めて再描画するだけ。
  if (!done && w.auto) {
    setTimeout(() => {
      const cw = game.watch;
      if (!cw || cw !== w || !cw.auto || cw.idx >= cw.events.length) return;
      cw.justAdvanced = true;
      cw.idx = watchAdvanceIdx(cw, cw.unit || 'pitch');
      renderWatchScreen(u);
    }, 700);
  }
  root.append(el('div', { class: 'watchspacer' })); // 固定下部バーの下敷き（本文がバーに隠れないための余白）
  w.justAdvanced = false;
}

/** 再生位置を1単位進めた idx を返す（unit='pitch'|'pa'|'inning'）。 */
function watchAdvanceIdx(w, unit) {
  const ev = w.events;
  let i = w.idx;
  if (unit === 'pa') {
    // 次の打席結果（pa/bunt）まで消化
    while (i < ev.length) { const t = ev[i].type; i++; if (t === 'pa' || t === 'bunt' || t === 'end') break; }
    return i;
  }
  if (unit === 'inning') {
    // これから消化するハーフ＝idx 以降で最初にイニング情報（inning+half）を持つイベントのハーフ
    // （打席の途中なら現ハーフ・ハーフ境界なら次ハーフ）。そのハーフの残り全部を消化する。
    let curI = null; let curH = null;
    for (let j = i; j < ev.length; j++) {
      const e = ev[j];
      if (e.inning != null && e.half != null) { curI = e.inning; curH = e.half; break; }
    }
    while (i < ev.length) {
      const e = ev[i];
      if (curI != null && e.type === 'atbat' && (e.inning !== curI || e.half !== curH)) break;
      i++;
      if (e.type === 'end') break;
    }
    return i;
  }
  // '1球': 1イベントずつ（start はスキップ＝最初のクリックで即打者/一球が見える）
  while (i < ev.length) { const t = ev[i].type; i++; if (t !== 'start') break; }
  return i;
}

/**
 * events[0..idx) を再生して観戦ビューを組む（純関数・ゲーム状態を読まない）。
 * 返り値: スコア/R/H/E・イニング/ハーフ/アウト・塁上走者(playerId)・B-Sカウント・
 * 現在の打者/投手・両軍スタメン（交代反映）・当日成績・実況行・ベンチ/ブルペン残量。
 */
function watchReconstruct(w, u) {
  const { events, idx } = w;
  const { tname } = u;
  // 打席ごとの指標変化（§16）: 現在の再生位置までの当日累積を beforeGame に足し込みながら進む
  // （dailyOf と同じ「毎レンダー1パス再生」に相乗り＝過去の打席ぶんを個別に再計算しない）。
  const mdCtx = {
    cfg: u.state.cfg, beforeGame: w.beforeGame || new Map(),
    gameBat: new Map(), gamePit: new Map(), gameFld: new Map(),
    lastScore: new Map(), u,
  };
  const v = {
    home: null, away: null,
    scoreH: 0, scoreA: 0, hitsH: 0, hitsA: 0, errH: 0, errA: 0,
    inning: 1, half: 'top', outs: 0, basesPids: [null, null, null],
    balls: 0, strikes: 0, lastCall: null,
    batterId: null, curPitcherId: null, curPitchCount: 0,
    pitcher: { home: null, away: null },
    lineups: { home: [], away: [] },
    bull: { home: 0, away: 0 }, bullMax: { home: 0, away: 0 },
    bench: { home: 0, away: 0 }, benchMax: { home: 0, away: 0 },
    daily: new Map(), // batterId → {ab, h, res:[]}（当日成績）
    abIndex: 0, // 何打席目か（コース図の決定論ハッシュ座標のキー・atbatごとに+1）
    curAb: null, // 現在の打席 { abIdx, batterId, pitcherId, pitches:[{n,call,band,text}], result:{cls,parts}|null }
    lastPA: null, // 直近の 'pa' イベント（打球フィールド図用）: { bb, result, resultText, cls }|null
    metricDelta: null, // 直近の打席の指標変化（§16・「▼ 指標の変化」用）: {batting,pitching,fielding,...}|null
    line: [], // [{inning, top, bottom}] イニング別得点
    halfStarted: new Set(), // '3/top' 等（ラインスコアの 0 と空欄の区別）
    lines: [], // 実況行 [{text|parts, cls, kind}]
    ended: false, endInnings: 9,
  };
  const sideOf = (teamId) => (teamId === v.home ? 'home' : 'away');
  const dailyOf = (pid) => {
    let d = v.daily.get(pid);
    if (!d) { d = { ab: 0, h: 0, res: [] }; v.daily.set(pid, d); }
    return d;
  };
  const ensureLine = (inning) => {
    let c = v.line.find((x) => x.inning === inning);
    if (!c) { c = { inning, top: 0, bottom: 0 }; v.line.push(c); }
    return c;
  };
  const setScores = (e) => {
    if (e.batTeam === v.home) { v.scoreH = e.batScore; v.scoreA = e.fldScore; }
    else { v.scoreA = e.batScore; v.scoreH = e.fldScore; }
  };
  let lastHalfKey = '';
  for (let i = 0; i < idx && i < events.length; i++) {
    const e = events[i];
    if (e.type === 'start') {
      v.home = e.home; v.away = e.away;
      v.pitcher.home = e.homeStarter; v.pitcher.away = e.awayStarter;
      v.curPitcherId = e.homeStarter; // 1回表はホームが守備
      v.lineups.home = e.homeLineup.map((s) => ({ playerId: s.playerId, pos: s.pos }));
      v.lineups.away = e.awayLineup.map((s) => ({ playerId: s.playerId, pos: s.pos }));
      v.bull.home = v.bullMax.home = e.homeBullpen.length;
      v.bull.away = v.bullMax.away = e.awayBullpen.length;
      v.bench.home = v.benchMax.home = e.homeBench.length;
      v.bench.away = v.benchMax.away = e.awayBench.length;
      v.lines.push({ kind: 'start', cls: 'ev-start', text: `プレイボール: ${tname(e.away)}（先攻） vs ${tname(e.home)}（後攻）` });
      v.lines.push({ kind: 'start', cls: 'ev-start', parts: ['先発: ', u.playerLink(e.awayStarter), `（${tname(e.away)}） − `, u.playerLink(e.homeStarter), `（${tname(e.home)}）`] });
    } else if (e.type === 'atbat') {
      v.inning = e.inning; v.half = e.half; v.outs = e.outs;
      v.basesPids = e.basesPids.slice();
      v.balls = 0; v.strikes = 0; v.lastCall = null;
      v.batterId = e.batterId; v.curPitcherId = e.pitcherId; v.curPitchCount = e.pitcherPitches;
      setScores(e);
      ensureLine(e.inning);
      v.halfStarted.add(`${e.inning}/${e.half}`);
      const hk = `${e.inning}/${e.half}`;
      if (hk !== lastHalfKey) {
        lastHalfKey = hk;
        v.lines.push({ kind: 'inning', cls: 'ev-start', text: `━ ${e.inning}回${e.half === 'bottom' ? '裏' : '表'} ${tname(e.batTeam)}の攻撃 ━` });
      }
      const d = dailyOf(e.batterId);
      v.abIndex++;
      v.curAb = { abIdx: v.abIndex, batterId: e.batterId, pitcherId: e.pitcherId, pitches: [], result: null };
      v.lines.push({ kind: 'ab', cls: 'ev-ab', parts: ['◇ ', u.playerLink(e.batterId), `（今日 ${d.ab}打数${d.h}安打）`, ' 対 ', u.playerLink(e.pitcherId), `（${e.pitcherPitches}球）`] });
    } else if (e.type === 'pitch') {
      v.balls = e.balls; v.strikes = e.strikes; v.lastCall = e.call;
      v.curPitchCount++;
      // 全投球にカウント(B-S)を統一表記（最終球も省略しない）
      const wild = e.wild ? '　→ 捕手が後逸！走者進塁' : '';
      const ptxt = `${e.n}球目 ${WATCH_PITCH_JP[e.pitchType] || e.pitchType} ${WATCH_CALL_JP[e.call] || e.call} ${e.balls}-${e.strikes}${wild}`;
      if (v.curAb) v.curAb.pitches.push({ n: e.n, call: e.call, band: e.band, type: e.pitchType, text: ptxt });
      // 一球行にも統一色（コース図ドット/現打席リストと同じ pc-* クラス）
      v.lines.push({ kind: 'pitch', cls: 'ev-pitch ' + watchCallCls(e.call), text: '　' + ptxt });
    } else if (e.type === 'pa') {
      const outsBeforeThis = v.outs; // 指標変化(§16)用スナップショット（e.outsBeforeと一致するはず）
      v.inning = e.inning; v.half = e.half; v.outs = e.outsAfter;
      if (e.basesPids) v.basesPids = e.basesPids.slice();
      setScores(e);
      if (e.runsOnPlay) ensureLine(e.inning)[e.half === 'bottom' ? 'bottom' : 'top'] += e.runsOnPlay;
      if (WATCH_HITS.has(e.result)) v[e.batTeam === v.home ? 'hitsH' : 'hitsA']++;
      if (e.result === 'E') v[e.batTeam === v.home ? 'errA' : 'errH']++; // 失策は守備側に計上
      const d = dailyOf(e.batterId);
      const sacFly = e.sacFly === true; // エンジンのctx.sacFlyを唯一の真実とする（realism_r1 §F-2）
      if (!(e.outcome === 'BB' || e.outcome === 'HBP' || sacFly)) d.ab++;
      if (WATCH_HITS.has(e.result)) d.h++;
      d.res.push(watchResShort(e));
      // 実況（畳み表示の1行）: [N回表/裏] 打者: 結果（＋得点行は現在スコア付記）
      const r = watchPaBody(e, v.lastCall);
      const pts = e.runsOnPlay && e.result !== 'HR' ? `（${e.runsOnPlay}点）` : '';
      const cls = (r.cls + (e.runsOnPlay > 0 ? ' ev-score' : '')).trim();
      const tail = `: ${r.body}${pts}${e.runsOnPlay > 0 ? watchScoreTxt(v, tname) : ''}`;
      v.lines.push({ kind: 'pa', cls, parts: [`[${e.inning}回${watchHalfJP(e.half)}] `, u.playerLink(e.batterId), tail] });
      if (v.curAb) v.curAb.result = { cls, parts: [u.playerLink(e.batterId), tail] };
      v.lastPA = { bb: e.bb || null, result: e.result, resultText: r.body, cls: r.cls };
      v.metricDelta = metricDeltaForEvent(e, outsBeforeThis, v.curPitcherId, mdCtx);
      v.balls = 0; v.strikes = 0;
    } else if (e.type === 'bunt') {
      const outsBeforeThis = v.outs; // 指標変化(§16)用スナップショット（bunt にはoutsBeforeフィールドが無い）
      const beforeBat = e.batTeam === v.home ? v.scoreH : v.scoreA;
      v.inning = e.inning; v.half = e.half; v.outs = e.outsAfter;
      v.basesPids = e.basesPids.slice();
      setScores(e);
      const runs = (e.batTeam === v.home ? v.scoreH : v.scoreA) - beforeBat; // スクイズ等の得点
      const d = dailyOf(e.batterId);
      let txt; let cls;
      if (e.outcome === 'success') { d.res.push('犠打'); txt = '送りバント成功'; cls = ''; }
      else if (e.outcome === 'hit') {
        d.ab++; d.h++; d.res.push('バント安打');
        v[e.batTeam === v.home ? 'hitsH' : 'hitsA']++;
        txt = 'セーフティバントが内野安打に！'; cls = 'ev-hit';
      } else { d.ab++; d.res.push('バント失敗'); txt = 'バント失敗（先行走者が封殺）'; cls = ''; }
      if (runs > 0) cls = (cls + ' ev-score').trim();
      const tail = `: ${txt}${runs > 0 ? `（${runs}点）${watchScoreTxt(v, tname)}` : ''}`;
      v.lines.push({ kind: 'pa', cls, parts: [`[${e.inning}回${watchHalfJP(e.half)}] `, u.playerLink(e.batterId), tail] });
      if (v.curAb) v.curAb.result = { cls, parts: [u.playerLink(e.batterId), tail] };
      v.metricDelta = metricDeltaForEvent(e, outsBeforeThis, v.curPitcherId, mdCtx);
      v.balls = 0; v.strikes = 0;
    } else if (e.type === 'steal') {
      if (e.basesPids) v.basesPids = e.basesPids.slice();
      if (e.outsAfter != null) v.outs = e.outsAfter;
      const inn = e.inning != null ? e.inning : v.inning;
      const hf = e.half || v.half;
      v.lines.push({ kind: 'steal', cls: e.success ? 'ev-run' : 'ev-err', parts: [`[${inn}回${watchHalfJP(hf)}] `, u.playerLink(e.runnerId), e.success ? ': 盗塁成功！（二塁へ）' : ': 盗塁失敗（盗塁死）'] });
    } else if (e.type === 'sub') {
      const side = sideOf(e.team);
      const lu = v.lineups[side];
      const slot = lu.find((s) => s.playerId === e.outPid);
      if (slot) slot.playerId = e.inPid;
      if (e.kind === 'RP') {
        v.bull[side] = Math.max(0, v.bull[side] - 1);
        v.pitcher[side] = e.inPid;
        // 継投は常に「守備側（これから守る側を含む）」で起きる＝現在投手を無条件に更新してよい
        // （回頭の交代は次の atbat より先に発火し v.half が旧ハーフのままのため、half からの守備側判定は不可）。
        v.curPitcherId = e.inPid; v.curPitchCount = 0;
        v.lines.push({ kind: 'sub', cls: 'ev-sub', parts: [`　[${tname(e.team)}] 投手交代 → `, u.playerLink(e.inPid)] });
      } else {
        v.bench[side] = Math.max(0, v.bench[side] - 1);
        if (e.kind === 'PH') v.lines.push({ kind: 'sub', cls: 'ev-sub', parts: [`　[${tname(e.team)}] 代打 `, u.playerLink(e.inPid), `（← ${u.pname(e.outPid)}）`] });
        else if (e.kind === 'PR') {
          if (e.basesPids) v.basesPids = e.basesPids.slice();
          v.lines.push({ kind: 'sub', cls: 'ev-sub', parts: [`　[${tname(e.team)}] 代走 `, u.playerLink(e.inPid), `（← ${u.pname(e.outPid)}）`] });
        } else v.lines.push({ kind: 'sub', cls: 'ev-sub', parts: [`　[${tname(e.team)}] 守備固め `, u.playerLink(e.inPid), `（${u.posJP(e.pos || '')}・← ${u.pname(e.outPid)}）`] });
      }
    } else if (e.type === 'end') {
      v.scoreH = e.homeScore; v.scoreA = e.awayScore;
      v.ended = true; v.endInnings = e.innings;
      v.lines.push({ kind: 'end', cls: 'ev-start', text: `試合終了: ${tname(v.home)} ${e.homeScore} - ${e.awayScore} ${tname(v.away)}${e.innings > 9 ? `（延長${e.innings}回）` : ''}` });
    }
  }
  return v;
}

/** 当日成績の略記（左安/中飛/三振/四球…）。スタメン表・対戦カードの「今日」列用。 */
export function watchResShort(e) {
  if (e.outcome === 'K') return '三振';
  if (e.outcome === 'BB') return e.isIBB ? '敬遠' : '四球';
  if (e.outcome === 'HBP') return '死球';
  const d = e.bb ? watchDirChar(e.bb.sprayDeg) : '';
  if (e.result === '1B') return d + '安';
  if (e.result === '2B') return d + '2';
  if (e.result === '3B') return d + '3';
  if (e.result === 'HR') return d + '本';
  if (e.result === 'E') return d + '失';
  if (e.sacFly) return '犠飛';
  if (e.fc) return '野選'; // フィールダースチョイス（打者は出塁・realism_r1 §A）
  // アウトになった打球は責任野手(fielderPos)で略記する（三ゴ・一飛・中直…）
  const f = watchFielderChar(e);
  if (e.battedType === 'GB') return f + 'ゴ';
  if (e.battedType === 'LD') return f + '直';
  return f + '飛';
}

/**
 * 打席結果の言語化＋色分けクラス（スポナビ風・「レフトへのタイムリーツーベース！」等）。
 * cls: 安打=ev-hit / 本塁打=ev-hr / 三振=ev-k / 四死球=ev-bb / 失策=ev-err / 凡退=''。
 * 得点(ev-score)は呼び出し側で runsOnPlay から付与する。
 */
export function watchPaBody(e, lastCall) {
  const dir = e.bb ? watchDirName(e.bb.sprayDeg) : '';
  if (e.outcome === 'K') return { cls: 'ev-k', body: lastCall === 'called' ? '見逃し三振' : '空振り三振' };
  if (e.outcome === 'BB') return { cls: 'ev-bb', body: e.isIBB ? '申告敬遠で歩かされる' : '四球を選んで出塁' };
  if (e.outcome === 'HBP') return { cls: 'ev-bb', body: '死球' };
  if (e.result === 'E') return { cls: 'ev-err', body: `${watchFielderName(e) || dir}のエラーで出塁` };
  if (e.result === 'HR') {
    const n = e.runsOnPlay;
    return { cls: 'ev-hr', body: `${dir}スタンドへ${n >= 2 ? `の${n}ラン` : 'ソロ'}ホームラン！！${e.bb ? `（EV${Math.round(e.bb.evKmh)}km/h 飛距離${Math.round(e.bb.distanceM)}m）` : ''}` };
  }
  if (e.result === '3B') return { cls: 'ev-hit', body: `${dir}への${e.runsOnPlay ? 'タイムリー' : ''}スリーベース！` };
  if (e.result === '2B') return { cls: 'ev-hit', body: `${dir}への${e.runsOnPlay ? 'タイムリー' : ''}ツーベース！` };
  if (e.result === '1B') return { cls: 'ev-hit', body: `${dir}前へ${e.runsOnPlay ? 'タイムリーヒット！' : 'ヒット'}` };
  if (!e.battedType) return { cls: '', body: '凡退' };
  const dp = e.outsAfter - e.outsBefore >= 2;
  const sf = e.sacFly === true; // エンジンのctx.sacFlyを唯一の真実とする（realism_r1 §F-2）
  // アウトになった打球は責任野手(fielderPos)で言語化する（ショートゴロ／ファーストフライ等）
  const spot = watchFielderName(e) || '内野';
  const body = sf ? `${spot}へ犠牲フライ`
    : dp ? `${spot}ゴロで併殺（ダブルプレー）`
    : e.fc ? `${spot}への内野ゴロ、フィールダースチョイスで一塁に生きる`
    : `${spot}${WATCH_BATTED_JP[e.battedType] || '打球'}でアウト`;
  return { cls: e.fc ? 'ev-hit' : '', body };
}

/**
 * 「現在の打席」ボックス（G1a: 速報タブ先頭）: 現打席の投球を1球目→N球目の正順で表示。
 * 打席が決着したら結果を大きく表示（次の打席開始で更新）。先頭に打者/投手名の1行(.curabvs)を持つ。
 */
function watchCurrentAb(v, u) {
  const { el, state, playerLink } = u;
  const box = el('div', { class: 'curab' });
  box.append(el('div', { class: 'curabhead' }, v.ended ? '最終打席' : '現在の打席'));
  // G1a手順5: 速報タブ既定表示で「誰が打っているか」が分かるよう、打者/投手名を1行追加する
  // （watchMatchup と同じデータソース・利き腕表記は watchBatsJP を再利用）。試合開始前は省略。
  if (v.batterId) {
    const bp = state.byId.get(v.batterId);
    const pp = v.curPitcherId ? state.byId.get(v.curPitcherId) : null;
    const d = v.daily.get(v.batterId);
    const todayTxt = d ? `今日${d.ab}打数${d.h}安打` : '今日第1打席';
    box.append(el('div', { class: 'curabvs' }, [
      '打者 ', playerLink(v.batterId), bp ? `（${watchBatsJP(bp, pp)}・${todayTxt}）　` : '　',
      '投手 ', playerLink(v.curPitcherId), `（球数${v.curPitchCount || 0}）`,
    ]));
  }
  const ab = v.curAb;
  if (!ab) { box.append(el('div', { class: 'muted' }, '— 試合開始前 —')); return box; }
  if (!ab.pitches.length && !ab.result) box.append(el('div', { class: 'curabpitch muted' }, '打席開始（第1球を待つ）'));
  // 一球行はコース図ドット/実況一球行と同じ判定色（pc-*）で統一
  for (const p of ab.pitches) box.append(el('div', { class: 'curabpitch ' + watchCallCls(p.call) }, p.text));
  if (ab.result) {
    box.append(el('div', { class: 'curabresult ' + (ab.result.cls || '') + (u.game.watch.justAdvanced ? ' fx' : '') }, ab.result.parts));
    // §16 ユーザー要望: 打席決着で変化した指標を結果直下にぶら下げ表示（既定で開いた折りたたみ）。
    const mdBox = watchMetricDeltaBox(v, u);
    if (mdBox) box.append(mdBox);
  }
  return box;
}

/** 打球結果の着弾マーカー色（ui.mjs sprayChart の ballColor と同じ配色: HR=金/長打=青/単打=白/アウト=灰）。 */
function watchBallColor(res) {
  return res === 'HR' ? '#e8b84b' : res === '2B' || res === '3B' ? '#5aa9e6' : res === '1B' ? '#f4f1e6' : '#6d7f74';
}

/**
 * F3: 「打球フィールド図」カラム（対戦パネルの右側・実データ1件・静的画像・スポナビ風）。
 * 直近の 'pa' イベント（v.lastPA・watchReconstruct が再生済みイベントから記録）の打球データを
 * 1件だけ描画する。sprayChart（ui.mjs）と同じ座標変換（ファウルライン±45°・内野目安円・本塁）を
 * 流用し、着弾点は1つの大きめマーカー、本塁からの軌跡は laDeg 帯で弧の高さを変えて視覚的に区別する
 * （物理シミュレーションではなく見た目の区別のみ）。打球のない打席（三振/四球等）は図の枠自体を描画せず
 * （G1b）、結果テキスト（打席前は「まだ打球なし」）のみを表示する。
 */
function watchFieldChart(v, u) {
  const { el, svgEl } = u;
  const col = el('div', { class: 'duelcol fieldcol' });
  col.append(el('div', { class: 'duelhead' }, '打球'));
  const p = v.lastPA;
  const W = 240; const H = 220; const hx = W / 2; const hy = H - 20; const scale = (H - 36) / 135;
  const pt = (deg, dist) => {
    const r = (deg * Math.PI) / 180;
    return [hx + dist * scale * Math.sin(r), hy - dist * scale * Math.cos(r)];
  };
  const hasBb = !!(p && p.bb);
  if (hasBb) {
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'fieldchart' });
    const [lx, ly] = pt(-45, 125); const [rx, ry] = pt(45, 125);
    svg.append(svgEl('path', { d: `M ${hx} ${hy} L ${lx} ${ly} A ${125 * scale} ${125 * scale} 0 0 1 ${rx} ${ry} Z`, fill: '#123d2a', stroke: '#2f6b4a' }));
    const [b2x, b2y] = pt(0, 38);
    svg.append(svgEl('circle', { cx: b2x, cy: b2y, r: 3, fill: '#c9a06a' }));
    svg.append(svgEl('circle', { cx: hx, cy: hy, r: 3, fill: '#fff' }));
    const bb = p.bb;
    const cfg = u.state && u.state.cfg;
    const barrel = !!(cfg && isBarrel(bb.evKmh, bb.laDeg, cfg.tuning.metrics));
    const [ex, ey] = pt(bb.sprayDeg, Math.min(bb.distanceM, 130));
    // 軌跡: laDeg帯で弧の高さを変える（<10=ゴロ気味の直線／10-25=浅い弧／25+=山なり）
    const arcH = bb.laDeg < 10 ? 4 : bb.laDeg < 25 ? 20 : 46;
    const ctrlX = (hx + ex) / 2; const ctrlY = (hy + ey) / 2 - arcH;
    svg.append(svgEl('path', {
      d: `M ${hx} ${hy} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`,
      class: 'fieldtraj', fill: 'none', stroke: '#e9e4d0', 'stroke-width': '1.6', 'stroke-dasharray': '4 3', opacity: 0.9,
    }));
    // バレル（Statcast近似判定）は着弾マーカーの縁取りをオレンジ太枠にして結果色と独立に強調表示する。
    svg.append(svgEl('circle', {
      cx: ex.toFixed(1), cy: ey.toFixed(1), r: p.result === 'HR' ? 6.5 : 5.5, class: 'fieldmark' + (barrel ? ' barrel' : ''),
      fill: watchBallColor(p.result), stroke: barrel ? '#ff9d3d' : '#0c3122', 'stroke-width': barrel ? '2.5' : '1.5',
    }));
    col.append(svg);
    col.append(el('div', { class: 'fieldlabel ' + (p.cls || '') }, p.resultText));
    col.append(el('div', { class: 'fieldsub muted' },
      `EV${Math.round(bb.evKmh)}km/h ${Math.round(bb.distanceM)}m 角度${Math.round(bb.laDeg)}°${barrel ? '・バレル' : ''}`));
  } else if (!p) {
    col.append(el('div', { class: 'fieldlabel muted' }, 'まだ打球なし'));
  } else {
    col.append(el('div', { class: 'fieldlabel ' + (p.cls || '') }, p.resultText));
  }
  return col;
}

// ============================================================================
// E2ゾーニング改: 「今の状況」パネル／サブタブ本体
// ============================================================================

/** 一球判定 → 統一色クラス（ボール=白/見逃しS=緑/空振り=赤/ファウル=黄/インプレー=青）。 */
function watchCallCls(call) {
  if (call === 'called') return 'pc-called';
  if (call === 'whiff') return 'pc-whiff';
  if (call === 'foul') return 'pc-foul';
  if (call === 'inplay') return 'pc-inplay';
  return 'pc-ball'; // ball / hbp
}

/**
 * G1a: B-S-Oランプ1行（旧 watchNowPanel 内のローカル関数をモジュールレベルへ切り出し）。
 * watchScorebar（新）から使う。watchNowPanel は G1a で削除済み。
 */
function lampRow(label, n, max, cls, u) {
  const { el } = u;
  return el('div', { class: 'bsorow' }, [
    el('span', { class: 'bsolabel' }, label),
    ...Array.from({ length: max }, (_, i) => el('span', { class: 'lamp ' + cls + (i < n ? ' on' : '') }, '')),
  ]);
}

/**
 * G1a: コンパクトスコアボード（旧 watchNowPanel の置き換え・常設はこれだけ）。
 * [チーム名 得点] [回表裏/B-S-O/塁表示] [チーム名 得点] [▼展開]。
 * B-S-Oランプ・塁表示は v.ended のとき描画しない（残留点灯/残留表示バグの根治）。
 * ▼ボタンで w.lineOpen をトグル（既定false）し、直下にラインスコアを展開する。
 */
function watchScorebar(v, u, w) {
  const { el, game, tname, tabbr, teamColor } = u;
  const my = game.gs.playerTeamId;
  const sbTeam = (tid, score, side) => el('div', {
    class: 'sbteam ' + side + (tid === my ? ' nowmy' : ''),
    style: tid ? `--team-accent:${teamColor(tid)}` : '',
  }, [
    el('span', { class: 'sbname' }, tid ? tabbr(tid) : '—'),
    el('span', { class: 'sbscore' }, String(score)),
  ]);
  const midKids = [
    el('div', { class: 'sbinning' }, v.ended
      ? '試合終了' + (v.endInnings > 9 ? `　延長${v.endInnings}回` : '')
      : `${v.inning}回${watchHalfJP(v.half)}`),
  ];
  if (!v.ended) {
    midKids.push(el('div', { class: 'sbbso bso' }, [
      lampRow('B', Math.min(v.balls, 3), 3, 'lb', u),
      lampRow('S', Math.min(v.strikes, 2), 2, 'ls', u),
      lampRow('O', Math.min(v.outs, 2), 2, 'lo', u),
    ]));
    midKids.push(el('div', { class: 'sbbases' }, [
      el('span', { class: 'sbbase b3' + (v.basesPids[2] ? ' on' : '') }, ''),
      el('span', { class: 'sbbase b2' + (v.basesPids[1] ? ' on' : '') }, ''),
      el('span', { class: 'sbbase b1' + (v.basesPids[0] ? ' on' : '') }, ''),
    ]));
  }
  const bar = el('div', { class: 'scorebar' }, [
    sbTeam(v.away, v.scoreA, 'away'),
    el('div', { class: 'sbmid' }, midKids),
    sbTeam(v.home, v.scoreH, 'home'),
    el('button', { class: 'sbexpand link', onclick: () => { w.lineOpen = !w.lineOpen; renderWatchScreen(u); } }, '▼'),
  ]);
  // G1a修正: このラップdivがブロックボックスを生成すると、.scorebarのposition:stickyの
  // 効く範囲（containing block=このwrap自身の高さ）がbar本体とほぼ同じ高さになり、
  // 実質1pxもスクロール位置に貼り付かなくなる（sticky不具合）。display:contentsで
  // ボックス生成を止め、barを親(root)の直接の子であるかのように扱わせることで、
  // .wtabs（rootへ直接append）と同じ土俵でstickyが機能するようにする。
  const wrap = el('div', { class: 'scorebarwrap' }, [bar]);
  if (w.lineOpen) wrap.append(el('div', { class: 'sblinescore' }, [watchLineScore(v, u)]));
  return wrap;
}

/** サブタブ「速報」: 実況フィード（新しい順・既定は打席結果のみ・全球表示トグル）。 */
function watchFeedTab(root, v, u, w) {
  const { el, pname, tname } = u;
  let lines = w.allPitches ? v.lines : v.lines.filter((ln) => ln.kind !== 'pitch' && ln.kind !== 'ab');
  lines = lines.slice(-160).reverse();
  // G1a手順8: 珍記録（notables）は watchControls から移設し、試合終了時に速報フィードの先頭へ足す。
  // クラスは 'newsrow good' の金枠スタイルを流用して祝祭感を保つ（.pbpline 単体では枠が無いため必ず併記）。
  if (v.ended) {
    const { notables } = detectGameNotables(w.events);
    const notableLines = [];
    for (const n of notables) {
      const head = notableHeadline(n, (id) => pname(id), (id) => tname(id));
      if (head) notableLines.push({ cls: 'newsrow good notable' + (w.justAdvanced ? ' fx' : ''), text: `🎉 ${head}` });
    }
    lines = [...notableLines, ...lines];
  }
  root.append(el('div', { class: 'pbphead' }, [
    el('span', { class: 'muted' }, '実況（新しい順）'),
    el('button', { class: 'link', onclick: () => { w.allPitches = !w.allPitches; renderWatchScreen(u); } }, `${w.allPitches ? '☑' : '☐'} 全球表示`),
  ]));
  root.append(el('div', { class: 'pbp' }, lines.map((ln) => el('div', { class: 'pbpline ' + (ln.cls || '') }, ln.parts || ln.text))));
}

/**
 * サブタブ「ボックス」: ここまでの両軍打者/投手の当日ライン（E4簡易ボックススコアの列構成を流用）。
 * 再生位置(idx)までのイベント列から buildBoxScore（純関数・§17準拠）で都度再構築＝状態を変えない。
 */
function watchBoxTab(root, u, w) {
  const { el, tname } = u;
  const box = buildBoxScore(w.events.slice(0, Math.min(w.idx, w.events.length)));
  if (!box.home) { root.append(el('div', { class: 'muted' }, '— 試合開始前 —')); return; }
  for (const side of ['away', 'home']) {
    const teamId = side === 'home' ? box.home : box.away;
    root.append(el('h3', { class: 'leaguename' }, `${tname(teamId)}　打撃`));
    root.append(watchBoxBatTable(box.batters[side], u));
    root.append(el('h3', { class: 'leaguename' }, `${tname(teamId)}　投手`));
    root.append(watchBoxPitTable(box.pitchers[side], u));
  }
  root.append(el('div', { class: 'muted', style: 'margin-top:6px' },
    'ここまでの当日集計（簡易・失点は在板中の得点を現投手へ帰属する近似）。選手名クリックで詳細。'));
}

/** ボックス: 打者の当日ライン表（E4と同じ列: 打順/守/選手/打数/安打/本/打点/四死球/三振）。 */
function watchBoxBatTable(batters, u) {
  const { el, td, playerLink, posJP } = u;
  const list = batters.slice().sort((a, b) => (a.ord ?? 99) - (b.ord ?? 99));
  const trs = list.map((bt) => el('tr', {}, [
    td(bt.ord ?? '-'),
    td(bt.pos === '打' || bt.pos === '走' || bt.pos === '守' ? bt.pos : posJP(bt.pos || '-'), 'left'),
    el('td', { class: 'left' }, [playerLink(bt.pid)]),
    td(bt.ab), td(bt.h), td(bt.hr), td(bt.rbi), td(bt.bb), td(bt.k),
  ]));
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [
    el('thead', {}, el('tr', {}, [
      el('th', {}, '打順'), el('th', { class: 'left' }, '守'), el('th', { class: 'left' }, '選手'),
      el('th', {}, '打数'), el('th', {}, '安打'), el('th', {}, '本'), el('th', {}, '打点'), el('th', {}, '四死球'), el('th', {}, '三振'),
    ])),
    el('tbody', {}, trs),
  ])]);
}

/** ボックス: 投手の当日ライン表（E4と同じ列: 選手/回/球数/被安/失点/四死球/奪三振）。 */
function watchBoxPitTable(pitchers, u) {
  const { el, td, playerLink } = u;
  const trs = pitchers.map((pt) => el('tr', {}, [
    el('td', { class: 'left' }, [playerLink(pt.pid)]),
    td(`${Math.floor(pt.outs / 3)}.${pt.outs % 3}`), td(pt.np), td(pt.h), td(pt.r), td(pt.bb), td(pt.k),
  ]));
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { class: 'left' }, '選手'), el('th', {}, '回'), el('th', {}, '球数'),
      el('th', {}, '被安'), el('th', {}, '失点'), el('th', {}, '四死球'), el('th', {}, '奪三振'),
    ])),
    el('tbody', {}, trs),
  ])]);
}

/** 上部ラインスコア（イニング別得点＋R/H/E）。 */
function watchLineScore(v, u) {
  const { el, td, tname, game } = u;
  const innMax = Math.max(9, v.line.reduce((a, x) => Math.max(a, x.inning), 0), v.inning);
  const head = el('tr', {}, [
    el('th', { class: 'left' }, ''),
    ...Array.from({ length: innMax }, (_, i) => el('th', {}, String(i + 1))),
    el('th', { class: 'rcol' }, 'R'), el('th', {}, 'H'), el('th', {}, 'E'),
  ]);
  const cell = (isHome, inn) => {
    if (!v.halfStarted.has(`${inn + 1}/${isHome ? 'bottom' : 'top'}`)) {
      // ホームがサヨナラ勝ち等で裏の攻撃なし → X 表記（未来回は空欄）
      return v.ended && isHome && inn + 1 === v.endInnings ? 'X' : '';
    }
    const c = v.line.find((x) => x.inning === inn + 1);
    return String(c ? (isHome ? c.bottom : c.top) : 0);
  };
  const rowFor = (teamId, isHome, total, hits, errs) => el('tr', { class: teamId === game.gs.playerTeamId ? 'myteam' : '' }, [
    el('td', { class: 'left' }, tname(teamId)),
    ...Array.from({ length: innMax }, (_, i) => td(cell(isHome, i))),
    el('td', { class: 'rcol' }, String(total)), td(hits), td(errs),
  ]);
  return el('div', { class: 'tablewrap' }, [el('table', { class: 'stat scoreboard' }, [
    el('thead', {}, head),
    el('tbody', {}, [rowFor(v.away, false, v.scoreA, v.hitsA, v.errA), rowFor(v.home, true, v.scoreH, v.hitsH, v.errH)]),
  ])]);
}

/** フィールド盤面（SVG・塁上走者名＋アウトカウント）。 */
function watchDiamond(v, u) {
  const { svgEl, svgText, pname } = u;
  const W = 250; const H = 200;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'diamond' });
  const cx = W / 2; const cy = 140; const s = 44;
  const home = [cx, cy]; const first = [cx + s, cy - s]; const second = [cx, cy - 2 * s]; const third = [cx - s, cy - s];
  svg.append(svgEl('polygon', { points: `${home} ${first} ${second} ${third}`, fill: '#123d2a', stroke: '#2f6b4a' }));
  const baseAt = (pt, occ) => svgEl('rect', { x: pt[0] - 8, y: pt[1] - 8, width: 16, height: 16, transform: `rotate(45 ${pt[0]} ${pt[1]})`, fill: occ ? '#e8b84b' : '#0c3122', stroke: '#c9a06a' });
  svg.append(baseAt(first, v.basesPids[0]));
  svg.append(baseAt(second, v.basesPids[1]));
  svg.append(baseAt(third, v.basesPids[2]));
  svg.append(svgEl('rect', { x: home[0] - 7, y: home[1] - 7, width: 14, height: 14, transform: `rotate(45 ${home[0]} ${home[1]})`, fill: '#f4f1e6' }));
  // 塁上走者名（E2）
  const nm = (pid) => { const s2 = String(pname(pid)); return s2.length > 6 ? s2.slice(0, 6) : s2; };
  if (v.basesPids[0]) svg.append(svgText({ x: first[0] + 11, y: first[1] + 4, fill: '#e8b84b', 'font-size': '10' }, nm(v.basesPids[0])));
  if (v.basesPids[1]) svg.append(svgText({ x: second[0], y: second[1] - 13, fill: '#e8b84b', 'font-size': '10', 'text-anchor': 'middle' }, nm(v.basesPids[1])));
  if (v.basesPids[2]) svg.append(svgText({ x: third[0] - 11, y: third[1] + 4, fill: '#e8b84b', 'font-size': '10', 'text-anchor': 'end' }, nm(v.basesPids[2])));
  // G1a: アウトカウント円3つ＋「N OUT」テキスト・上部の「N回表」テキストはスコアバーに一本化したため撤去
  // （塁の菱形＋走者名だけ残す）。
  return svg;
}

/** F1: 打者の利き腕表記（両打は対戦投手との実効打席も括弧で: 例「両打(左)」）。 */
function watchBatsJP(batter, pitcher) {
  if (batter.bats === 'S') {
    return pitcher ? `両打(${effectiveBats(batter, pitcher) === 'L' ? '左' : '右'})` : '両打';
  }
  return batter.bats === 'L' ? '左打' : '右打';
}

/** 対戦カード（現在の打者/投手・利き腕・今日の結果・シーズン成績）。B-S-Oは「今の状況」パネルへ移設。 */
function watchMatchup(v, u) {
  const { el, state, playerLink, fmt3, f2 } = u;
  const box = el('div', { class: 'matchup' });
  // 打者（利き腕＋今日 X打数Y安打＋当日打席履歴チップ＋シーズンAVG/HR/OPS）
  const bid = v.batterId;
  const bp = bid ? state.byId.get(bid) : null; // bats/throws は公開情報（player モデル）
  const pid = v.curPitcherId;
  const pp = pid ? state.byId.get(pid) : null;
  const bs = bid && state.res && state.res.statsById ? state.res.statsById.get(bid) : null;
  const bm = bs && bs.batting.pa > 0 ? playerBatting(bs, state.lc) : null;
  const d = bid ? v.daily.get(bid) : null;
  const hasToday = d && (d.ab > 0 || d.res.length > 0);
  box.append(el('div', { class: 'murow' }, [
    el('span', { class: 'mulabel' }, '打者'),
    el('span', { class: 'muname' }, bid ? [playerLink(bid)] : '—'),
    ...(bp ? [el('span', { class: 'handtag' }, watchBatsJP(bp, pp))] : []),
    el('span', { class: 'mutoday' }, hasToday ? `今日 ${d.ab}打数${d.h}安打` : '今日 第1打席'),
    ...(hasToday && d.res.length ? [el('span', { class: 'reschips' }, d.res.map((r) => el('span', { class: 'reschip' }, r)))] : []),
    el('span', { class: 'muted' }, bm ? `AVG ${fmt3(bm.avg)} / ${bm.hr}本 / OPS ${fmt3(bm.ops)}` : '今季成績なし'),
  ]));
  // 投手（利き腕＋球数＋シーズンERA/K）
  const ps = pid && state.res && state.res.statsById ? state.res.statsById.get(pid) : null;
  const pm = ps && ps.pitching.outs > 0 ? playerPitching(ps, state.lc, state.cfg) : null;
  box.append(el('div', { class: 'murow' }, [
    el('span', { class: 'mulabel' }, '投手'),
    el('span', { class: 'muname' }, pid ? [playerLink(pid)] : '—'),
    ...(pp ? [el('span', { class: 'handtag' }, pp.throws === 'L' ? '左投' : '右投')] : []),
    el('span', { class: 'mutoday' }, `球数 ${v.curPitchCount || 0}`),
    el('span', { class: 'muted' }, pm && Number.isFinite(pm.era) ? `ERA ${f2(pm.era)} / ${pm.so}K` : '今季成績なし'),
  ]));
  return box;
}

/**
 * G1a: 進行バー（下部固定・全幅・1行）。ボタン文言は既存のまま変更しない（§0ルール8）。
 * 進行中: 1球/1打席/1イニング/自動再生/最後まで。試合終了時: ホームへ戻る のみ
 * （最終スコアはスコアバーが同じ情報を示すため .finalscore は撤去・珍記録は速報フィード側へ移設）。
 */
function watchControls(v, u, done) {
  const { el, game } = u;
  const w = game.watch;
  const ctrl = el('div', { class: 'row watchctrl' });
  if (!done) {
    const adv = (unit) => { w.unit = unit; w.justAdvanced = true; w.idx = watchAdvanceIdx(w, unit); renderWatchScreen(u); };
    ctrl.append(el('button', { class: 'primary', onclick: () => adv('pitch') }, '▶ 1球'));
    ctrl.append(el('button', { onclick: () => adv('pa') }, '▶ 1打席'));
    ctrl.append(el('button', { onclick: () => adv('inning') }, '▶ 1イニング'));
    ctrl.append(el('button', { class: w.auto ? 'primary' : '', onclick: () => { w.auto = !w.auto; renderWatchScreen(u); } }, w.auto ? '⏸ 自動再生を止める' : '▶▶ 自動再生'));
    ctrl.append(el('button', { onclick: () => { w.auto = false; w.justAdvanced = true; w.idx = w.events.length; renderWatchScreen(u); } }, '⏩ 最後まで'));
  } else {
    ctrl.append(el('button', { class: 'primary', onclick: () => { game.watch = null; u.renderHub(); } }, 'ホームへ戻る'));
  }
  return ctrl;
}

/** サブタブ「スタメン」: 両軍スタメン表（打順/守/選手/当日成績）＋ベンチ・ブルペン残量（旧折りたたみを移設）。 */
function watchLineupTab(root, v, u) {
  const { el, td, tname, posJP } = u;
  const body = el('div', { class: 'lineupbody' });
  for (const side of ['away', 'home']) {
    const col = el('div', { class: 'lineupcol' });
    col.append(el('div', { class: 'muted' }, `${tname(v[side])} スタメン`));
    const rows = v.lineups[side].map((s, i) => {
      const d = v.daily.get(s.playerId);
      return el('tr', {}, [
        td(i + 1), td(posJP(s.pos), 'left'),
        el('td', { class: 'left' }, [u.playerLink(s.playerId)]),
        el('td', { class: 'left' }, d ? `${d.ab}打数${d.h}安打${d.res.length ? `（${d.res.join('・')}）` : ''}` : '—'),
      ]);
    });
    col.append(el('div', { class: 'tablewrap' }, [el('table', { class: 'stat' }, [
      el('thead', {}, el('tr', {}, [el('th', {}, '打順'), el('th', { class: 'left' }, '守'), el('th', { class: 'left' }, '選手'), el('th', { class: 'left' }, '今日')])),
      el('tbody', {}, rows),
    ])]));
    body.append(col);
  }
  // ベンチ/ブルペン残量（両軍・旧 benchBox を統合）
  const resBar = (label, cur, max) => el('div', { class: 'resrow' }, [
    el('span', { class: 'reslabel' }, label),
    el('span', { class: 'restrack' }, [el('span', { class: 'resfill', style: `width:${max ? (cur / max) * 100 : 0}%` })]),
    el('span', { class: 'resval' }, `${cur}/${max}`),
  ]);
  const bb = el('div', { class: 'benchbox' }, [el('div', { class: 'muted' }, '残量（ブルペン / ベンチ）')]);
  for (const side of ['away', 'home']) {
    bb.append(el('div', { class: 'muted', style: 'margin-top:4px' }, tname(v[side])));
    bb.append(resBar('ブルペン', v.bull[side], v.bullMax[side]));
    bb.append(resBar('ベンチ', v.bench[side], v.benchMax[side]));
  }
  body.append(bb);
  root.append(body);
}

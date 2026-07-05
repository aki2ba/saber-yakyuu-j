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
// E2ゾーニング改（「野球観戦アプリのように情報を整理してほしい。1球ごとのコースも見たい」対応）:
//   - 情報ゾーニング: 最上部「今の状況」パネル(.nowpanel)＝大スコア＋回/表裏＋アウト＋盤面＋B-S-O
//     → コンパクトなラインスコア → 進行ボタン群（固定位置） → 「対戦」パネル(.duelpanel)＝
//     打者/投手カード＋現打席リスト＋コース図 → watch内サブタブ(.wtab)「速報／ボックス／スタメン」。
//   - コース図: 現打席の各投球をストライクゾーン図に①②③…の番号付きドットでプロット。
//     帯（band: 0=ゾーン内/1=際/2=明確ボール）はエンジンの実データ（pitchイベント搭載・乱数非消費）。
//     帯の中の細かい位置は hashSeed（rng非消費の決定論ハッシュ）による演出＝同じ試合は何度見ても同じ図。
//   - 判定の色体系を統一: ボール=白/見逃しS=緑/空振り=赤/ファウル=黄/インプレー=青（pc-*クラス）。
//     コース図ドット・現打席リスト・実況の一球行（全球表示時）で共通。
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
import { playerBatting, playerPitching, hashSeed } from '../engine.mjs';
import { detectGameNotables, notableHeadline } from '../game/index.mjs';
import { buildBoxScore } from '../game/boxscore.mjs';

const WATCH_PITCH_JP = { fastball: 'ストレート', slider: 'スライダー', curve: 'カーブ', changeup: 'チェンジアップ', fork: 'フォーク', sinker: 'シンカー', cutter: 'カットボール' };
const WATCH_CALL_JP = { ball: 'ボール', called: '見逃しストライク', whiff: '空振り', foul: 'ファウル', inplay: '打った！', hbp: '死球' };
const WATCH_BATTED_JP = { GB: 'ゴロ', LD: 'ライナー', FB: 'フライ', PU: '小フライ' };
const WATCH_HITS = new Set(['1B', '2B', '3B', 'HR']);

/** 打球方向（スプレー角→守備位置の呼び名）。負=左・正=右（sprayChart と同じ符号系）。 */
function watchDirName(deg) {
  return deg < -12 ? 'レフト' : deg > 12 ? 'ライト' : 'センター';
}
function watchDirChar(deg) {
  return deg < -12 ? '左' : deg > 12 ? '右' : '中';
}
/** イニングハーフの和名（'bottom'→裏）。 */
function watchHalfJP(half) {
  return half === 'bottom' ? '裏' : '表';
}
/** 得点イベント行末に付ける現在スコア「（先攻 X-Y 後攻）」。 */
function watchScoreTxt(v, tname) {
  return `（${tname(v.away)} ${v.scoreA}-${v.scoreH} ${tname(v.home)}）`;
}
/** 内野打球（ゴロ/小フライ）の守備位置の呼び名（スプレー角→三遊二一）。 */
function watchInfieldName(deg) {
  return deg < -20 ? 'サード' : deg < 0 ? 'ショート' : deg < 20 ? 'セカンド' : 'ファースト';
}
function watchInfieldChar(deg) {
  return deg < -20 ? '三' : deg < 0 ? '遊' : deg < 20 ? '二' : '一';
}

/** 観戦画面本体。u = ui.mjs の共有ヘルパー束（watchDeps()）。 */
export function renderWatchScreen(u) {
  const { el, game, tname } = u;
  const w = game.watch;
  if (!w) { u.renderHub(); return; }
  if (!w.tab) w.tab = 'live'; // watch内サブタブ（'live'=速報/'box'=ボックス/'lineup'=スタメン・UIのみ）
  u.refreshRes(); // 対戦カードのシーズン成績（観測値）を最新化
  const v = watchReconstruct(w.events, w.idx, u);
  const done = w.idx >= w.events.length;
  const root = document.getElementById('app');
  root.innerHTML = '';
  root.append(el('div', { class: 'header' }, [
    el('h2', {}, ['観戦　', el('span', { class: 'muted' }, `${tname(v.away)} vs ${tname(v.home)}`)]),
    el('div', { class: 'row' }, [el('button', { class: 'link', onclick: () => { w.auto = false; game.watch = null; u.renderHub(); } }, 'ホームへ戻る')]),
  ]));
  // 1) 「今の状況」パネル: 大スコア＋回/表裏＋アウト＋B-S-O＋盤面SVG（視覚階層の最上位）
  root.append(watchNowPanel(v, u));
  // 2) ラインスコア（イニング別得点＋R/H/E・コンパクトに維持）
  root.append(watchLineScore(v, u));
  // 3) 進行コントロール（「今の状況」直下の固定位置: 1球/1打席/1イニング/自動再生/最後まで）
  root.append(watchControls(v, u, done));
  // 4) 「対戦」パネル: 打者/投手カード＋現打席リスト＋コース図（ストライクゾーンプロット）
  root.append(el('div', { class: 'duelpanel' }, [
    el('div', { class: 'duelcol' }, [watchMatchup(v, u), watchCurrentAb(v, u)]),
    watchZoneCol(v, u, w),
  ]));
  // 5) watch内サブタブ: 速報（実況フィード・既定）／ボックス（両軍当日ライン）／スタメン（＋残量）
  root.append(el('div', { class: 'wtabs' }, [['live', '速報'], ['box', 'ボックス'], ['lineup', 'スタメン']].map(([k, label]) =>
    el('button', { class: 'wtab' + (w.tab === k ? ' active' : ''), onclick: () => { w.tab = k; renderWatchScreen(u); } }, label))));
  if (w.tab === 'box') watchBoxTab(root, u, w);
  else if (w.tab === 'lineup') watchLineupTab(root, v, u);
  else watchFeedTab(root, v, u, w);
  // 自動再生（UIのみ・状態不変）: タイマーは再生位置(idx)を1単位進めて再描画するだけ。
  if (!done && w.auto) {
    setTimeout(() => {
      const cw = game.watch;
      if (!cw || cw !== w || !cw.auto || cw.idx >= cw.events.length) return;
      cw.idx = watchAdvanceIdx(cw, cw.unit || 'pitch');
      renderWatchScreen(u);
    }, 700);
  }
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
function watchReconstruct(events, idx, u) {
  const { tname } = u;
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
      if (v.curAb) v.curAb.pitches.push({ n: e.n, call: e.call, band: e.band, text: ptxt });
      // 一球行にも統一色（コース図ドット/現打席リストと同じ pc-* クラス）
      v.lines.push({ kind: 'pitch', cls: 'ev-pitch ' + watchCallCls(e.call), text: '　' + ptxt });
    } else if (e.type === 'pa') {
      v.inning = e.inning; v.half = e.half; v.outs = e.outsAfter;
      if (e.basesPids) v.basesPids = e.basesPids.slice();
      setScores(e);
      if (e.runsOnPlay) ensureLine(e.inning)[e.half === 'bottom' ? 'bottom' : 'top'] += e.runsOnPlay;
      if (WATCH_HITS.has(e.result)) v[e.batTeam === v.home ? 'hitsH' : 'hitsA']++;
      if (e.result === 'E') v[e.batTeam === v.home ? 'errA' : 'errH']++; // 失策は守備側に計上
      const d = dailyOf(e.batterId);
      const sacFly = e.result === 'out' && e.runsOnPlay > 0 && e.battedType && e.battedType !== 'GB';
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
      v.balls = 0; v.strikes = 0;
    } else if (e.type === 'bunt') {
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
function watchResShort(e) {
  if (e.outcome === 'K') return '三振';
  if (e.outcome === 'BB') return e.isIBB ? '敬遠' : '四球';
  if (e.outcome === 'HBP') return '死球';
  const d = e.bb ? watchDirChar(e.bb.sprayDeg) : '';
  if (e.result === '1B') return d + '安';
  if (e.result === '2B') return d + '2';
  if (e.result === '3B') return d + '3';
  if (e.result === 'HR') return d + '本';
  if (e.result === 'E') return d + '失';
  if (e.runsOnPlay > 0 && e.battedType && e.battedType !== 'GB') return '犠飛';
  // ゴロ/小フライは内野の守備位置（三遊二一）、ライナー/フライは外野方向（左中右）で略記
  if (e.battedType === 'GB') return (e.bb ? watchInfieldChar(e.bb.sprayDeg) : '') + 'ゴ';
  if (e.battedType === 'PU') return (e.bb ? watchInfieldChar(e.bb.sprayDeg) : '') + '飛';
  return d + (e.battedType === 'LD' ? '直' : '飛');
}

/**
 * 打席結果の言語化＋色分けクラス（スポナビ風・「レフトへのタイムリーツーベース！」等）。
 * cls: 安打=ev-hit / 本塁打=ev-hr / 三振=ev-k / 四死球=ev-bb / 失策=ev-err / 凡退=''。
 * 得点(ev-score)は呼び出し側で runsOnPlay から付与する。
 */
function watchPaBody(e, lastCall) {
  const dir = e.bb ? watchDirName(e.bb.sprayDeg) : '';
  if (e.outcome === 'K') return { cls: 'ev-k', body: lastCall === 'called' ? '見逃し三振' : '空振り三振' };
  if (e.outcome === 'BB') return { cls: 'ev-bb', body: e.isIBB ? '申告敬遠で歩かされる' : '四球を選んで出塁' };
  if (e.outcome === 'HBP') return { cls: 'ev-bb', body: '死球' };
  if (e.result === 'E') return { cls: 'ev-err', body: `${dir}のエラーで出塁` };
  if (e.result === 'HR') {
    const n = e.runsOnPlay;
    return { cls: 'ev-hr', body: `${dir}スタンドへ${n >= 2 ? `の${n}ラン` : 'ソロ'}ホームラン！！${e.bb ? `（EV${Math.round(e.bb.evKmh)}km/h 飛距離${Math.round(e.bb.distanceM)}m）` : ''}` };
  }
  if (e.result === '3B') return { cls: 'ev-hit', body: `${dir}への${e.runsOnPlay ? 'タイムリー' : ''}スリーベース！` };
  if (e.result === '2B') return { cls: 'ev-hit', body: `${dir}への${e.runsOnPlay ? 'タイムリー' : ''}ツーベース！` };
  if (e.result === '1B') return { cls: 'ev-hit', body: `${dir}前へ${e.runsOnPlay ? 'タイムリーヒット！' : 'ヒット'}` };
  if (!e.battedType) return { cls: '', body: '凡退' };
  const dp = e.outsAfter - e.outsBefore >= 2;
  const sf = e.runsOnPlay > 0 && e.battedType !== 'GB';
  // ゴロ/小フライは内野の守備位置名（ショートゴロ等）、ライナー/フライは外野方向で言語化
  const spot = e.battedType === 'GB' || e.battedType === 'PU' ? (e.bb ? watchInfieldName(e.bb.sprayDeg) : '内野') : dir;
  const body = sf ? `${dir}へ犠牲フライ`
    : dp ? `${spot}ゴロで併殺（ダブルプレー）`
    : `${spot}${WATCH_BATTED_JP[e.battedType] || '打球'}でアウト`;
  return { cls: '', body };
}

/**
 * 「現在の打席」ボックス（対戦カード直下・E2改）: 現打席の投球を1球目→N球目の正順で表示。
 * 打席が決着したら結果を大きく表示（次の打席開始で更新）。
 */
function watchCurrentAb(v, u) {
  const { el } = u;
  const box = el('div', { class: 'curab' });
  box.append(el('div', { class: 'curabhead' }, v.ended ? '最終打席' : '現在の打席'));
  const ab = v.curAb;
  if (!ab) { box.append(el('div', { class: 'muted' }, '— 試合開始前 —')); return box; }
  if (!ab.pitches.length && !ab.result) box.append(el('div', { class: 'curabpitch muted' }, '打席開始（第1球を待つ）'));
  // 一球行はコース図ドット/実況一球行と同じ判定色（pc-*）で統一
  for (const p of ab.pitches) box.append(el('div', { class: 'curabpitch ' + watchCallCls(p.call) }, p.text));
  if (ab.result) box.append(el('div', { class: 'curabresult ' + (ab.result.cls || '') }, ab.result.parts));
  return box;
}

// ============================================================================
// E2ゾーニング改: 「今の状況」パネル／コース図（ストライクゾーンプロット）／サブタブ本体
// ============================================================================

/** 一球判定 → 統一色クラス（ボール=白/見逃しS=緑/空振り=赤/ファウル=黄/インプレー=青）。 */
function watchCallCls(call) {
  if (call === 'called') return 'pc-called';
  if (call === 'whiff') return 'pc-whiff';
  if (call === 'foul') return 'pc-foul';
  if (call === 'inplay') return 'pc-inplay';
  return 'pc-ball'; // ball / hbp
}

/** 投球番号の丸数字（①②③…・21球目以降は素の数字）。 */
function watchCircledNum(n) {
  return n >= 1 && n <= 20 ? String.fromCharCode(0x245f + n) : String(n);
}

/**
 * 「今の状況」パネル: 大きなスコア（チーム名＋得点）＋回/表裏＋アウト＋B-S-Oランプ＋盤面SVG。
 * 視覚階層の最上位（スコア > 回・アウト > 対戦 > 詳細）。
 */
function watchNowPanel(v, u) {
  const { el, game, tname } = u;
  const my = game.gs.playerTeamId;
  const teamCol = (tid, score) => el('div', { class: 'nowteam' + (tid === my ? ' nowmy' : '') }, [
    el('div', { class: 'nowtname' }, tid ? tname(tid) : '—'),
    el('div', { class: 'nowtscore' }, String(score)),
  ]);
  const lampRow = (label, n, max, cls) => el('div', { class: 'bsorow' }, [
    el('span', { class: 'bsolabel' }, label),
    ...Array.from({ length: max }, (_, i) => el('span', { class: 'lamp ' + cls + (i < n ? ' on' : '') }, '')),
  ]);
  const mid = el('div', { class: 'nowmid' }, [
    el('div', { class: 'nowinning' }, v.ended ? '試合終了' : `${v.inning}回${watchHalfJP(v.half)}`),
    el('div', { class: 'nowouts' }, v.ended ? (v.endInnings > 9 ? `延長${v.endInnings}回` : '') : `${v.outs} アウト`),
    el('div', { class: 'bso' }, [
      lampRow('B', Math.min(v.balls, 3), 3, 'lb'),
      lampRow('S', Math.min(v.strikes, 2), 2, 'ls'),
      lampRow('O', Math.min(v.outs, 2), 2, 'lo'),
    ]),
  ]);
  return el('div', { class: 'nowpanel' }, [
    el('div', { class: 'nowscore' }, [teamCol(v.away, v.scoreA), mid, teamCol(v.home, v.scoreH)]),
    watchDiamond(v, u),
  ]);
}

// コース図のジオメトリ（viewBox座標）: 外周＝図全体、内枠＝ストライクゾーン
const WATCH_ZP = { W: 160, H: 180, zx: 50, zy: 52, zw: 60, zh: 76 };

/**
 * 現打席の一球座標（決定論・rng非消費）: 帯(band)は実データ、帯内の細かい位置は
 * hashSeed(試合識別子, 打席index, 球番号)で生成＝同じ試合は何度見ても同じ図。
 *  band0=ゾーン枠内 / band1=枠線±周辺 / band2=枠の外（明確ボール）。
 * リアリティの規律（ユーザーレビュー対応）:
 *  - 明確ボールは「際からの距離減衰」で描く（現実の外し球の大半はゾーン至近。大外れは稀）
 *  - スイングされた球（chase）は際のすぐ外に限定（届かない場所のファウルを描かない）
 *  - 見逃しボールはやや低め方向へバイアス（低めに外す/ワンバウンド系が最頻という現実）
 */
function watchPitchXY(rec, abIdx, n, band, swung = false) {
  const { W, H, zx, zy, zw, zh } = WATCH_ZP;
  const day = rec && rec.day != null ? rec.day : 0;
  const key1 = hashSeed(day, String(rec && rec.home || ''), String(rec && rec.away || ''), abIdx, n, 1) / 4294967296;
  const key2 = hashSeed(day, String(rec && rec.home || ''), String(rec && rec.away || ''), abIdx, n, 2) / 4294967296;
  if (band === 0) return [zx + 6 + key1 * (zw - 12), zy + 7 + key2 * (zh - 14)]; // ゾーン枠内
  // 枠中心からの方位角でゾーン枠線上の点を取り、際は±ジッタ・明確ボールは外側へ減衰で押し出す
  const cx = zx + zw / 2; const cy = zy + zh / 2;
  // 見逃しの明確ボールは方位を低め寄りに（sinが正=下方向の確率を上げる）
  let th = key1 * Math.PI * 2;
  if (band === 2 && !swung && key1 < 0.5) th = Math.PI * (0.25 + key1); // 下半円へ寄せる（半数）
  const dx = Math.cos(th); const dy = Math.sin(th);
  const t = Math.min((zw / 2) / Math.max(Math.abs(dx), 1e-6), (zh / 2) / Math.max(Math.abs(dy), 1e-6));
  let r;
  if (band === 1) r = t + (key2 - 0.5) * 9; // 際: 枠線を跨ぐ±ジッタ
  else if (swung) r = t + 4 + key2 * key2 * 8; // chase: 際のすぐ外（+4〜12px・近距離加重）
  else r = t + 5 + key2 * key2 * 22; // 見逃しボール: 距離減衰（大半は+5〜11px・大外れは稀）
  const x = Math.min(W - 12, Math.max(12, cx + dx * r));
  const y = Math.min(H - 12, Math.max(12, cy + dy * r));
  return [x, y];
}

/** コース図カラム（見出し＋ゾーンSVG＋凡例）。 */
function watchZoneCol(v, u, w) {
  const { el } = u;
  const col = el('div', { class: 'zonecol' });
  col.append(el('div', { class: 'curabhead' }, 'コース（捕手視点）'));
  col.append(watchZonePlot(v, u, w));
  const leg = el('div', {
    class: 'zonelegend',
    title: '高さ・コースの帯（ゾーン内／際／明確ボール）は投球の実データ。帯の中の細かい位置は決定論ハッシュによる演出です（同じ試合は何度見ても同じ図）。',
  }, [
    el('span', { class: 'pc-ball' }, '●ボール'),
    el('span', { class: 'pc-called' }, '●見逃し'),
    el('span', { class: 'pc-whiff' }, '●空振り'),
    el('span', { class: 'pc-foul' }, '●ファウル'),
    el('span', { class: 'pc-inplay' }, '●インプレー'),
  ]);
  col.append(leg);
  return col;
}

/** ストライクゾーンプロット本体: ゾーン枠＋九分割目安線＋現打席の投球ドット（①②③…）。 */
function watchZonePlot(v, u, w) {
  const { svgEl, svgText } = u;
  const { W, H, zx, zy, zw, zh } = WATCH_ZP;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'zoneplot' });
  svg.append(svgEl('rect', { x: 2, y: 2, width: W - 4, height: H - 4, rx: 8, fill: '#0c3122', stroke: '#2f6b4a' })); // 外周
  svg.append(svgEl('rect', { x: zx, y: zy, width: zw, height: zh, fill: '#123d2a', stroke: '#9fb8ac', 'stroke-width': '1.5' })); // ゾーン枠
  for (let i = 1; i < 3; i++) { // 九分割の目安線
    svg.append(svgEl('line', { x1: zx + (zw / 3) * i, y1: zy, x2: zx + (zw / 3) * i, y2: zy + zh, stroke: '#2f6b4a', 'stroke-width': '0.6' }));
    svg.append(svgEl('line', { x1: zx, y1: zy + (zh / 3) * i, x2: zx + zw, y2: zy + (zh / 3) * i, stroke: '#2f6b4a', 'stroke-width': '0.6' }));
  }
  const ab = v.curAb;
  if (ab) {
    for (const p of ab.pitches) {
      const swung = p.call === 'whiff' || p.call === 'foul' || p.call === 'inplay';
      const [x, y] = watchPitchXY(w.rec, ab.abIdx, p.n, p.band ?? 1, swung);
      svg.append(svgText({
        x, y: y + 4.5, class: 'pdot ' + watchCallCls(p.call),
        'font-size': '13', 'font-weight': '700', 'text-anchor': 'middle',
      }, watchCircledNum(p.n)));
    }
  }
  return svg;
}

/** サブタブ「速報」: 実況フィード（新しい順・既定は打席結果のみ・全球表示トグル）。 */
function watchFeedTab(root, v, u, w) {
  const { el } = u;
  let lines = w.allPitches ? v.lines : v.lines.filter((ln) => ln.kind !== 'pitch' && ln.kind !== 'ab');
  lines = lines.slice(-160).reverse();
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
  // アウトカウント
  for (let i = 0; i < 3; i++) svg.append(svgEl('circle', { cx: 24 + i * 16, cy: 184, r: 5, fill: i < v.outs ? '#c96a5a' : '#0c3122', stroke: '#c9a06a' }));
  svg.append(svgText({ x: 64, y: 188, fill: '#9fb8ac', 'font-size': '11' }, `${v.outs} OUT`));
  svg.append(svgText({ x: cx, y: 16, fill: '#e9e4d0', 'font-size': '12', 'text-anchor': 'middle' }, `${v.inning}回${v.half === 'bottom' ? '裏' : '表'}`));
  return svg;
}

/** 対戦カード（現在の打者/投手・今日の結果・シーズン成績）。B-S-Oは「今の状況」パネルへ移設。 */
function watchMatchup(v, u) {
  const { el, state, playerLink, fmt3, f2 } = u;
  const box = el('div', { class: 'matchup' });
  // 打者（今日 X打数Y安打＋当日打席履歴チップ＋シーズンAVG/HR/OPS）
  const bid = v.batterId;
  const bs = bid && state.res && state.res.statsById ? state.res.statsById.get(bid) : null;
  const bm = bs && bs.batting.pa > 0 ? playerBatting(bs, state.lc) : null;
  const d = bid ? v.daily.get(bid) : null;
  const hasToday = d && (d.ab > 0 || d.res.length > 0);
  box.append(el('div', { class: 'murow' }, [
    el('span', { class: 'mulabel' }, '打者'),
    el('span', { class: 'muname' }, bid ? [playerLink(bid)] : '—'),
    el('span', { class: 'mutoday' }, hasToday ? `今日 ${d.ab}打数${d.h}安打` : '今日 第1打席'),
    ...(hasToday && d.res.length ? [el('span', { class: 'reschips' }, d.res.map((r) => el('span', { class: 'reschip' }, r)))] : []),
    el('span', { class: 'muted' }, bm ? `AVG ${fmt3(bm.avg)} / ${bm.hr}本 / OPS ${fmt3(bm.ops)}` : '今季成績なし'),
  ]));
  // 投手（球数＋シーズンERA/K）
  const pid = v.curPitcherId;
  const ps = pid && state.res && state.res.statsById ? state.res.statsById.get(pid) : null;
  const pm = ps && ps.pitching.outs > 0 ? playerPitching(ps, state.lc, state.cfg) : null;
  box.append(el('div', { class: 'murow' }, [
    el('span', { class: 'mulabel' }, '投手'),
    el('span', { class: 'muname' }, pid ? [playerLink(pid)] : '—'),
    el('span', { class: 'mutoday' }, `球数 ${v.curPitchCount || 0}`),
    el('span', { class: 'muted' }, pm && Number.isFinite(pm.era) ? `ERA ${f2(pm.era)} / ${pm.so}K` : '今季成績なし'),
  ]));
  return box;
}

/** 進行コントロール（1球/1打席/1イニング・自動再生・最後まで／終了時は最終スコア＋珍記録）。 */
function watchControls(v, u, done) {
  const { el, game, tname } = u;
  const w = game.watch;
  const ctrl = el('div', { class: 'row', style: 'flex-wrap:wrap;margin:8px 0' });
  if (!done) {
    const adv = (unit) => { w.unit = unit; w.idx = watchAdvanceIdx(w, unit); renderWatchScreen(u); };
    ctrl.append(el('button', { class: 'primary', onclick: () => adv('pitch') }, '▶ 1球'));
    ctrl.append(el('button', { onclick: () => adv('pa') }, '▶ 1打席'));
    ctrl.append(el('button', { onclick: () => adv('inning') }, '▶ 1イニング'));
    ctrl.append(el('button', { class: w.auto ? 'primary' : '', onclick: () => { w.auto = !w.auto; renderWatchScreen(u); } }, w.auto ? '⏸ 自動再生を止める' : '▶▶ 自動再生'));
    ctrl.append(el('button', { onclick: () => { w.auto = false; w.idx = w.events.length; renderWatchScreen(u); } }, '⏩ 最後まで'));
  } else {
    ctrl.append(el('div', { class: 'finalscore' }, `試合終了　${tname(v.home)} ${v.scoreH} - ${v.scoreA} ${tname(v.away)}`));
    // 珍記録検出（C4・§54）: ノーヒッター/完全試合/サイクル/猛打賞
    const { notables } = detectGameNotables(w.events);
    for (const n of notables) {
      const head = notableHeadline(n, (id) => u.pname(id), (id) => tname(id));
      if (head) ctrl.append(el('div', { class: 'newsrow good', style: 'width:100%' }, `🎉 ${head}`));
    }
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

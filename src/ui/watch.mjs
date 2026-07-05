// ============================================================================
// フェーズE2: 試合観戦のスポナビ風刷新（ラインスコア・フィールド盤面・対戦カード・一球速報）
//
// ユーザーフィードバック（phaseE_spec）「試合は見れたものではない。スポナビの野球速報みたいなのがいい」対応。
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
import { playerBatting, playerPitching } from '../engine.mjs';
import { detectGameNotables, notableHeadline } from '../game/index.mjs';

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
  u.refreshRes(); // 対戦カードのシーズン成績（観測値）を最新化
  const v = watchReconstruct(w.events, w.idx, u);
  const done = w.idx >= w.events.length;
  const root = document.getElementById('app');
  root.innerHTML = '';
  root.append(el('div', { class: 'header' }, [
    el('h2', {}, ['観戦　', el('span', { class: 'muted' }, `${tname(v.away)} vs ${tname(v.home)}`)]),
    el('div', { class: 'row' }, [el('button', { class: 'link', onclick: () => { w.auto = false; game.watch = null; u.renderHub(); } }, 'ハブへ戻る')]),
  ]));
  // 上部: ラインスコア（イニング別得点＋R/H/E）
  root.append(watchLineScore(v, u));
  // 中央: フィールド盤面（走者名/アウト）＋対戦カード（B-S-Oランプ/今日の結果/シーズン成績）
  root.append(el('div', { class: 'watchgrid' }, [watchDiamond(v, u), watchMatchup(v, u)]));
  // 進行コントロール（1球/1打席/1イニング/自動再生/最後まで）
  root.append(watchControls(v, u, done));
  // 下部: 一球速報フィード（新しい行が上）。ダイジェスト表示（progressive=false）は結果行のみに間引く。
  let lines = w.progressive ? v.lines : v.lines.filter((ln) => ln.kind !== 'pitch' && ln.kind !== 'ab');
  lines = lines.slice(-160).reverse();
  root.append(el('div', { class: 'pbp' }, lines.map((ln) => el('div', { class: 'pbpline ' + (ln.cls || '') }, ln.parts || ln.text))));
  // 折りたたみ: 両軍スタメン表（当日成績）＋ベンチ/ブルペン残量（既存表示を統合）
  root.append(watchLineupPanel(v, u));
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
      v.lines.push({ kind: 'ab', cls: 'ev-ab', parts: ['◇ ', u.playerLink(e.batterId), `（今日 ${d.h}-${d.ab}）`, ' 対 ', u.playerLink(e.pitcherId), `（${e.pitcherPitches}球）`] });
    } else if (e.type === 'pitch') {
      v.balls = e.balls; v.strikes = e.strikes; v.lastCall = e.call;
      v.curPitchCount++;
      // 決着球（3ストライク/4ボール/インプレー/死球）はカウント表記を省略（結果行が続く）
      const decided = e.strikes >= 3 || e.balls >= 4 || e.call === 'inplay' || e.call === 'hbp';
      const cnt = decided ? '' : ` (${e.balls}-${e.strikes})`;
      const wild = e.wild ? '　→ 捕手が後逸！走者進塁' : '';
      v.lines.push({ kind: 'pitch', cls: 'ev-pitch', text: `　${e.n}球目 ${WATCH_PITCH_JP[e.pitchType] || e.pitchType} ${WATCH_CALL_JP[e.call] || e.call}${cnt}${wild}` });
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
      v.lines.push(watchPaLine(e, v.lastCall, u));
      v.balls = 0; v.strikes = 0;
    } else if (e.type === 'bunt') {
      v.inning = e.inning; v.half = e.half; v.outs = e.outsAfter;
      v.basesPids = e.basesPids.slice();
      setScores(e);
      const d = dailyOf(e.batterId);
      let txt;
      if (e.outcome === 'success') { d.res.push('犠打'); txt = '送りバント成功'; }
      else if (e.outcome === 'hit') {
        d.ab++; d.h++; d.res.push('バント安打');
        v[e.batTeam === v.home ? 'hitsH' : 'hitsA']++;
        txt = 'セーフティバントが内野安打に！';
      } else { d.ab++; d.res.push('バント失敗'); txt = 'バント失敗（先行走者が封殺）'; }
      v.lines.push({ kind: 'pa', cls: e.outcome === 'hit' ? 'ev-run' : '', parts: [u.playerLink(e.batterId), `: ${txt}`] });
      v.balls = 0; v.strikes = 0;
    } else if (e.type === 'steal') {
      if (e.basesPids) v.basesPids = e.basesPids.slice();
      if (e.outsAfter != null) v.outs = e.outsAfter;
      v.lines.push({ kind: 'steal', cls: e.success ? 'ev-run' : '', parts: ['　', u.playerLink(e.runnerId), e.success ? ' が盗塁成功！（二塁へ）' : ' が盗塁失敗（盗塁死）'] });
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

/** 打席結果の実況行（スポナビ風の言語化・「レフトへのタイムリーツーベース！」等）。 */
function watchPaLine(e, lastCall, u) {
  const dir = e.bb ? watchDirName(e.bb.sprayDeg) : '';
  let cls = e.runsOnPlay ? 'ev-run' : '';
  let body;
  if (e.outcome === 'K') body = lastCall === 'called' ? '見逃し三振' : '空振り三振';
  else if (e.outcome === 'BB') body = e.isIBB ? '申告敬遠で歩かされる' : '四球を選んで出塁';
  else if (e.outcome === 'HBP') body = '死球';
  else if (e.result === 'E') body = `${dir}のエラーで出塁`;
  else if (e.result === 'HR') {
    cls = 'ev-hr';
    const n = e.runsOnPlay;
    body = `${dir}スタンドへ${n >= 2 ? `の${n}ラン` : 'ソロ'}ホームラン！！${e.bb ? `（EV${Math.round(e.bb.evKmh)}km/h 飛距離${Math.round(e.bb.distanceM)}m）` : ''}`;
  } else if (e.result === '3B') body = `${dir}への${e.runsOnPlay ? 'タイムリー' : ''}スリーベース！`;
  else if (e.result === '2B') body = `${dir}への${e.runsOnPlay ? 'タイムリー' : ''}ツーベース！`;
  else if (e.result === '1B') body = `${dir}前へ${e.runsOnPlay ? 'タイムリーヒット！' : 'ヒット'}`;
  else if (!e.battedType) body = '凡退';
  else {
    const dp = e.outsAfter - e.outsBefore >= 2;
    const sf = e.runsOnPlay > 0 && e.battedType !== 'GB';
    // ゴロ/小フライは内野の守備位置名（ショートゴロ等）、ライナー/フライは外野方向で言語化
    const spot = e.battedType === 'GB' || e.battedType === 'PU' ? (e.bb ? watchInfieldName(e.bb.sprayDeg) : '内野') : dir;
    body = sf ? `${dir}へ犠牲フライ`
      : dp ? `${spot}ゴロで併殺（ダブルプレー）`
      : `${spot}${WATCH_BATTED_JP[e.battedType] || '打球'}でアウト`;
  }
  const pts = e.runsOnPlay && e.result !== 'HR' ? `（${e.runsOnPlay}点）` : '';
  return { kind: 'pa', cls, parts: [u.playerLink(e.batterId), `: ${body}${pts}`] };
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

/** 対戦カード（現在の打者/投手・今日の結果・シーズン成績・B-S-Oランプ）。名前クリック→詳細モーダル。 */
function watchMatchup(v, u) {
  const { el, state, playerLink, fmt3, f2 } = u;
  const box = el('div', { class: 'matchup' });
  // B-S-O ランプ
  const lampRow = (label, n, max, cls) => el('div', { class: 'bsorow' }, [
    el('span', { class: 'bsolabel' }, label),
    ...Array.from({ length: max }, (_, i) => el('span', { class: 'lamp ' + cls + (i < n ? ' on' : '') }, '')),
  ]);
  box.append(el('div', { class: 'bso' }, [
    lampRow('B', Math.min(v.balls, 3), 3, 'lb'),
    lampRow('S', Math.min(v.strikes, 2), 2, 'ls'),
    lampRow('O', Math.min(v.outs, 2), 2, 'lo'),
  ]));
  // 打者（今日の打席結果＋シーズンAVG/HR/OPS）
  const bid = v.batterId;
  const bs = bid && state.res && state.res.statsById ? state.res.statsById.get(bid) : null;
  const bm = bs && bs.batting.pa > 0 ? playerBatting(bs, state.lc) : null;
  const d = bid ? v.daily.get(bid) : null;
  box.append(el('div', { class: 'murow' }, [
    el('span', { class: 'mulabel' }, '打者'),
    el('span', { class: 'muname' }, bid ? [playerLink(bid)] : '—'),
    el('span', { class: 'mutoday' }, d && (d.ab > 0 || d.res.length > 0) ? `今日 ${d.h}-${d.ab}${d.res.length ? `（${d.res.join('・')}）` : ''}` : '今日 第1打席'),
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
    ctrl.append(el('button', { class: 'primary', onclick: () => { game.watch = null; u.renderHub(); } }, 'ハブへ戻る'));
  }
  return ctrl;
}

/** 折りたたみ: 両軍スタメン表（打順/守/選手/当日成績）＋ベンチ・ブルペン残量。 */
function watchLineupPanel(v, u) {
  const { el, td, game, tname, posJP } = u;
  const w = game.watch;
  const box = el('div', { class: 'lineupbox' });
  box.append(el('button', { class: 'link', onclick: () => { w.showBench = !w.showBench; renderWatchScreen(u); } },
    `${w.showBench ? '▾' : '▸'} スタメン・ベンチ／ブルペン残量`));
  const body = el('div', { class: 'lineupbody' + (w.showBench ? '' : ' collapsed') });
  for (const side of ['away', 'home']) {
    const col = el('div', { class: 'lineupcol' });
    col.append(el('div', { class: 'muted' }, `${tname(v[side])} スタメン`));
    const rows = v.lineups[side].map((s, i) => {
      const d = v.daily.get(s.playerId);
      return el('tr', {}, [
        td(i + 1), td(posJP(s.pos), 'left'),
        el('td', { class: 'left' }, [u.playerLink(s.playerId)]),
        el('td', { class: 'left' }, d ? `${d.h}-${d.ab}${d.res.length ? `（${d.res.join('・')}）` : ''}` : '0-0'),
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
  box.append(body);
  return box;
}

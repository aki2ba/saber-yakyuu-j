// ============================================================================
// フェーズE4: 簡易ボックススコア（観戦イベント列 → 両軍打者/投手の当日集計行）
//
//   buildBoxScore(events) … simulateGame の onEvent 構造化イベント列
//     （start/atbat/pitch/pa/bunt/steal/sub/end・すべて乱数非消費）から、
//     日程・結果タブの「簡易ボックススコア」に必要な当日集計だけを組む純関数。
//
// 設計原則:
//   - §17（生イベント非永続）: 生イベント列はこの集計を作ったら捨てる。playerGameLog には
//     この「集計行のみ」が rec.box として残る（save の seasonState.playerGameLog も集計値のみ）。
//   - 決定論: 入力イベント列の純関数・乱数非使用。load の replay（advanceRuntimeDay 再走）でも
//     同一イベント列から同一の box が再構築される（セーブ→ロード→リプレイで bit 一致）。
//   - 簡易であること: 公式記録の細部（継承走者の失点帰属・暴投得点の打点除外等）は
//     「現在の投手/打者へ帰属」の近似で足りる（UI の当日ライン表示用。シーズン公式集計は
//     statline が正・本集計はそれに影響しない）。
// ============================================================================

/** 安打として数える打席結果。 */
const BOX_HIT_SET = new Set(['1B', '2B', '3B', 'HR']);

/**
 * 観戦イベント列から簡易ボックススコアを組む。
 * @param {Array} events simulateGame onEvent の構造化イベント列（1試合ぶん）
 * @returns {Object} {
 *   home, away, starters:{home,away},
 *   line:[{i,t,b}] イニング別得点（t=表/b=裏・null=未実施（サヨナラX等））,
 *   hits:{home,away}, errs:{home,away}, innings,
 *   batters:{home:[{pid,ord,pos,ab,h,hr,rbi,bb,k}],away:[...]}（出場順・bbは四死球）,
 *   pitchers:{home:[{pid,outs,np,h,r,bb,k,hr}],away:[...]}（登板順・rは在板中の失点）
 * }
 */
export function buildBoxScore(events) {
  const box = {
    home: null,
    away: null,
    starters: { home: null, away: null },
    line: [],
    hits: { home: 0, away: 0 },
    errs: { home: 0, away: 0 },
    innings: 9,
    batters: { home: [], away: [] },
    pitchers: { home: [], away: [] },
  };
  const batBy = new Map(); // pid → 打者集計行
  const pitBy = new Map(); // pid → 投手集計行
  const slots = { home: [], away: [] }; // 打順スロット（交代を追跡・pid列）
  const scores = { home: 0, away: 0 }; // イベント時点のスコア（batScore 同期＝暴投得点も拾う）
  const curPit = { home: null, away: null }; // 現在の投手（集計行参照）
  let curOuts = 0; // 現ハーフのアウト（盗塁死/犠打のアウト帰属用）
  let lastBatSide = 'away'; // pitch イベントの帰属（atbat が先行するため常に正しい）

  const sideOf = (teamId) => (teamId === box.home ? 'home' : 'away');
  const lineOf = (inning) => {
    let c = box.line.find((x) => x.i === inning);
    if (!c) { c = { i: inning, t: null, b: null }; box.line.push(c); }
    return c;
  };
  const startHalf = (inning, half) => {
    const c = lineOf(inning);
    const k = half === 'bottom' ? 'b' : 't';
    if (c[k] == null) c[k] = 0;
  };
  const batterOf = (pid, side, ord, pos) => {
    let b = batBy.get(pid);
    if (!b) { b = { pid, ord, pos, ab: 0, h: 0, hr: 0, rbi: 0, bb: 0, k: 0 }; batBy.set(pid, b); box.batters[side].push(b); }
    return b;
  };
  const pitcherOf = (pid, side) => {
    let p = pitBy.get(pid);
    if (!p) { p = { pid, outs: 0, np: 0, h: 0, r: 0, bb: 0, k: 0, hr: 0 }; pitBy.set(pid, p); box.pitchers[side].push(p); }
    return p;
  };
  /** batScore の増分をイニング得点と現投手の失点へ配る（暴投/捕逸の得点も batScore に含まれる）。 */
  const syncScore = (batSide, batScore, inning, half) => {
    const d = batScore - scores[batSide];
    if (d > 0) {
      const c = lineOf(inning);
      const k = half === 'bottom' ? 'b' : 't';
      c[k] = (c[k] ?? 0) + d;
      const fld = batSide === 'home' ? 'away' : 'home';
      if (curPit[fld]) curPit[fld].r += d;
      scores[batSide] = batScore;
    }
  };

  for (const e of events) {
    if (e.type === 'start') {
      box.home = e.home;
      box.away = e.away;
      box.starters.home = e.homeStarter;
      box.starters.away = e.awayStarter;
      curPit.home = pitcherOf(e.homeStarter, 'home');
      curPit.away = pitcherOf(e.awayStarter, 'away');
      for (const [side, lu] of [['home', e.homeLineup], ['away', e.awayLineup]]) {
        slots[side] = lu.map((s) => s.playerId);
        lu.forEach((s, i) => batterOf(s.playerId, side, i + 1, s.pos));
      }
    } else if (e.type === 'atbat') {
      const bSide = sideOf(e.batTeam);
      const fSide = bSide === 'home' ? 'away' : 'home';
      lastBatSide = bSide;
      startHalf(e.inning, e.half);
      curOuts = e.outs;
      // 現投手を権威値（atbat.pitcherId）で同期＋球数を登板累計（pitcherPitches）で補正
      curPit[fSide] = pitcherOf(e.pitcherId, fSide);
      if (e.pitcherPitches > curPit[fSide].np) curPit[fSide].np = e.pitcherPitches;
    } else if (e.type === 'pitch') {
      const fld = lastBatSide === 'home' ? 'away' : 'home';
      if (curPit[fld]) curPit[fld].np++;
    } else if (e.type === 'pa') {
      const bSide = sideOf(e.batTeam);
      const fSide = bSide === 'home' ? 'away' : 'home';
      const b = batterOf(e.batterId, bSide, null, '');
      const p = pitcherOf(e.pitcherId, fSide);
      const isHit = BOX_HIT_SET.has(e.result);
      // 打者ライン: 打数（四死球/犠飛を除く）・安打・本・打点・四死球・三振
      const sacFly = e.result === 'out' && e.runsOnPlay > 0 && e.battedType && e.battedType !== 'GB';
      if (!(e.outcome === 'BB' || e.outcome === 'HBP' || sacFly)) b.ab++;
      if (isHit) { b.h++; box.hits[bSide]++; }
      if (e.result === 'HR') b.hr++;
      if (e.outcome === 'BB' || e.outcome === 'HBP') b.bb++;
      if (e.outcome === 'K') b.k++;
      // 打点（簡易）: 失策と併殺ゴロ間の得点は打点なし（公式準拠・暴投分は近似で含む）
      const gbDp = e.result === 'out' && e.battedType === 'GB' && e.outsAfter - e.outsBefore >= 2;
      if (e.result !== 'E' && !gbDp) b.rbi += e.runsOnPlay;
      // 投手ライン: アウト・被安/被本・四死球・奪三振（失点は syncScore が現投手へ配る）
      p.outs += e.outsAfter - e.outsBefore;
      if (isHit) p.h++;
      if (e.result === 'HR') p.hr++;
      if (e.outcome === 'BB' || e.outcome === 'HBP') p.bb++;
      if (e.outcome === 'K') p.k++;
      if (e.result === 'E') box.errs[fSide]++;
      curOuts = e.outsAfter;
      syncScore(bSide, e.batScore, e.inning, e.half);
    } else if (e.type === 'bunt') {
      const bSide = sideOf(e.batTeam);
      const fSide = bSide === 'home' ? 'away' : 'home';
      const b = batterOf(e.batterId, bSide, null, '');
      const p = curPit[fSide];
      if (e.outcome === 'hit') { b.ab++; b.h++; box.hits[bSide]++; if (p) p.h++; }
      else if (e.outcome === 'fail') b.ab++;
      if (p) p.outs += Math.max(0, e.outsAfter - curOuts);
      curOuts = e.outsAfter;
      syncScore(bSide, e.batScore, e.inning, e.half);
    } else if (e.type === 'steal') {
      // 盗塁死は現投手のアウトに数える（在板中のアウト＝投球回の整合）
      if (e.outsAfter != null) {
        const fld = sideOf(e.batTeam) === 'home' ? 'away' : 'home';
        if (curPit[fld]) curPit[fld].outs += Math.max(0, e.outsAfter - curOuts);
        curOuts = e.outsAfter;
      }
    } else if (e.type === 'sub') {
      const side = sideOf(e.team);
      if (e.kind === 'RP') {
        curPit[side] = pitcherOf(e.inPid, side);
      }
      // 打順スロットの追跡（PH/PR/DEF＋DH無しリーグの投手交代も打順に入る）
      const idx = slots[side].indexOf(e.outPid);
      if (idx >= 0) {
        slots[side][idx] = e.inPid;
        const pos = e.kind === 'PH' ? '打' : e.kind === 'PR' ? '走' : e.kind === 'RP' ? 'P' : (e.pos || '守');
        batterOf(e.inPid, side, idx + 1, pos);
      }
    } else if (e.type === 'end') {
      box.innings = e.innings;
      syncScore('home', e.homeScore, e.innings, 'bottom');
      syncScore('away', e.awayScore, e.innings, 'top');
    }
  }
  box.line.sort((a, b) => a.i - b.i);
  return box;
}

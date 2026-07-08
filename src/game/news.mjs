// ============================================================================
// フェーズC4: ニュースフィード（週次ダイジェスト＋珍記録検出・phaseC_spec C4）
//
//   detectGameNotables(events)  … 1試合の観戦イベント列（onEvent の pa/start/end）から
//        ノーヒットノーラン・完全試合・サイクル安打・猛打賞を検出する（純関数）。
//   streakOf(gameLog, teamId)   … 直近の連勝/連敗を数える。
//   weeklyDigest({...})         … 自チームの直近成績から見出しをテンプレ生成（実データ差し込み）。
//
// 決定論: すべて入力（イベント列/試合ログ/順位表）の純関数。乱数非使用（onEvent は乱数非消費＝
//   検出の有無は試合結果に一切影響しない＝既存50較正が不変）。生イベントは当該シーズンのみ（§17）。
// ============================================================================
import { gamesBehind } from '../sim/season.mjs';

const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR']);
/** 出塁（安打＋四死球＋失策）。完全試合の判定に使う（走者を一人も出さない）。 */
const REACH_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'BB', 'HBP', 'E']);

/**
 * 1試合の観戦イベント列から珍記録を検出する。events は onEvent の構造化イベント
 * （type: 'start'|'pa'|'end'|'steal'|'sub'）。'pa' の result/outcome/pitTeam/batTeam/batterId を使う。
 * @param {Array} events
 * @returns {Array} [{kind, ...}] kind='noHitter'|'perfectGame'|'cycle'|'multiHit'
 */
export function detectGameNotables(events) {
  let start = null;
  let end = null;
  const byPitTeam = new Map(); // pitTeam → {hits, reaches, batTeam}
  const byBatter = new Map(); // batterId → {teamId, hits, types:Set}
  for (const e of events) {
    if (e.type === 'start') start = e;
    else if (e.type === 'end') end = e;
    else if (e.type === 'pa') {
      let pt = byPitTeam.get(e.pitTeam);
      if (!pt) { pt = { hits: 0, reaches: 0, batTeam: e.batTeam }; byPitTeam.set(e.pitTeam, pt); }
      if (HIT_RESULTS.has(e.result)) pt.hits++;
      if (REACH_RESULTS.has(e.result)) pt.reaches++;
      let bt = byBatter.get(e.batterId);
      if (!bt) { bt = { teamId: e.batTeam, hits: 0, types: new Set() }; byBatter.set(e.batterId, bt); }
      if (HIT_RESULTS.has(e.result)) { bt.hits++; bt.types.add(e.result); }
    }
  }
  const out = [];
  // ノーヒッター/完全試合は試合完了（end）が前提。
  if (end) {
    for (const [pitTeam, pt] of byPitTeam) {
      if (pt.hits === 0) {
        if (pt.reaches === 0) out.push({ kind: 'perfectGame', teamId: pitTeam, opponent: pt.batTeam });
        else out.push({ kind: 'noHitter', teamId: pitTeam, opponent: pt.batTeam });
      }
    }
  }
  // サイクル安打（単/二/三/本の4種を1試合で）／猛打賞（3安打以上）。
  for (const [batterId, bt] of byBatter) {
    if (bt.types.size === 4) out.push({ kind: 'cycle', batterId, teamId: bt.teamId });
    if (bt.hits >= 3) out.push({ kind: 'multiHit', batterId, teamId: bt.teamId, hits: bt.hits });
  }
  return { start, end, notables: out };
}

/** 珍記録を日本語見出しへ（pnameOf: id→選手名, tnameOf: id→球団名）。 */
export function notableHeadline(n, pnameOf, tnameOf) {
  if (n.kind === 'perfectGame') return `完全試合達成！ ${tnameOf(n.teamId)} の投手陣が ${tnameOf(n.opponent)} を完璧に封じる`;
  if (n.kind === 'noHitter') return `ノーヒットノーラン！ ${tnameOf(n.teamId)} が ${tnameOf(n.opponent)} 相手に無安打`;
  if (n.kind === 'cycle') return `サイクル安打！ ${pnameOf(n.batterId)} が単打・二塁打・三塁打・本塁打をすべて記録`;
  if (n.kind === 'multiHit') return `${pnameOf(n.batterId)} が猛打賞（${n.hits}安打）の固め打ち`;
  return '';
}

/**
 * 昇降格ニュース見出し（F2-3）。mv = rt.rosterMoves / step.rosterMoves の1件。
 * off要約・週次ダイジェスト・ハブのニュース欄の素材（純関数・乱数非使用）。
 * @param {{type:string, teamId:string, upName:string, upPos:string, downName:string, downPos:string}} mv
 * @param {Function} tnameOf teamId→球団名
 */
export function rosterMoveHeadline(mv, tnameOf) {
  const t = tnameOf(mv.teamId);
  if (mv.type === 'ilReplace') return `${t}、${mv.downName}（${mv.downPos}）が故障で登録抹消 — 二軍から${mv.upName}を昇格`;
  if (mv.type === 'ilReturn') return `${t}、${mv.upName}（${mv.upPos}）が離脱から復帰し一軍登録（${mv.downName}は登録抹消）`;
  if (mv.type === 'perfSwap') return `${t}、不振の${mv.downName}（${mv.downPos}）を登録抹消 — 二軍で好調の${mv.upName}を昇格`;
  return '';
}

/**
 * 直近の連勝/連敗を数える（自チーム視点・最新試合から遡る）。
 * @param {Array} gameLog [{home,away,homeScore,awayScore,tie}]
 * @returns {{type:'W'|'L'|'T'|null, len:number}}
 */
export function streakOf(gameLog, teamId) {
  let type = null;
  let len = 0;
  for (let i = gameLog.length - 1; i >= 0; i--) {
    const g = gameLog[i];
    if (g.home !== teamId && g.away !== teamId) continue;
    const isHome = g.home === teamId;
    const my = isHome ? g.homeScore : g.awayScore;
    const opp = isHome ? g.awayScore : g.homeScore;
    const r = g.tie ? 'T' : my > opp ? 'W' : 'L';
    if (type === null) { type = r; len = 1; }
    else if (r === type) len++;
    else break;
  }
  return { type, len };
}

/** 自リーグ内の順位とゲーム差（首位攻防の判定素）。 */
function rankAndGb(standings, teamId) {
  const row = standings.find((r) => r.teamId === teamId);
  if (!row) return null;
  const lg = standings.filter((r) => (r.league ?? 'ALL') === (row.league ?? 'ALL'));
  lg.sort((a, b) => (b.w - b.l) - (a.w - a.l) || (b.rs - b.ra) - (a.rs - a.ra));
  const rank = lg.findIndex((r) => r.teamId === teamId) + 1;
  const top = lg[0];
  const gb = gamesBehind(top, row); // 標準的なゲーム差
  const gp = row.w + row.l + (row.t || 0); // 消化試合数（開幕直後の「首位快走」誤発火を防ぐガード用）
  return { rank, gb, total: lg.length, gp };
}

/**
 * 週次ダイジェスト見出し（自チーム・実データ差し込み）。テンプレ文＋直近成績。
 * @param {{gameLog:Array, standings:Array, teamId:string, nameOf:Function, recentN?:number}} o
 * @returns {Array} [{text, cls}]（cls='good'|'bad'|'info'）
 */
export function weeklyDigest({ gameLog, standings, teamId, nameOf, recentN = 7 }) {
  const out = [];
  const myName = nameOf(teamId);
  // 連勝/連敗
  const st = streakOf(gameLog, teamId);
  if (st.type === 'W' && st.len >= 3) out.push({ text: `${myName}、${st.len}連勝で波に乗る！`, cls: 'good' });
  else if (st.type === 'L' && st.len >= 3) out.push({ text: `${myName}、${st.len}連敗…反攻なるか`, cls: 'bad' });
  // 首位攻防（開幕直後は全チーム勝率.000で並ぶため、順位の意味が生まれる試合数まではガード）
  const rg = rankAndGb(standings, teamId);
  if (rg && rg.gp >= 5) {
    if (rg.rank === 1) out.push({ text: `${myName}が首位快走（${rg.total}球団中1位）`, cls: 'good' });
    else if (rg.gb <= 3) out.push({ text: `首位攻防、${myName}は${rg.rank}位・${rg.gb.toFixed(1)}ゲーム差の激戦`, cls: 'info' });
  }
  // 直近の完封勝ち／大勝
  const myGames = gameLog.filter((g) => g.home === teamId || g.away === teamId).slice(-recentN);
  for (const g of myGames) {
    const isHome = g.home === teamId;
    const my = isHome ? g.homeScore : g.awayScore;
    const opp = isHome ? g.awayScore : g.homeScore;
    const oppId = isHome ? g.away : g.home;
    if (opp === 0 && my > 0) { out.push({ text: `${myName}が${nameOf(oppId)}を完封（${my}-0）`, cls: 'good' }); break; }
  }
  for (const g of myGames) {
    const isHome = g.home === teamId;
    const my = isHome ? g.homeScore : g.awayScore;
    const opp = isHome ? g.awayScore : g.homeScore;
    const oppId = isHome ? g.away : g.home;
    if (my - opp >= 7) { out.push({ text: `${myName}が${nameOf(oppId)}に${my}-${opp}の大勝`, cls: 'good' }); break; }
  }
  return out;
}

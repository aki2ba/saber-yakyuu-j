// ============================================================================
// Q2: 育成方針の「コーチ経過報告」（thyroxin/research/baseball_game_mechanics_research_20260723 Q2・
//   OOTP Player Development Lab 2.0 の進捗バー/中間レポート翻案）。
//
//   coachReportPhase(state)              … 現在dayが「全日程の1/3・2/3を跨いだ最初の週」なら
//                                           'mid'|'late' を返す（それ以外は null）。
//   coachProgressReports(state, names)   … その週に設定中の育成方針（自チームのみ）ぶん、コーチの
//                                           経過報告テキストを生成する（純関数）。
//
// 設計原則（CLAUDE.md鉄則・タスク仕様の厳守事項）:
//   - 観測statlineのみ: rt.playerGameLog の当日ボックス（ab/h/hr/bb/k・outs/r/bb/k/hr・出場位置）
//     だけを使う。真値(trueAbility)・coachOverallScore（層3=スカウトの見立て）は一切参照しない
//     （三層構造: 本ファイルは「層2＝観測成績」の推移だけを文章化する）。
//   - 決定論: テンプレ選択は hashSeed(masterSeed,'coachreport',year,phase,axisKind,playerId) の
//     独立座標のみ（既存の生成/進行ストリーム・他のニュース系座標と非干渉）。
//   - サンプルが薄い（半期のAB/IP/出場試合が閾値未満）選手は「まだ判断できない」として報告を
//     出さない（nicknameFor の「未知数」ゲートと同じ思想＝憶測を書かない）。
//   - 新規保存フィールド無し: state.trainingPolicies（既存H4ログ）とrt.playerGameLog（当季のみ）
//     だけから毎回その場で導出する（§17に準拠・保存データは増やさない）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { pendingDay } from './season_runtime.mjs';
import { parsePolicy, TRAINING_LABELS } from './training.mjs';

// バンドル同一スコープ制約のため一意名（storylines.mjs の idAsc と衝突回避）。
const idAscCr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** playerGameLog の1試合分から、指定playerIdの打者/投手ボックス行を探す（無ければnull）。 */
function findBatterLine(rec, playerId) {
  const box = rec.box;
  if (!box) return null;
  return (box.batters?.home ?? []).find((b) => b.pid === playerId)
    ?? (box.batters?.away ?? []).find((b) => b.pid === playerId)
    ?? null;
}
function findPitcherLine(rec, playerId) {
  const box = rec.box;
  if (!box) return null;
  return (box.pitchers?.home ?? []).find((p) => p.pid === playerId)
    ?? (box.pitchers?.away ?? []).find((p) => p.pid === playerId)
    ?? null;
}

/**
 * 現在の経過日を「前半／後半」に二分し、その選手の当季ぶんの打撃ボックスを両半へ積む
 * （playerGameLog は自チーム試合のみ・§17=当該シーズンのみの生存データ）。
 * @returns {{early:Object, late:Object}} 各半期 {ab,h,hr,bb,games,posCount:Map<pos,count>}
 */
function battingHalfSplit(state, playerId) {
  const rt = state.rt;
  const elapsed = pendingDay(rt);
  const mid = elapsed / 2;
  const mk = () => ({ ab: 0, h: 0, hr: 0, bb: 0, games: 0, posCount: new Map() });
  const early = mk();
  const late = mk();
  for (const rec of rt.playerGameLog) {
    const line = findBatterLine(rec, playerId);
    if (!line) continue;
    const bucket = rec.day < mid ? early : late;
    bucket.ab += line.ab || 0;
    bucket.h += line.h || 0;
    bucket.hr += line.hr || 0;
    bucket.bb += line.bb || 0;
    bucket.games += 1;
    if (line.pos) bucket.posCount.set(line.pos, (bucket.posCount.get(line.pos) || 0) + 1);
  }
  return { early, late };
}

/** 同・投手ボックス版（outs/h/r/bb/k/hr）。 */
function pitchingHalfSplit(state, playerId) {
  const rt = state.rt;
  const elapsed = pendingDay(rt);
  const mid = elapsed / 2;
  const mk = () => ({ outs: 0, r: 0, bb: 0, k: 0, hr: 0, games: 0 });
  const early = mk();
  const late = mk();
  for (const rec of rt.playerGameLog) {
    const line = findPitcherLine(rec, playerId);
    if (!line) continue;
    const bucket = rec.day < mid ? early : late;
    bucket.outs += line.outs || 0;
    bucket.r += line.r || 0;
    bucket.bb += line.bb || 0;
    bucket.k += line.k || 0;
    bucket.hr += line.hr || 0;
    bucket.games += 1;
  }
  return { early, late };
}

const fmtAvgCr = (v) => v.toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.');
const pctFmt = (v) => `${(v * 100).toFixed(1)}%`;

const MIN_AB_PER_HALF = 15; // 打撃トレンド判定の最低打数（半期あたり）
const AVG_UP_DELTA = 0.02; // 打率が上向いたとみなす差
const HR_RATE_UP_DELTA = 0.015; // 本塁打/打数 が上向いたとみなす差

/** 打撃方針の観測トレンド（打率・本塁打ペースの前半/後半比較）。サンプル不足はnull。 */
function battingTrend(early, late) {
  if (early.ab < MIN_AB_PER_HALF || late.ab < MIN_AB_PER_HALF) return null;
  const avgE = early.h / early.ab;
  const avgL = late.h / late.ab;
  const hrRE = early.hr / early.ab;
  const hrRL = late.hr / late.ab;
  const avgDelta = avgL - avgE;
  const hrDelta = hrRL - hrRE;
  const up = avgDelta >= AVG_UP_DELTA || hrDelta >= HR_RATE_UP_DELTA;
  return { bucket: up ? 'up' : 'flat', avgE, avgL, hrRE, hrRL };
}
function battingDescr(t) {
  return `打率${fmtAvgCr(t.avgE)}→${fmtAvgCr(t.avgL)}、本塁打ペース${pctFmt(t.hrRE)}→${pctFmt(t.hrRL)}`;
}

const MIN_OUTS_PER_HALF = 30; // 半期あたり最低10イニング相当
const ERA_UP_DELTA = 0.7; // 目安防御率（自責点近似=r）が改善したとみなす差（低いほど良い）
const K9_UP_DELTA = 0.8; // 9回換算奪三振が向上したとみなす差

/** 投手の観測トレンド（目安防御率・9回換算奪三振の前半/後半比較）。サンプル不足はnull。 */
function pitchingTrend(early, late) {
  if (early.outs < MIN_OUTS_PER_HALF || late.outs < MIN_OUTS_PER_HALF) return null;
  const ipE = early.outs / 3;
  const ipL = late.outs / 3;
  const eraE = (early.r * 9) / ipE;
  const eraL = (late.r * 9) / ipL;
  const k9E = (early.k * 9) / ipE;
  const k9L = (late.k * 9) / ipL;
  const up = eraL - eraE <= -ERA_UP_DELTA || k9L - k9E >= K9_UP_DELTA;
  return { bucket: up ? 'up' : 'flat', eraE, eraL, k9E, k9L };
}
function pitchingDescr(t) {
  return `目安防御率${t.eraE.toFixed(2)}→${t.eraL.toFixed(2)}、奪三振ペース${t.k9E.toFixed(1)}→${t.k9L.toFixed(1)}（9回換算）`;
}

const MIN_GAMES_PER_HALF = 3; // 出場機会トレンド判定の最低試合数（半期あたり）
const POS_SHARE_UP_DELTA = 0.2; // コンバート先ポジションの出場比率が定着してきたとみなす差

/** コンバート方針: 対象ポジションでの出場比率の前半/後半比較。サンプル不足はnull。 */
function convertTrend(early, late, pos) {
  if (early.games < MIN_GAMES_PER_HALF || late.games < MIN_GAMES_PER_HALF) return null;
  const shareE = (early.posCount.get(pos) || 0) / early.games;
  const shareL = (late.posCount.get(pos) || 0) / late.games;
  return { bucket: shareL - shareE >= POS_SHARE_UP_DELTA ? 'up' : 'flat', shareE, shareL };
}
function convertDescr(t, posLabel) {
  return `${posLabel}での出場比率${pctFmt(t.shareE)}→${pctFmt(t.shareL)}`;
}

/** 守備/走塁/休養/バランス方針のフォールバック: 出場機会（試合数）の前半/後半比較。 */
function usageTrend(early, late) {
  if (early.games < MIN_GAMES_PER_HALF || late.games < MIN_GAMES_PER_HALF) return null;
  return { bucket: late.games - early.games >= 1 ? 'up' : 'flat', gE: early.games, gL: late.games };
}
function usageDescr(t) {
  return `出場${t.gE}試合→${t.gL}試合`;
}

const REPORT_CLOSERS = {
  up: [
    '方針の効果が出てきているようです。',
    '狙い通りの成長曲線に見えます。',
  ],
  flat: [
    'まだ目に見える成果は出ていません。',
    '効果が数字に表れるのはこれからかもしれません。',
  ],
};

/** テンプレ選択＋整形（hashSeed独立座標＝表示文言のみ・結果に非干渉）。 */
function finalizeReport(state, playerId, axisKind, phase, bucket, descr, policyLabel, special) {
  const r = makeRng(hashSeed(state.masterSeed, 'coachreport', state.year, phase, axisKind, playerId));
  const closers = REPORT_CLOSERS[bucket];
  const closer = closers[r.int(closers.length)];
  const specialTag = special ? '（特別指導）' : '';
  return {
    playerId, axisKind, phase, bucket,
    text: `【${policyLabel}${specialTag}】${descr}。${closer}`,
    cls: bucket === 'up' ? 'good' : 'info',
  };
}

/** 選手1名ぶんの経過報告を組む（役割/方針の種類で対象トレンドを切り替える）。サンプル不足はnull。 */
function buildCoachReport(state, p, tp, phase, posLabelOf) {
  const parsed = parsePolicy(tp.policy);
  if (!parsed) return null;
  const policyLabel = parsed.kind === 'convert' ? `コンバート（${posLabelOf(parsed.pos)}）` : (TRAINING_LABELS[parsed.kind] ?? parsed.kind);

  if (p.role === 'pitcher') {
    const { early, late } = pitchingHalfSplit(state, p.id);
    const t = pitchingTrend(early, late);
    if (!t) return null;
    return finalizeReport(state, p.id, 'pitching', phase, t.bucket, pitchingDescr(t), policyLabel, tp.special);
  }
  if (parsed.kind === 'batting') {
    const { early, late } = battingHalfSplit(state, p.id);
    const t = battingTrend(early, late);
    if (!t) return null;
    return finalizeReport(state, p.id, 'batting', phase, t.bucket, battingDescr(t), policyLabel, tp.special);
  }
  if (parsed.kind === 'convert') {
    const { early, late } = battingHalfSplit(state, p.id);
    const t = convertTrend(early, late, parsed.pos);
    if (!t) return null;
    return finalizeReport(state, p.id, 'convert', phase, t.bucket, convertDescr(t, posLabelOf(parsed.pos)), policyLabel, tp.special);
  }
  // defense/speed/rest/balanced: 打席ボックスから拾える具体指標が無いため、観測できる唯一の事実
  //   （出場機会の推移）を報告する。
  const { early, late } = battingHalfSplit(state, p.id);
  const t = usageTrend(early, late);
  if (!t) return null;
  return finalizeReport(state, p.id, parsed.kind, phase, t.bucket, usageDescr(t), policyLabel, tp.special);
}

/**
 * 現在dayが「全日程の1/3・2/3を跨いだ最初の週」なら 'mid'|'late' を返す（研究レポートQ2の
 * 「シーズン中盤・終盤」トリガー）。週の幅は cfg.game.daysPerWeek（既存P3週次目標と同じ境界）。
 * @param {Object} state GameState（state.rt が必要）
 * @returns {'mid'|'late'|null}
 */
export function coachReportPhase(state) {
  const rt = state.rt;
  if (!rt || rt.finalDay == null || rt.finalDay < 0) return null;
  const elapsed = pendingDay(rt);
  const span = state.cfg.game.daysPerWeek;
  const total = rt.finalDay + 1;
  const midDay = Math.floor(total / 3);
  const lateDay = Math.floor((total * 2) / 3);
  if (elapsed >= midDay && elapsed < midDay + span) return 'mid';
  if (elapsed >= lateDay && elapsed < lateDay + span) return 'late';
  return null;
}

/**
 * Q2: 育成方針の「コーチ経過報告」一覧（自チーム・当年ぶんの state.trainingPolicies のみ対象）。
 * coachReportPhase が null（中盤/終盤の窓の外）のときは常に空配列。
 * @param {Object} state GameState
 * @param {{posLabelOf?:Function}} names posLabelOf: 守備位置コード→表示ラベル（既定は識別子そのまま）
 * @returns {Array<{playerId:string, axisKind:string, phase:string, bucket:'up'|'flat', text:string, cls:string}>}
 */
export function coachProgressReports(state, names = {}) {
  const phase = coachReportPhase(state);
  if (!phase || !state.rt) return [];
  const { posLabelOf = (pos) => pos } = names;
  const rows = (state.trainingPolicies || []).filter((tp) => tp.yearIndex === state.yearIndex);
  const out = [];
  for (const tp of rows) {
    const p = state.league.players.find((x) => x.id === tp.playerId && x.teamId === state.playerTeamId);
    if (!p) continue;
    const rep = buildCoachReport(state, p, tp, phase, posLabelOf);
    if (rep) out.push(rep);
  }
  out.sort((a, b) => idAscCr(a.playerId, b.playerId));
  return out;
}

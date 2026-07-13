// ============================================================================
// 故障の「オフシーズン処理」（§10.5）— 当季に**試合中に発生した**故障の結果を真値へ落とす
//
// ★R3（2026-07-13）: 故障の発生自体は src/sim/injury.mjs ＋ sim/game.mjs へ移した
//   （試合中の露出イベントごとのハザード）。旧 applyInjuries（オフに1選手1回ロールして
//   翌年の開幕ILにする簡略化）は撤去。ここに残るのは「当季の故障ログを消費して
//   故障歴を積み・後遺（能力減）を真値へ適用する」オフシーズンの後処理のみ。
//
// なぜ分けるか:
//   - **真値はシーズン中に動かさない**（C2a の不変量「1年目シーズン中に真値/年齢は動かない」）。
//     試合中に確定するのは「離脱の事実（severity/gamesLost）」だけで、能力への影響はオフに入る。
//   - **load の replay 可能性**: 過去年のオフは season を再シムせずに再走する（index.mjs load）。
//     故障が試合由来になったので、当季の故障ログを save に永続し（state.injuryLog）、
//     replay ではそのログを渡して同一の後遺・故障歴を再構築する（farmPromotionLog と同じ方式）。
// ============================================================================
import { clamp, clampRating } from '../model/util.mjs';

/**
 * 当季に発生した故障イベントを消費し、故障歴の積み上げと後遺（真値の一時減）を適用する。
 * オフシーズン遷移から呼ばれる純関数（in-place・乱数非使用＝決定論・順序非依存）。
 *
 * @param {Array} players league.players（引退で消えた選手は events 側で無視される）
 * @param {Array<{id:string, severity:string, gamesLost:number}>} events 当季の故障ログ
 * @param {Object} cfg createConfig()
 * @param {number} year 当該シーズンの年（履歴に記録）
 * @returns {Array} 適用した故障イベント（サマリ表示用。players に居ない id は落とす）
 */
export function applySeasonInjuries(players, events, cfg, year) {
  const byId = new Map(players.map((p) => [p.id, p]));
  const applied = [];
  // 決定論・順序非依存: id 昇順→同一選手内は day 昇順で適用する（ログの並びに依存しない）。
  const sorted = events
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : (a.day ?? 0) - (b.day ?? 0)));
  for (const ev of sorted) {
    const p = byId.get(ev.id);
    if (!p) continue; // 引退/移籍で league.players に居ない（＝安全弁）
    const hist = p.trueAbility.career.injuryHistory ?? (p.trueAbility.career.injuryHistory = []);
    hist.push({ year, severity: ev.severity, gamesLost: ev.gamesLost });
    applyAftereffect(p, ev.severity, cfg.tuning.injury);
    applied.push({ id: p.id, year, severity: ev.severity, gamesLost: ev.gamesLost });
  }
  return applied;
}

/**
 * 後遺（§10.5）: 復帰後の一時的な能力減を真値へ反映する。身体系（走力・初動・パワー）を
 * 中心に落とし、技巧系は残す（＝技巧派の生存に効く）。投手の重症は球速低下の始まり（非対称）。
 * ここで落ちた分は以後の加齢カーブ（成長ドリフト）で部分的に回復しうる（点でなく幅で・§10.3）。
 */
function applyAftereffect(p, severity, inj) {
  const mag = severity === 'major' ? inj.aftMajor : inj.aftMinor;
  const t = p.trueAbility;
  t.common.speed = clampRating(t.common.speed - mag);
  t.common.reaction = clampRating(t.common.reaction - mag);
  t.common.power = clampRating(t.common.power - mag * 0.6);
  t.batting.ev = clampRating(t.batting.ev - mag * 0.6);
  if (p.role === 'pitcher' && severity === 'major') {
    t.pitching.velocityKmh = clamp(t.pitching.velocityKmh - inj.aftVeloMajor, 130, 165);
    t.pitching.control = clampRating(t.pitching.control - mag * 0.5);
  }
}

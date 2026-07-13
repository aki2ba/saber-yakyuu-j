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
    hist.push({ year, site: ev.site ?? null, siteName: ev.siteName ?? null, severity: ev.severity, gamesLost: ev.gamesLost });
    applyAftereffect(p, ev, cfg.tuning.injury);
    applied.push({ id: p.id, year, site: ev.site ?? null, siteName: ev.siteName ?? null, severity: ev.severity, gamesLost: ev.gamesLost });
  }
  return applied;
}

/**
 * 後遺（§10.5・★R6 文献調査に基づく再設計）。
 *
 * 【旧実装の誤り】故障するたびに走力・初動・パワー・EV を恒久的に削っていた。
 *   これは実証と食い違う。**「率は戻るが、出場量は戻らない」**（Camp et al., n=216 / Lansdown & Feeley, n=80）:
 *     - トミー・ジョン術後: **K%/BB%/FIP は有意差なし（＝率は戻る）**。球速だけ −0.7mph
 *       （35歳以上は −2.9mph と大きい）
 *     - 一方 **登板数 120.7→72.6・投球回 338.1→223.6 は術後3年平均でも回復しない（P<.001）**
 *     - ACL再建後も ERA/WHIP/打率/OBP/SLG はすべて有意差なし（Erickson, n=124）
 *     - 肩関節唇修復後は **キャリア長そのものが短縮**（投手 2.3年 vs 対照 5.8年）
 *
 * 【新実装】削るのは "出場量" の側:
 *   - 軽症: 恒久的な能力低下なし（率は戻る）
 *   - 重症の投手: **スタミナ**（＝登板数/イニングの上限）と球速を削る。35歳以上は球速を大きく削る
 *   - 重症の下肢（ハム/膝/足首/鼠径）: 走力・初動を削る（走塁・守備範囲＝身体的な"量"）
 *   - 重症の肩: 引退圧を上げる（キャリア長が縮む）
 *   打撃の"率"（contact/eye/la）とパワー/EV は **触らない**。
 */
function applyAftereffect(p, ev, inj) {
  const A = inj.aftereffect;
  if (ev.severity !== 'major') return; // 軽症は率も量も戻る（A.minorNone）
  const t = p.trueAbility;
  if (p.role === 'pitcher') {
    // 出場量: スタミナ恒久減（登板数・投球回が戻らない）
    t.pitching.stamina = clampRating(t.pitching.stamina - A.majorStamina);
    const dv = p.age >= A.oldAge ? A.majorVeloKmhOld : A.majorVeloKmh;
    t.pitching.velocityKmh = clamp(t.pitching.velocityKmh - dv, 130, 165);
  }
  if (A.lowerBodySites.includes(ev.site)) {
    t.common.speed = clampRating(t.common.speed - A.majorLowerBodySpeed);
    t.common.reaction = clampRating(t.common.reaction - A.majorLowerBodyReaction);
  }
}

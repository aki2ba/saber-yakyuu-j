// ============================================================================
// 故障ハザード（§10.5）— シム層（試合中の発生）とゲーム層（オフの後遺処理）の共有定義
//
// ★R3 再設計（2026-07-13・ユーザー指示「シーズン中、何なら試合中の故障は実装してください」）:
//   旧実装は「オフシーズンに“その年に故障したか”を1選手1回の確率で決め、**翌年の開幕IL**として
//   持ち込む」という簡略化だった（src/game/injury.mjs）。そのため
//     ・1年目は故障者が皆無（プレイヤーが最初に遊ぶ年に誰も壊れない）
//     ・2年目以降も「開幕時点で既に離脱している」選手しか存在せず、**シーズン中に壊れない**
//     ・結果、一軍/二軍の入替が NPB の 1/5（実測 9.8件/球団年 ⇔ NPB 実入替 50-70回）に留まり、
//       一軍出場の異なり選手も 35.8人（NPB 61人）しか出なかった
//   → 故障は「試合中の露出イベント（打席・投球・守備機会）ごとのハザード」として発生させる。
//     壊れた選手はその場で退き（投手は即降板・野手はベンチと交代）、以後の試合を離脱する。
//     離脱者は roster_moves の IL補充（既存機能）で二軍から補充される＝入替が自然に湧く。
//
// 設計原則:
//   - 予測でなくハザード（§10.5）: 誰が壊れるかは確率事象。合わせるのは集団の分布（§1）。
//   - 決定論: 乱数は試合の階層シード rng のみ（Date.now/Math.random 禁止）。
//   - **真値はシーズン中に動かさない**（鉄則7の実装上の含意・C2a テストの不変量）:
//     試合中に決まるのは「離脱の事実（severity/gamesLost）」だけ。後遺（能力減）と故障歴の
//     積み上げは**オフシーズンに当季の故障ログを消費して**適用する（game/injury.mjs）。
//   - 三層構造: ハザードは真値（年齢・球速・故障歴）で決まる（＝身体の事実であって観測ではない）。
// ============================================================================
import { clamp } from '../model/util.mjs';

/**
 * 1選手の「1シーズンあたり」故障ハザード（0..cap）。年齢・守備位置・投球負荷・故障歴（再発）で上下。
 * 故障歴が増える／重症化するほど再発リスクが上がる（§10.5「最大リスク・再発」）。
 * R3ではこの値を **露出イベント1回あたりの確率へ正規化する係数** としても使う（exposureProb）。
 * @returns {number} このシーズンに故障する確率のスケール（refHazard=平均的選手の基準値）
 */
export function injuryHazard(p, cfg) {
  const inj = cfg.tuning.injury;
  const t = p.trueAbility;
  const hist = t.career.injuryHistory ?? [];
  let h = inj.base;
  h += Math.max(0, p.age - inj.ageRamp) * inj.agePerYear;
  if (p.role === 'pitcher') {
    h += inj.pitcher;
    h += Math.max(0, t.pitching.velocityKmh - inj.veloRef) * inj.veloPerKmh; // 球速＝投球負荷の代理
  }
  if (p.primaryPos === 'C') h += inj.catcher; // R3: 割増は0（捕手の負傷"頻度"は他ポジより低い・Guy 2015）
  // 故障歴（再発・最大リスク）: 件数×重症度で将来リスクが上がる。
  //   ★R4: 合計に上限（recurCap）を設ける。無制限に累積すると、試合中の故障（R3）で履歴が
  //   早く積み上がり、多年運用でリーグ全体が壊れやすくなって出場時間が削れる（規定到達が
  //   較正帯を割る）。「前回の故障が最大の予測因子」は事実だが、青天井ではない。
  let priorMajor = false;
  let recur = 0;
  for (const e of hist) {
    recur += e.severity === 'major' ? inj.recurMajor : inj.recurMinor;
    if (e.severity === 'major') priorMajor = true;
  }
  h += Math.min(recur, inj.recurCap ?? Infinity);
  // 投手の大怪我経験は以後の恒常的な将来リスク（非対称・§10.5）。
  if (p.role === 'pitcher' && priorMajor) h += inj.pitcherMajorLegacy;
  return clamp(h, 0, inj.cap);
}

/**
 * 露出イベント1回あたりの故障確率（R3）。
 *   kind: 'perPA'（打者の1打席＝スイング・走塁） / 'perBF'（投手の対戦打者1人＝肩肘の消耗）
 *       / 'perFieldPlay'（野手が処理した打球1つ） / 'perCatcherPA'（捕手の守備1打席＝ファウルチップ/ブロッキング）
 * 個体差は injuryHazard を refHazard で割った倍率で入れる（＝ハザードの形を1箇所に集約する）。
 * これにより「高球速ほど壊れる」「加齢で壊れる」「再発する」が試合中の発生にもそのまま効く。
 *
 * 【契機の配分について】現実の"試合中"の負傷は 投球23%/打撃24%/守備23%/走塁22% とほぼ均等
 * （Esquivel 2019）。本モデルは走塁を perPA に含め、さらに **投手の perBF に「試合外の投げ込み
 * （現実の故障の37%が試合外・うち29.8%が throwing）」を吸収させている**（＝投球回数に比例する
 * 消耗の代理）。そのため契機の内訳は投球側に寄るが、**観測される投手:野手の件数比 1.0-1.3:1
 * （NPB実測）に一致する**ことを較正の対象とする（realism-check Part F）。
 */
export function exposureProb(p, kind, cfg) {
  const IS = cfg.tuning.injury.inSeason;
  const base = IS[kind] ?? 0;
  if (!base) return 0;
  return base * (injuryHazard(p, cfg) / IS.refHazard);
}

/**
 * 故障の重さと離脱試合数を引く（故障が起きたと決まった後に呼ぶ）。
 * 故障歴があると重症化しやすく、投手の大怪我経験は更に重くなりやすい（再発の悪循環・§10.5）。
 * @returns {{severity:'minor'|'major', gamesLost:number}}
 */
export function rollInjurySeverity(p, cfg, prng) {
  const inj = cfg.tuning.injury;
  const hist = p.trueAbility.career.injuryHistory ?? [];
  const priorMajor = hist.some((e) => e.severity === 'major');
  let majorP = inj.majorGivenInjury;
  if (hist.length) majorP += inj.majorHistBonus;
  // R3: 投手・捕手は「頻度」でなく「重症度」で差がつく（肩肘/膝・頭頸部は離脱が長い）。
  if (p.role === 'pitcher') majorP += inj.majorPitcher ?? 0;
  if (p.primaryPos === 'C') majorP += inj.majorCatcher ?? 0;
  if (p.role === 'pitcher' && priorMajor) majorP += inj.majorPitcherLegacy;
  const major = prng.chance(clamp(majorP, 0, 0.95));
  const gamesLost = major
    ? inj.majorGamesLo + prng.int(inj.majorGamesHi - inj.majorGamesLo + 1)
    : inj.minorGamesLo + prng.int(inj.minorGamesHi - inj.minorGamesLo + 1);
  return { severity: major ? 'major' : 'minor', gamesLost };
}

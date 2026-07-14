// ============================================================================
// H4: 育成方針・キャンプ（phaseH_fun_spec H4・期待値保存の間接介入）
//
//   本モジュールは「方針の意味論」（policy文字列の解析・軸グループの対象判定・
//   AI球団の自動方針・コーチの見立てスカラー）だけを持つ純関数群（ヘッドレス）。
//   実際に trueAbility を動かす（curveDelta へ倍率を掛ける）のは src/game/aging.mjs 側
//   （grow/decline の実体・軸の列挙は aging.mjs が握っている＝二重管理を避ける）。
//
// 設計原則（phaseH_fun_spec 全柱共通の鉄則・H4節）:
//   - 期待値保存: ここでは「対象/非対象」の分類だけを提供する。実際の (1+δ)/(1−δ·w) 計算は
//     aging.mjs が対象/非対象それぞれの grow 総和から w を出して行う（恒久シフト禁止・R7の教訓）。
//   - 介入ログはプレイヤー（人間）のぶんだけ state.trainingPolicies に積む（bidFA/proposeTrade と
//     同じ流儀）。AI球団の方針は teamEvalProfile から**毎回決定論的に再導出**する（ログに積まない＝
//     personality/H3-1と同じ「idから再導出できるものは保存しない」設計）。
//   - 三層構造: coachOverallScore は「観測（真値+スカウトノイズ）」であって真値そのものではない
//     （ui/team.mjs の teamScoutGrade と同じ観測座標・式を再利用できるようここへ切り出す）。
// ============================================================================
import { makeRng, hashSeed } from '../rng.mjs';
import { FIELD_POSITIONS } from '../model/positions.mjs';

/** UIが選べる方針の「種別」。'convert' は 'convert:<POS>' の形でのみ使う（POS は FIELD_POSITIONS）。 */
export const TRAINING_KINDS = ['batting', 'defense', 'speed', 'convert', 'rest', 'balanced'];

/** 方針の日本語ラベル（UI表示用）。convert は posJP と組み合わせて「コンバート（◯◯）」と表示する。 */
export const TRAINING_LABELS = {
  batting: '打撃強化',
  defense: '守備強化',
  speed: '走塁強化',
  convert: 'コンバート',
  rest: '休養',
  balanced: 'バランス',
};

/**
 * policy 文字列を { kind, pos } へ分解する。不正な文字列は null（呼び出し側はエラーにする）。
 * @param {string} policy 'batting'|'defense'|'speed'|'rest'|'balanced'|'convert:<POS>'
 */
export function parsePolicy(policy) {
  if (!policy || typeof policy !== 'string') return null;
  if (policy.startsWith('convert:')) {
    const pos = policy.slice('convert:'.length);
    return FIELD_POSITIONS.includes(pos) ? { kind: 'convert', pos } : null;
  }
  return TRAINING_KINDS.includes(policy) && policy !== 'convert' ? { kind: policy, pos: null } : null;
}

/**
 * 軸 (section, key[, pos]) が方針の「対象グループ」に属するか。
 * 対象グループの構造的な定義（trueAbility の既存セクション分けをそのまま使う＝専用ロジック無し）:
 *   batting … trueAbility.batting の7軸
 *   defense … trueAbility.fielding の全軸（positioningIQ/framing/blocking + positionProf全ポジション）
 *   speed   … common.speed + trueAbility.baserunning の2軸
 *   convert … trueAbility.fielding.positionProf[pos]（対象は指定した1ポジションのみ）
 *   rest/balanced … 対象グループを持たない（常に false＝グループtiltは無効）
 */
export function isTargetAxis(parsed, section, key, pos) {
  if (!parsed) return false;
  switch (parsed.kind) {
    case 'batting':
      return section === 'batting';
    case 'defense':
      return section === 'fielding';
    case 'speed':
      return (section === 'common' && key === 'speed') || section === 'baserunning';
    case 'convert':
      return section === 'fielding' && key === 'positionProf' && pos === parsed.pos;
    default:
      return false;
  }
}

/** z化: (v-mean)/sd（sd=0ならズレ無しとして0を返す）。 */
function z(v, mean, sd) {
  return sd ? (v - mean) / sd : 0;
}

/**
 * AI球団の自動方針（teamEvalProfile由来・決定論・乱数不使用）。
 * wBat/wDef をそれぞれの分布パラメータでz化した差が閾値を超えた球団だけ偏らせる
 * （大半は balanced のまま＝リーグ全体で見て系統バイアスにならない＝較正ヘッドルーム保護）。
 * 投手は対象外（打撃/守備という方針の対象が薄い＝つねに balanced）。
 * @param {Object} p Player
 * @param {Object|null} profile teamEvalProfile() の返値（無ければ balanced）
 * @param {Object} cfg
 * @returns {string} 'batting'|'defense'|'balanced'
 */
export function aiAutoPolicy(p, profile, cfg) {
  if (!profile || p.role === 'pitcher') return 'balanced';
  const pc = cfg.tuning.market.profile;
  const tc = cfg.tuning.training;
  const zBat = z(profile.wBat, pc.wBatMean, pc.wBatSd);
  const zDef = z(profile.wDef, pc.wDefMean, pc.wDefSd);
  const diff = zBat - zDef;
  if (diff > tc.aiTiltZThresh) return 'batting';
  if (-diff > tc.aiTiltZThresh) return 'defense';
  return 'balanced';
}

/**
 * 選手1人ぶんの実効方針を解決する（人間の明示ログ優先 → 自チームの未設定は balanced →
 * 他球団(AI)は teamEvalProfile 由来の自動方針）。
 * @param {Object} p Player（id/teamId/roleを参照）
 * @param {{policyMap?:Map, profiles?:Map, playerTeamId?:string}} ctx
 *   policyMap: playerId -> {policy, special}（当年ぶんに絞り込み済みの人間介入ログ）
 *   profiles:  teamId -> teamEvalProfile()（AI自動方針の入力・省略時はAI方針を出さない）
 * @param {Object} cfg
 * @returns {{policy:string, special:boolean}}
 */
export function resolvePlayerTraining(p, ctx, cfg) {
  const explicit = ctx?.policyMap?.get(p.id);
  if (explicit) return { policy: explicit.policy, special: !!explicit.special, source: 'human' };
  if (!ctx?.profiles || p.teamId === ctx.playerTeamId) return { policy: 'balanced', special: false, source: 'default' };
  return { policy: aiAutoPolicy(p, ctx.profiles.get(p.teamId), cfg), special: false, source: 'ai' };
}

/**
 * 「コーチの見立て」総合値（生スカラー・グレード化はしない＝S/A/B/C/D/E化はUIの責務）。
 * ui/team.mjs の teamScoutGrade と同じ観測座標(scoutSeed,'coachView',軸キー)・同じ式を使う
 * （三層構造: 真値そのものではなく「真値+球団固有ノイズ」の観測＝スカウトの目）。
 * H4のキャンプ成果（特別指導選手の前後差）はこの値の before/after 差で作る。
 * @param {Object} p Player（trueAbility/role/scoutSeed/id）
 * @param {Object} cfg
 */
export function coachOverallScore(p, cfg) {
  const t = p.trueAbility;
  const cl20 = (x) => Math.max(20, Math.min(80, x));
  const sd = (cfg?.tuning?.mgr?.scoutSd ?? 5) * 1.4;
  const seed = p.scoutSeed ?? hashSeed(p.id, 'scout');
  const obs = (key, v) => cl20(v + makeRng(hashSeed(seed, 'coachView', key)).normal(0, sd));
  let axes;
  if (p.role === 'pitcher') {
    const pi = t.pitching;
    const veloR = cl20(50 + (pi.velocityKmh - 146) * 2);
    axes = [obs('velo', veloR), obs('control', pi.control), obs('stamina', pi.stamina)];
    if (pi.pitches.length) {
      let sum = 0;
      pi.pitches.forEach((x, i) => { sum += obs('pitch' + i, x.current); });
      axes.push(sum / pi.pitches.length);
    }
  } else {
    const b = t.batting;
    axes = [obs('ev', b.ev), obs('la', b.la), obs('contact', b.contact), obs('eye', b.eye), obs('speed', t.common.speed)];
  }
  return axes.reduce((a, x) => a + x, 0) / axes.length;
}

// ============================================================================
// 架空選手・チーム・リーグのジェネレータ（§0法的前提 / §1 / §10.2 / 0-6）
//
// 方針:
//   - 名前は完全架空（実在選手名・そのもじりを使わない）。姓名パーツの手続き合成。
//   - 能力は分布から個体ごとに引く（§1「合わせるのは集団の分布」）。中心50/裾でばらす。
//   - 三層の器を埋める: layer1=trueAbility（ここで生成）/ layer3=scoutSeed / layer2=空。
//   - declineRateは能力タイプと相関（§10.2: 速球・走力高＆制球・技巧低→衰え速い）。
//   - 分布の平均/分散は初期値。最終的な"リアルさ"は較正(1-11)でこのノブを回して合わせる。
//   - masterSeed＋階層シードで、生成は決定論・順序非依存（誰が回しても同じリーグ）。
// ============================================================================
import { makeRng, hashSeed } from './rng.mjs';
import { createPlayer, createTrueAbility, createPitch } from './model/player.mjs';
import { FIELD_POSITIONS, PITCH_TYPES } from './model/positions.mjs';
import { clamp, clampRating } from './model/util.mjs';
import { createBallpark } from './model/battedball.mjs';
import { hitScore } from './sim/team.mjs';

// --- 名前パーツ（完全架空・common surname/given の手続き合成。プールは拡張可） ------
// F2-1: リーグ総人口 ~1,000-1,300人へ拡大したため姓・名を各56へ増強（組合せ3,136＝衝突率を抑制）。
const SURNAMES = [
  '青柳', '石垣', '大空', '海堂', '桐生', '黒瀬', '小鳥遊', '相良',
  '志摩', '瀬川', '立花', '茅野', '鶴見', '灯野', '成瀬', '羽鳥',
  '氷室', '深沢', '真壁', '御影', '柳沢', '結城', '芳賀', '鷲尾',
  '綾瀬', '一之瀬', '宇津木', '恵那', '奥寺', '篝', '如月', '九条',
  '燕堂', '西園寺', '汐見', '菫原', '瀬能', '空木', '橘田', '悠木',
  '燈台', '波岡', '仁科', '布瀬', '帆村', '真鍋原', '三日月', '椋本',
  '芽室', '八雲', '夕凪', '嵐田', '凛堂', '若栗', '澪標', '菖蒲谷',
];
const GIVEN = [
  '陽', '駿', '空良', '樹', '奏太', '海斗', '大河', '蒼真',
  '悠人', '玲', '湊', '一颯', '隼', '楓', '直', '和',
  '琉生', '碧', '慶', '拓実', '真澄', '航', '創', '燿',
  '旭', '郁弥', '詠太', '凱', '海里', '馨', '橙也', '恭吾',
  '澄人', '奏楽', '汰一', '瑞樹', '天翔', '透吾', '那由', '虹郎',
  '暖', '晴凪', '柊真', '楓雅', '穂高', '真昼', '深青', '結人',
  '遥斗', '洛', '凌雅', '瑠海', '蓮司', '禄', '航琉', '皐',
];

// --- 架空チーム名（実在NPB球団名を避けた造語） -------------------------------
const TEAM_NAMES = [
  '白鷺ホワイトス', '疾風ゲイルズ', '蒼波ブルーズ', '紅蓮フレイムス',
  '雷鳴サンダー', '黒曜オブシディアン', '翠嶺グリーンズ', '金獅子ライオネル',
  '銀翼シルバーズ', '暁アヴローラ', '嵐山ストームズ', '夜叉ナイツ',
];

// 球団アクセントカラー（UI表示専用の識別色）。TEAM_NAMES とインデックス対応で定義し、
// 改名時に色マップだけ取り残される乖離を構造的に防ぐ。エンジンのロジックはこれを読まない。
const TEAM_ACCENTS = [
  '#e9e4d0', '#5ecbe0', '#4f8fe0', '#e0574a',
  '#e8c93a', '#9b8cd9', '#5fd694', '#d9a13d',
  '#b8c4c9', '#e0895a', '#8898a8', '#c65a86',
];
export const TEAM_COLORS = Object.fromEntries(TEAM_NAMES.map((n, i) => [n, TEAM_ACCENTS[i]]));

// 球団略称（UI表示専用・スコアボード/狭幅テーブル用）。TEAM_NAMES とインデックス対応（G1a）。
const TEAM_ABBRS = [
  '白鷺', '疾風', '蒼波', '紅蓮', '雷鳴', '黒曜',
  '翠嶺', '金獅子', '銀翼', '暁', '嵐山', '夜叉',
];
export const TEAM_ABBR = Object.fromEntries(TEAM_NAMES.map((n, i) => [n, TEAM_ABBRS[i]]));

function draw(rng, mean = 50, sd = 10) {
  return clampRating(rng.normal(mean, sd));
}

/** 完全架空の姓名を合成 */
export function generateName(rng) {
  return SURNAMES[rng.int(SURNAMES.length)] + '　' + GIVEN[rng.int(GIVEN.length)];
}

/** 投手を1人生成 */
export function generatePitcher(rng, id) {
  const velocityKmh = Math.round(clamp(rng.normal(146, 4.5), 130, 165)); // NPB先発平均~146
  const control = draw(rng, 50, 13); // S5較正: 分散を微拡大（平均不変）＝エース級FIPの裾→投手WAR王
  // （F2-5: 12→13。出場登録29人選抜でリーグ平均が上澄み化しエースの相対優位が圧縮→裾を再拡大）
  const stamina = draw(rng, 50, 12);

  // 球種数 2〜5（奪三振能力とは独立, §8.1）。fastball は必ず保有。
  const nPitches = 2 + rng.int(4);
  const pool = shuffle(rng, PITCH_TYPES.filter((t) => t !== 'fastball'));
  const types = ['fastball', ...pool.slice(0, nPitches - 1)];
  const pitches = types.map((t) =>
    createPitch(t, {
      current: draw(rng, 50, 10),
      whiff: draw(rng, 50, 15), // S5較正: 分散を微拡大（平均不変）＝奪三振の裾→投手WAR王（F2-5: 14→15・同上）
      hrSuppress: draw(rng, 50, 10),
      contactQuality: draw(rng, 50, 10), // 被コンタクト質の抑止（EV抑止に接続・A-9修正）
    }),
  );

  // §10.2 衰え相関: 速球高＆制球低 → 衰え速い（技巧派だけ長生き）。
  const declineRate = clamp(
    0.5 + (velocityKmh - 146) * 0.03 - (control - 50) * 0.012 + rng.normal(0, 0.15),
    0.1,
    1.3,
  );

  const t = createTrueAbility({
    common: {
      arm: draw(rng, 56, 9),
      speed: draw(rng, 42, 9),
      hands: draw(rng, 48, 9),
      reaction: draw(rng, 48, 9),
      power: draw(rng, 40, 8), // S5較正: 投手打席を実NPB水準（打率~.13）へ＝セパ得点差の門番
    },
    // 投手打撃は実NPB水準（AVG~.15 / K%~30 / 極低BB）へ。特に対球種適性を低く設定しないと
    // 既定50（球種に対し平均打者）のままK%が上がらずAVGが.21まで膨れ、セパ得点差が埋没する（レビュー#3）。
    // F2-5再較正: 出場登録29人選抜でDH枠の打者の質が上がりセパ得点差が帯上限(0.45)を超過
    //   → 投手打撃を僅かに底上げ（DH無リーグの得点を持ち上げ差を帯内へ）。rng消費数は不変（値のみ）。
    batting: {
      ev: draw(rng, 30, 6),
      la: draw(rng, 39, 6),
      contact: draw(rng, 31, 6),
      eye: draw(rng, 29, 6),
      vsFastball: draw(rng, 30, 6), // 対速球適性（低＝速球で三振を取られる）
      vsBreaking: draw(rng, 28, 6), // 対変化球適性
    },
    pitching: { velocityKmh, control, stamina, gbRate: draw(rng, 50, 12), hold: draw(rng, 50, 10), pitches },
    // §12.4: peakAge も能力タイプと相関させる（技巧＝制球高ほど後ろズレ／速球高ほど前ズレ）。
    //   乱数は base の rng.normal 一発のみ（既引きの velocityKmh/control で決定論シフト）＝生成の
    //   乱数列は不変＝1年目シム（既存50較正）に一切影響しない。晩成の“稀化/ゲート”を復活させる。
    career: {
      peakAge: Math.round(clamp(rng.normal(27, 2) + (control - 50) * 0.05 - (velocityKmh - 146) * 0.12, 23, 34)),
      declineRate,
    },
  });

  return createPlayer({
    id,
    name: generateName(rng),
    role: 'pitcher',
    primaryPos: 'P',
    bats: rng.chance(0.3) ? 'L' : 'R',
    throws: rng.chance(0.28) ? 'L' : 'R',
    age: 18 + rng.int(20),
    trueAbility: t,
    scoutSeed: hashSeed(id, 'scout'),
  });
}

// ポジション別の打撃バイアス（守備難ポジは打撃控えめ＝現実の傾向。較正で微調整）
const POS_POWER_BIAS = { '1B': 8, RF: 6, LF: 6, '3B': 3, CF: 0, C: -2, '2B': -3, SS: -5 };

// ============================================================================
// ポジション別の走力・肩バイアス（一次データ由来）
// 正典: thyroxin/research/fielding_metrics_reference.md §14
//
// 旧実装は「CF/SS だけ速い、RF/C だけ強肩、残り全員フラット」という二値スイッチだった。
// 実データはそうなっていない（捕手は最も遅い／二塁手は三塁手より速い／一塁手・二塁手の肩は
// 三塁手より6〜9mphも弱い／コーナー外野は二塁手より速い）。
//
// レーティングへの写像: 1 rating pt = 選手個人の標準偏差の 0.1（＝σ=10 rating）。
//   走力: Baseball Savant 2024 (N=566・競争的走塁10回以上) を CSV から自己集計。
//         リーグ全体平均 27.30 ft/sec（公称27と一致＝集計の検算）、個人SD 1.36 ft/sec。
//         bias = (ポジション平均 − 27.30) / 1.36 × 10
//   肩:   Baseball Savant 2024 公表のポジション別平均（上位10%送球の平均）。
//         個人SD ≈ 6 mph（arm_overall 5.77 / max_arm 6.62 で挟んだ自己集計値）。
//         bias = (ポジション平均 − 7ポジ平均85.17) / 6.0 × 10
//
// draw の sd は「母集団sdを現行と一致させる値」と「実測の位置内SD」が独立に一致した:
//   走力 9.97 vs 実測位置内SD 6.1〜9.3 rating  → 10 を採用
//   肩   7.06 vs 実測位置内SD 6.7〜8.3 rating  → 7.1 を採用
// base は生成人数で重み付けした平均が現行値（走力50.70 / 肩52.44）になるよう定めた（較正の揺れを最小化）。
// ============================================================================
const SPEED_BASE = 49.58;
const SPEED_SD = 10;
// Savant 2024 ft/sec: CF 28.68 / SS 27.93 / LF 27.87 / RF 27.79 / 2B 27.61 / 3B 27.30 / 1B 26.32 / C 25.97
const POS_SPEED_BIAS = { CF: 10.1, SS: 4.6, LF: 4.2, RF: 3.6, '2B': 2.3, '3B': 0, '1B': -7.2, C: -9.8 };

const ARM_BASE = 51.28;
const ARM_SD = 7.1;
// Savant 2024 mph: CF 89.7 / RF 89.4 / LF 88.1 / SS 86.9 / 3B 85.7 / 2B 79.3 / 1B 77.1
// ⚠️捕手は Savant が Arm Strength から除外している（Pop Time で評価する）ため一次情報の平均が存在しない。
//   2017年のトップ捕手の max-effort 送球が 87〜88mph（＝外野平均と同水準）という二次情報しかないので、
//   RF と同値を「設計値」として置く。出典のある数値ではないことを明示する。
const POS_ARM_BIAS = { CF: 7.5, RF: 7.0, C: 7.0, LF: 4.9, SS: 2.9, '3B': 0.9, '2B': -9.8, '1B': -13.5 };

// 盗塁技術は走力と連続に結線する（旧実装は speed>55 で 46→55 と 9pt 跳ぶ階段関数で、
// speed 25 の選手と speed 54 の選手の盗塁技術が同じだった）。
// 傾き・切片・残差sdは、旧実装の周辺分布（平均48.85 / sd12.56 / steal~speed の回帰係数0.2636）を
// 保つよう定めた＝段差の撤廃だけを行い、新しい数値を発明しない。
const STEAL_BASE = 48.67;
const STEAL_PER_SPEED = 0.2636;
const STEAL_SD = 12.17;

/** 野手を1人生成（primaryPos を主守備位置に） */
export function generateFielder(rng, id, primaryPos) {
  const speed = draw(rng, SPEED_BASE + (POS_SPEED_BIAS[primaryPos] ?? 0), SPEED_SD);
  const powerBias = POS_POWER_BIAS[primaryPos] ?? 0;
  const power = draw(rng, 50 + powerBias, 10); // S5較正: 打撃系sdを微圧縮（平均不変）＝5ツール重畳の
  // 外れ値が野手WAR王を9.5超へ押し上げるのを抑える（打率王/HR王の裾もこのsdで同時較正）

  // 守備習熟: 主ポジ高、他は低。ユーティリティは近隣に分散（§13）。
  const positionProf = {};
  for (const p of FIELD_POSITIONS) positionProf[p] = draw(rng, 24, 5);
  positionProf[primaryPos] = draw(rng, 60, 8);
  if (rng.chance(0.35)) {
    // ユーティリティ寄り: もう1ポジ育つ
    const alt = FIELD_POSITIONS[rng.int(FIELD_POSITIONS.length)];
    positionProf[alt] = Math.max(positionProf[alt], draw(rng, 48, 8));
  }

  const declineRate = clamp(0.5 + (speed - 50) * 0.012 + rng.normal(0, 0.15), 0.1, 1.3);

  const t = createTrueAbility({
    common: {
      speed,
      power,
      arm: draw(rng, ARM_BASE + (POS_ARM_BIAS[primaryPos] ?? 0), ARM_SD),
      hands: draw(rng, 50, 10),
      reaction: draw(rng, 50, 10),
    },
    batting: {
      ev: draw(rng, 50 + powerBias, 9.5),
      la: draw(rng, 50, 10),
      pull: draw(rng, 50, 12),
      contact: draw(rng, 50, 9.5),
      eye: draw(rng, 50, 9.5),
      vsFastball: draw(rng, 50, 11), // 対速球適性（§4段階1）
      vsBreaking: draw(rng, 50, 11), // 対変化球適性
    },
    fielding: {
      positionProf,
      positioningIQ: draw(rng, 50, 10),
      framing: primaryPos === 'C' ? draw(rng, 50, 10) : draw(rng, 30, 6),
    },
    baserunning: { steal: draw(rng, STEAL_BASE + (speed - 50) * STEAL_PER_SPEED, STEAL_SD), baserunIQ: draw(rng, 50, 10) },
    // §12.4: peakAge を能力タイプ相関で引く（走力系ほど前ズレ＝早熟／低走力の技巧・パワー型ほど
    //   後ろズレ）。乱数は base の rng.normal 一発のみ（既引きの speed で決定論シフト）＝生成の
    //   乱数列は不変＝1年目シム（既存50較正）に影響しない。晩成が“稀な少数テール”になるよう寄せる。
    career: {
      peakAge: Math.round(clamp(rng.normal(27, 2) - (speed - 50) * 0.06, 23, 34)),
      declineRate,
    },
  });

  // ブロッキング（§B1・捕手専用）: 独立シード(id基準)で引き、メインの生成ストリームを一切乱さない
  // （既存リーグ生成をバイト一致で保つ＝B1の変更を「一球シム化」だけに閉じる）。非捕手は既定50=WP/PB非関与。
  if (primaryPos === 'C') t.fielding.blocking = clampRating(makeRng(hashSeed(id, 'block')).normal(50, 10));

  return createPlayer({
    id,
    name: generateName(rng),
    role: 'fielder',
    primaryPos,
    bats: rng.chance(0.35) ? 'L' : rng.chance(0.08) ? 'S' : 'R',
    throws: rng.chance(0.15) ? 'L' : 'R',
    age: 18 + rng.int(20),
    trueAbility: t,
    scoutSeed: hashSeed(id, 'scout'),
  });
}

/**
 * 時代トレンド（D3・§11.3）の新人への反映（in-place・乱数非消費＝決定論）。
 * era.veloBump=平均球速の経年上昇（投手のみ）、era.cohortQuality=世代の波（ドラフト当たり/外れ年）を
 * 新人の主要レーティングへ加算する。boost=王朝均衡の弱球団再分配（team.balanceBoost・非負）。
 * era はプレーンデータ（game/era.mjs の computeEra 由来）＝ generate は game/ を import しない。
 * @param {Object} p 生成直後の新人（trueAbility を持つ）
 * @param {{veloBump?:number, cohortQuality?:number}} era 時代成分（省略時は無効果）
 * @param {number} boost 王朝均衡の追加 rating boost（>=0・省略時0）
 */
export function applyEraToRookie(p, era = null, boost = 0) {
  const dRating = (era && era.cohortQuality ? era.cohortQuality : 0) + (boost || 0);
  const dVelo = era && era.veloBump ? era.veloBump : 0;
  if (!dRating && !dVelo) return p;
  const t = p.trueAbility;
  if (dVelo) t.pitching.velocityKmh = clamp(t.pitching.velocityKmh + dVelo, 130, 168);
  if (!dRating) return p;
  const bump = (obj, key) => { obj[key] = clampRating(obj[key] + dRating); };
  if (p.role === 'pitcher') {
    bump(t.pitching, 'control');
    bump(t.pitching, 'stamina');
    for (const pi of t.pitching.pitches) { bump(pi, 'current'); bump(pi, 'whiff'); }
  } else {
    for (const k of ['ev', 'la', 'contact', 'eye']) bump(t.batting, k);
    bump(t.common, 'power');
    bump(t.common, 'speed');
    bump(t.fielding.positionProf, p.primaryPos);
  }
  return p;
}

/**
 * 新人（ドラフト相当）を1人生成する（C2b 世代交代・§10.6）。
 * 既存の generatePitcher/generateFielder を id 基準の独立シードで駆動し、年齢だけを
 * 高卒/大卒相当（rookieAgeMin..Max）へ上書きする（生成の乱数列は消費済みで決定論・順序非依存）。
 * @param {number} seed ドラフト用の階層シード（hashSeed(masterSeed,'draft',yearIndex)）
 * @param {string} id 新人の一意ID（例 'T4Y3N0'）。live/replay で同一なら bit 一致
 * @param {{role:'pitcher'|'fielder', primaryPos:string, ageMin:number, ageMax:number, debutYear:number, era?:Object}} o
 *   era=時代トレンド成分（D3・§11.3）。指定時は生成後に球速の経年上昇/世代の波を反映（乱数非消費）。
 * @returns {Object} Player（teamId は呼び出し側で設定）
 */
export function generateRookie(seed, id, { role, primaryPos, ageMin = 18, ageMax = 22, debutYear, era = null, cfg = null }) {
  const rng = makeRng(hashSeed(seed, id));
  const p = role === 'pitcher' ? generatePitcher(rng, id) : generateFielder(rng, id, primaryPos);
  // 新人は若い（栄冠的な伸びしろ＝成長ドリフトの母数）。generate 内部の age 抽選結果は
  // 独立シードで引き直して上書きする（メイン列の順序は乱さない＝決定論）。
  const aRng = makeRng(hashSeed(seed, id, 'age'));
  p.age = ageMin + aRng.int(Math.max(1, ageMax - ageMin + 1));
  p.birthSeason = debutYear != null ? debutYear - p.age : null;
  p.primaryPos = role === 'pitcher' ? 'P' : primaryPos;
  // 時代トレンド（D3）: 世代の波・球速の経年上昇を反映（王朝均衡の team boost は draft 割当後に別途）。
  // R2: era は「素質の波」なのでポテンシャルに効かせる＝ applyMaturity の **前** に適用する。
  if (era) applyEraToRookie(p, era, 0);
  // R2: 年齢確定後にポテンシャル→現在能力。これで高卒新人(18)は一軍平均を大きく下回り、
  //   数年かけて育つ（旧実装は新人がいきなりリーグ平均能力を持っていた＝「初期値ができすぎ」）。
  //   rookiePotentialLift（負値）は「ドラフトはプールの上澄みを選ぶ」ぶんの相殺（§下記）:
  //   球団は surplus 付きプールから自評価の最良を指名するため、指名された新人のポテンシャルは
  //   プール平均より高く出る。これを補正しないと毎年リーグへ「平均より強い個体」が注入され続け、
  //   多年で能力が単調インフレする（実測: 15年で一軍EV +1.5pt → SLG +0.03）。
  if (cfg) applyMaturity(p, cfg, cfg.tuning.market.rookiePotentialLift ?? 0);
  return p;
}

// 1チームの守備位置配分（F2-1: 支配下70人＝投手33-36＋野手34-37）。
//   CORE=従来の一軍層20人（年齢は従来一様帯）／DEPTH=二軍層14人（若手厚め）／EXTRA=35-37人目の追加先。
//   合計で各ポジション最低4人（C4 1B4 2B4-5 3B4 SS5 LF4 CF5 RF4-5）＝一軍・二軍の両編成が同時に成立する。
const CORE_FIELDER_PLAN = [
  'C', 'C', 'C',
  '1B', '1B',
  '2B', '2B', '2B',
  '3B', '3B',
  'SS', 'SS', 'SS',
  'LF', 'LF',
  'CF', 'CF', 'CF',
  'RF', 'RF',
];
const DEPTH_FIELDER_PLAN = [
  'C',
  '1B', '1B',
  '2B',
  '3B', '3B',
  'SS', 'SS',
  'LF', 'LF',
  'CF', 'CF',
  'RF', 'RF',
];
const EXTRA_FIELDER_POS = ['C', '2B', 'RF']; // 野手35-37人目の追加ポジション（投手数の球団差ぶん）

/**
 * 重み付き年齢分布から年齢を1つ引く（R2・realism_r2_age_roster_spec §2-C）。
 * weights は {age: 相対重み}。決定論: 整数キーは昇順に走査される（JSのプロパティ順序仕様）。
 */
function drawAgeWeighted(rng, weights) {
  const ages = Object.keys(weights);
  let total = 0;
  for (const a of ages) total += weights[a];
  let u = rng.next() * total;
  for (const a of ages) {
    u -= weights[a];
    if (u <= 0) return Number(a);
  }
  return Number(ages[ages.length - 1]);
}

// ============================================================================
// R2 成熟度カーブ（realism_r2_age_roster_spec §2-A,B,D / §10.1）
//
// generatePitcher/generateFielder が引くのは **ポテンシャル（成長終端＝peak時の能力）** であり、
// 現在の能力ではない。applyMaturity が age まで aging と同一のカーブを適用して現在能力にする。
//   現在能力 = ポテンシャル + baseLift + survivorBonus(age) + maturityDelta(能力, age)
// これで「生成された28歳」と「18歳から育った28歳」が同分布になる（生成と加齢の内部整合）。
//
// 旧実装は age を能力と独立に引いていたため、18歳の平均能力＝30歳の平均能力（相関 r=0.012）で、
// 一軍登録の38%・規定到達者の36%が20歳以下という破綻を生んでいた（ユーザー報告「初期値ができすぎ」）。
// ============================================================================

/**
 * 1能力軸ぶんの成熟度デルタ（ポテンシャルからの差）。aging.curveDelta の逆積分＝同一カーブ。
 *   未成熟: 成長終端(growEnd)までの残り年数ぶん grow を引く（＝まだ伸びていない）
 *   衰え:   衰え開始(onset)から age までの decline を年ごとに積む（declineAccel の加速も同式で）
 * 成長係数 gm は生成時には未知なので 1（平均的な成長を辿った個体）と仮定する。
 */
function maturityDelta(prof, age, peak, dr, aging) {
  let d = 0;
  const growEnd = peak + prof.peakShift;
  if (age < growEnd) d -= prof.grow * (growEnd - age);
  const onset = peak + prof.declineOffset;
  for (let a = onset; a <= age - 1; a++) d -= prof.decline * dr * (1 + aging.declineAccel * (a - onset));
  return d;
}

/**
 * 生成された「ポテンシャル」を age 時点の「現在能力」へ変換する（in-place・乱数非消費・決定論）。
 * age を確定させた **後** に呼ぶこと（generateRookie は age を上書きするため順序が重要）。
 *
 * survivorBonus: 34歳で支配下に残っているのは「ポテンシャルが高かった個体」だけ（弱い個体は
 *   淘汰済み・§10.6 生存バイアス）。1年目リーグにその結果を織り込む。これが無いとベテランが
 *   「衰えただけの弱い選手」ばかりになり全員二軍に沈む（別の非現実）。
 * baseLift: 年齢構造の導入でロスターの平均能力が下がるぶんを戻す中心化（★較正の主ノブ）。
 *
 * 動かす能力の集合は aging.agePlayer と完全に同一（対称性＝生成と加齢が同じ関数であることの担保）。
 */
export function applyMaturity(p, cfg, extraLift = 0) {
  const aging = cfg.tuning.aging;
  const M = cfg.tuning.maturity;
  const t = p.trueAbility;
  const age = p.age;
  const peak = t.career.peakAge;
  const dr = t.career.declineRate;
  const lift = M.baseLift + extraLift + Math.max(0, age - M.survivorFromAge) * M.survivorSlope;
  const profOf = (k) => aging.profiles[k] ?? aging.profiles.default;
  const put = (obj, key, profKey, extra = 0) => {
    obj[key] = clampRating(obj[key] + lift + extra + maturityDelta(profOf(profKey), age, peak, dr, aging));
  };
  // 長打だけの追加加点（R2較正・野手のみ）: power/ev は decline が最速の軸なので、一軍の高齢化で
  //   リーグ長打力だけが構造的に不足する。投手打撃には効かせない（セパ得点差の帯を動かさない）。
  const pw = p.role === 'fielder' ? M.powerLift : 0;

  for (const k of ['speed', 'arm', 'hands', 'reaction', 'power']) put(t.common, k, k, k === 'power' ? pw : 0);
  for (const k of ['ev', 'la', 'pull', 'contact', 'eye', 'vsFastball', 'vsBreaking']) put(t.batting, k, k, k === 'ev' ? pw : 0);

  // 投手（球速は km/h 実数＝別スケール。lift は veloPerRating で換算して写す）
  const pi = t.pitching;
  const v = aging.velo;
  pi.velocityKmh = clamp(
    pi.velocityKmh + lift * M.veloPerRating + maturityDelta(v, age, peak, dr, aging),
    v.min,
    v.max,
  );
  for (const k of ['control', 'stamina', 'gbRate', 'hold']) put(pi, k, k);
  for (const pitch of pi.pitches) {
    for (const k of ['current', 'whiff', 'hrSuppress', 'contactQuality']) put(pitch, k, 'pitchStuff');
  }

  // 守備・走塁
  put(t.fielding, 'positioningIQ', 'positioningIQ');
  put(t.fielding, 'framing', 'framing');
  if (t.fielding.blocking != null) put(t.fielding, 'blocking', 'blocking');
  for (const pos of Object.keys(t.fielding.positionProf)) put(t.fielding.positionProf, pos, 'positionProf');
  put(t.baserunning, 'steal', 'steal');
  put(t.baserunning, 'baserunIQ', 'baserunIQ');

  return p;
}

/**
 * 1チームの支配下ロスターを生成（F2-1: 70人＝投手33-36＋野手34-37）。
 * 投手数は rng で球団ごとに散らし、残りを野手に充てる（合計は cfg.tuning.roster.controlledPerTeam で恒常）。
 * 年齢は R2 の重み付き分布（roster.ageWeights・NPB実態の山型）から引き、確定後に applyMaturity で
 * 「ポテンシャル → その年齢での現在能力」へ変換する（＝若手は未成熟・ベテランは衰え＋生存バイアス）。
 */
export function generateTeam(rng, teamId, cfg) {
  const R = cfg.tuning.roster;
  const nPitchers = R.pitchersMin + rng.int(R.pitchersMax - R.pitchersMin + 1);
  const nFielders = R.controlledPerTeam - nPitchers;
  const plan = CORE_FIELDER_PLAN.concat(DEPTH_FIELDER_PLAN);
  for (let i = plan.length; i < nFielders; i++) {
    plan.push(EXTRA_FIELDER_POS[(i - CORE_FIELDER_PLAN.length - DEPTH_FIELDER_PLAN.length) % EXTRA_FIELDER_POS.length]);
  }
  const roster = [];
  for (let i = 0; i < nPitchers; i++) {
    const p = generatePitcher(rng, `${teamId}P${i + 1}`);
    p.age = drawAgeWeighted(rng, R.ageWeights);
    roster.push(applyMaturity(p, cfg));
  }
  for (let i = 0; i < nFielders; i++) {
    const p = generateFielder(rng, `${teamId}F${i + 1}`, plan[i]);
    p.age = drawAgeWeighted(rng, R.ageWeights);
    roster.push(applyMaturity(p, cfg));
  }
  return roster;
}

/**
 * 球団の育成方針（devFocus 20-80）から育成選手の保有数を決める（F2-1・決定論の純関数）。
 * devCountMin..Max へ線形写像＝育成に厚い球団(ソフトバンク型)と薄い球団の個性が人数に出る。
 */
export function devCountFor(devFocus, cfg) {
  const R = cfg.tuning.roster;
  const t = clamp((devFocus - 20) / 60, 0, 1);
  return Math.round(R.devCountMin + (R.devCountMax - R.devCountMin) * t);
}

/**
 * 1球団分の育成選手を生成する（F2-1・§12.1）。rosterStatus='minor' で league.farm に入る別枠。
 * 能力の生成分布は支配下と同一（観測が薄い・ノイズ大なのは既存 §12.1 の farm 観測枠組みが担う）。
 * 年齢は 18-24 中心（若手最厚）。id は `${teamId}D{n}`＝支配下(P/F)と衝突しない。
 */
export function generateFarmPlayers(rng, teamId, count, cfg) {
  const R = cfg.tuning.roster;
  const list = [];
  for (let i = 0; i < count; i++) {
    const id = `${teamId}D${i + 1}`;
    const isPitcher = rng.chance(R.devPitcherShare);
    const p = isPitcher
      ? generatePitcher(rng, id)
      : generateFielder(rng, id, FIELD_POSITIONS[rng.int(FIELD_POSITIONS.length)]);
    p.age = drawAgeWeighted(rng, R.devAgeWeights); // 育成は支配下より若い（R2）
    p.rosterStatus = 'minor';
    p.teamId = teamId;
    list.push(applyMaturity(p, cfg)); // 年齢確定後にポテンシャル→現在能力（＝育成は未成熟な若手）
  }
  return list;
}

/**
 * 監督プロファイルを生成（S1・§S2/S3の采配判断が参照する「監督ポリシー」の個性）。
 * 20-80スケール(50=リーグ平均)。判断ロジック自体は src/sim/manager.mjs に置く（S2）。
 */
export function generateManager(rng) {
  return {
    buntTend: draw(rng, 50, 12), // 犠打の好み（高いほどバントさせる）
    stealTend: draw(rng, 50, 12), // 盗塁の積極性
    ibbTend: draw(rng, 50, 12), // 敬遠の使い方
    quickHook: draw(rng, 50, 12), // 継投の早さ（高いほど早く投手を代える）
    devFocus: draw(rng, 50, 14), // 育成方針（F2-1・フロントの個性）: 高いほど育成選手を多く抱える（10-40人へ写像）
  };
}

/**
 * 球場ジオメトリの生偏差を1つ引く（D2 パークファクター・§11.2）。
 * 各偏差は平均0の対称分布（sizeSd/centerSd/asymSd/heightSd）。リーグ内ゼロサム中心化は
 * generateLeague 側で行い（球場分布の平均＝中立球場）、得点環境の据え置きを保証する。
 * 決定論: park専用RNG系列で引くこと（選手生成RNGを消費しない＝選手はD2前とbyte同一）。
 * @returns {{dSize:number, dCenter:number, dAsym:number, dHeight:number}}
 */
export function generatePark(rng, cfg) {
  const P = cfg.tuning.park;
  return {
    dSize: rng.normal(0, P.sizeSd), // 球場全体の広狭（両翼＋中堅を一様に）
    dCenter: rng.normal(0, P.centerSd), // 中堅の独立偏差
    dAsym: rng.normal(0, P.asymSd), // 左右非対称（左翼 +dAsym / 右翼 −dAsym）
    dHeight: rng.normal(0, P.heightSd), // フェンス高
  };
}

/**
 * ゼロサム中心化済みの生偏差から球場オブジェクトを構築する（D2）。
 * @param {{dSize,dCenter,dAsym,dHeight}} dev リーグ平均を引いた（＝中心化済み）偏差
 * @param {string} name 完全架空の球場名（実在球場名は使わない・§11.2）
 */
export function buildParkFromDeviations(dev, name, cfg) {
  const P = cfg.tuning.park;
  const lf = clamp(P.baseLine + dev.dSize + dev.dAsym, P.lineClampLo, P.lineClampHi);
  const rf = clamp(P.baseLine + dev.dSize - dev.dAsym, P.lineClampLo, P.lineClampHi);
  const center = clamp(P.baseCenter + dev.dSize + dev.dCenter, P.centerClampLo, P.centerClampHi);
  const height = clamp(P.baseHeight + dev.dHeight, P.heightClampLo, P.heightClampHi);
  return createBallpark({
    name,
    lineDistM: (lf + rf) / 2, // 代表値（表示・後方互換）
    lfLineM: lf,
    rfLineM: rf,
    centerDistM: center,
    gapDistM: (center + (lf + rf) / 2) / 2, // 中間の目安（表示用）
    fenceHeightM: height,
  });
}

/** 完全架空の球場名を球団名から合成（実在球場名は使わない・§11.2） */
function parkNameFor(teamName) {
  return `${teamName}スタジアム`;
}

/**
 * リーグ全体を生成。masterSeed＋階層シードで決定論・順序非依存。
 * 2リーグ制: 前半球団=leagues[0]（L1・DH無）、後半=leagues[1]（L2・DH有）。
 * @returns {{masterSeed:number, teams:Array, players:Array}}
 */
export function generateLeague(masterSeed, config) {
  const numTeams = config.league.numTeams;
  const leagues = config.league.leagues ?? null;
  const perLeague = leagues ? Math.ceil(numTeams / leagues.length) : numTeams;

  // 1) 全チームのロスターを生成（チームシードで決定論・順序非依存）＋攻撃力を測る。
  const built = [];
  for (let ti = 0; ti < numTeams; ti++) {
    const teamId = `T${ti + 1}`;
    const trng = makeRng(hashSeed(masterSeed, 'team', ti));
    const roster = generateTeam(trng, teamId, config);
    for (const p of roster) p.teamId = teamId;
    const manager = generateManager(makeRng(hashSeed(masterSeed, 'manager', ti)));
    // 球場ジオメトリの生偏差（D2・§11.2）。park専用RNG系列＝選手/監督RNGを消費しない（選手はD2前とbyte同一）。
    const parkDev = generatePark(makeRng(hashSeed(masterSeed, 'park', ti)), config);
    // 育成選手（F2-1・§12.1）: 球団の育成方針(devFocus)で人数に差（10-40人）。専用RNG系列＝支配下と独立。
    const farm = generateFarmPlayers(
      makeRng(hashSeed(masterSeed, 'devroster', ti)),
      teamId,
      devCountFor(manager.devFocus, config),
      config,
    );
    // 攻撃力＝「一軍級の上位野手」のhitScore合計（F2-1: 全野手合計だと二軍層/育成の人数差で歪むため
    //   デプスチャートに乗る上位 offenseTopN 人で測る＝リーグ間の一軍攻撃力を均衡させる本来の目的に整合）。
    const topN = config.tuning.roster.offenseTopN;
    const offense = roster
      .filter((p) => p.role === 'fielder')
      .map((p) => hitScore(p))
      .sort((a, b) => b - a)
      .slice(0, topN)
      .reduce((a, v) => a + v, 0);
    built.push({ teamId, roster, farm, manager, offense, parkDev });
  }

  // 球場偏差をリーグ内でゼロサム中心化（D2）: 各偏差からリーグ平均を引き、球場分布の平均＝中立球場に
  //   する（リーグ全体の得点環境を据え置き＝PF平均≈100・§D2）。中心化は決定論（順序非依存の総和）。
  const nBuilt = built.length;
  const parkMean = { dSize: 0, dCenter: 0, dAsym: 0, dHeight: 0 };
  for (const t of built) for (const k of Object.keys(parkMean)) parkMean[k] += t.parkDev[k];
  for (const k of Object.keys(parkMean)) parkMean[k] /= nBuilt || 1;
  for (const t of built) {
    t.parkCentered = {
      dSize: t.parkDev.dSize - parkMean.dSize,
      dCenter: t.parkDev.dCenter - parkMean.dCenter,
      dAsym: t.parkDev.dAsym - parkMean.dAsym,
      dHeight: t.parkDev.dHeight - parkMean.dHeight,
    };
  }

  // 2) リーグ均衡割当（2リーグ×偶数のみ）: 攻撃力降順にグリーディで「総攻撃力が小さいリーグ」へ
  //    詰め、両リーグの野手攻撃を近づける。→ セ・パ得点差がDH効果だけを反映して安定する（競争均衡）。
  //    それ以外の構成は従来どおり前半L1/後半L2の連番割当。
  const leagueOf = new Map();
  if (leagues && leagues.length === 2 && numTeams % 2 === 0) {
    const half = numTeams / 2;
    const sums = [0, 0];
    const counts = [0, 0];
    for (const t of built.slice().sort((a, b) => b.offense - a.offense)) {
      let g;
      if (counts[0] >= half) g = 1;
      else if (counts[1] >= half) g = 0;
      else g = sums[0] <= sums[1] ? 0 : 1;
      leagueOf.set(t.teamId, g);
      sums[g] += t.offense;
      counts[g]++;
    }
  } else {
    built.forEach((t, ti) =>
      leagueOf.set(t.teamId, leagues ? Math.min(Math.floor(ti / perLeague), leagues.length - 1) : 0),
    );
  }

  // 3) teams配列を [L1..., L2...] 順（各リーグ内はチーム番号順）に並べ、名前を最終位置で付与。
  const ordered = leagues
    ? built.slice().sort((a, b) => leagueOf.get(a.teamId) - leagueOf.get(b.teamId))
    : built;
  const teams = [];
  const players = [];
  const farm = [];
  ordered.forEach((t, idx) => {
    const gi = leagueOf.get(t.teamId);
    const name = TEAM_NAMES[idx] ?? t.teamId;
    teams.push({
      id: t.teamId,
      name,
      league: leagues ? leagues[gi].id : null,
      manager: t.manager,
      // 本拠地球場（D2・§11.2）。ゼロサム中心化済み偏差から構築（完全架空名）。
      park: buildParkFromDeviations(t.parkCentered, parkNameFor(name), config),
      playerIds: t.roster.map((p) => p.id),
    });
    players.push(...t.roster);
    // 育成選手（F2-1）: league.players/team.playerIds と別枠の league.farm へ（既存 §12.1 farm 枠組み）。
    farm.push(...t.farm);
  });
  return { masterSeed, teams, players, farm };
}

/** Fisher–Yates（rng使用・決定論） */
function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

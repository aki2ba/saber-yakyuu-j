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
import { createPlayer, createTrueAbility, createPitch, PERSONALITIES } from './model/player.mjs';
import { FIELD_POSITIONS, PITCH_TYPES } from './model/positions.mjs';
import { clamp, clampRating } from './model/util.mjs';
import { createBallpark } from './model/battedball.mjs';
import { hitScore } from './sim/team.mjs';

// --- 名前パーツ（選手アイデンティティ刷新・2026-07-20） --------------------------------
// ユーザー要望「同じ苗字ばかりでわかりづらい。珍しくて読みやすい苗字で、名前＝その選手、にしたい」。
// 方針:
//   - 実在する「全国数百〜数万人」帯の珍しめだが素直に読める苗字を厳選（名字由来net等の
//     珍名ランキング帯を参考）。難読（小鳥遊・澪標等）・創作貴族風（西園寺・九条等）は廃止。
//   - 有名NPB選手の特徴的な姓（立浪/鳥谷/掛布/王/新庄/則本/千賀/甲斐/源田/筒香/山川 等）は
//     パブリシティ権への安全側配慮で収録しない（苗字単体に著作権はないが想起の芽を絶つ）。
//   - フルネーム＝選手アイデンティティ（innateKindOf/identitySeed）。同じ名前は常に同じ選手。
const SURNAMES = [
  '相原', '青鹿', '赤尾', '赤峰', '秋谷', '芥川', '朝比奈', '浅葉',
  '安芸', '阿久津', '安曇', '跡部', '姉崎', '虻川', '天城', '雨宮',
  '綾部', '鮎川', '新井田', '荒木田', '有働', '有馬', '粟津', '飯干',
  '伊集院', '磯貝', '磯部', '一戸', '井手', '稲城', '犬飼', '茨木',
  '今枝', '今城', '入江', '岩城', '岩渕', '宇喜多', '宇佐美', '牛尾',
  '氏家', '碓井', '宇都', '鵜殿', '海野', '浦野', '瓜生', '江口',
  '海老原', '襟川', '大蔵', '大迫', '大和田', '小笠', '荻野目', '長船',
  '忍田', '小田切', '乙部', '帯金', '大八木', '奥住', '小椋', '尾上',
  '鏡味', '柿崎', '筧', '桂川', '金森', '樺沢', '上条', '亀岡',
  '苅田', '神林', '木皿', '北大路', '北見', '衣川', '君島', '肝付',
  '久我', '草壁', '久住', '楠見', '国枝', '国広', '車田', '黒岩',
  '桑野', '古閑', '小暮', '小柴', '越野', '木場', '小針', '狛江',
  '小峰', '権田', '加賀谷', '加地', '勝間田', '金田一', '鹿又', '蒲原',
  '菊間', '岸波', '木戸口', '京極', '桐山', '久保寺', '熊倉', '倉科',
  '気仙', '神津', '高野瀬', '小金丸', '五味渕', '是枝', '近江', '児島',
  '雑賀', '佐伯', '嵯峨', '坂巻', '相楽', '佐倉', '実方', '佐渡',
  '真田', '猿橋', '沢城', '塩谷', '鹿野', '宍戸', '雫石', '信夫',
  '柴崎', '渋川', '島津', '下条', '下平', '白波瀬', '城戸', '陣内',
  '菅谷', '鈴鹿', '諏訪部', '瀬尾', '瀬戸口', '曽根崎', '園部', '曽谷',
  '佐分利', '早乙女', '三瓶', '椎名', '重信', '宿谷', '白鳥', '進藤',
  '須賀川', '菅生', '洲崎', '関谷', '千田', '沢渡', '汐入', '塩浜',
  '高千穂', '田切', '竹之内', '竹宮', '橘川', '辰野', '玉置', '千歳',
  '千早', '津々見', '津野田', '鶴丸', '手島', '土井垣', '土岐', '常盤',
  '外川', '鳥海', '土肥', '高嶺', '滝波', '田名部', '玉城', '太刀川',
  '立木', '舘野', '田水', '知念', '千国', '司城', '寺内', '土肥原',
  '直江', '長曽根', '長束', '中丸', '名越', '梨本', '那須野', '灘',
  '名取', '奈良岡', '成宮', '南雲', '新島', '仁井田', '二階堂', '西小路',
  '布川', '沼澤', '根岸', '猫田', '野々村', '野呂', '名倉', '難波',
  '韮沢', '布施川', '二本柳', '丹羽', '縄田', '奈半利', '羽賀', '萩野谷',
  '長谷部', '波多野', '八丁', '花房', '羽生田', '早瀬', '速水', '播磨',
  '彦坂', '土方', '一橋', '日野原', '兵藤', '平岩', '蛭田', '吹越',
  '福王', '藤白', '二見', '船越', '古井戸', '古橋', '不破', '保科',
  '穂積', '堀之内', '本庄', '袴田', '箱崎', '蜂谷', '早坂', '半井',
  '日名子', '風呂本', '別府', '逸見', '洞口', '枚田', '舞原', '前園',
  '真柴', '真下', '町屋', '松枝', '松代', '真鍋', '真山', '三雲',
  '水城', '水無瀬', '御手洗', '水戸部', '峰岸', '三次', '宮腰', '六車',
  '棟方', '村雨', '室伏', '目時', '毛塚', '百地', '籾山', '森重',
  '諸星', '間宮', '馬渡', '万田', '三留', '妻鳥', '八巻', '矢作',
  '矢富', '山名', '山野辺', '結城', '湯浅', '柚木', '弓削', '由利',
  '横溝', '吉良', '若狭', '和久井', '鷲見', '渡会', '綿貫', '八代',
  '矢吹', '世良', '龍造寺', '若泉', '脇坂', '和栗',
];
const GIVEN = [
  '陽', '駿', '空良', '樹', '奏太', '海斗', '大河', '蒼真',
  '悠人', '玲', '湊', '一颯', '隼', '楓', '直', '和',
  '琉生', '碧', '慶', '拓実', '真澄', '航', '創', '燿',
  '旭', '郁弥', '詠太', '凱', '海里', '馨', '橙也', '恭吾',
  '澄人', '奏楽', '汰一', '瑞樹', '天翔', '透吾', '那由', '虹郎',
  '暖', '晴凪', '柊真', '楓雅', '穂高', '真昼', '深青', '結人',
  '遥斗', '洛', '凌雅', '瑠海', '蓮司', '禄', '航琉', '皐',
  '瑛人', '旺祐', '海翔', '絃', '律', '千隼', '慧吾', '大雅',
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

/**
 * H3-1: 性格タグを id 基準の独立シードで決定論的に引く（generatePitcher/generateFielder が
 * 呼ぶ本体のメイン乱数列は一切消費しない＝R6 durability/§B1 blocking と同じ「独立シード方式」。
 * 既存セーブの補完（game/index.mjs load()）も本関数を呼ぶ＝新規生成と旧セーブ補完が同式で一致する。
 */
export function assignPersonality(id) {
  const rng = makeRng(hashSeed(id, 'personality'));
  return PERSONALITIES[rng.int(PERSONALITIES.length)];
}

/**
 * H5-A: 球団の財力プロファイル（年俸予算budget）を masterSeed×teamId の独立シードから
 * 決定論的に引く（teamEvalProfile・§13と同じ「球団ごとに固定の癖」流儀・独立シード='finance'
 * ＝支配下/育成/監督/球場の生成ストリームを一切乱さない）。budget は生成時に固定され、
 * H5-Cでファン人気連動の年次見直しが入るまでキャリア中不変（phaseH_fun_spec H5-A）。
 * 既存セーブの補完（game/index.mjs load()・src/game/finance.mjs refreshTeamFinance）も
 * 本関数を呼ぶ＝新規生成と旧セーブ補完が同式で一致する（personality と同じ「後付け可能」構造）。
 */
export function teamFinanceProfile(masterSeed, teamId, cfg) {
  const b = cfg.tuning.economy.budget;
  const r = makeRng(hashSeed(masterSeed, 'finance', teamId));
  return { budget: Math.round(clamp(r.normal(b.mean, b.sd), b.min, b.max)) };
}

/** 完全架空の姓名を合成（レガシー経路・直接呼び出しテスト用。実世界生成は drawUniqueName を使う） */
export function generateName(rng) {
  return SURNAMES[rng.int(SURNAMES.length)] + '　' + GIVEN[rng.int(GIVEN.length)];
}

// ============================================================================
// 選手アイデンティティ（2026-07-20・ユーザー要望「名前＝その選手。同じ選手は同じ初期値」）
//
// フルネームから独立シードで決定論導出する＝**どの世界(masterSeed)・どのセーブでも
// 同じ名前は同じ選手**（役割・守備位置・利き手・素質・性格・故障耐性・ドラフト時の出自）。
// 世界が決めるのは「誰がいつどの球団に現れるか」（名前の抽選順）と、登場後の経過
// （加齢・成長乱数・故障・時代の波 era・王朝均衡 boost）だけ。
//   - 数値分布は従来の world-rng 生成と完全に同一（シード源が変わるだけ）＝較正53指標は分布不変
//   - scoutSeed は従来どおり世界側（球団の見立て違いは世界の個性であって選手の属性ではない）
// ============================================================================

/** 生成本体（素質・利き手・球種）の乱数列。名前だけから決まる＝世界横断で同一 */
export function identityBodyRng(name) {
  return makeRng(hashSeed('togen-id-body', name));
}

// 野手ポジションの出現重み（チーム編成プラン CORE+DEPTH+EXTRA の必要数と整合＝棄却抽選が軽い）
const POS_ID_WEIGHTS = [['C', 13], ['1B', 11], ['2B', 13], ['3B', 11], ['SS', 14], ['LF', 11], ['CF', 14], ['RF', 13]];

/** 名前から役割と主ポジションを決定論導出（世界は「必要な型に合う名前」を探して採用する） */
export function innateKindOf(name) {
  const r = makeRng(hashSeed('togen-id-kind', name));
  if (r.chance(0.5)) return { role: 'pitcher', primaryPos: 'P' };
  let total = 0;
  for (const [, w] of POS_ID_WEIGHTS) total += w;
  let u = r.next() * total;
  for (const [pos, w] of POS_ID_WEIGHTS) {
    u -= w;
    if (u <= 0) return { role: 'fielder', primaryPos: pos };
  }
  return { role: 'fielder', primaryPos: 'RF' };
}

/** 使用済みフルネーム集合から苗字の使用回数マップを作る（世界内の同姓抑制の入力） */
export function surnameCountsOf(names) {
  const m = new Map();
  for (const n of names) {
    const s = String(n).split('　')[0];
    m.set(s, (m.get(s) ?? 0) + 1);
  }
  return m;
}

/**
 * 世界内ユニークな名前を1つ引く（役割/ポジション型に合うアイデンティティを棄却抽選）。
 *   - フルネームは used と衝突しない＝世界に同姓同名は存在しない
 *   - 同姓は指数的に抑制（未使用=必ず採用 / n人使用中=0.25^n でしか採用しない）
 *     →「同じ苗字ばかりでわかりづらい」の解消（ユーザー報告・旧実装は56姓に平均20人）
 * used / surCount は呼び出し元が管理（この関数が採用時に更新する）。決定論（rng は専用ストリーム）。
 * @param {{role:string, primaryPos:?string}} want 必要な型（primaryPos=null は役割のみ指定）
 */
export function drawUniqueName(rng, used, surCount, want) {
  for (let pass = 0; pass < 2; pass++) {
    const tries = pass === 0 ? 3000 : 30000;
    for (let t = 0; t < tries; t++) {
      const s = SURNAMES[rng.int(SURNAMES.length)];
      if (pass === 0) {
        const c = surCount.get(s) ?? 0;
        if (c > 0 && rng.next() > Math.pow(0.25, c)) continue; // 同姓の指数抑制
      }
      const g = GIVEN[rng.int(GIVEN.length)];
      const name = s + '　' + g;
      if (used.has(name)) continue;
      const kind = innateKindOf(name);
      if (kind.role !== want.role) continue;
      if (want.role === 'fielder' && want.primaryPos && kind.primaryPos !== want.primaryPos) continue;
      used.add(name);
      surCount.set(s, (surCount.get(s) ?? 0) + 1);
      return name;
    }
    // pass 1: 名前空間が混んで型が見つからない場合は同姓抑制を捨てて再走査（安全弁）
  }
  // 究極の安全弁: 2万超の組合せが型条件込みで枯渇した場合のみ（実運用では到達しない）
  return generateName(rng);
}

/** 投手を1人生成。
 *  name を渡すと選手アイデンティティ経路＝呼び出し元は rng に identityBodyRng(name) を渡すこと。
 *  性格・故障耐性も名前キーで引く（同じ名前=同じ選手）。name 省略時は従来の world-rng 経路（テスト互換）。 */
export function generatePitcher(rng, id, name = null) {
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

  // R6: 潜在的な故障耐性（生涯不変の真値）。独立シードで引き、メインの生成ストリームを
  //   一切消費しない。アイデンティティ経路(name有)では名前キー＝世界横断で同一の耐性。
  t.career.durability = clampRating(makeRng(hashSeed(name ?? id, 'durability')).normal(50, 10));
  return createPlayer({
    id,
    name: name ?? generateName(rng),
    role: 'pitcher',
    primaryPos: 'P',
    bats: rng.chance(0.3) ? 'L' : 'R',
    throws: rng.chance(0.28) ? 'L' : 'R',
    age: 18 + rng.int(20),
    trueAbility: t,
    scoutSeed: hashSeed(id, 'scout'), // 球団の見立てノイズは世界側（選手の属性ではない）
    personality: assignPersonality(name ?? id), // H3-1（アイデンティティ経路では名前キー）
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

/** 野手を1人生成（primaryPos を主守備位置に）。
 *  name を渡すと選手アイデンティティ経路（generatePitcher と同じ規約）。 */
export function generateFielder(rng, id, primaryPos, name = null) {
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

  // ブロッキング（§B1・捕手専用）: 独立シードで引き、メインの生成ストリームを一切乱さない。
  // アイデンティティ経路(name有)では名前キー＝世界横断で同一。非捕手は既定50=WP/PB非関与。
  if (primaryPos === 'C') t.fielding.blocking = clampRating(makeRng(hashSeed(name ?? id, 'block')).normal(50, 10));

  t.career.durability = clampRating(makeRng(hashSeed(name ?? id, 'durability')).normal(50, 10)); // R6（同上）
  return createPlayer({
    id,
    name: name ?? generateName(rng),
    role: 'fielder',
    primaryPos,
    bats: rng.chance(0.35) ? 'L' : rng.chance(0.08) ? 'S' : 'R',
    throws: rng.chance(0.15) ? 'L' : 'R',
    age: 18 + rng.int(20),
    trueAbility: t,
    scoutSeed: hashSeed(id, 'scout'), // 球団の見立てノイズは世界側（選手の属性ではない）
    personality: assignPersonality(name ?? id), // H3-1（アイデンティティ経路では名前キー）
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
export function generateRookie(seed, id, { role, primaryPos, ageMin = 18, ageMax = 22, debutYear, era = null, cfg = null, name = null }) {
  // 選手アイデンティティ（name有）: 素質・年齢帯内の抽選も名前キー＝どの世界でも同じ初期値で指名される。
  //   世界依存で残るのは era（時代の波＝環境）と、指名後の成長・故障・王朝均衡 boost だけ。
  const rng = name ? identityBodyRng(name) : makeRng(hashSeed(seed, id));
  const p = role === 'pitcher' ? generatePitcher(rng, id, name) : generateFielder(rng, id, primaryPos, name);
  // 新人は若い（栄冠的な伸びしろ＝成長ドリフトの母数）。generate 内部の age 抽選結果は
  // 独立シードで引き直して上書きする（メイン列の順序は乱さない＝決定論）。
  const aRng = makeRng(name ? hashSeed('togen-id-age', name) : hashSeed(seed, id, 'age'));
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
  if (cfg) {
    const mk = cfg.tuning.market;
    // R7（決定1）: 高卒(refAge未満)ほど「期限付き未成熟負債」を積む。負債は applyAging が
    //   毎年 youthDebtRepayPerYear ずつ返済して0へ収束させる＝一時的な弱さ（恒久劣化ではない）。
    const youthDebt = -(mk.youthDebtPerYear ?? 0) * Math.max(0, (mk.youthDebtRefAge ?? 0) - p.age);
    p.trueAbility.career.youthDebt = youthDebt;
    applyMaturity(p, cfg, (mk.rookiePotentialLift ?? 0) + draftSkew(seed, id, cfg, name) + youthDebt);
  }
  return p;
}

/**
 * R7（決定2）: 新人の真値分布に右の歪みを入れる（現行=正規分布。現実=大多数が凡庸/少数の大当たり・
 * 97%がWAR5未満・§draft_timeline_evidence）。独立シードで駆動＝メイン生成列を乱さない（決定論）。
 * 期待値0で設計する（bustProb の確率で mean=-skewBustMag/2 の凡庸オフセット、残りは平均 starScale
 * ＝ p*m/(2*(1-p)) の指数裾「大当たり」オフセット）＝多年平均に系統ドリフトを起こさない。
 */
function draftSkew(seed, id, cfg, name = null) {
  const dk = cfg.tuning.market.draft;
  if (!dk?.skewBustProb) return 0;
  // アイデンティティ経路（name有）: 当たり/凡庸の歪みも名前キー＝「大器の名前」は世界横断で大器。
  const r = makeRng(name ? hashSeed('togen-id-skew', name) : hashSeed(seed, id, 'skew'));
  const p = dk.skewBustProb;
  const m = dk.skewBustMag;
  if (r.chance(p)) return -m * r.next(); // 凡庸〜伸び悩み: uniform(-m, 0)
  const starScale = (p * m) / (2 * (1 - p)); // E[skew]=0 になるよう解析的に導出
  return -starScale * Math.log(1 - r.next()); // 大当たり: 指数裾（稀に大きく化ける）
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
export function generateTeam(rng, teamId, cfg, alloc = null) {
  const R = cfg.tuning.roster;
  const nPitchers = R.pitchersMin + rng.int(R.pitchersMax - R.pitchersMin + 1);
  const nFielders = R.controlledPerTeam - nPitchers;
  const plan = CORE_FIELDER_PLAN.concat(DEPTH_FIELDER_PLAN);
  for (let i = plan.length; i < nFielders; i++) {
    plan.push(EXTRA_FIELDER_POS[(i - CORE_FIELDER_PLAN.length - DEPTH_FIELDER_PLAN.length) % EXTRA_FIELDER_POS.length]);
  }
  const roster = [];
  for (let i = 0; i < nPitchers; i++) {
    const id = `${teamId}P${i + 1}`;
    // アイデンティティ経路（alloc有=実世界生成）: 名前を先に確保し、素質は名前キーの独立列から。
    // 年齢（キャリアの現在地）だけは世界が決める＝同じ選手が世界ごとに違う年齢で登場する。
    const name = alloc ? drawUniqueName(alloc.rng, alloc.used, alloc.sur, { role: 'pitcher' }) : null;
    const p = generatePitcher(name ? identityBodyRng(name) : rng, id, name);
    p.age = drawAgeWeighted(rng, R.ageWeights);
    roster.push(applyMaturity(p, cfg));
  }
  for (let i = 0; i < nFielders; i++) {
    const id = `${teamId}F${i + 1}`;
    const name = alloc ? drawUniqueName(alloc.rng, alloc.used, alloc.sur, { role: 'fielder', primaryPos: plan[i] }) : null;
    const p = generateFielder(name ? identityBodyRng(name) : rng, id, plan[i], name);
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
export function generateFarmPlayers(rng, teamId, count, cfg, alloc = null) {
  const R = cfg.tuning.roster;
  const list = [];
  for (let i = 0; i < count; i++) {
    const id = `${teamId}D${i + 1}`;
    const isPitcher = rng.chance(R.devPitcherShare);
    let p;
    if (alloc) {
      // アイデンティティ経路: 役割は世界（球団の育成方針）・ポジションは名前=人物に従う
      const name = drawUniqueName(alloc.rng, alloc.used, alloc.sur, { role: isPitcher ? 'pitcher' : 'fielder' });
      const kind = innateKindOf(name);
      p = isPitcher
        ? generatePitcher(identityBodyRng(name), id, name)
        : generateFielder(identityBodyRng(name), id, kind.primaryPos, name);
    } else {
      p = isPitcher
        ? generatePitcher(rng, id)
        : generateFielder(rng, id, FIELD_POSITIONS[rng.int(FIELD_POSITIONS.length)]);
    }
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

  // 選手アイデンティティ: 名前の抽選機（世界内フルネーム一意＋同姓の指数抑制）。
  //   名前列は専用シード＝チーム/球場/監督の各RNG系列とは独立。抽選はチーム順に逐次＝決定論。
  //   ⚠️ used/sur は世界全体で共有するため、この抽選だけは「順序依存」＝チームのループ順を変えないこと。
  const alloc = {
    rng: makeRng(hashSeed(masterSeed, 'names')),
    used: new Set(),
    sur: new Map(),
  };

  // 1) 全チームのロスターを生成（チームシードで決定論・順序非依存）＋攻撃力を測る。
  const built = [];
  for (let ti = 0; ti < numTeams; ti++) {
    const teamId = `T${ti + 1}`;
    const trng = makeRng(hashSeed(masterSeed, 'team', ti));
    const roster = generateTeam(trng, teamId, config, alloc);
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
      alloc,
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
      // H5-A（phaseH_fun_spec）: 年俸予算。budgetは決定論付与（財力差・§13と同じ独立シード流儀）。
      //   payrollは契約更改前ゆえ0＝オフシーズン処理（refreshTeamFinance）が実額へ更新する。
      finance: { budget: teamFinanceProfile(masterSeed, t.teamId, config).budget, payroll: 0 },
    });
    players.push(...t.roster);
    // 育成選手（F2-1）: league.players/team.playerIds と別枠の league.farm へ（既存 §12.1 farm 枠組み）。
    farm.push(...t.farm);
  });
  // usedNames: 世界で使用済みのフルネーム台帳（選手アイデンティティ）。ドラフト新人の命名が
  //   引退者も含めた全既出名と衝突しないよう、market が読み・確定後に追記する（セーブへ永続）。
  return { masterSeed, teams, players, farm, usedNames: [...alloc.used] };
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

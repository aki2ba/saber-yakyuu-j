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
import { hitScore } from './sim/team.mjs';

// --- 名前パーツ（完全架空・common surname/given の手続き合成。プールは拡張可） ------
const SURNAMES = [
  '青柳', '石垣', '大空', '海堂', '桐生', '黒瀬', '小鳥遊', '相良',
  '志摩', '瀬川', '立花', '茅野', '鶴見', '灯野', '成瀬', '羽鳥',
  '氷室', '深沢', '真壁', '御影', '柳沢', '結城', '芳賀', '鷲尾',
];
const GIVEN = [
  '陽', '駿', '空良', '樹', '奏太', '海斗', '大河', '蒼真',
  '悠人', '玲', '湊', '一颯', '隼', '楓', '直', '和',
  '琉生', '碧', '慶', '拓実', '真澄', '航', '創', '燿',
];

// --- 架空チーム名（実在NPB球団名を避けた造語） -------------------------------
const TEAM_NAMES = [
  '白鷺ホワイトス', '疾風ゲイルズ', '蒼波ブルーズ', '紅蓮フレイムス',
  '雷鳴サンダー', '黒曜オブシディアン', '翠嶺グリーンズ', '金獅子ライオネル',
  '銀翼シルバーズ', '暁アヴローラ', '嵐山ストームズ', '夜叉ナイツ',
];

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
  const control = draw(rng, 50, 12); // S5較正: 分散を微拡大（平均不変）＝エース級FIPの裾→投手WAR王
  const stamina = draw(rng, 50, 12);

  // 球種数 2〜5（奪三振能力とは独立, §8.1）。fastball は必ず保有。
  const nPitches = 2 + rng.int(4);
  const pool = shuffle(rng, PITCH_TYPES.filter((t) => t !== 'fastball'));
  const types = ['fastball', ...pool.slice(0, nPitches - 1)];
  const pitches = types.map((t) =>
    createPitch(t, {
      current: draw(rng, 50, 10),
      whiff: draw(rng, 50, 14), // S5較正: 分散を微拡大（平均不変）＝奪三振の裾→投手WAR王
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
    batting: {
      ev: draw(rng, 25, 6),
      la: draw(rng, 39, 6),
      contact: draw(rng, 24, 6),
      eye: draw(rng, 29, 6),
      vsFastball: draw(rng, 25, 6), // 対速球適性（低＝速球で三振を取られる）
      vsBreaking: draw(rng, 23, 6), // 対変化球適性
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

/** 野手を1人生成（primaryPos を主守備位置に） */
export function generateFielder(rng, id, primaryPos) {
  const speed = draw(rng, primaryPos === 'CF' || primaryPos === 'SS' ? 58 : 48, 11);
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
      arm: draw(rng, primaryPos === 'RF' || primaryPos === 'C' ? 58 : 50, 10),
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
    baserunning: { steal: draw(rng, speed > 55 ? 55 : 46, 12), baserunIQ: draw(rng, 50, 10) },
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
 * 新人（ドラフト相当）を1人生成する（C2b 世代交代・§10.6）。
 * 既存の generatePitcher/generateFielder を id 基準の独立シードで駆動し、年齢だけを
 * 高卒/大卒相当（rookieAgeMin..Max）へ上書きする（生成の乱数列は消費済みで決定論・順序非依存）。
 * @param {number} seed ドラフト用の階層シード（hashSeed(masterSeed,'draft',yearIndex)）
 * @param {string} id 新人の一意ID（例 'T4Y3N0'）。live/replay で同一なら bit 一致
 * @param {{role:'pitcher'|'fielder', primaryPos:string, ageMin:number, ageMax:number, debutYear:number}} o
 * @returns {Object} Player（teamId は呼び出し側で設定）
 */
export function generateRookie(seed, id, { role, primaryPos, ageMin = 18, ageMax = 22, debutYear }) {
  const rng = makeRng(hashSeed(seed, id));
  const p = role === 'pitcher' ? generatePitcher(rng, id) : generateFielder(rng, id, primaryPos);
  // 新人は若い（栄冠的な伸びしろ＝成長ドリフトの母数）。generate 内部の age 抽選結果は
  // 独立シードで引き直して上書きする（メイン列の順序は乱さない＝決定論）。
  const aRng = makeRng(hashSeed(seed, id, 'age'));
  p.age = ageMin + aRng.int(Math.max(1, ageMax - ageMin + 1));
  p.birthSeason = debutYear != null ? debutYear - p.age : null;
  p.primaryPos = role === 'pitcher' ? 'P' : primaryPos;
  return p;
}

// 1チームの守備位置配分（合計20野手＋13投手＝33人）
const FIELDER_PLAN = [
  'C', 'C', 'C',
  '1B', '1B',
  '2B', '2B', '2B',
  '3B', '3B',
  'SS', 'SS', 'SS',
  'LF', 'LF',
  'CF', 'CF', 'CF',
  'RF', 'RF',
];
const PITCHERS_PER_TEAM = 13;

/** 1チームのロスターを生成 */
export function generateTeam(rng, teamId) {
  const roster = [];
  for (let i = 0; i < PITCHERS_PER_TEAM; i++) {
    roster.push(generatePitcher(rng, `${teamId}P${i + 1}`));
  }
  FIELDER_PLAN.forEach((pos, i) => {
    roster.push(generateFielder(rng, `${teamId}F${i + 1}`, pos));
  });
  return roster;
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
  };
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
    const roster = generateTeam(trng, teamId);
    for (const p of roster) p.teamId = teamId;
    const manager = generateManager(makeRng(hashSeed(masterSeed, 'manager', ti)));
    // 攻撃力＝野手のhitScore合計（投手はDH無で常に打つため、均衡はDH枠以外の野手攻撃で測る）。
    const offense = roster.filter((p) => p.role === 'fielder').reduce((a, p) => a + hitScore(p), 0);
    built.push({ teamId, roster, manager, offense });
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
  ordered.forEach((t, idx) => {
    const gi = leagueOf.get(t.teamId);
    teams.push({
      id: t.teamId,
      name: TEAM_NAMES[idx] ?? t.teamId,
      league: leagues ? leagues[gi].id : null,
      manager: t.manager,
      playerIds: t.roster.map((p) => p.id),
    });
    players.push(...t.roster);
  });
  return { masterSeed, teams, players };
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

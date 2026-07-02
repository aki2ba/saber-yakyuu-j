// ============================================================================
// 中央パラメータ（config）モジュール（自己レビュー M6 / F43）
//
// 較正の可変係数・NPB目標帯・試合数依存の媒介変数・リーグ定数の器を一箇所に集約する。
//   - 較正(1-11/2-11)は「このモジュールだけ」を調整対象にする（マジックナンバーを散らさない）
//   - §19が要求する「エンジンバージョン固定＝定数セットの凍結」の単一面を兼ねる
//   - 較正ランが共有状態を汚さないよう createConfig() で毎回ディープコピーを配る
// ============================================================================

export const CONFIG_VERSION = '0.0.4-phaseA-s1';

/** リーグ設定（フェーズA: 12球団×143試合・2リーグ制）。
 *  試合のDH有無は「ホーム球団の所属リーグ規則」に従う（旧 dh:'all' は廃止・S2で試合側に接続）。
 *  日程はS3で「リーグ内125＋交流戦18」へ（S1は総当たり近似: 11相手×13=143）。 */
export const LEAGUE_DEFAULT = {
  numTeams: 12,
  gamesPerSeason: 143, // NPB準拠。最終形はリーグ内5相手×25＋交流戦6相手×3（S3日程v2）
  // 2リーグ制（名称は完全架空の造語）。dh=false のリーグは投手が打席に立つ（セ系）。
  leagues: [
    { id: 'L1', name: '陽炎リーグ', dh: false }, // セ・リーグ系（DH無し）
    { id: 'L2', name: '蒼天リーグ', dh: true }, // パ・リーグ系（DH有り）
  ],
  rotationSize: 6, // 先発ローテ人数（中6日・NPB標準）
  rosterActive: 28, // 出場登録の目安（フェーズ3で精緻化）
};

/**
 * 較正目標帯（フェーズA・12球団143試合2リーグ制 / phaseA_spec.md の表を全実装）。
 * 各値は [min,max]（片側条件はスカラー）。tools/calibrate.mjs の機械判定に使う（S4で結線）。
 */
export const CALIBRATION_TARGETS = {
  batting: {
    avg: [0.255, 0.262], // リーグ合算
    obp: [0.32, 0.328],
    slg: [0.39, 0.41],
    ops: [0.715, 0.735], // 下限を.715へ僅かに緩和（フェーズA）
    kPct: [0.18, 0.2],
    bbPct: [0.078, 0.083],
    hrPerTeam: [110, 130], // per team / 143G ⚠️過剰HR＝最大の地雷＝第一の門番指標
    runsPerTeamPerGame: [3.9, 4.3],
    wobaLeague: [0.325, 0.335],
    // セ・パ得点差: DH有リーグ(L2) − DH無リーグ(L1) の得点/球団/試合の差（DH差の発現）
    runDiffDhMinusNoDh: [0.1, 0.45],
  },
  pitching: {
    era: [3.5, 3.9], // リーグ合算
    fip: [3.6, 4.0],
  },
  // タイトル級（リーグリーダーの分布の裾）
  leaders: {
    avg: [0.32, 0.355], // 打率王（帯を.355へ拡大）
    hr: [40, 55], // HR王
    rbi: [95, 140], // 打点王（ベンチ導入で低下想定）
    sb: [30, 65], // 盗塁王
    ipStarter: [150, 195], // 先発IPリーダー（中6日でもエースは深く）
    reliefG: [45, 65], // 登板数王（救援・連投制限下）
    sv: [30, 45], // SV王
    hld: [30, 45], // HLD王
  },
  // 采配の発現（犠打・敬遠・完投）
  tactics: {
    shPerTeamNoDh: [55, 110], // 犠打/球団平均（DH無リーグ=投手バント込みでセ>パ）
    shPerTeamDh: [30, 75], // 犠打/球団平均（DH有リーグ）
    ibbPerTeam: [10, 40], // 敬遠/球団平均
    cgLeague: [5, 30], // 完投（リーグ計）
  },
  war: {
    totalLeague: [370, 430], // 12球団×143試合
    hitterShare: [0.53, 0.57], // 野手:投手 ≈ 55:45
    leaderHitter: [7, 9.5], // 野手WAR王
    leaderPitcher: [5.5, 8], // 投手WAR王
    floorMin200PA: -2.5, // 200PA以上の野手の最小WAR > この値（「WAR-6」の根絶＝起用AIの機能証明）
    uzrTop: [20, 30],
  },
  // 起用・休養の発現
  usage: {
    qualifiedPerTeam: [5, 9], // 規定打席到達者/球団
    catcherStarterGames: [100, 135], // 正捕手の出場試合（143未満＝休養AIの発現）
  },
};

/**
 * エンジン調整ノブ（初期値・較正で動かす）。§18主要定数＋新EV/LAエンジン固有ノブ。
 * 新エンジンでは BABIP/HR は打球格子から創発するため、旧「結果先決め」定数と1:1でない（F44）。
 */
export const TUNING_DEFAULT = {
  hrScale: 0.972, // 本塁打産出スケール（門番: hrPerTeam）※予備較正済み。⚠️HRは閾値のため感度大
  babipBase: 0.3, // インプレー打球の安打基準
  fieldingCoef: 0.0009, // 守備係数（§18）
  // WAR代替水準（§9・§18の初期値。143試合/NPBへ較正対象）
  replBatterPer600: 18, // (PA/600)×18 ※WAR較正。監査A1でDH位置補正(-16run)を正しく計上した分、代替水準を16→18へ再較正(総WAR≈186/野手比≈0.54へ回復)
  replFipMult: 1.25, // replFIP = lgFIP × 1.25 ※WAR較正。投手WAR王は~4.2でやや低(aces IP・FIP spread起因,後で拡大)

  // 打席規律層（1-1）: log5/オッズ比で K/BB/HBP/インプレー を分岐する較正ノブ。
  // League は打席1回あたりの基準確率、Slope は能力(20-80)→logit の感度。
  pa: {
    kLeague: 0.19, // リーグK率（NPB ~19%）
    bbLeague: 0.0795, // リーグBB率 ※較正済み
    hbpLeague: 0.009, // リーグHBP率
    kSlope: 0.22, // K感度 ※較正済み（分布の裾M4を圧縮）
    bbSlope: 0.2, // BB感度 ※較正済み
    hbpSlope: 0.1, // HBP感度（投手制球の荒れ）
    kContactW: 0.7, // 打者K傾向へのコンタクト寄与
    kEyeW: 0.3, // 打者K傾向への選球眼寄与
    kVeloPerKmh: 0.6, // 投手奪三振への球速寄与（1km/h ≒ 0.6 レーティング）
    // 球種格子 段階1（2-1）: 1打席ごとに投手の球種を1つ選び、その whiff で解決。
    fastballWeight: 2.0, // 球種選択で速球系を重く（残りは1.0）
    whiffAptW: 0.24, // 打者の対該当クラス適性が高いほどKしにくい
  },

  // 左右プラトーン（S1・M7解消）: 同利き手（実効打席サイド==投手の利き腕）へのペナルティ。
  // スイッチ(S)は常に投手と逆打席＝有利側に立つ（同利きにならない）。
  // 効果量の初期値は同利きで wOBA −.020〜.030 相当（S5較正で調整）。
  platoon: {
    kLogitSame: 0.1, // 同利きで K の logit 増（三振しやすい）
    bbLogitSame: -0.08, // 同利きで BB の logit 減（四球を選びにくい）
    evKmhSame: -1.2, // 同利きで打球EVの中心を下げる (km/h)
  },

  // 犠打（S2 maybeBunt が消費。§S2-4）: 試行判断・結果テーブル。2ストライク概念はフェーズB。
  bunt: {
    successProb: 0.78, // 成功（走者進塁・打者アウト・sh++・ABなし）
    failProb: 0.12, // 失敗（先頭走者アウト）。残り＝内野安打
    hitProb: 0.1, // 内野安打化
    maxScoreDiff: 2, // 接戦判定（±この点差以内で試行）
    attemptBase: 0.25, // 非強打者×バント局面の基本試行率
    tendW: 0.5, // 監督buntTend(50中心)の感度（logit増分/10pt）
    pitcherAttempt: 0.9, // 投手打席はほぼ必ずバント
    weakBatterWoba: 0.31, // 「非強打者」の目安（観測wOBAがこれ未満）
  },

  // 敬遠（S2 maybeIBB が消費。§S2-5）: 一塁空き×2死or一死×終盤接戦×強打者（or次打者が投手）。
  ibb: {
    base: 0.35, // 条件成立時の基本敬遠率
    tendW: 0.5, // 監督ibbTend(50中心)の感度
    minInning: 7, // 終盤のみ
    maxScoreDiff: 2, // 接戦のみ
    strongBatterWoba: 0.36, // 「強打者」の目安（観測wOBA上位）
  },

  // 交代（S2 代打/代走/守備固め。§S2-3）
  sub: {
    phInning: 7, // 野手への代打は7回以降
    phPitcherInning: 6, // 投手への代打は6回以降
    phMaxBehind: 3, // ビハインドこの点差以内（or接戦）の得点機で発動
    phGainMin: 5, // 代打起用に要する実効打力差（プラトーン込みhitScore相当）
    prInning: 8, // 代走は8回以降
    prMaxScoreDiff: 2, // 2点差以内
    prSpeedGainMin: 10, // ベンチ最速との走力差がこれ以上
    defInning: 8, // 守備固めは8回以降
    defLeadMin: 1, // リード1〜3で発動
    defLeadMax: 3,
  },

  // 休養（S3 日次スタメンAI。正捕手100-135試合へ）
  rest: {
    catcherRestProb: 0.18, // 捕手の休養基本率/試合
    fielderRestProb: 0.02, // 野手の休養基本率/試合
    streakW: 0.004, // 連続出場1試合ごとの休養率加算
  },

  // 投手疲労・可用性（S3。連投制限・中6日の基盤）
  fatigue: {
    maxConsecDays: 2, // 2連投まで（3連投禁止）
    prevDayPitchLimit: 30, // 前日30球以上→当日不可
    starterRestDays: 5, // 先発は中5日以上
  },

  // 観測成績ベース起用（S3 usage.mjs）。三層構造: 真値は直接見ない（観測statline＋スカウトノイズ）。
  usage: {
    reviewInterval: 25, // 見直し間隔（試合）
    trustPA: 150, // 観測wOBAの信頼度加重の半飽和PA（少PAは回帰）
    scoutSd: 6, // スカウト評価ノイズのSD（rating単位・scoutSeed基準）
    swapMargin: 0.01, // レギュラー入替に要する実効wOBA差
    platoonMargin: 0.005, // プラトーン入替に要する実効wOBA差
  },

  // 編成・打順（S1 buildDepthChart v2。§S1-3）
  depth: {
    posToolW: 0.4, // positionRank: 守備素材(Range,50中心)の重み（習熟=1基準）
    posBatW: 0.2, // positionRank: 打撃(hitScoreを50中心スケール化)の重み
    leadoffSpeedW: 1.0, // 1番選定: speed(50中心)の加点重み
  },

  // 走塁（2-4 wSB, §6）: 盗塁の試行・成否を 走者Steal/Speed × 投手Hold × 捕手Arm から生成。
  steal: {
    attemptBase: 0.11, // 一塁走者が二塁を狙う基本試行率（機会あたり）
    attemptSlope: 0.45, // 走者の積極性感度（Steal/Speed）
    successBase: 0.72, // 基本成功率（損益分岐~70%近辺・NPB）
    stealSlope: 0.32, // 成功率への走者寄与
    holdSlope: 0.28, // 投手クイックによる抑止
    armSlope: 0.3, // 捕手肩による抑止
  },
  // 走塁 run値（§6）。NPB寄り: SB≈+0.19 / CS≈−0.38。UBRは走者Speed/IQで進塁確率を上下（2-5）。
  run: { runSB: 0.19, runCS: -0.38, ubrSlope: 0.008, runUBR: 0.4 },
  // 併殺（2-6 wGDP, §6）: GBアウト×走者一塁×2アウト未満で併殺成立。打者の足で回避。
  gdp: { base: 0.42, speedW: 0.005, runGDP: -0.42 },

  // 守備（2-7/2-8, §7）: 野手個人のRangeを期待アウトに接続し、OAAに個人スキルを乗せる。
  field: {
    rangePerRating: 0.0016, // Range 1pt → 実効被安打率をこれだけ下げる（OAAの個人シグナル）
    wRange: { positioningIQ: 0.45, reaction: 0.3, speed: 0.25 }, // Range合成重み（§7.1）
    runPerOutInfield: 0.75, // OAA→run換算（内野・Statcast FRV）
    runPerOutOutfield: 0.9, // 外野
    runPerError: 0.5, // 失策1つ（ポジ平均との差）あたりのrun価値。UZRのErrR成分（監査A3・§7.2）
    framePerInning: 0.0005, // 捕手フレーミング: (framing-50)×これ×守備イニング をrun換算（監査B5・§7.3）
  },

  // 対戦巡目（1-5, §3.3）: 同一投手を1試合に複数回見るほど打者有利。
  // Phase1は一律係数のプレースホルダ。球種数重み付けは 2-1/2-2 後に有効化。
  tto: {
    kPerTime: 0.025, // 2巡目以降、K の logit を巡目あたり減らす（打者は三振しにくく）
    evPerTime: 0.7, // 2巡目以降、打球EV を巡目あたり +km/h（芯を捉えやすく）
  },

  // 打球生成(1-2)＋結果解決(1-3)。EV/LA/方向を先に作り、球場ジオメトリで結果を導く（§3.2）。
  // ※ bb 群は予備較正済み（5リーグ平均で AVG.258/OBP.323/SLG.401/HR118/ERA3.85/得点4.22、
  //    かつ分布の裾も 打率王.348/HR王47 まで圧縮=M4対応。RBI王~145は満員打線ゆえ構造的に高め）。
  bb: {
    // EV(打球速度 km/h)
    evBase: 139, // 平均打球速度の中心
    evPerEV: 0.45, // 打者EV適性1pt → km/h ※較正済み（裾圧縮）
    evPerPower: 0.22, // 生体power1pt → km/h ※較正済み
    evPitchSuppress: 0.3, // 投手の被コンタクト質抑止1pt → km/h減（選択球種のcontactQuality）
    evHrSuppressW: 0.25, // 選択球種のhrSuppressが高いほどEV減（弱い打球＝M3の結線）
    evAptW: 0.26, // 打者の対該当クラス適性が高いほどEV増（§4段階1）
    evSd: 14,
    // LA(打球角度 度)
    laBase: 12,
    laPerLA: 0.35, // 打者LA適性 → 角度中心シフト ※較正済み
    laPitchGB: 0.22, // 投手ゴロ率 → 角度を下げる
    laSd: 23,
    // 方向(spray 度: 0=中堅, ±45=ライン)。pull適性で引っ張り側へ。
    sprayPull: 0.55,
    spraySd: 17,
    // 飛距離モデル
    carry: 0.6, // v^2/g に掛ける実効係数（空気抵抗込みの縮み）
    // 結果グリッド（xBABIP系。type別の基準hit率＋EV補正）
    hitGB: 0.218,
    hitLD: 0.672, // 文献整合(ライナー安打率~.68-.70)へ引上げ(B-8)。得点環境は下の較正で再収束
    hitFB: 0.122,
    hitPU: 0.02,
    evHitW: 0.004, // (evKmh-140)×これ を hit率に加算 ※較正済み
    gapDistM: 90, // 単打/二塁打の境界（外野手到達圏）。これ未満の空中安打は単打（監査B1: 84→90で二塁打過剰是正＋得点環境較正）
    fbHitBonusM: 84, // FB警告帯ヒット加点(+0.15)の閾値。BABIP環境を保つため二塁打境界と分離（監査B1）
    tripleDistM: 94, // 二塁打/三塁打候補の深さ。これ以上の深いギャップ/ライン際球が三塁打になりうる（監査B1）
    tripleBase: 0.32, // 深いギャップ球の三塁打基本率（打者speedで上下）※較正済み
    tripleSpeedW: 0.007, // 打者speed(50中心)→三塁打率への寄与
    // 失策（ROE・§7 Hands）。インプレーのアウトが確率 errBase−(Hands−50)×errHandsW で失策になる。
    // 失策以降その回の得点は非自責（ERA<失点 の差＝未自責点を生む・較正の整合に必須）。
    errBase: 0.023,
    errHandsW: 0.0006,
    // 走者進塁の確率（Phase1簡易。UBRの精緻化は2-5）
    singleScore2: 0.56, // 単打で二塁走者が生還する確率（残りは三塁止まり）※較正済み（監査B後の得点環境再収束）
    doubleScore1: 0.50, // 二塁打で一塁走者が生還する確率（残りは三塁止まり）※較正済み（監査B後の得点環境再収束）
  },
};

/**
 * シムのラン環境から 1-6（リーグ定数導出パス）で埋める定数の器。
 * §18の 13.3/1.216 等は「初期値」であって、ここに導出値を上書きしてから指標を確定する（2パス）。
 */
export function createLeagueConstants() {
  return {
    linearWeights: null, // {bb,hbp,b1,b2,b3,hr, outValue,...}
    wobaScale: null,
    lgwOBA: null,
    lgFIP: null,
    fipConstant: null,
    rpw: null, // Runs Per Win
    posAdjPer1350: null, // 143試合へ再スケール後の位置補正（§9・M3）
  };
}

/** 設定一式のディープコピーを配る（較正ランごとに独立させる） */
export function createConfig(overrides = {}) {
  const cfg = {
    version: CONFIG_VERSION,
    league: clone(LEAGUE_DEFAULT),
    targets: clone(CALIBRATION_TARGETS),
    tuning: clone(TUNING_DEFAULT),
    leagueConstants: createLeagueConstants(),
  };
  return deepAssign(cfg, overrides);
}

// --- 試合数依存の媒介変数（M3: 162試合MLB定数を143へ再スケール） -------------
/** 規定打席（≒ games×3.1） */
export function qualifiedPA(games = LEAGUE_DEFAULT.gamesPerSeason) {
  return Math.round(games * 3.1);
}
/** 規定投球回（= games×1） */
export function qualifiedIP(games = LEAGUE_DEFAULT.gamesPerSeason) {
  return games;
}
/** フル出場の守備イニング（= games×9）。posAdj の分母（旧1350の置換） */
export function fieldingInningsFull(games = LEAGUE_DEFAULT.gamesPerSeason) {
  return games * 9;
}

/** 値が [min,max] に収まるか（較正の合否判定ヘルパー） */
export function inRange(v, range) {
  return v >= range[0] && v <= range[1];
}

// --- 内部ヘルパー -----------------------------------------------------------
function clone(o) {
  return JSON.parse(JSON.stringify(o));
}
function deepAssign(base, over) {
  for (const k of Object.keys(over)) {
    const ov = over[k];
    if (base[k] && ov && typeof base[k] === 'object' && typeof ov === 'object' && !Array.isArray(ov)) {
      deepAssign(base[k], ov);
    } else if (ov !== null && typeof ov === 'object') {
      base[k] = clone(ov); // 葉のオブジェクト/配列は複製し、override元との状態共有を断つ
    } else {
      base[k] = ov; // null・プリミティブは葉として代入
    }
  }
  return base;
}

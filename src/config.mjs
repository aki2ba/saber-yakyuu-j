// ============================================================================
// 中央パラメータ（config）モジュール（自己レビュー M6 / F43）
//
// 較正の可変係数・NPB目標帯・試合数依存の媒介変数・リーグ定数の器を一箇所に集約する。
//   - 較正(1-11/2-11)は「このモジュールだけ」を調整対象にする（マジックナンバーを散らさない）
//   - §19が要求する「エンジンバージョン固定＝定数セットの凍結」の単一面を兼ねる
//   - 較正ランが共有状態を汚さないよう createConfig() で毎回ディープコピーを配る
// ============================================================================

export const CONFIG_VERSION = '0.0.8-phaseA-fix';

/** リーグ設定（フェーズA: 12球団×143試合・2リーグ制）。
 *  試合のDH有無は「ホーム球団の所属リーグ規則」に従う（旧 dh:'all' は廃止・S2で試合側に接続）。
 *  日程はS3日程v2: リーグ内5相手×25（ホーム13/12交互）＋交流戦6相手×3 → 143試合。 */
export const LEAGUE_DEFAULT = {
  numTeams: 12,
  gamesPerSeason: 143, // NPB準拠 = リーグ内125 + 交流戦18（S3日程v2）
  // 2リーグ制（名称は完全架空の造語）。dh=false のリーグは投手が打席に立つ（セ系）。
  leagues: [
    { id: 'L1', name: '陽炎リーグ', dh: false }, // セ・リーグ系（DH無し）
    { id: 'L2', name: '蒼天リーグ', dh: true }, // パ・リーグ系（DH有り）
  ],
  inLeagueGamesPerOpp: 25, // リーグ内 同一相手との試合数（ホーム13/12を交互に）
  interLeagueGamesPerOpp: 3, // 交流戦 同一相手との試合数（3連戦を一方の本拠地で）
  rotationSize: 6, // 先発ローテ人数（中6日・NPB標準）
  rosterActive: 28, // 出場登録の目安（フェーズ3で精緻化）
  // ポストシーズン規則（§S3-3）: CS1st=2戦先勝 → CSFinal=1位に1勝アド・4勝先取 → 日本シリーズ=4勝先取(2-3-2)
  postseason: {
    csFirstWins: 2, // CSファーストの必要勝数（2位本拠地）
    csFinalWins: 4, // CSファイナルの必要勝数（アドバンテージ込み・1位本拠地）
    csFinalAdv: 1, // リーグ1位のアドバンテージ勝数
    japanSeriesWins: 4, // 日本シリーズの必要勝数
  },
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
    kPct: [0.18, 0.205], // 上限を.205へ（投手打撃の現実化で投手被Kが増え、リーグK%~.20はNPB水準として妥当）
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
    // WAR下限（起用AIの機能証明・原則2「WAR-6の根絶」）を2本立てで判定する:
    //   floorCatastrophe: 全シード中の単一最悪値 > これ（系統的な起用崩壊＝WAR-4〜-6の根絶を保証）
    //   floorTypical:     各シーズンの最悪レギュラーWARの平均 > これ（典型的な最下位が破局的でない）
    // 単一minを典型閾値で判定すると、稀な貧ロスター（捕手難）の1選手で極値統計が落ちるため分離。
    floorCatastrophe: -4.0, // 単一最悪 > -4.0（絶対に -5/-6 を出さない）
    floorTypical: -2.5, // 各シーズン最悪の平均 > -2.5
    uzrTop: [20, 30],
  },
  // 起用・休養の発現
  usage: {
    qualifiedPerTeam: [5, 9], // 規定打席到達者/球団
    catcherStarterGames: [100, 135], // 正捕手の出場試合（143未満＝休養AIの発現）
  },
  // フェーズB B3c 追加系指標の健全性チェック帯（新指標の妥当域）。
  // ※これらは「追加集計」の健全性検証であり、上の既存30目標帯とは独立（既存30は不変を維持）。
  //   xwOBA≈wOBA・ΣRE24≈0・WPAゼロサム・平均LI=1.0 は構造上の恒等（モデル=シム / martingale）。
  //   LOB%/QS率/ARM/SD王 はNPB水準の妥当域（QS率は現行simが上振れ＝B1/全体較正で収束）。
  phaseB: {
    xwobaVsWoba: 0.003, // |リーグ xwOBA − wOBA| ≤ これ（打球モデル=シムの恒等）
    lobPct: [0.70, 0.75], // リーグ残塁率
    qsRate: [0.45, 0.60], // 先発QS率（NPB水準・現行simは上振れ＝要 sim較正で収束）
    armLeader: [5, 12], // 外野ARM上位（対リーグ平均run）
    re24SumAbs: 1e-6, // |ΣRE24| ≤ これ（打者+走者+投手 = 0 恒等）
    wpaZeroSum: 1e-9, // WPAゼロサム最大誤差 ≤ これ（1試合 勝者±0.5）
    liAvg: [0.999, 1.001], // 打席加重平均LI = 1.0（正規化・aLI/pLI）
    sdLeader: [20, 50], // シャットダウン王（好救援の高レバレッジ成功）
  },
};

/**
 * B3a 追加系指標（一球データを要さない集計指標・§B3）の定義定数。
 * Barrel/HardHit/SweetSpot のEV/LA帯・方向境界・SIERA(FG公開式)/kwERA の係数を集約する。
 * ※これらは物理/定義に基づく固定値（較正ノブではない）だが、規約に従い config.tuning に集約し、
 *   metrics.mjs 側は cfg 未指定時にこの既定値へフォールバックする。
 */
export const METRICS_CONST = {
  hardHitKmh: 152, // HardHit% 閾値（EV≥152km/h ≈ 95mph）
  barrelMinKmh: 157.7, // Barrel下限EV（≈98mph）
  barrelBaseLo: 26, // 98mph時のBarrel帯 LA下限
  barrelBaseHi: 30, // 98mph時のBarrel帯 LA上限
  barrelLoSlope: 1.0, // mph超過1あたりLA下限を下げる度数（116mphで8°）
  barrelHiSlope: 1.11, // mph超過1あたりLA上限を上げる度数（116mphで50°）
  barrelMinLA: 8, // Barrel帯の最小LA
  barrelMaxLA: 50, // Barrel帯の最大LA
  sweetSpotLoLA: 8, // Sweet-Spot% の下限LA
  sweetSpotHiLA: 32, // Sweet-Spot% の上限LA
  centAbsSpray: 15, // |spray|≤これ=中堅方向(Cent)。外は引っ張り/流し
  // SIERA（FanGraphs公開式・Swartz）: netGB=(GB−FB−PU)/PA, SO/PA, BB/PA。
  // netGB²項は符号保存（GB>FB+PU で負寄与＝好投、逆で正寄与）＝ cNet2×netGB×|netGB|。
  siera: { c0: 6.145, cSO: -16.986, cBB: 11.434, cNet: -1.858, cSO2: 7.653, cNet2: -6.664, cSOnet: 10.13, cBBnet: -5.195 },
  // kwERA = 5.40 − 12×(K% − BB%)
  kwERA: { c0: 5.4, k: 12 },
};

/**
 * B2 文脈指標（RE24/WPA/LI・§B2）の定義/導出定数。
 * 状態キー（イニング/表裏/点差クリップ/塁アウト）の粒度と、勝率表(WE)の階層平滑化強度、
 * シャットダウン/メルトダウンの WPA 閾値を集約する。これらは較正ラン相当の大標本から
 * RE行列・WE表・LI表を導出する2パス（season.mjs で結線）で参照される。
 */
export const CONTEXT_CONST = {
  innMax: 9, // イニングのクリップ上限（延長は9回バケットへ集約）
  scoreDiffClip: 8, // 点差クリップ ±8（打者側視点 = 攻撃側得点−守備側得点）
  sdThreshold: 0.06, // SD(≥+0.06)/MD(≤−0.06) の1登板WPA閾値（FG方式）
  // WE 勝率表の階層平滑化: fine(24状態)←coarse(イニング/表裏/点差)←diff周辺←0.5
  weSmoothK: 40, // fine セル← coarse事前分布の平滑化擬似標本
  weCoarseK: 40, // coarse セル← diff周辺分布の平滑化擬似標本
  weDiffK: 20, // diff周辺← 0.5 への軽い平滑化擬似標本
};

/**
 * エンジン調整ノブ（初期値・較正で動かす）。§18主要定数＋新EV/LAエンジン固有ノブ。
 * 新エンジンでは BABIP/HR は打球格子から創発するため、旧「結果先決め」定数と1:1でない（F44）。
 */
export const TUNING_DEFAULT = {
  // B3a 追加系指標（率/期待値）の定義定数（§B3・上の METRICS_CONST を集約）。
  metrics: METRICS_CONST,
  // B2 文脈指標（RE24/WPA/LI）の導出/定義定数（§B2・上の CONTEXT_CONST を集約）。
  context: CONTEXT_CONST,

  hrScale: 0.992, // 本塁打産出スケール（門番: hrPerTeam/HR王）。⚠️HRは閾値のため感度大
  babipBase: 0.3, // インプレー打球の安打基準
  fieldingCoef: 0.0009, // 守備係数（§18）
  // WAR代替水準（§9・§18の初期値。143試合/NPBへ較正対象）
  replBatterPer600: 18.8, // (PA/600)×これ ※WAR較正（救援repl現実化後、野手WAR比を0.53下限から離す）
  // 投手の役割別代替水準（S3・FanGraphs方式 B-5。旧 replFipMult=lgFIP×1.25 を廃止）:
  // pitcherWAR = (lgFIP−FIP)/9×IP/RPW + (IP/9)×replPer9。replPer9 は GS/G で先発/救援を按分。
  replStarterPer9: 0.153, // 先発の代替水準（wins/9IP）※投手WAR王5.5-8の門番（総WAR/野手比とのトレードオフの均衡点）
  replRelieverPer9: 0.020, // 救援の代替水準（wins/9IP）※レビュー#2: 0.012はブルペン総WARを負に沈める→約0へ引上げ（野手WAR比との両立で0.020）
  // FanGraphs方式（救援は先発より低い代替水準だが極端でない）へ寄せ、ブルペン総WARを僅かに正へ。

  // 打席規律層（1-1）: log5/オッズ比で K/BB/HBP/インプレー を分岐する較正ノブ。
  // League は打席1回あたりの基準確率、Slope は能力(20-80)→logit の感度。
  pa: {
    kLeague: 0.191, // リーグK率（NPB ~19-20%）
    bbLeague: 0.0795, // リーグBB率 ※較正済み
    hbpLeague: 0.009, // リーグHBP率
    kSlope: 0.22, // K感度 ※較正済み（分布の裾M4を圧縮）
    bbSlope: 0.2, // BB感度 ※較正済み
    hbpSlope: 0.1, // HBP感度（投手制球の荒れ）
    kContactW: 0.65, // 打者K傾向へのコンタクト寄与 ※S5較正（打者側K裾の圧縮・投手側は不変）
    kEyeW: 0.3, // 打者K傾向への選球眼寄与
    kVeloPerKmh: 0.85, // 投手奪三振への球速寄与 ※エース級K裾＝投手WAR王の門番
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
    attemptBase: 0.16, // 非強打者×バント局面の基本試行率 ※S2予備調整（野手SHがセパ差を埋没させない水準へ）
    tendW: 0.5, // 監督buntTend(50中心)の感度（logit増分/10pt）
    pitcherAttempt: 0.9, // 投手打席はほぼ必ずバント
    pitcherMaxScoreDiff: 6, // 投手はこの点差以内でのみバント（大差では打たせる。野手より広い）
    weakBatterWoba: 0.3, // 「非強打者」の目安（観測wOBAがこれ未満）※S2予備調整
    pitches: 2.5, // バント打席の投球数近似（S2）
  },

  // 敬遠（S2 maybeIBB が消費。§S2-5）: 一塁空き×2死or一死×終盤接戦×強打者（or次打者が投手）。
  ibb: {
    base: 0.7, // 条件成立時の基本敬遠率 ※S5較正（敬遠10-40/球団へ）
    tendW: 0.5, // 監督ibbTend(50中心)の感度
    minInning: 7, // 終盤のみ
    maxScoreDiff: 2, // 接戦のみ
    strongBatterWoba: 0.36, // 「強打者」の目安（観測wOBA上位）
    pitches: 4, // 敬遠の投球数（ボール4球）
  },

  // 交代（S2 代打/代走/守備固め。§S2-3）
  sub: {
    phInning: 7, // 野手への代打は7回以降
    phPitcherInning: 6, // 投手への代打は6回以降
    phMaxBehind: 3, // ビハインドこの点差以内（or接戦）の得点機で発動
    phGainMin: 5, // 代打起用に要する実効打力差（プラトーン込みhitScore相当）
    phPlatoonW: 10, // プラトーン補正のhitScore換算（同利きの候補はこれだけ減点）
    prInning: 8, // 代走は8回以降
    prMaxScoreDiff: 2, // 2点差以内
    prSpeedGainMin: 10, // ベンチ最速との走力差がこれ以上
    defInning: 8, // 守備固めは8回以降
    defLeadMin: 1, // リード1〜3で発動
    defLeadMax: 3,
    defGainMin: 8, // 守備固めに要する守備スコア差（習熟+素材。優位時のみ交代）
  },

  // 監督の観測評価（S2 manager.mjs）: インゲーム判断用の観測wOBA近似。
  // 三層構造の原則: 采配は観測statlineのみを見る（trueAbility は編成時評価に限る）。
  mgr: {
    wobaScale: 1.24, // 生の得点価値/PA → wOBA 換算の簡易スケール（リーグ定数導出前の近似）
    wobaPrior: 0.323, // 少打席の回帰先（リーグ平均wOBA相当）
    wobaPriorPA: 60, // 回帰の事前打席数（PAが少ないほど平均へ寄せる）
  },

  // 継投（S2 継投v2。§S2-7）: 役割ベース（closer/setup8/setup7/middle/long）＋降板判定の閾値。
  pen: {
    saveLeadMax: 3, // セーブ機会のリード上限（1〜3点差）
    leverageMinInning: 7, // 勝ちパターン継投の開始回（7回=setup7）
    starterPitchBase: 82, // 先発の球数上限の基礎（+ stamina×starterPitchStamW）
    starterPitchStamW: 0.73, // スタミナ→球数上限の感度 ※S5較正（高スタミナ先発の深投~110球）
    quickHookW: 0.5, // 監督quickHook(50中心)→球数上限の減分（早い継投ほど上限低）
    starterMaxRuns: 6, // 先発の失点即降板ライン
    tiredOuts: 18, // 6回以降（アウト数）で
    tiredRuns: 4, // 4失点なら降板
    starterStayRuns: 1, // 7-8回のセーブ機会でも失点これ以下の先発は続投 ※S5較正（8回はセットアッパーへ＝HLD王の門番）
    cgMinOuts: 21, // 9回続投（完投・完封狙い）に必要な先発アウト数（かつ無失点）
    cgMaxPitches: 102, // 9回続投を許す球数上限（完投の門番・S5較正。リード有無に依らず適用）
    relieverMaxOuts: 3, // 勝ちパターン役割（closer/setup8/setup7）は基本1イニング
    middleMaxOuts: 6, // middle（非役割）は複数イニング可（登板数王の圧縮・S5較正）
    relieverMaxRuns: 3, // 救援の失点降板ライン
    longOuts: 8, // 敗戦処理ロングは2-3回を投げる
    bigBehind: 5, // これ以上のビハインド=敗戦処理（longへ）
  },

  // 休養（S3 日次スタメンAI。正捕手100-135試合へ）
  rest: {
    catcherRestProb: 0.085, // 捕手の休養基本率/試合 ※S5較正（正捕手100-135試合へ）
    fielderRestProb: 0.026, // 野手の休養基本率/試合 ※S5較正
    streakW: 0.004, // 連続出場1試合ごとの休養率加算
    benchWoba: 0.295, // 不振ベンチの発動水準（観測ベース混合評価＋レンジ項がこれ未満・S5較正）
    slumpBenchProb: 0.75, // 不振ベンチの発動率/試合（捕手は通常対象外・S5較正）
    // 捕手は希少性・リード継続性から通常の不振ベンチ対象外だが、「壊滅的」水準（benchWobaより
    // 更に下＝wRAA最悪級×守備破綻）に限り控えと出場を分け、WAR-3級の定着を防ぐ（原則2「WAR-6の根絶」）。
    catcherDisasterWoba: 0.258, // 捕手の壊滅判定（混合評価＋レンジがこれ未満で作動）
    catcherDisasterBenchProb: 0.4, // 壊滅捕手の休養率/試合（完全ベンチでなく控えと分担＝正捕手枠は保つ）
  },

  // 投手疲労・可用性（S3。連投制限・中6日の基盤）
  fatigue: {
    maxConsecDays: 2, // 2連投まで（3連投禁止）
    prevDayPitchLimit: 24, // 前日この球数以上→当日不可 ※S5較正（SV/HLD/登板数の負荷分散）
    starterRestDays: 5, // 先発は中5日以上
  },

  // 観測成績ベース起用（S3 usage.mjs）。三層構造: 真値は直接見ない（観測statline＋スカウトノイズ）。
  usage: {
    reviewInterval: 25, // 見直し間隔（試合）
    trustPA: 80, // 観測wOBAの信頼度加重の半飽和PA（少PAは回帰）※S5較正
    scoutSd: 5, // スカウト評価ノイズのSD（rating単位・scoutSeed基準）※S5較正
    swapMargin: 0.005, // レギュラー入替に要する実効wOBA差 ※S5較正
    catcherSwapMargin: 0.04, // 捕手のみ厚め（リード面の継続性＝正捕手100-135試合の門番・S5較正）
    platoonMargin: 0.005, // プラトーン入替に要する実効wOBA差
    scoutWobaPerPt: 0.0035, // スカウト打撃評価(50中心rating)1pt → wOBA換算
    defWobaPerPt: 0.0005, // ポジション守備評価(習熟項)1pt → wOBA換算（同一ポジション内比較のみ・S5較正）
    rangeWobaPerPt: 0.0015, // レンジ評価(50中心)1pt → wOBA換算（UZR産出に比例する成分・S5較正）
    platoonWobaPenalty: 0.014, // 同利き手の実効wOBA減（相手先発でのプラトーン入替判断用）
    promoteStep: 0.45, // 見直しごとに挑戦者の先発シェアを増やす幅（1.0で完全昇格＝漸進的な入替。<0.5=3回の見直しで昇格）※S5較正
    candidatesPerPos: 6, // ポジション候補 = 編成時 positionRank の上位この人数 ※S5較正
    windowMinPA: 60, // 直近フォーム窓（前々回見直し以降）の採用に要する窓内PA（未満は累積で評価・S5較正）
  },

  // 日程v2（S3 buildSchedule）: 「節」カレンダーの休日規則
  schedule: {
    maxTeamConsecDays: 6, // 連続試合日はこの日数まで（超えたら休日を挟む＝NPBの週1休の近似）
  },

  // 編成・打順（S1 buildDepthChart v2。§S1-3）
  depth: {
    posToolW: 0.4, // positionRank: 守備素材(Range,50中心)の重み（習熟=1基準）
    posBatW: 0.2, // positionRank: 打撃(hitScoreを50中心スケール化)の重み
    leadoffSpeedW: 1.0, // 1番選定: speed(50中心)の加点重み
  },

  // 走塁（2-4 wSB, §6）: 盗塁の試行・成否を 走者Steal/Speed × 投手Hold × 捕手Arm から生成。
  // gate系はS2の采配ゲート（監督stealTend×状況。§S2-6）。
  steal: {
    attemptBase: 0.11, // 一塁走者が二塁を狙う基本試行率（機会あたり）
    attemptSlope: 0.45, // 走者の積極性感度（Steal/Speed）
    successBase: 0.72, // 基本成功率（損益分岐~70%近辺・NPB）
    stealSlope: 0.32, // 成功率への走者寄与
    holdSlope: 0.28, // 投手クイックによる抑止
    armSlope: 0.3, // 捕手肩による抑止
    tendW: 0.4, // 監督stealTend(50中心)の試行logit感度
    gateBigDiff: 5, // 大差の目安（±この点差以上では走らない）
    gateBigDiffLogit: 1.6, // 大差時の試行logit減
    gateStrong2OutLogit: 0.8, // 2死×強打者（観測wOBA上位）での自重logit減
  },
  // 走塁 run値（§6）。NPB寄り: SB≈+0.19 / CS≈−0.38。UBRは走者Speed/IQで進塁確率を上下（2-5）。
  run: { runSB: 0.19, runCS: -0.38, ubrSlope: 0.007, runUBR: 0.36 }, // ubr系はS5較正（BsR裾）
  // 併殺（2-6 wGDP, §6）: GBアウト×走者一塁×2アウト未満で併殺成立。打者の足で回避。
  gdp: { base: 0.42, speedW: 0.007, runGDP: -0.42 }, // speedWはS5較正（足↔併殺回避の結線を統計的に頑健へ）

  // 守備（2-7/2-8, §7）: 野手個人のRangeを期待アウトに接続し、OAAに個人スキルを乗せる。
  field: {
    rangePerRating: 0.0015, // Range 1pt → 実効被安打率をこれだけ下げる（OAAの個人シグナル）※S5較正（UZR裾。0.0016→0.0015）
    wRange: { positioningIQ: 0.45, reaction: 0.3, speed: 0.25 }, // Range合成重み（§7.1）
    runPerOutInfield: 0.75, // OAA→run換算（内野・Statcast FRV）
    runPerOutOutfield: 0.9, // 外野
    runPerError: 0.5, // 失策1つ（ポジ平均との差）あたりのrun価値。UZRのErrR成分（監査A3・§7.2）
    framePerInning: 0.0005, // 捕手フレーミング: (framing-50)×これ×守備イニング をrun換算（監査B5・§7.3）
    // --- B3b UZR成分分解（ARM/DPR/rSB・§B3b）: 追加集計の対平均run換算係数。
    //     いずれも WAR用の uzrRuns には加えず（＝較正30指標が完全不変）、
    //     uzrComponents（分解表示）でのみ合成する（総UZR不変が理想・§検証）。
    armRunPerOpp: 0.007, // 外野ARM: 追加進塁機会1回あたり (arm-50)×これ をrun換算（対平均・game.mjsで累積。上位+5〜12run）
    runPerDP: 0.45, // DPR: 併殺1つ（対リーグ平均転換率）あたりのrun価値。1件の併殺は二遊間で共有する1イベント（打者側 runGDP=-0.42 と同型の対称値）
    dpShare: 0.5, // DPR: 上記の1イベントrun価値を参加者で分担する比率。game.mjs が1機会/成立を 2B・SS 双方にフル計上するため、二重帰属を避けるべく各参加者に0.5を配分（Σで単一計上のチーム値に一致・§B3b）
  },
  // 走塁 Spd（簡易4成分・Bill James風0-10スケール・§B3b）: SB成功率×頻度・三塁打率・XBT%・守備位置速度の合成。
  spd: {
    minSbAtt: 5, // 盗塁成功率を採用する最小企図数（未満は中立）
    neutralSbRate: 0.5, // 企図僅少時の中立成功率
    sbFreqRef: 0.15, // 盗塁企図頻度（企図/一塁到達）の10点基準
    b3Ref: 0.02, // 三塁打率（三塁打/インプレー）の10点基準
    xbtRef: 0.6, // XBT%（追加進塁率）の10点基準
    posDefault: 4, // 位置速度の既定
    posSpeed: { CF: 8, SS: 7, '2B': 6, '3B': 4, RF: 5, LF: 4, C: 2, '1B': 2, DH: 3 }, // 守備位置の速度性（0-10）
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
    evPerEV: 0.355, // 打者EV適性1pt → km/h ※S5較正（裾圧縮＝野手WAR王7-9.5）
    evPerPower: 0.2, // 生体power1pt → km/h ※S5較正
    evPitchSuppress: 0.3, // 投手の被コンタクト質抑止1pt → km/h減（選択球種のcontactQuality）
    evHrSuppressW: 0.25, // 選択球種のhrSuppressが高いほどEV減（弱い打球＝M3の結線）
    evAptW: 0.26, // 打者の対該当クラス適性が高いほどEV増（§4段階1）
    evSd: 14,
    // LA(打球角度 度)
    laBase: 12,
    laPerLA: 0.42, // 打者LA適性 → 角度中心シフト ※S5較正（HR王の裾はLA側で確保）
    laPitchGB: 0.22, // 投手ゴロ率 → 角度を下げる
    laSd: 23,
    // 方向(spray 度: 0=中堅, ±45=ライン)。pull適性で引っ張り側へ。
    sprayPull: 0.55,
    spraySd: 17,
    // 飛距離モデル
    carry: 0.6, // v^2/g に掛ける実効係数（空気抵抗込みの縮み）
    // 結果グリッド（xBABIP系。type別の基準hit率＋EV補正）
    hitGB: 0.2195, // ※S5較正
    hitLD: 0.672, // 文献整合(ライナー安打率~.68-.70)へ引上げ(B-8)。得点環境は下の較正で再収束
    hitFB: 0.131, // ※S5較正
    hitPU: 0.02,
    evHitW: 0.003, // (evKmh-140)×これ を hit率に加算 ※S5較正（BABIP裾＝打率王≤.355）
    gapDistM: 85.5, // 単打/二塁打の境界（外野手到達圏）。これ未満の空中安打は単打（監査B1で84→90、S5較正でSLG帯確保のため85.5へ。fbHitBonusM=84より上を維持）
    fbHitBonusM: 84, // FB警告帯ヒット加点(+0.15)の閾値。BABIP環境を保つため二塁打境界と分離（監査B1）
    tripleDistM: 94, // 二塁打/三塁打候補の深さ。これ以上の深いギャップ/ライン際球が三塁打になりうる（監査B1）
    tripleBase: 0.32, // 深いギャップ球の三塁打基本率（打者speedで上下）※較正済み
    tripleSpeedW: 0.007, // 打者speed(50中心)→三塁打率への寄与
    // 失策（ROE・§7 Hands）。インプレーのアウトが確率 errBase−(Hands−50)×errHandsW で失策になる。
    // 失策以降その回の得点は非自責（ERA<失点 の差＝未自責点を生む・較正の整合に必須）。
    errBase: 0.023,
    errHandsW: 0.0006,
    // 走者進塁の確率（Phase1簡易。UBRの精緻化は2-5）
    singleScore2: 0.6, // 単打で二塁走者が生還する確率（残りは三塁止まり）※S5較正（得点環境・rpw）
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

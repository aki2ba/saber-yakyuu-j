// ============================================================================
// 中央パラメータ（config）モジュール（自己レビュー M6 / F43）
//
// 較正の可変係数・NPB目標帯・試合数依存の媒介変数・リーグ定数の器を一箇所に集約する。
//   - 較正(1-11/2-11)は「このモジュールだけ」を調整対象にする（マジックナンバーを散らさない）
//   - §19が要求する「エンジンバージョン固定＝定数セットの凍結」の単一面を兼ねる
//   - 較正ランが共有状態を汚さないよう createConfig() で毎回ディープコピーを配る
// ============================================================================

export const CONFIG_VERSION = '0.10.0-farm'; // F2-5: ロスター拡大(70+育成)・出場登録29人環境への再較正

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
  rosterActive: 29, // 出場登録人数（F2-2: 支配下70人からシーズン開始時に球団AIが29人を選抜。NPB=出場登録29人相当）
  // 二軍リーグ（F2-2）: 同じ12球団のファームを2リーグ（完全架空名・一軍と同分割）で並走させる。
  //   一軍と同じ simulateGame・別の集計器(farmStats)。日程は一軍と同じ day カレンダーに載せる（同日消化）。
  //   null にすると二軍リーグを組まない（一軍結果は独立ストリームゆえ有無で byte 不変＝重い多年テストの節約用）。
  farm: {
    leagues: [
      { id: 'F1', name: '若草リーグ', dh: true }, // 一軍L1球団のファーム（二軍は両リーグDH制＝育成試合の簡略）
      { id: 'F2', name: '暁リーグ', dh: true }, // 一軍L2球団のファーム
    ],
    inLeagueGamesPerOpp: 22, // リーグ内 5相手×22 = 110試合（NPBファーム~110-130試合帯の下限側）
    interLeagueGamesPerOpp: 0, // 二軍の交流戦は無し（総試合 660 = 110×12/2）
    gamesPerSeason: 110,
  },
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
    // BABIP は独立ノブではなく AVG/K%/HR から算術的に決まる従属変数。
    // 「打球解決モデルが AVG/K%/HR と整合しているか」の冗長チェックとして門番に置く（正典§11.8）。
    // ⚠️NPB 2023-25 の実測は .288〜.292 だが、本シムの他の目標帯（AVG .255-.262 / OPS .715-.735 /
    //   HR 110-130 / 4.2点）は NPB 2015-19 の「飛ぶボール」時代の得点環境であり、BABIP も
    //   その環境と整合させる。低反発球時代へ寄せるなら得点環境一式の再ベースラインが必要（別課題）。
    babip: [0.298, 0.318],
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
    qsRate: [0.45, 0.60], // 先発QS率（NPB水準・B1一球化＋継投再較正で帯内に収束）
    armLeader: [5, 12], // 外野ARM上位（対リーグ平均run）
    ofAssistLeader: [5, 11], // 外野補殺リーダー（NPB.jp 2025実測: セ6 / パ9・正典§6.4）
    // --- 守備の門番（正典§11.8）。守備指標は長らく較正の対象外＝野放しだった。
    //   規定守備400イニング以上の野手UZR（捕手はUZRを持たない）。
    //   FanGraphs 目安「+15=ゴールドグラブ級 / −15=劣悪」。NPB(DELTA)実測も外崎+15.4(2022)・
    //   菊池+12.3(2014) と同水準で、143/162 の比例縮小を行う根拠は無い（正典§6.3）。
    uzrTop: [11, 20], // リーグ最高UZR
    uzrBottom: [-22, -11], // リーグ最低UZR
    uzrSd: [4, 7], // 規定守備者のUZR標準偏差（現実は約5）
    re24SumAbs: 1e-6, // |ΣRE24| ≤ これ（打者+走者+投手 = 0 恒等）
    wpaZeroSum: 1e-9, // WPAゼロサム最大誤差 ≤ これ（1試合 勝者±0.5）
    liAvg: [0.999, 1.001], // 打席加重平均LI = 1.0（正規化・aLI/pLI）
    sdLeader: [20, 50], // シャットダウン王（好救援の高レバレッジ成功）
    // --- B1-3 規律系（一球シムの副産物・リーグ集計の率）------------------------------
    pitchesPerPA: [3.7, 4.0], // 投球数/打席
    zonePct: [0.42, 0.48], // Zone%（明確にゾーン内の帯のみ・従来定義＝0.9.1でも不変）
    oSwingPct: [0.26, 0.34], // O-Swing%（ゾーン外スイング率・FanGraphs定義。0.9.1: ボーダー帯を
    //   半分ゾーン外として按分計上＝(際×0.5+明確)のスイング率。帯はNPB/MLB実測25-33%と整合し維持）
    zSwingPct: [0.60, 0.70], // Z-Swing%（ゾーン内スイング率）
    contactPct: [0.75, 0.81], // Contact%（スイングの接触率）
    swStrPct: [0.085, 0.12], // SwStr%（空振り/全投球）
    cswPct: [0.26, 0.31], // CSW%（見逃し+空振り / 全投球）
    fStrikePct: [0.58, 0.64], // F-Strike%（初球ストライク率）
    starterPitchesPerGame: [90, 110], // 先発投球数/試合（中6日と整合）
    wpPbPerTeam: [35, 70], // WP+PB/球団
    framingLeader: [6, 15], // フレーミングrun上位（捕手・対リーグ平均run）
  },
  // フェーズD2 パークファクター（§11.2）の健全性チェック帯（既存50とは独立の追加系）。
  //   得点環境は既存50が据え置きを保証（PF対称・ゼロサム）。ここは PF が「球団ごとに散る」ことと
  //   「PF補正後の wRC+ がリーグ100中心（＝補正がゼロサム）」を検証する。
  phaseD: {
    // PF散らばり（12球団の run PF の最大−最小）。⚠️1年の run PF は試合数有限の統計ノイズが支配的で、
    //   球場個性ゼロ（中立単一park）でも max−min≈0.29 の床がある。球場個性を載せると≈0.35へ増える
    //   （＝上位/下位が実効±10-17%に散る）。よって帯は「ノイズ床(0.29)＋球場signal」を含む水準に置く。
    pfRunsSpread: [0.24, 0.48], // max(pfRuns)−min(pfRuns)（ノイズ床0.29＋球場個性）
    pfRunsMean: [0.99, 1.01], // リーグ平均 pfRuns（正規化により≈1＝ゼロサム＝得点環境据え置きの担保）
    parkWrcPlusCenter: [98.0, 102.0], // PA加重リーグ park補正 wRC+（補正がゼロサム＝100中心）
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

  hrScale: 0.9695, // 本塁打産出スケール（門番: hrPerTeam/HR王）。⚠️HRは閾値のため感度大。
  //   守備モデル刷新でPA数がわずかに動き HR王 が帯を割ったため微増（0.966→0.9695・HR/team は帯中央を維持）
  //   F2-5: 出場登録29人選抜の上澄み効果でHR/teamが141へ膨張→0.985から引下げて[110,130]帯へ再収束
  babipBase: 0.3, // インプレー打球の安打基準
  fieldingCoef: 0.0009, // 守備係数（§18）
  // WAR代替水準（§9・§18の初期値。143試合/NPBへ較正対象）
  // 野手の代替水準（正典 sabermetrics_glossary.md §7.1 / §10.5）。
  //   FanGraphs: 代替勝利の総量 = 570 × (Games/2430) を固定し、打席比で按分する。
  //   ＝ 1チーム1試合あたり 570/(30×162) = 0.1173 wins。このシムは較正で値を決める。
  //   代替勝利を wins で固定することで、時代トレンド（得点環境の揺れ）で総WARが動かなくなる。
  replHitterWinsPerTeamGame: 0.134, // ※WAR較正（総WAR・野手WAR比の門番）
  replBatterPer600: 19.1, // 【フォールバック専用】lc が無いときだけ使う旧式 (PA/600)×これ [run]
  // 投手の役割別代替水準（S3・FanGraphs方式 B-5。旧 replFipMult=lgFIP×1.25 を廃止）:
  // pitcherWAR = (lgFIP−FIP)/9×IP/RPW + (IP/9)×replPer9。replPer9 は GS/G で先発/救援を按分。
  replStarterPer9: 0.166, // 先発の代替水準（wins/9IP）※投手WAR王5.5-8の門番（総WAR/野手比とのトレードオフの均衡点）
  //   F2-5: 29人選抜でリーグ平均投手が上澄み化しエースの相対FIP優位が圧縮（WAR王5.3へ低下）→0.153から引上げ
  replRelieverPer9: 0.014, // 救援の代替水準（wins/9IP）※レビュー#2: 0.012はブルペン総WARを負に沈める→約0へ引上げ。
  //   F2-5: replStarter引上げの総WAR超過(430上限)を救援側で相殺（0.020→0.014・ブルペン総WARは非負を維持）
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

  // ==========================================================================
  // 一球ごとシミュレーション（B1・§B1）: (balls,strikes) カウント状態機械のノブ。
  // plateAppearance.mjs の runPlateAppearance が消費する。K/BB/HBP は 3ストライク/4ボール/
  // 死球として創発する（旧 pa.* の log5 一発抽選は廃止し legacy 化）。全ノブをここへ集約。
  // 較正の第一目標帯（§B1-3）: 投球数/打席3.7-4.0・Zone%42-48・O-Swing26-34/Z-Swing60-70・
  //   Contact75-81・SwStr8.5-12・CSW26-31・F-Strike58-64。
  // ==========================================================================
  pitch: {
    // --- 投球ロケーション（ゾーン内/ボーダー/明確ボールの3帯） ---
    zoneBase: 0.399, // 基準ゾーン内率（control50・even count）※Zone%の主ノブ（B1較正: 0.42→0.432。
    //   F2-5: 29人選抜で制球上位が残りリーグBB%が6.6%へ沈没→0.432から引下げてBB%[7.8,8.3]/K%/F-Strikeを回復。
    //   選抜後の実効Zone%は[42,48]帯内=44-45%に留まる）
    zoneControlW: 0.005, // 制球(50中心)→ゾーン率（制球でストライク先行）
    zoneAheadW: -0.10, // 追い込み(0-2,1-2)でゾーン率減（ボールで釣る）
    zoneBehindW: 0.15, // ビハインド(3-0,3-1,2-0)でゾーン率増（置きにいく）
    zoneEvenBehindW: 0.04, // balls>strikes の軽いビハインドでゾーン率増
    // 帯配分の現実化（0.9.1-pitchband・ユーザーレビュー「クソボールばかり」対応）:
    //   Statcast帯換算では際(shadow)が全投球の~40%・明確ボール(chase/waste)は~30%。旧0.34は
    //   際18.8%/明確36.6%と歪んでいた（際が少なく大外れが多い）→ 0.56で際~31%/明確~24%へ。
    borderShare: 0.56, // 非ゾーンのうちボーダー帯（フレーミングが効く縁）の割合。残りは明確ボール
    // --- 打者スイング判断 ---
    zSwingBase: 0.62, // ゾーン内スイング率（Z-Swing%の主ノブ・B1較正: 0.66→0.62で早見せ→投球数/CSW↑）
    bSwingBase: 0.46, // ボーダー帯スイング率（0.9.1: 据置。際の球数自体が~1.6倍になるため base 据置でも
    //   際スイングの絶対量は増え、chase減と合わせて全体swing量はほぼ不変）
    oSwingBase: 0.10, // ボール球スイング率（chase・0.9.1: 0.235→0.10。明確ボールへの手出し~30%は現実(~18%)比1.7倍
    //   → 2ストライク保護スイング/同利き補正込みの実効で~15-18%へ現実化。BB%はborderCsBase/whiff系で再収束）
    swingEyeW: 0.004, // eye(50中心)→ボーダー/ボール球スイング率減（見極め。0.9.1: 0.006→0.004。
    //   chase基準の半減で eye 差の相対効果が増幅され、高eye打者のchaseが下限クランプに張り付いて
    //   規律の質差が過大に→セパ得点差(DH規則単位)が帯上限超え＋野手WAR王9.5超え。
    //   傾き圧縮で両者を帯へ戻す（0.005では野手WAR王9.6が残存→0.004で~8.9）
    swingZoneEyeW: 0.0015, // eye→ゾーンスイング率減（わずか。巧打者は good pitch を待てる）
    twoStrikeSwingW: 0.20, // 2ストライクの保護スイング増（全帯・B1較正: 0.11→0.20。当てにいく→ファウル粘り）
    threeOhTakeW: 0.42, // 3-0での自重（スイング率減）
    // --- スイング時の空振り ---
    whiffZoneBase: 0.175, // ゾーン内スイングの空振り基準（B1較正: 0.095→0.175。0.9.1: →0.185。
    //   帯再配分で空振りの多いchase swingが減った分をゾーン内で補い Contact%[75,81] を維持。
    //   F2-5: whiffPitchW引上げ(0.006→0.008)が選抜後の上澄みリーグでK%を押し上げるため基準3本を引下げて相殺）
    whiffBorderBase: 0.303, // ボーダー帯スイングの空振り基準（B1較正: 0.16→0.27。0.9.1: →0.32。F2-5: →0.303・同上）
    whiffOBase: 0.417, // ボール球スイング（chase）の空振り基準（B1較正: 0.26→0.38。0.9.1: →0.44。F2-5: →0.417・同上）
    whiffPitchW: 0.008, // 球種whiff(50中心)→空振り増（F2-5: 0.006→0.008。29人選抜でエースの相対K優位が
    //   圧縮され投手WAR王が帯割れ→投手間スプレッドを拡大しエースの裾を回復。リーグK%は基準3本の引下げで相殺）
    whiffContactW: 0.006, // 打者contact(50中心)→空振り減
    whiffAptW: 0.004, // 対該当クラス適性(50中心)→空振り減
    whiffTwoStrikeW: 0.235, // 2ストライクの空振り率減（当てにいく短縮スイング。ppa↑・K抑制・B1較正: 0→0.18。
    //   0.9.1: →0.215。F2-5: →0.235（選抜後のK%を[18,20.5]上限内に収める最終相殺）
    // --- 接触時: ファウル vs インプレー ---
    foulBase: 0.47, // 接触のうちファウルになる基準
    foulTwoStrikeW: 0.18, // 2ストライクでファウル率増（粘り＝カット・B1較正: 0.08→0.18で投球数/PA↑）
    // --- 見逃し時: ボーダー帯の捕手フレーミング判定 ---
    borderCsBase: 0.175, // ボーダー帯見逃しのストライク獲得基準（framing50=リーグ中立時。0.9.1: 0.24→0.183。
    //   際の球数~1.6倍で見逃しストライクが増えBB%が沈むため、獲得率を下げて BB%[7.8,8.3] を回復。
    //   F2-5: →0.175（zoneBase引下げと合わせたBB/K再配分の微調整））
    frameSlopePerPt: 0.0024, // framing(50中心)→ボーダーCS率±（一球単位の創発。0.9.1: 0.0040→0.0024。
    //   際が18.8%→~31%へ増えフレーミング機会が~1.6倍になったため、上位run[6,15]を保つよう傾きで相殺）
    runPerCall: 0.125, // 1コール(vs中立)→run（framingRuns。per-inning近似の置換・§7.3）
    // --- HBP（内角外れの低確率イベント。現行率~0.9%/PAを維持） ---
    hbpPerClearBall: 0.0113, // 明確ボール1球あたりのHBP率（0.9.1: 0.007→0.0104。明確ボール36.6%→~24.7%の
    //   帯再配分でHBP機会が0.675倍になったため率で相殺＝HBP/PA~0.9%を維持。F2-5: →0.0113（OBP下限の回復））
    hbpControlW: 0.006, // 制球が低い(50-control)ほどHBP増
    // --- 暴投/捕逸（ワンバウンド球×捕手blocking） ---
    dirtBaseBreaking: 0.16, // 明確ボール(変化球)がワンバウンドになる率（0.9.1: 0.11→0.16。帯再配分で
    //   明確ボールが0.675倍→WP+PB/球団[35,70]を維持するよう率で相殺）
    blockSlopePerPt: 0.005, // blocking(50中心)→ワンバウンド抜け回避
    wildBase: 0.52, // ワンバウンド×走者ありで球が抜ける基準（blockで減）
    wpShare: 0.6, // 抜けたうち暴投(投手起因→wp)の割合。残りは捕逸(捕手起因→pb)
    // --- プラトーン/TTO の一球パラメータ再配置（旧 pa.platoon/tto の log5 相当を一球へ） ---
    platoonWhiffSame: 0.03, // 同利きで空振り率増（K↑）※D1-2: baseline維持（league K%を帯内に保つため据置）
    platoonOSwingSame: 0.05, // 同利きでchase増（BB↓）※D1-2 0.03→0.05（同利きBB抑制を強化）
    ttoWhiff: 0.010, // 巡目(tto)ごとに空振り率減（打者が慣れる＝K↓・EV↑は bb.tto側）
    // --- 球種選択のカウント依存重み（selectPitchByCount） ---
    fastballWeight: 2.0, // even時の速球系重み（残り球種=1.0）
    putawayWhiffBias: 0.9, // 2ストライク時、高whiff球種(whiff-50)に比例して重み増（決め球）
    behindFastballBias: 1.6, // ビハインド(3ball/2-0)で速球系重みを追加（制球しやすい球）
  },

  // 左右プラトーン（S1・M7解消）: 同利き手（実効打席サイド==投手の利き腕）へのペナルティ。
  // スイッチ(S)は常に投手と逆打席＝有利側に立つ（同利きにならない）。
  // 効果量の初期値は同利きで wOBA −.020〜.030 相当（S5較正で調整）。
  platoon: {
    // D1-2: 同利きwOBAを −.012→−.023 へ引上げ（目標帯 −.020〜.025・レビュー#4残差の解消）。
    //   ⚠️一球シム(runPlateAppearance)で実際に効く同利きノブは【pitch.platoonWhiffSame(K側)・
    //     pitch.platoonOSwingSame(chase/BB側)・この evKmhSame(EV→wOBA側)】の3つ。
    //     kLogitSame/bbLogitSame は旧 log5 一発抽選(paProbabilities)専用＝legacy（現行シムは不使用・
    //     単体テストのみ）。よって wOBA差の主ノブは evKmhSame とし、K%を膨らませないよう whiff は
    //     baseline維持・chase(oSwing)のみ増。EV減で落ちたリーグ得点環境は bb.evBase(139→139.55)で
    //     全体を再センタリング（同利き差=相対値は不変・§D1-2）。
    kLogitSame: 0.18, // 【legacy】同利きで K の logit 増（paProbabilities専用・現行シム不使用）※D1-2で意図に合わせ0.10→0.18
    bbLogitSame: -0.14, // 【legacy】同利きで BB の logit 減（同上）※D1-2 -0.08→-0.14
    evKmhSame: -2.5, // 同利きで打球EVの中心を下げる (km/h)※D1-2 -1.2→-2.5（一球シムで効く wOBA差の主ノブ）
  },

  // 犠打（S2 maybeBunt が消費。§S2-4）: 試行判断・結果テーブル。2ストライク概念はフェーズB。
  bunt: {
    successProb: 0.78, // 成功（走者進塁・打者アウト・sh++・ABなし）
    failProb: 0.12, // 失敗（先頭走者アウト）。残り＝内野安打
    hitProb: 0.1, // 内野安打化
    maxScoreDiff: 2, // 接戦判定（±この点差以内で試行）
    attemptBase: 0.17, // 非強打者×バント局面の基本試行率 ※S2予備調整（野手SHがセパ差を埋没させない水準へ）
    //   守備モデル刷新(Distance-Time)＋ARM実イベント化でバント局面の期待値が変わり犠打が目減りしたため再較正(0.145→0.17)
    //   F2-5: 0.16→0.145（DH無リーグの攻撃力を僅かに回復しセパ得点差を帯上限0.45から離す。SH帯は維持）
    tendW: 0.5, // 監督buntTend(50中心)の感度（logit増分/10pt）
    pitcherAttempt: 0.8, // 投手打席はほぼ必ずバント（F2-5: 0.9→0.8。セパ得点差の再収束＝投手にも僅かに打たせる）
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
    phPitcherInning: 5, // 投手への代打は5回以降（F2-5: 6→5。29人登録でベンチが厚くなった分DH無リーグの
    //   代打起用を現実寄りに前倒し＝セパ得点差[0.1,0.45]の再収束の主ノブ）
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
    starterPitchBase: 70, // 先発の球数上限の基礎（+ stamina×starterPitchStamW）
    starterPitchStamW: 0.68, // スタミナ→球数上限の感度 ※S5較正（高スタミナ先発の深投~110球）
    //   F2-5: 0.64→0.68（エースの深投＝投手WAR王の回復。QS率は代打前倒し(sub.phPitcherInning)で帯内に収まる）
    quickHookW: 0.44, // 監督quickHook(50中心)→球数上限の減分（早い継投ほど上限低）
    starterMaxRuns: 6, // 先発の失点即降板ライン
    tiredOuts: 18, // 6回以降（アウト数）で
    tiredRuns: 4, // 4失点なら降板
    starterStayRuns: 1, // 7-8回のセーブ機会でも失点これ以下の先発は続投 ※S5較正（8回はセットアッパーへ＝HLD王の門番）
    cgMinOuts: 21, // 9回続投（完投・完封狙い）に必要な先発アウト数（かつ無失点）
    cgMaxPitches: 80, // 9回続投を許す球数上限（完投の門番・S5較正。リード有無に依らず適用）
    relieverMaxOuts: 3, // 勝ちパターン役割（closer/setup8/setup7）は基本1イニング
    middleMaxOuts: 6, // middle（非役割）は複数イニング可（登板数王の圧縮・S5較正）
    relieverMaxRuns: 3, // 救援の失点降板ライン
    longOuts: 8, // 敗戦処理ロングは2-3回を投げる
    bigBehind: 5, // これ以上のビハインド=敗戦処理（longへ）
    // D4 レバレッジ駆動継投（§8.3の完成）: 接戦度(LI代理=回×点差×走者/アウト)で最良救援を高LI場面へ。
    //   代理LIは状態の純関数＝pass1/pass2で不変（決定論・WPA telescoping を壊さない）。
    levInningPivot: 7, // レバレッジ回重みの起点（7回=1.0）
    levInningSlope: 0.3, // 1回ごとの重み増（8回1.3 / 9回1.6 / 延長…）
    levInningCap: 12, // 回重みの頭打ち（延長の暴走防止）
    levCloseScale: 2.5, // 点差の減衰スケール（同点=1.0・離れるほど指数減衰）
    levRunnerW: 0.35, // 走者1人あたりの重み
    levRispW: 0.25, // 得点圏（2B/3B）加点
    levOutW: 0.15, // アウト1つあたりの減衰
    highLevThreshold: 1.6, // 高レバレッジ判定閾値（この上で最良セットアッパーを投入・S5較正で調整）
    // 破綻救援ガード（多年運用・原則2「WAR-6の根絶」の投手版・捕手の壊滅ガードと同型）。
    //   前年の観測失点率(RA9=r*27/outs)が破綻水準の"前歴"があり、かつ当年も観測で不振を確認できる
    //   救援を、当日ブルペン可用リストから確率的に外す（連投蓄積を止め破綻救援のIP膨張＝投手WARの
    //   単調悪化を防ぐ）。三層構造: 真値は見ず前年＋当年の観測RA9のみで判定。
    //   ★1年目不変の保証: 判定には"前年の観測ライン"が必須で、1年目は前年が存在しない（priorPitch 空）
    //     ため全員 前歴なし＝ガードは一切作動しない（較正53指標・SV/HLD/登板数王が byte 不変）。
    //     ゆえに以下の閾値は1年目較正に無影響で、多年の健全性（6seed×60年で最悪救援WARを最小化しつつ
    //     救援登板分布を保つ）だけで較正した。
    //   ★間引き率の設計（実測知見）: 完全排除(prob=1)は逆効果＝空いたIPが最小登板の別の弱い救援へ集中し
    //     "被害の付け替え"で最悪WARがかえって悪化（-6級）する。0.6 前後の"確率間引き"が最善で、
    //     早めの検出(CurrBF小)とあわせて破綻救援のIP膨張を抑えつつ健全な救援へ負荷を薄く分散する。
    //     6seed×60年で 最悪救援WAR -5.27→-4.34 / WAR<-4 の season 17→1（登板数王・SV/HLD分布は健全維持）。
    relieverGuardPriorRA9: 5.5, // 前年の観測RA9がこれ以上＝救援として破綻の前歴（リーグ平均救援RA9≈4.2）
    relieverGuardPriorBF: 100, // 前年の最低対戦打者数（少なければ前歴と見なさない＝一時起用/新人を守る）
    relieverGuardCurrRA9: 6.0, // 当年の観測RA9がこれ以上（前歴＋当年不振の二段確認・当年持ち直しは対象外）
    relieverGuardCurrBF: 45, // 当年これだけ投げてなお不振なら間引き開始（早期検出でIP膨張を抑制。序盤小標本は不作動）
    relieverGuardExcludeProb: 0.6, // 該当救援を当日可用から外す確率（完全排除でなく間引き＝負荷を分散し登板分布を保つ）
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
    prevDayPitchLimit: 21, // 前日この球数以上→当日不可 ※S5較正（SV/HLD/登板数の負荷分散）
    starterRestDays: 5, // 先発は中5日以上
  },

  // 観測成績ベース起用（S3 usage.mjs）。三層構造: 真値は直接見ない（観測statline＋スカウトノイズ）。
  usage: {
    reviewInterval: 25, // 見直し間隔（試合）
    trustPA: 80, // 観測wOBAの信頼度加重の半飽和PA（少PAは回帰）※S5較正
    scoutSd: 5, // スカウト打撃評価ノイズのSD（rating単位・scoutSeed基準）※S5較正
    // D1-3（三層構造の徹底）: 守備の起用評価(defEval/rangeEval)も真値の無ノイズ参照をやめ、
    //   打撃scoutEvalと同様に scoutSeed由来の決定論ノイズ（球団が守備を読み違える成分）を付与する。
    //   1選手につき単一のノイズを rangeEval と def[pos] 双方へ一貫適用（読み違えは首尾一貫）。
    //   ⚠️WAR下限の門番（破局/典型）を壊さない小さめのSD。0で完全無効（旧＝真値参照）。
    scoutDefSd: 3, // スカウト守備評価ノイズのSD（rating単位・scoutSeed基準・§D1-3）
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

  // ロスター生成の規模（F2-1・§12.1/§15）: 支配下70人＋育成10-40人/球団（NPB準拠）。
  //   一軍はこの母集団から上澄み選抜（デプスチャート）＝二軍は自然に「一軍に及ばない選手＋若手」になる。
  //   能力の生成分布そのものは従来を維持（generatePitcher/generateFielder のノブは不変）。
  roster: {
    controlledPerTeam: 70, // 支配下人数/球団（NPB=70人）
    pitchersMin: 33, // 投手数の下限（球団差 33-36。残り＝野手 34-37）
    pitchersMax: 36, // 投手数の上限
    corePitchers: 13, // 年齢を従来一様帯(18-37)で引く「主力層」投手数（超過分は若手厚めの年齢帯）
    coreFielders: 20, // 同・野手数（従来 FIELDER_PLAN 相当＝各ポジの一軍層）
    youngAgeMin: 18, // 下位支配下（コア超過分）の年齢帯: min + floor((max-min+1)·u^skew)
    youngAgeMax: 27,
    youngAgeSkew: 2.0, // skew>1 で若年側へ歪む（18-24中心＝成長曲線途中の若手を厚く）
    devCountMin: 10, // 育成選手数の下限（球団の育成方針 devFocus で 10-40 に散る）
    devCountMax: 40, // 育成選手数の上限
    devAgeMin: 18, // 育成の年齢帯（18-24中心・若手最厚）
    devAgeMax: 24,
    devAgeSkew: 1.5,
    devPitcherShare: 0.55, // 育成に占める投手の割合（NPB育成は投手偏重の近似）
    offenseTopN: 12, // リーグ攻撃力均衡化で測る「一軍級の上位野手」数（全員合計だと育成/控えの人数差で歪む）
    // --- F2-2 出場登録29人の選抜（selectActiveRoster・編成時評価＝buildDepthChart と同輪） ---
    activePitchers: 14, // 登録29人中の投手数（ローテ6+救援8。NPBの13-15人帯の中庸。残り15人=野手）
    activeBackupCatchers: 1, // 守備8ポジ充足後に必ず確保する控え捕手数（正捕手+1＝捕手2人体制）
    farmKeepPerPos: 2, // 登録選抜が各主ポジションに二軍へ残す最低野手数（二軍のデプスチャート成立を保証）
  },

  // シーズン中の出場登録入替（F2-3 roster_moves.mjs・phaseF_spec F2-3）。
  //   三層構造: 判定は一軍/二軍の観測statline＋スカウト評価（決定論ノイズ）のみ（真値不参照）。
  //   鉄則7: 1年目は enableMoves が立たず一切不作動（simulateSeason と bit 同一を維持）。
  moves: {
    swapCooldownDays: 10, // 入替クールダウン（NPB10日ルールの簡略化）: 登録/抹消から再移動までの日数
    ilMinDays: 4, // IL補充を出す最低の残り離脱日数（数日の離脱では登録を動かさない）
    reviewInterval: 25, // 成績入替チェックの周期（チーム消化試合数。既存の25試合レビューと同周期）
    perfSwapMargin: 0.008, // 野手の成績入替に要する実効wOBA差（二軍評価−レベル差割引 > 一軍評価＋これ）
    farmGapWoba: 0.02, // 二軍観測wOBAのレベル差割引（二軍の投手レベルは低い＝観測は甘く出る）
    farmMinPA: 40, // 昇格候補野手に要する二軍観測の最低PA（標本不足では動かさない）
    pitchSwapRA9: 1.2, // 投手の成績入替に要するRA9差（一軍RA9 −（二軍RA9＋割引）> これ）
    farmGapRA9: 0.7, // 二軍観測RA9のレベル差割引
    pitchMinBF: 40, // 一軍不振投手の判定に要する最低対戦打者数
    farmPitchMinOuts: 45, // 昇格候補投手に要する二軍観測の最低アウト数（15回）
    // IL補充の球団AI評価（callupScore = evaluateProspect＋二軍観測の加点。観測＋スカウト）
    callupWobaW: 250, // 二軍観測wOBA偏差 → 球団AI評価点の換算（野手）
    callupRa9W: 6, // 二軍観測RA9偏差 → 球団AI評価点の換算（投手）
    callupRa9Ref: 4.5, // 二軍観測RA9の基準（これより良ければ加点）
    callupTrustPA: 80, // 二軍観測の信頼度半飽和PA（野手・少PAはスカウト評価優位）
    callupTrustOuts: 90, // 同（投手・アウト数）
    // --- §req_20260708: ローテ投手の成績入替（旧実装はローテ全除外＝不振先発が固定化する欠陥） ---
    rotationMinBF: 100, // ローテ投手の判定に要する最低対戦打者数（救援pitchMinBF=40より緩衝を厚く＝数試合の不調では動かさない）
    rotationSwapRA9: 1.8, // ローテ入替に要するRA9差（救援pitchSwapRA9=1.2より大きく＝先発は簡単には外さない）
    rotationStarterScoreW: 0.02, // 昇格候補選定でstarterScore(先発適性・真値)を軽く加点する重み
    // --- §req_20260708: 育成→支配下の季節中昇格（旧実装は年1回オフのみ＋同型引退枠待ちで塩漬け）。
    //     NPB実務（支配下登録期限=例年7/31）に合わせ、シーズンの一定割合を過ぎたら昇格を締め切る。
    farmPromoteDeadlineFrac: 0.72, // 昇格を受け付ける season日数の割合（開幕からこの割合まで）
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
  // ubr系はS5較正（BsR裾）。runUBR1t3b/runUBRTakerTagは§req_20260708新設シナリオの
  // run価値（文献のRE24差分実測例~0.2-0.3runsを参考にrunUBR=0.36よりやや低めで開始）。
  run: {
    // 正典 sabermetrics_glossary.md §6.2（一次: FanGraphs Library wSB）
    //   runSB = +0.2 は全シーズン固定。runCS = −(2×RunsPerOut + 0.075) の可変式で、
    //   leagueConstants が実データから導出する（lc.runCS）。ここの値はリーグ定数が無い場合の
    //   フォールバックにすぎない（テスト・単体呼び出し用）。
    runSB: 0.2, runCS: -0.4, ubrSlope: 0.007, runUBR: 0.36,
    runUBR1t3b: 0.28, // 単打での一塁→三塁進塁（成功時の限界価値）
    runUBRTag: 0.28, // タッグアップでの二塁→三塁進塁
  },
  // 併殺（2-6 wGDP, §6）: GBアウト×走者一塁×2アウト未満で併殺成立。打者の足で回避。
  gdp: { base: 0.42, speedW: 0.007, runGDP: -0.42 }, // speedWはS5較正（足↔併殺回避の結線を統計的に頑健へ）

  // 守備（§7 / 全面再設計 2026-07-09）: Distance-Time モデル（Statcast OAA と同型）。
  //   正典: thyroxin/research/fielding_metrics_reference.md §2 / §11
  //   打球ごとに各野手の「アウト化確率 p」を幾何から導く。p はリーグ中立（＝catch probability）。
  //   個人の Range は実効クロージング速度 Smax に乗り、抽選側にのみ効く。
  //   ※ 旧 hitGB/hitLD/hitFB/hitPU/evHitW/timeDifficulty*/posTypicalDepthM/rangeLogitSlope は
  //     この幾何から創発するため撤去した（打球種別の安打率はもうノブではない）。
  field: {
    // --- 守備隊形（本塁原点の極座標。r=距離[m], t=spray角[deg]・負が三塁側） ---
    //     実際のMLB/NPBの平均的な守備位置に近い値。内野手は塁間より深く守る。
    positions: {
      '3B': { r: 34, t: -33 },
      SS: { r: 44, t: -16 },
      '2B': { r: 44, t: 16 },
      '1B': { r: 33, t: 35 },
      LF: { r: 88, t: -28 },
      CF: { r: 98, t: 0 },
      RF: { r: 88, t: 28 },
    },
    // --- 到達モデル ---
    smaxBase: 6.78, // リーグ平均野手の実効クロージング速度 m/s（反応後の平均速度。全力疾走9m/sより低い）※較正済み: 得点環境中立に着地
    // Range 1pt → Smax の増分 m/s（50中心）。UZRの広がりと |xwOBA−wOBA| 乖離を同時に支配する:
    //   個人差を強めるほど「守備中立の xwOBA」と「実際に上手いレギュラーが守った wOBA」がずれる。
    //   0.022 で UZR上位≈+15（FanGraphs のゴールドグラブ級）かつ |xwOBA−wOBA| ≤ 0.003 に収まる。
    smaxPerRating: 0.022,
    width: 1.05, // 到達ロジスティックの幅 m/s。小さいほど p が両極化する ※較正対象
    reactionS: 0.3, // 初動までの反応時間 s
    reachM: 1.7, // グラブ＋ダイブの到達半径 m
    backPenalty: 0.35, // 後方への移動の減速（Statcastが2017年に direction を追加した理由）※較正対象
    // --- ゴロ ---
    gbSpeedFactor: 0.8, // ゴロの実効水平速度 = EV(m/s) × これ（バウンド減速込み）※較正対象
    gbMinDepth: 3, // 迎撃点がこれより手前なら処理対象外（本塁付近の当たり）
    gbMaxDepth: 50, // 迎撃点がこれより奥なら内野を抜けた
    gloveHeightM: 2.1, // 迎撃点での打球高度がこれを超えると内野手の頭上を通過
    // --- 送球アウト（Statcast infield OAA の「塁までの距離」「打者走者の足」） ---
    transferS: 0.7, // 捕球 → リリース
    throwSpeed: 32, // 送球速度 m/s
    runnerToFirstS: 4.35, // 打者走者の一塁到達 s（speed 50 = 平均）
    runnerToFirstPerRating: 0.008, // speed 1pt → 一塁到達が何秒縮むか（速い打者に内野安打が湧く）※較正対象
    throwWidth: 0.22, // 送球アウトのロジスティック幅 s

    wRange: { positioningIQ: 0.45, reaction: 0.3, speed: 0.25 }, // Range合成重み（§7.1）
    // --- run 換算（すべて MLB.com 公式 FRV glossary の固定定数・正典§2.4） ---
    runPerOutInfield: 0.75, // "1 out = .75 runs (infielders)"
    runPerOutOutfield: 0.9, // "1 out = .9 runs (outfielders)"
    runPerError: 0.5, // 失策1つ（ポジ平均との差）あたりのrun価値。UZRのErrR成分（§7.2）
    framePerInning: 0.0005, // 捕手フレーミング（per-inning近似の遺構。実際は一球ごとに runPerCall で積む）
    // --- ARM（外野送球）: 実イベントから創発させる（旧 armRunPerOpp = 真値の線形変換は撤去）。
    //   強肩は (a) 走者に自重させ（armAdvSuppress） (b) 走った走者を刺す（armKill*）。
    //   ARM run は armOpp/armAdv/armKill の生カウントからリーグ平均基準で算出（fielding.mjs）。
    ofReachM: 45, // 空中球がこの距離以上に落ちたら外野が処理する（＝外野手の返球が関与する）
    armAdvSuppress: 0.0045, // 肩1pt(50中心) → 走者の追加進塁確率をこれだけ下げる ※較正対象
    armKillBase: 0.1, // 走った走者を刺す基本確率（リーグ平均の肩） ※較正済み（NPB外野補殺リーダー年6〜9本）
    armKillSlope: 0.003, // 肩1pt → 刺殺確率の増分
    armKillMax: 0.25, // 刺殺確率の上限
    runPerDP: 0.4, // "Double Plays 1 = .4"（旧0.45を FRV 準拠へ）
    dpShare: 0.5, // 1件の併殺を 2B・SS で分担する比率（game.mjs が双方にフル計上するため・§B3b）
    // 捕手送球: "Catcher Throwing 1 SB prevented = .65 runs, the difference between a SB (+.2) and a CS (-.45)"
    //   → 定数を置かず run.runSB − run.runCS から導出する（正典§8.4）
    runPerBlock: 0.25, // "Catcher Blocking 1 = .25"
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
    evBase: 139.75, // 平均打球速度の中心 ※D1-2: 同利きEV罰則強化(-1.2→-2.5)でリーグ平均EVが下がった分を全体で再センタリング（139→139.55・同利き相対差は不変）。
    //   0.9.1-pitchband: 帯再配分＋chase現実化＋swingEyeW圧縮で沈んだ得点環境(AVG/OBP/OPS)を全体で再センタリング（139.55→139.75）
    evPerEV: 0.355, // 打者EV適性1pt → km/h ※S5較正（裾圧縮＝野手WAR王7-9.5）
    evPerPower: 0.23, // 生体power1pt → km/h ※S5較正。F2-5: 0.2→0.23（29人選抜でHR王/HR平均比が
    //   0.32→0.31へ薄まりHR王が帯割れ→powerスプレッド拡大でスラッガーの裾を回復。野手WAR王≤9.5は維持）
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
    // --- HR分布形状（D1-1・§D1）: フェンス越え判定を「HR専用飛距離モデル」として明示化 ---
    // 幾何の distanceM（安打/長打の落下点用・carry×lift幅24・peak26）と同一入力から、フェンス
    // 越え専用の hrDist を再構成する（battedBallResult）。HR飛距離は打者power/EV/最適LAへ依存:
    //   hrDist = carry・(v²/g)・hrLift(LA;peak,conc)・evBoost(EV;ref,width,gain)
    // hrLift=適角ガウス、evBoost=飽和ロジスティック（よく捉えた強打へ上限gainまでのボーナス。
    //   線形の青天井で怪物打者が暴走するのを避ける）。hrScale は総量ノブ（門番: HR/team・HR王）。
    //
    // ⚠️D1較正の重要知見: HR王(裾)の seed窓分散は「その seed にスラッガーが生成されたか」に律速
    //   される生成側の性質。打球モデル側の集中(concを狭める/evBoostを強める)は HR/team据え置き下で
    //   平均への集中が floor seed(怪物不在)のリーダーHRを uniform な hrScale 引下げで削り、
    //   out-of-sample の窓2(seeds13-24)を 40.8→38 へ悪化させる（＝裾を伸ばすと床が抜けるトレード
    //   オフ／閾値HRの hrScale 過敏）。~15通りの探索で「HR/team∈[110,130] 下で3窓すべて帯内かつ床>40」
    //   を最も頑健に満たすのは中立設定(=baseline)。よって集中は無効化(gain=0)し、モデルは明示化のみ
    //   残す（D2パークファクターが hrDist×球場フェンスで『同じ打球がHRにも凡フライにも』を出す土台）。
    hrLaPeak: 26, // HR最適打球角度（度）。幾何のliftと一致（中立＝baseline HR挙動を維持）
    hrLaConcentration: 24, // HR飛距離ガウスの幅（度）。幾何のliftと一致（狭めると床が抜けるため中立）
    hrEvRef: 152, // 飽和evBoostの中心速度(km/h)。スラッガー帯（gain=0で現在無効＝realism調整/将来フック）
    hrEvWidth: 4, // 飽和evBoostの立ち上がり幅(km/h)
    hrEvGain: 0, // evBoostの上限（0=無効＝中立/baseline維持）。>0で「よく捉えた球」のHR飛距離を最大+この割合
    // --- フェンス高→HR実効距離（D2・§11.2）: 高い壁ほどHRに必要な飛距離が増える。 ---
    //   実効フェンス = fenceDistanceAt + hrFenceHeightW×(fenceHeightM − hrFenceHeightBase)。
    //   中立球場(4m)は差0＝baseline不変。高い壁の球場は同じ打球が凡フライ側へ（原則1: 文脈で化ける）。
    hrFenceHeightBase: 4, // 実効距離ペナルティの基準フェンス高(m)。中立と同じ＝差0
    hrFenceHeightW: 1.5, // フェンス高1m超過あたりの実効フェンス距離加算(m)
    // ⚠️ 旧「結果グリッド」(hitGB/hitLD/hitFB/hitPU/evHitW/fbHitBonusM) は撤去した。
    //   打球種別ごとの安打率は、守備隊形と打球の幾何から創発する（tuning.field の Distance-Time モデル）。
    //   正典: thyroxin/research/fielding_metrics_reference.md §11.2 / §11.4
    //   同様に timeDifficultyW/Cap・posTypicalDepthM・outfieldLDTypicalDepthM も撤去（対症療法だった）。
    // 単打/二塁打の境界。新モデルでは外野手の定位置(LF/RF=88m)より手前に置く:
    //   そこへ落ちた打球は外野手が「下がりながら/走りながら」処理するため打者を単打に留められない。
    //   ※旧86.0はDistance-Timeモデル導入前の自由ノブ。得点環境中立(SLG/OPS維持)のため76.0へ再較正。
    gapDistM: 76.0,
    tripleDistM: 94, // 二塁打/三塁打候補の深さ。これ以上の深いギャップ/ライン際球が三塁打になりうる（監査B1）
    tripleBase: 0.32, // 深いギャップ球の三塁打基本率（打者speedで上下）※較正済み
    tripleSpeedW: 0.007, // 打者speed(50中心)→三塁打率への寄与
    // 失策（ROE・§7 Hands）。インプレーのアウトが確率 errBase−(Hands−50)×errHandsW で失策になる。
    // 失策以降その回の得点は非自責（ERA<失点 の差＝未自責点を生む・較正の整合に必須）。
    errBase: 0.023,
    errHandsW: 0.0006,
    // 走者進塁の確率（UBR/EqBRR文献のシナリオ別RE24分解に準拠・§req_20260708強化）
    singleScore2: 0.51, // 単打で二塁走者が生還する確率（残りは三塁止まり）※S5較正（得点環境・rpw）
    //   F2-5: 0.6→0.54（率系(AVG/OBP/SLG)に触れず総得点だけ下げるERA再収束ノブ）。
    //   §req_20260708: 新設の1塁→3塁/タッグアップ分だけ得点機会が増えたぶんをさらに0.54→0.51で相殺
    doubleScore1: 0.44, // 二塁打で一塁走者が生還する確率（残りは三塁止まり）※較正済み（監査B後の得点環境再収束。F2-5: 0.50→0.46・同上。§req_20260708: 0.46→0.44でERA残差を相殺）
    // ※12seed較正でrpw/ERA/runs帯を大幅超過(4.77 vs [3.9,4.3])と判明。文献値の下限側へ寄せて引き下げ。
    singleScore1to3: 0.10, // 単打で一塁走者が三塁まで進む確率（残りは二塁止まり・文献の実測値~25-40%帯・NEW）
    tagBase: 0.14, // 外野フライ(2アウト未満)で二塁走者が三塁までタッグアップする確率・NEW
  },

  // ==========================================================================
  // 球場生成分布（D2 パークファクター・§11.2「文脈で化ける」）: 各球団本拠地に完全架空の
  //   球場ジオメトリ（両翼/中堅距離・左右非対称・フェンス高）を持たせる分布ノブ。
  //   src/generate.mjs の generatePark が消費し、generateLeague が球団ごとに1つ生成する。
  //   分布は対称（各偏差の平均0）＋リーグ内でゼロサム中心化＝リーグ平均ジオメトリ=中立球場。
  //   よってリーグ全体の得点環境は据え置き（PF平均≈100）。HR閾値の凸性ぶんだけ微増するのを
  //   hrScale の再較正で吸収する（§D2）。PF上位/下位は ±5-15% に散る。
  //   決定論: park専用のRNG系列（hashSeed(seed,'park',ti)）で引き、選手生成RNGは一切触らない
  //   （＝選手は D2 前と byte 同一。変わるのは球場を使う season シムのみ）。
  // ==========================================================================
  park: {
    baseLine: 100, // 両翼の中立距離(m)
    baseCenter: 122, // 中堅の中立距離(m)
    baseHeight: 4, // フェンス高の中立(m)
    // ⚠️D2較正: HR越えは閾値（凸）ゆえ球場個性は「リーグ平均HR/HR王」を動かす。SDを上げると
    //   凸性で HR/team が膨らみ HR王(裾)が薄まる（生成律速・D1知見）。~k=0.55 で HR/team≈121・
    //   HR王≈42・PFspread≈0.30（[0.10,0.34]）・得点環境据え置きを同時達成（8-12seed探索）。
    sizeSd: 1.4, // 球場全体の広狭（両翼＋中堅を一様シフト）偏差SD(m)
    centerSd: 2.5, // 中堅の独立偏差SD(m)（広い中堅＝中距離弾が凡フライ／狭い中堅＝伸びる）
    asymSd: 1.9, // 左右非対称の偏差SD(m)（狭い翼×引っ張り＝移籍で化ける/死ぬ）
    heightSd: 0.7, // フェンス高の偏差SD(m)
    lineClampLo: 88, // 両翼距離の下限(m)（非現実的な極端値の抑制）
    lineClampHi: 112, // 両翼距離の上限(m)
    centerClampLo: 112, // 中堅距離の下限(m)
    centerClampHi: 134, // 中堅距離の上限(m)
    heightClampLo: 1.5, // フェンス高の下限(m)
    heightClampHi: 8, // フェンス高の上限(m)
    batShare: 0.5, // PF→打者/投手補正の在宅露出率（本拠地は約半分の試合）。pfBat=1+(pfRuns−1)×これ
  },

  // ==========================================================================
  // 時代トレンドと王朝均衡（D3・§11.3「集団・時代系」・多年運用）: オフシーズン遷移で「時代」を
  //   ゆっくり動かすノブ。src/game/era.mjs の computeEra/eraSeasonConfig/teamBalanceBoost が消費。
  //   ⚠️**1年目（yearIndex=0）は完全に identity**（computeEra が全成分ゼロ・eraSeasonConfig が
  //   baseCfg を同一参照で返す）＝既存50較正は完全不変（byte一致）。ドリフトは2年目以降のみ。
  //   決定論: era は (masterSeed, yearIndex) の純関数＝live/replay で bit 一致。
  // ==========================================================================
  era: {
    enabled: true, // false でD3を無効化（全年 identity＝多年でもドリフト無し）
    // --- 得点環境の緩やかな揺れ（投高打低↔打高投低）: EV中心(bb.evBase)を正弦で上下 ---
    //   位相0の sin(2π·yi/period) ゆえ yi=0 で必ず0（year0 identity の担保）。振幅±0.8km/h で
    //   得点環境が緩やかに上下する（打高/投高の時代）。周期は世界ごとに散らす。
    offenseAmpKmh: 0.8, // EV中心の揺れ振幅(km/h)
    wavePeriod: 9, // 揺れの基本周期(年)
    wavePeriodSd: 2.0, // 周期の世界差SD(年)（位相0は保持）
    // --- 平均球速の経年上昇（新人世代が世代ごとに速くなる・約+0.5km/h/年）---
    veloPerYear: 0.5, // 新人生成の平均球速が1年（yearIndex）あたり+これ(km/h)
    veloBumpMax: 10, // 経年上昇の上限(km/h)（暴走防止）
    // --- 世代の波（ドラフト当たり年/外れ年→黄金世代）: 新人品質(rating)を年ごとに揺らす ---
    cohortSd: 1.2, // 通常年の新人品質の揺れSD(rating)
    goldenProb: 0.12, // 黄金世代（当たり年）の確率
    goldenBoost: 5.0, // 黄金世代の新人品質ボーナス(rating)
    leanProb: 0.12, // 外れ年の確率
    leanPenalty: 4.0, // 外れ年の新人品質ペナルティ(rating)
    // --- 王朝と均衡（戦力の平均回帰＝ドラフト再分配）: 弱い球団の新人を厚く ---
    balanceReversion: 40, // 勝率.500未満ぶん(0-1)×これ＝新人 rating boost（弱い球団ほど良い人材）
    balanceMaxDev: 0.15, // 反映する勝率不足の上限（.35以下は同扱い＝暴走防止）
  },

  // ==========================================================================
  // 加齢・成長カーブ（C2a・§10.1-10.3 / §12.4）: オフシーズンに trueAbility を動かすノブ。
  // src/game/aging.mjs の applyAging が消費する（1年目レギュラーシーズンには一切効かない
  // ＝加齢は2年目以降のみ。既存50較正指標は完全不変）。
  //
  // モデル（能力ごとに「成長→維持→衰え」の3相）:
  //   growEnd = peakAge + peakShift  … ここまで毎年 +grow（若手は成長係数 gm で幅を持つ）
  //   onset   = peakAge + declineOffset … ここから毎年 −decline×declineRate×(1+accel×経過年)
  //   peakShift/declineOffset を能力タイプで振り、§10.1 の「早落ち/遅くまで残る/むしろ伸びる/
  //   加齢に強い」を構造から出す。declineRate は個体差（§10.2・generate で球速/走力相関で既引き）。
  // ==========================================================================
  aging: {
    youngAge: 25, // これ未満を「若手」とする（成長を高分散・bust厚めで出す＝§10.3）
    driftSdYoung: 1.6, // 若手の年次ノイズSD（能力1軸あたり・rating）
    driftSdOld: 0.9, // ベテランの年次ノイズSD
    growthVarYoung: 0.35, // 若手の成長係数 gm の分散（点でなく幅で・TINSTAAPP）
    bustProb: 0.15, // 若手が「伸び悩む」確率（下方の裾を厚く＝bust多め）
    bustMag: 0.9, // bust 時に成長係数 gm から引く量（負に振れれば真値が退行）
    growthMultMin: -0.6, // gm の下限（bust で退行しうる）
    growthMultMax: 2.4, // gm の上限（覚醒的な急成長の上振れ）
    declineAccel: 0.12, // 衰えの加速（onset 超過1年ごとに衰え幅を増やす＝終盤の急落）

    // 球速（km/h 実数・レーティングと別枠）: 加齢で落ちる。高球速×高declineRate ほど早く落ちる。
    velo: {
      grow: 0.3, // 若手のうちは僅かに伸びる
      peakShift: -1, // 球速のピークは早い
      declineOffset: 2, // ピーク+2 から本格的に落ちる
      decline: 0.6, // 1年あたりの低下（×declineRate×加速）
      driftSdYoung: 0.6,
      driftSdOld: 0.4,
      min: 130,
      max: 165,
    },

    // 能力タイプ別プロファイル（§10.1）。grow=成長幅 / peakShift=成長終端の後ろズレ /
    //   declineOffset=衰え開始の後ろズレ / decline=衰え幅。未登録キーは default。
    //
    // ★Bug1 再較正（§11.3・多年運用の得点環境が一方向インフレ）:
    //   旧プロファイルは「生涯ネットドリフトが正」で、生存バイアス（弱個体淘汰・§10.6）と
    //   ドラフト選抜（プールの上澄みを獲る）と相まって、能動ロスターの能力平均が rookie 生成中心から
    //   +5〜6 も上振れし、20年でリーグ SLG/HR/ERA が単調インフレしていた（監査: SLG+16%/HR+71%/
    //   ERA+32%）。§11.3 の意図は投高打低↔打高投低の“揺れ”であって単調上昇ではない。
    //   → grow を大きく下げ、衰え開始（declineOffset）を前倒し・decline を強めて、
    //     「rookie 生成中心 ≒ 加齢後の生存ロスター定常平均」（net drift≈0）へ再較正した。
    //     これで 20年×多seed でも得点環境が NPB 目標帯付近に留まり、D3 era 波（正弦）がその上に
    //     乗る“有界な揺れ”になる。1年目（yearIndex0）は applyAging 非適用ゆえ完全不変（較正53指標不変）。
    //   個体の物語（§10.3 成長分散 gm・§10.4 ブレイク・§12.4 晩成/鉄人テール）は残す：山型・選球眼微増・
    //   鉄人の制球持続・晩成 LA は成長係数と declineRate の個体差＋テールから出る（集団平均だけを平す）。
    profiles: {
      // 早落ち（走力・守備初動・盗塁技術は足に連動）
      speed: { grow: 0.5, peakShift: -3, declineOffset: -1, decline: 1.2 },
      reaction: { grow: 0.5, peakShift: -2, declineOffset: 0, decline: 1.0 },
      steal: { grow: 0.5, peakShift: -2, declineOffset: 0, decline: 0.9 },
      // パワー/EV（得点環境の主動因）: 成長は peak まで・以後は速やかに衰える。旧値(grow0.9/dOff5/dec0.5)は
      //   全個体が peak+5 まで維持し母集団が peak に張り付いて上振れ→ここを net≈0 に平す（山型は維持）。
      power: { grow: 0.2, peakShift: 0, declineOffset: 0, decline: 1.55 },
      ev: { grow: 0.2, peakShift: 0, declineOffset: 0, decline: 1.55 },
      // 選球眼（むしろ伸びる＝加齢で微増・§10.1）。微増は残すが grow を抑え上振れ幅を圧縮（打撃の
      //   得点直結度は低い＝主に四球/OBP なので SLG/HR への寄与は小さく、微増を残しても環境は平坦）。
      eye: { grow: 0.45, peakShift: 1, declineOffset: 3, decline: 0.25 },
      // コンタクト・三振耐性（peak まで伸び以後は明確に悪化＝net≈0）
      contact: { grow: 0.2, peakShift: 0, declineOffset: 0, decline: 1.25 },
      vsFastball: { grow: 0.35, peakShift: 0, declineOffset: 1, decline: 1.0 },
      vsBreaking: { grow: 0.35, peakShift: 1, declineOffset: 1, decline: 1.0 },
      // LA最適化（晩成の主軸だが集団平均は平す。晩成 LA は高 gm×高 peakAge の少数テールから稀に出る）。
      la: { grow: 0.32, peakShift: 1, declineOffset: 1, decline: 1.1 },
      pull: { grow: 0.16, peakShift: 1, declineOffset: 1, decline: 0.4 },
      // 技術・IQ（加齢に強い＝decline は小さく残すが grow を抑え、衰え開始も §10.1 窓へ引き戻して
      //   母集団の底上げを断つ）。鉄人（高制球・低 declineRate）は個体テールから引き続き出る。
      control: { grow: 0.3, peakShift: 2, declineOffset: 5, decline: 0.55 }, // 石川雅規型（鉄人）はテール
      positioningIQ: { grow: 0.38, peakShift: 1, declineOffset: 3, decline: 0.35 },
      baserunIQ: { grow: 0.38, peakShift: 1, declineOffset: 3, decline: 0.35 },
      framing: { grow: 0.33, peakShift: 2, declineOffset: 4, decline: 0.4 },
      blocking: { grow: 0.3, peakShift: 2, declineOffset: 4, decline: 0.5 },
      gbRate: { grow: 0.1, peakShift: 2, declineOffset: 3, decline: 0.4 },
      hold: { grow: 0.2, peakShift: 2, declineOffset: 3, decline: 0.5 },
      positionProf: { grow: 0.36, peakShift: 2, declineOffset: 4, decline: 0.5 }, // 守備習熟は経験で伸び緩く落ちる（山本泰寛型）
      pitchStuff: { grow: 0.25, peakShift: 2, declineOffset: 3, decline: 0.6 }, // 球種の質（出し入れは技巧で残る）
      // 中間（肩・手・スタミナ）
      arm: { grow: 0.2, peakShift: 0, declineOffset: 2, decline: 0.8 },
      hands: { grow: 0.26, peakShift: 2, declineOffset: 3, decline: 0.6 },
      stamina: { grow: 0.16, peakShift: 1, declineOffset: 2, decline: 0.7 },
      default: { grow: 0.4, peakShift: 1, declineOffset: 4, decline: 0.6 },
    },
  },

  // ==========================================================================
  // 故障ハザード（C2b・§10.5）: オフシーズンに「その年に故障したか」を確率事象で決める
  //   （予測でなくハザード）。年齢・ポジション（捕手は壊れる）・投手の投球負荷（球速）・
  //   故障歴（最大リスク／再発）で確率を上下。src/game/injury.mjs の applyInjuries が消費。
  //   後遺（復帰後の一時的能力減）と非対称性（投手の大怪我＝将来リスク＋球速低下の始まり）を持つ。
  //   1年目レギュラーシーズンには一切効かない（故障判定は2年目以降のオフシーズンのみ）。
  // ==========================================================================
  injury: {
    base: 0.030, // 基本ハザード（1オフシーズンあたり）
    ageRamp: 30, // この年齢を超えると加齢で故障率が上がり始める
    agePerYear: 0.006, // ageRamp 超過1歳ごとのハザード加算
    pitcher: 0.030, // 投手の上乗せ（肩肘の消耗）
    veloRef: 148, // 球速がこの値を超える投手ほど投球負荷が高い
    veloPerKmh: 0.004, // veloRef 超過 1km/h ごとのハザード加算
    catcher: 0.050, // 捕手の上乗せ（膝腰・ファウルチップ＝壊れる）
    recurMinor: 0.020, // 軽症の故障歴1件ごとの再発リスク加算
    recurMajor: 0.050, // 重症の故障歴1件ごとの再発リスク加算（最大リスク）
    pitcherMajorLegacy: 0.050, // 投手が過去に大怪我＝以後の恒常的な将来リスク（非対称）
    cap: 0.55, // ハザードの上限
    majorGivenInjury: 0.22, // 故障したうち重症になる基本割合
    majorHistBonus: 0.10, // 故障歴があると重症化しやすい
    majorPitcherLegacy: 0.15, // 投手が過去に大怪我していると更に重症化しやすい
    minorGamesLo: 12, // 軽症の離脱試合数（下限）
    minorGamesHi: 45,
    majorGamesLo: 60, // 重症の離脱試合数（下限）
    majorGamesHi: 150,
    aftMinor: 1.5, // 軽症の後遺（身体系レーティングの一時減）
    aftMajor: 4.0, // 重症の後遺
    aftVeloMajor: 2.5, // 投手の重症時の球速低下(km/h)
  },

  // ==========================================================================
  // ブレイクイベント（C2b・§10.4/§11.1）: 低確率で能力が階段状にジャンプする離散イベント。
  //   上方=球種習得（列が生える千賀型）/覚醒（真値ジャンプ）/EVジャンプ（板山・用具型）、
  //   下方=制球崩壊（イップス）/燃え尽き/故障明けの別人化。
  //   §11.1: 上方だけだとリーグがインフレするので下方>上方を既定とする（バランス上ほぼ必須）。
  //   src/game/breakout.mjs の applyBreakouts が消費。1年目には効かない（2年目以降のオフのみ）。
  // ==========================================================================
  breakout: {
    upBase: 0.010, // 上方ブレイクの基本確率/オフシーズン
    downBase: 0.014, // 下方ブレイクの基本確率（上方より厚く＝インフレ抑止）
    youngAge: 24, // これ以下は覚醒（上方）が出やすい
    youngUpMult: 1.6, // 若手の上方確率倍率
    burnoutAge: 32, // これを超えると燃え尽き（下方）が出やすくなる
    burnoutPerYear: 0.002, // burnoutAge 超過1歳ごとの下方確率加算
    postInjuryDown: 0.15, // 直近オフに大怪我があると下方（別人化）が跳ね上がる
    newPitchShare: 0.5, // 投手の上方のうち「球種習得（列が生える）」になる割合。残りは覚醒
    yipsShare: 0.5, // 投手の下方のうち「制球崩壊（イップス）」になる割合。残りは燃え尽き
    jump: 8, // 覚醒/燃え尽きの階段幅（レーティング）
    veloJump: 2.5, // 覚醒時の球速ジャンプ(km/h)
    controlCollapse: 14, // イップス時の制球低下幅
    postInjuryMag: 6, // 故障明け別人化の追加低下幅
  },

  // ==========================================================================
  // 引退・世代交代（C2b・§10.6）: 能力・年齢・故障から引退を確率判定し、同チーム・同枠へ
  //   新人（ドラフト相当）を1:1で補充してリーグ人口/ロスター構成を恒常に保つ。
  //   生存バイアス（弱い個体が消え、加齢カーブが平らに見える＝鉄人が自動レア化）はそのまま正しい。
  //   src/game/roster.mjs の runRetirementAndDraft が消費。能力=引退判定の「出場機会」の代理
  //   （弱い＝出番が減る＝切られる）。真の出場機会依存の戦力外は C3（§12.2）で導入。
  // ==========================================================================
  retire: {
    minAge: 32, // これ未満は引退しない（若手・全盛期は残す）
    hardAge: 42, // これ以上は必ず引退（超高齢の打ち切り）
    rampAge: 32, // この年齢超過で引退確率が加齢加算され始める
    agePerYear: 0.060, // rampAge 超過1歳ごとの引退確率加算（late-30s の淘汰を効かせる）
    abilityRef: 47, // 「並」の総合力（この未満は引退圧が増す＝出場機会の代理）
    abilityPerPt: 0.022, // abilityRef 未満 1pt ごとの引退確率加算
    injuryPerHist: 0.030, // 故障歴1件ごとの引退確率加算
    eliteRetain: 0.018, // abilityRef 超過 1pt ごとの引退確率減（鉄人ほど残る＝生存バイアス→40代レア化）
    base: 0.030, // 基本引退確率（判定対象年齢での下駄）
    cap: 0.92, // 引退確率の上限
  },

  // ==========================================================================
  // 編成市場（C3a・§13/§15/§12.1）: 球団AI評価の球団差＋ドラフト＋育成/支配下二層。
  //   1年目レギュラーシーズンには一切効かない（市場はオフシーズン遷移＝2年目以降のみ）。
  //   src/game/market.mjs が消費。三層構造の原則: 球団AIは trueAbility を直接見ず、
  //   「観測ツール＋スカウトノイズ」を球団固有の重みで評価する（＝わざと不完全に間違う）。
  //   歪んだ球団評価と真価値の差分が「宝の泉」＝市場の非効率（守備/位置の過小評価を仕込む）。
  // ==========================================================================
  market: {
    // 世代生成（§15 ドラフト）: 新人の年齢層。高卒18/大卒22/社会人25相当の混合分布。
    cohort: {
      hsAge: 18, // 高卒相当
      colAge: 22, // 大卒相当
      corpAge: 25, // 社会人相当
      hsShare: 0.5, // 高卒の割合
      colShare: 0.35, // 大卒の割合（残り＝社会人）
    },
    surplusPerType: 3, // ドラフトプールの余剰（各(role,pos)型で 空き数＋これ）。選択肢＝評価差の発現＝宝の源

    // 球団AI評価関数の球団差（§13/§15）: 各球団が生成時に固定で引く「評価の癖」。
    //   wDef<1 の球団が多数＝守備/位置価値の系統的な過小評価（市場の非効率）。
    //   稀に wDef>1 の「守備を正しく重める球団」が混じり、他球団の捨てた宝を拾う（守備版マネーボール）。
    profile: {
      wBatMean: 1.0, wBatSd: 0.12, wBatMin: 0.5, wBatMax: 1.6, // 打撃/投球コアの重み（球団差小）
      wEyeMean: 1.0, wEyeSd: 0.45, wEyeMin: 0.2, wEyeMax: 2.2, // 出塁(選球眼)重視度（球団差大）
      wDefMean: 0.62, wDefSd: 0.42, wDefMin: 0.05, wDefMax: 1.8, // 守備/位置価値の重み（多くが<1＝過小評価）
      ageBiasMean: 0.5, ageBiasSd: 0.35, ageBiasMin: 0, ageBiasMax: 1.6, // 年齢バイアス（若手志向のペナルティ/歳）
      noiseSdMean: 6, noiseSdSd: 2, noiseSdMin: 2, // スカウト観測ノイズSD（rating単位・球団ごとの評価の荒さ）
    },
    // 評価成分のスケール（守備/出塁/位置価値の rating 換算）。
    eval: {
      eyeScale: 1.0, // 出塁(eye)成分のスケール
      posScale: 1.4, // 位置価値(posAdj)→rating換算スケール（守備マインド球団だけが重める）
      armW: 0.5, // 守備成分への肩(arm)寄与
      laW: 0.5, // 打撃成分へのLA寄与
    },

    // 育成/支配下 二層（§12.1）: 育成枠＝観測ノイズ大＆下振れで安く獲れる箱。
    //   昇格判定＝育成の観測成績が閾値超で支配下登録（＝這い上がり）。「稀に」起きるよう閾値を高く。
    farm: {
      perTeamSignsPerYear: 2, // 毎オフに各球団が獲る育成選手数（ドラフト漏れ＝過小評価された surplus から）
      perTeamMax: 45, // 育成枠の上限（超過は観測下位を解雇）。F2-1: 初期生成の育成10-40人を収容できる幅へ拡大
      maxAge: 26, // これを超えた育成選手は解雇（大成せず箱を空ける）
      promoteThreshold: 57, // 育成の「観測成績」がこれ超で支配下登録（稀）
      promoteObsNoiseSd: 6, // 昇格判定の観測ノイズSD（球場が薄い＝観測が荒い）
      promoteObsBias: -2, // 観測は下振れ方向にバイアス（育成は観測が歪む・§12.2）
      // F2-3: 昇格判定を二軍実成績ベースへ強化（§12.1）。当年の二軍statlineが「観測」へ加点される
      //   （二軍で打った/抑えた育成ほど昇格しやすい。標本が薄いと信頼度加重で効きが弱まる）。
      promotePerfTrustPA: 100, // 二軍打撃観測の信頼度半飽和PA
      promotePerfTrustOuts: 120, // 二軍投球観測の信頼度半飽和アウト数（40回）
      promoteWobaW: 60, // 二軍観測wOBA偏差 → 昇格観測点の換算（野手）
      promoteRa9W: 1.5, // 二軍観測RA9偏差 → 昇格観測点の換算（投手）
      promoteRa9Ref: 4.5, // 二軍観測RA9の基準（これより良ければ加点）
    },

    // ------------------------------------------------------------------------
    // C3b 選手市場: FA・トレード・戦力外/拾い上げ（§15 / §12.2）。
    //   src/game/transactions.mjs が消費。すべてオフシーズン遷移（2年目以降）でのみ発火し、
    //   1年目レギュラーシーズン（既存50較正）には一切効かない。移動はすべて同(role,primaryPos)の
    //   1:1 スワップ／循環＝球団あたりの役割・守備位置構成を厳密に不変に保つ（人口/構成恒常）。
    //   三層構造: 入札・受諾・拾い上げの査定は evaluateProspect（観測ツール＋スカウトノイズ×球団の癖）。
    //   放出（戦力外）判定だけは "実際の観測成績"（当該シーズンの生 statline）で下す＝出場機会に
    //   依存して歪む（少PA→ショボく見える＝上林型、不振→板山型）。査定を違える他球団が拾って生き返る。
    // ------------------------------------------------------------------------
    fa: {
      minAge: 30, // 国内FA権発生の下限年齢（年数条件の簡略代理・§15）
      maxAge: 36, // これ超は市場価値が薄く宣言しない（引退圏）
      declareRate: 0.06, // 資格者が宣言する確率（決定論rng・毎オフ少数）
      bidMargin: 8, // 移籍成立に必要な「最高入札−現球団評価」の下駄（評価差が要る＝分かれる）
      protectCount: 28, // 人的補償のプロテクト人数（非プロテクト＝残り5から補償を出す）
      longContractAge: 34, // これ以降の長期契約はリスク（契約年数フレーバー・§15）
      maxYears: 4, // 契約年数の上限（フレーバー表示用）
    },
    trade: {
      margin: 6, // 双方winに必要な各球団の純利得の下駄（churn抑制）
      maxPerYear: 6, // AI-AI 成立トレードの年間上限
      protectCount: 28, // 放出プールのプロテクト（非プロテクト同型のみ交換可）
    },
    release: {
      replacementWoba: 0.29, // 代替水準（観測貢献量 =（観測wOBA−これ）×PA）＝拾い上げ後の "観測改善" の物差し
      replacementFip: 4.6, // 投手の代替FIP（観測貢献量 =（これ−観測FIP）×IP/9）
      // 戦力外スコア = 観測貢献量 − 出場機会ペナルティ（少PA/少IP＝未確立でショボく見える＝上林型／
      //   高PAの不振＝板山型 も負に沈む）。放出はこのスコアが threshold 未満の非若手から worst 順に。
      fullPA: 300, // これ未満のPAは「出場機会が薄い」＝ペナルティ対象（規定打席の目安）
      ptPenaltyBat: 0.03, // 不足PA 1 あたりの戦力外スコア減（少出場ほど切られやすい＝渋滞の犠牲）
      fullIP: 35, // これ未満のIPはペナルティ対象（先発/中継ぎ両にかかる緩い目安）
      ptPenaltyPit: 0.18, // 不足IP 1 あたりの戦力外スコア減
      threshold: -3.0, // 戦力外スコアがこれ未満で戦力外候補
      minAge: 26, // これ未満は戦力外にしない（若手は観測が薄くても切らず育てる）
      maxCutsPerTeam: 2, // 各球団が毎オフ出す戦力外候補の上限（worst score から）
    },
  },

  // ==========================================================================
  // 演出・記録（C4・§16/§17）: 表彰・ニュース・記録・二つ名の判定定数。
  //   src/game/awards.mjs / src/game/news.mjs が消費。すべて "観測成績/WAR" ベースで
  //   選定・命名する（trueAbility を直接見ない＝三層構造）。集計値のみを参照し、
  //   1年目レギュラーシーズン（既存50較正）には一切干渉しない（表示・集計のみ）。
  // ==========================================================================
  awards: {
    // 二つ名（§16 Lv4回避=画像なし）: 通算 "観測" 集計のパターンで自動付与（priority順に判定）。
    //   trueAbility 非参照＝出場して積み上げた観測（H/HR/SB/BB%・IP/BB9/K9/S）だけで決める。
    nickname: {
      ipGate: 400, // 投手二つ名を付ける最低通算IP（未満は「未知数」）
      paGate: 1500, // 野手二つ名を付ける最低通算PA
      precisionBbPer9: 2.2, // 精密機械（制球特化＝通算BB/9がこれ以下）
      strikeoutKPer9: 9.0, // ドクターK（奪三振＝通算K/9がこれ以上）
      closerSv: 150, // 守護神（通算セーブ）
      workhorseIp: 1800, // 鉄腕（通算IP）
      sluggerHr: 200, // 大砲（通算本塁打）
      bigSluggerHr: 350, // 巨砲（通算本塁打・大砲より上位）
      speedSb: 200, // 韋駄天（通算盗塁）
      hitMachineH: 1500, // 安打製造機（通算安打）
      hitMachineAvg: 0.3, // 安打製造機の通算打率ゲート
      onbaseBbPct: 0.135, // 出塁の職人（通算BB%）
      isoSlugger: 0.2, // スラッガー（通算ISO）＋中量HR
      isoSluggerHr: 120,
    },
    // 通算マイルストーン（架空リーグ記録文脈・通算 careerStats から crossing 検出）。
    milestones: {
      hits: [1000, 1500, 2000],
      homeRuns: [200, 300, 400],
      wins: [100, 150, 200],
      saves: [100, 150, 250],
      strikeouts: [1000, 1500, 2000],
    },
    topN: 10, // リーグ記録トップN（シーズン/通算）
    gloveMinInnings: 400, // 守備の栄誉賞の最低守備イニング（過小サンプル除外）
    rotyMinPa: 100, // 新人王の最低打席（scrub 除外）
    rotyMinIp: 20, // 新人王の最低投球回
  },
};

/**
 * ゲーム層（フェーズC）の定数。日次カレンダー境界・セーブスキーマ版・開幕年。
 *   day = 日程の「節」index（1日1試合）。週/月境界は node --test で決定論的に刻むための単純割り。
 *   NPB 1シーズン ≈ 143試合 ≈ 150節前後 ≈ 6か月 なので daysPerMonth:26 で概ね月次に対応する。
 */
export const GAME_DEFAULT = {
  schemaVersion: 2, // セーブJSONのスキーマ版（load時の互換判定。C2bでオフシーズン意味論拡張→v2）
  firstSeason: 2026, // キャリア1年目の年
  daysPerWeek: 7, // advanceTo('weekEnd') の週境界
  daysPerMonth: 26, // advanceTo('monthEnd') の月境界（143試合≈6か月）
  rookieAgeMin: 18, // 新人（ドラフト補充）の最小年齢（高卒相当）
  rookieAgeMax: 22, // 新人の最大年齢（大卒/社会人相当）
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
    game: clone(GAME_DEFAULT),
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

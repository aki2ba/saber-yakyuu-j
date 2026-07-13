// ============================================================================
// リアリズム検証の現実側参照値（realism-check.mjs が消費）
//
// 方針（ユーザー指示 2026-07-12）: 「MLB物理を代理参照＋NPB公式のシーズン集計」
//   - 打球物理（EV/LA→結果の条件付き分布）: NPBには一球粒度の公開データが無いため、
//     MLB Statcast/FanGraphs の公開実測値を物理の代理参照とする（ボール・球場差は
//     band幅で吸収。シムの得点環境はNPB較正なので条件付き分布のみ比較する）
//   - シーズン総量（チーム/リーグ集計）: npb.jp 公式の年度別チーム成績を参照とする
//
// すべての値に source（実際に取得を確認したURL）と season を付ける。
// 取得検証: Web調査エージェント（2026-07-12実行）が実ページで確認した値のみ収載。
// band は [lo, hi] で「シムがこの帯に入れば現実整合」（ボール/リーグ差の許容込み）。
// ============================================================================

// MLB Statcast/FanGraphs 公開実測値（収集: 2026-07-12 Web調査エージェント・全て実ページで確認）。
// 【分類整合】Statcastの打球分類はLA閾値ベース（GB<10°/LD10-25°/FB25-50°/PU>50°）で、
// シムの battedType と同一定義＝そのまま比較可能（Savant 2023生データでプロファイルを照合済み）。
// band=[lo,hi] は「シムがこの帯なら現実整合」（年次変動・ボール差・NPB/MLB差の許容込み）。
// band無し（watchNote のみ）= 既知の穴/新発見の乖離＝WATCH運用（修正後にbandを付けてGATE昇格）。
export const MLB_PHYSICS = {
  pending: false,
  gbBabip: {
    value: '.232-.239（2013-2016複数年）', season: '2014/2016',
    source: 'library.fangraphs.com/offense/batted-ball/ ほか',
    watchNote: '既知の穴: EV分布に弱接触の左裾がなく内野安打が湧かない(audit§2)→sim低め。修正後 band[0.21,0.27] でGATE化',
  },
  ldBabip: {
    value: '.680-.730（FG2014 .685 / BP2010 .730）', season: '2014他', band: [0.60, 0.74],
    source: 'library.fangraphs.com/offense/batted-ball/',
  },
  fbBabipExHr: {
    value: '.127（HR除くフライBABIP）', season: '2016',
    source: 'fantasypros.com（FG系集計）',
    watchNote: '新発見(2026-07-12): simのフライが現実より安打になりすぎ（二塁打過多と同根）。ミックス再較正後 band[0.10,0.17] でGATE化',
  },
  puBa: {
    value: '.020', season: '2010記事',
    source: 'baseballprospectus.com/news/article/10333/',
    watchNote: '既知の穴: 捕手・投手が守備網に不在で本塁至近ポップが落ちる(audit§2)。修正後 band[0,0.05] でGATE化',
  },
  barrelBa: {
    value: '.742-.822（2016 .822 / 2021 .772 / 2023 .742）', season: '2016-2023',
    source: 'mlb.com/glossary/statcast/barrel ほか',
    watchNote: '新発見(2026-07-12): simのバレルはほぼ自動安打(.886)＝深い打球の捕球が現実より少ない。フェンス際/HR帯修正後 band[0.70,0.86] でGATE化',
  },
  barrelSlg: {
    value: '2.39-2.59', season: '2016-2023',
    source: '同上',
    watchNote: '同上（sim 3.27 = バレルのHR化率が現実より高い）',
  },
  hardHitBa: {
    value: '.506-.524（2018 .524 / 2023 .506）', season: '2018/2023',
    source: 'mlb.com/glossary/statcast/hard-hit-rate ほか',
    watchNote: '新発見(2026-07-12): sim低め(.414)＝強いゴロ・低いライナーの安打化が現実より少ない（GB BABIP低と同根）',
  },
  sweetSpotBa: {
    value: '.592-.598（2021/2023）', season: '2021/2023', band: [0.53, 0.66],
    source: 'fantraxhq.com / thedynastydugout.com（Statcast集計の転載・複数年一致）',
  },
  hrPerFb: {
    value: 'Savant定義(FB=LA25-50°) 18.1%（MLB2023・HR/FB）。NPBは低反発で概算8-10%', season: '2023',
    source: 'baseballsavant.mlb.com custom leaderboard CSV',
    watchNote: '新発見(2026-07-12): sim 4.2%＝HRのLA分布がFB帯(25°+)でなくLD帯(15-25°)に偏っている疑い（Part Dの内訳参照）',
  },
  // 打球プロファイル（Savant 2023 生データ: GB53501/LD29726/FB32493/PU8514）
  profile: {
    gb: [0.38, 0.48], // MLB2023実測 43.1%
    ld: [0.19, 0.29], // 23.9%
    fb: [0.21, 0.31], // 26.2%
    pu: [0.03, 0.10], // 6.9%
    season: '2023',
    source: 'baseballsavant.mlb.com custom leaderboard CSV（LA閾値分類＝simと同一定義）',
  },
  // その他の参照（レポート用）: 2B/H 20.2% / 3B/H 1.7% / HR/H 14.4%（MLB2023 B-Ref）、
  // SF/チーム41(162G)、GIDP/チーム115.5(162G)、外野補殺/チーム24.5(162G)、SB%80.2%(2023=ピッチクロック元年)
};

// 内野ライナーの現実参照（2026-07-12収集: Savant statcast_search CSV 2024年2,056試合を自己集計。
// クエリURLは再現可能・収集エージェントの出典参照）。NPBの「直飛」公開集計は存在せず（確認済み）。
export const MLB_LINEOUT = {
  season: '2024（3/28-9/30・2,056試合の自己集計）',
  source: 'baseballsavant.mlb.com/statcast_search（bb_type=line_drive × hit_location 1-6/7-9）',
  infielderShare: 0.287, // ライナーアウトのうち内野手捕球のシェア（外野71.3%）
  ifLineoutPerTeamGame: 0.652, // 内野ライナーアウト/チーム試合（両軍計~1.30/試合）
  ldOutRate: 0.374, // LD分類のアウト率（インプレーLDの37.4%がアウト）
  linedIntoDpPerGame: 0.0992, // ライナー併殺（両軍計/試合・約10試合に1件）。※シム未モデル（ダブルオフなし）
  la0to10Ev140plusLdOutPct: 0.337, // LA0-10°×EV≥140km/hのLD分類打球のアウト率（66%は安打）
  note: 'Statcastのbb_typeは低LA帯でGB/LDが混在する独自分類（純粋なLA閾値ではない）。simのairCatch(GB分類の初バウンド前迎撃)との厳密な突き合わせには定義差があるため、帯は発現保証レベルに留める',
};

// ============================================================================
// NPB 選手年齢構成・一軍/二軍運用の実測（収集: 2026-07-13 Web調査エージェント）。
// R2（年齢構造の是正）の参照値。旧実装は年齢と能力が完全無相関（r=0.012）で、支配下の19%が18歳・
// 一軍登録の38%・規定到達者の36%が20歳以下という破綻を起こしていた（ユーザー報告「初期値ができすぎ」）。
// ============================================================================
export const NPB_ROSTER_AGE = {
  season: '2026年度',
  source: 'https://npb.jp/bis/teams/rst_g.html / rst_t.html（公式の支配下選手一覧を直接集計）',
  // 巨人69人 / 阪神69人 の実測（n=2球団＝代表性に限界あり。band はその旨を織り込んで広めに取る）
  perTeam: {
    age18: { obs: 1, band: [0, 4] }, // 高卒ドラフト相当。旧実装は 13.6人/球団（＝破綻の主因）
    age19: { obs: 0.5, band: [0, 4] },
    a20to22: { obs: 8.5, band: [5, 13] },
    a23to25: { obs: 19.5, band: [13, 26] },
    a26to29: { obs: 22, band: [14, 30] },
    a30to33: { obs: 12, band: [6, 19] },
    a34plus: { obs: 6, band: [2, 11] },
  },
  meanAgeControlled: { obs: '26.94-27.06', band: [25.5, 28.5] }, // 支配下70人の平均年齢
  meanAgeFarm: { obs: 21.88, band: [20.0, 24.0], note: 'ソフトバンク育成51人の実測。支配下より約5歳若い' },
  // 一軍（出場選手登録29人）側。二次情報（確度中）: 2014年の一軍出場選手平均28.8歳。
  meanAgeActive: { obs: '~28', band: [26.5, 29.5], source: '二次情報（baseballchannel 2014）＝確度中' },
  // 高卒1年目の規定到達: 過去20年で確実な該当例が見つからない（清宮/佐々木朗希/藤浪/大谷とも未到達）。
  //   ＝ シムの「規定到達者に占める20歳以下の比率」は実質ゼロであるべき。
  rookieQualifiedShare: { obs: 0.0, band: [0, 0.03], note: '悉皆調査ではない（確度中）が、方向は明確' },
  peakAge: { hitter: [26, 29], pitcher: [23, 27], source: 'DELTA/1point02/note 等の複数分析が一致（確度中）' },
  // 出場選手登録の入替（巨人2024の自己集計。n=1球団＝規模感の目安）
  registrationMoves: {
    perTeamSeason: { obs: '実入替 50-70回（延べ公示 214件）', band: [20, 90] },
    distinctPlayersUsed: { obs: 61, band: [45, 70] }, // 1シーズンに一軍登録された異なり選手数
    source: 'https://www.my-favorite-giants.net/giants_data/major/2024.htm（原資料は公式公示）',
  },
  // 制度（日本プロフェッショナル野球協約2022・一次情報・確度高）
  rules: {
    controlledMax: 70, // 第79条（救済措置適用時80）
    activeMax: 29, // 第81条2項（感染症特例年は31）
    reRegisterWaitDays: 10, // 第85条: 抹消公示日を含み10日を経過しないと再登録不可
    source: 'https://jpbpa.net/wp-content/uploads/jpbpa-pdf/ag2022.pdf',
    note: '「育成→支配下登録の期限=7/31」は通説だが規約原文に単独の明文規定は見当たらない（未確認）。'
      + 'トレード期限(第108条・7/31)と育成保有資格の判定日(7月末日現在で支配下65名以上)の混同の可能性',
  },
};

// ============================================================================
// 故障・負傷離脱の現実参照（収集: 2026-07-13 Web調査）。R3（試合中の故障）の参照値。
//
// 【重要】NPBには故障者リスト(IL)制度が存在しない（野球協約84条の「出場選手登録抹消＋10日間
// 再登録不可」だけ）。よって NPB の故障者数は報道ベースの独自集計しかなく、軽症は構造的に漏れる。
// シムの「故障」は最短でも12試合（≈14日）離脱＝報道級に相当するので、NPB側の band を採る。
// ============================================================================
export const NPB_INJURY = {
  season: '2023-2024（NPB）／2011-2024（MLB代理参照）',
  // ① 故障離脱者数/球団/年。NPB実測 88名(2023)/87名(2024)÷12球団 = 7.3人。球団別レンジ 4-13人。
  //    出典: niwaka-yakyu.net/2023-l-npb-il-list/ , /2024-l-npb-il-list/（報道ベースの独自集計＝確度中）
  //    傍証: 故障による登録抹消日数は最多球団で 655-658日/年（データスタジアム集計・2017）。
  //    ＝ 7-9人 × 40-60日 ≈ 350-450日 と独立に整合する。
  perTeamSeason: { obs: 7.3, band: [6, 12] },
  // ② 重症（シーズン絶望級）の割合。Esquivel 2019（MLB HITS・n=51,548・PubMed 31909052・確度高）:
  //    試合中負傷の 8.4% / 試合外の 10.8% がシーズン絶望級。
  majorShare: { obs: 0.09, band: [0.05, 0.14] },
  // ③ 投手:野手の**件数**比。NPB実測 2024=47:40(1.18:1) / 2023=43:39(1.10:1)。
  //    ★「投手が壊れやすい」のは頻度でなく **1件あたりの離脱が長い** から（肩64日/肘59日 ⇔
  //      肉離れ40日/その他30-35日＝man-days比は 1.3-1.8:1）。頻度差は穏やか。
  pitcherToFielderCount: { obs: 1.14, band: [0.85, 1.45] },
  // ④ 1件あたりの平均離脱日数。部位別実測 30-64日（NPB 2017）／捕手全体 50.8日（MLB 2001-10）。
  meanDaysLost: { obs: 50, band: [35, 70] },
  // ⑤ 試合中の負傷交代/試合（両軍計）。※直接統計は存在しない（導出値）:
  //    MLB IL stints 26-32/球団年 × 試合中発生 62.8% ÷ 162試合 × 2 = 0.20-0.25。
  inGameExitsPerGame: { obs: 0.22, band: [0.05, 0.40], note: '導出値・原典なし（幅を広めに）' },
  // ⑥ 発生契機（試合中）: 投球23% / 打撃24% / 守備23% / 走塁22% とほぼ均等（Esquivel 2019）。
  //    ただし現実の故障の 37.2% は**試合外**発生（うち29.8%が throwing）。シムは試合中しか
  //    モデル化しないため、投手の perBF に試合外の投げ込み消耗を吸収させている（→ ③の件数比で較正）。
  causeShares: { pitching: 0.234, batting: 0.240, fielding: 0.226, baserunning: 0.216 },
  // ⑦ 捕手: 負傷"頻度"は他ポジションより **低い**（2.75/1000 Athlete-Exposure・Guy 2015・
  //    PubMed 26320222・確度高）。Carr 2022 でも捕手の負傷burdenは最低(11.0%)。
  //    → 「捕手は壊れる」は俗説。頻度は割増さず、**重症度**（膝・頭頸部）で差をつけるのが正しい。
  catcherFrequencyMultiplier: { obs: 1.0, note: 'むしろ0.8-1.0。旧実装の +0.05 割増は撤去した' },
  // ⑧ 最小離脱: NPB は抹消日を含み10日間再登録不可（野球協約84条・確度高）＝離脱の最小単位。
  minDaysOut: 10,
  sources: [
    'https://niwaka-yakyu.net/2024-l-npb-il-list/',
    'https://baseballgate.jp/p/146033/（データスタジアム・部位別離脱日数）',
    'https://pubmed.ncbi.nlm.nih.gov/31909052/（Esquivel 2019・試合中62.8%/契機の内訳）',
    'https://pubmed.ncbi.nlm.nih.gov/26320222/（Guy 2015・捕手の負傷率は低い）',
    'https://www.baseballprospectus.com/news/article/95713/（MLB IL stints 2021-24）',
  ],
};

// npb.jp 公式チーム成績（2023-2025・セパ12球団・143試合）。収集: 2026-07-12 Web調査
// エージェントが tmb_c/tmb_p/tmf_c/tmf_p.html を直接取得しパース（全ページ200 OK・原データ保存済み）。
// mean=12球団平均 / teamLo,teamHi=3年間の全チーム個別値の最小/最大（帯設定用）。
export const NPB_SEASON = {
  pending: false,
  seasons: '2023-2025',
  source: [
    'https://npb.jp/bis/2023/stats/tmb_c.html（〜2025・tmb_p/tmf_c/tmf_pも同形式）',
  ],
  avg: { means: [0.242, 0.243, 0.244], teamLo: 0.212, teamHi: 0.259 },
  runsPerTeam: { means: [498, 469.9, 471.2], teamLo: 350, teamHi: 607 }, // R/G ≈ 3.29-3.48
  hitsPerTeam: { means: [1151.7, 1152.7, 1171.1], teamLo: 971, teamHi: 1252 },
  b2PerTeam: { means: [198.8, 193.2, 192.9], teamLo: 146, teamHi: 243 },
  b3PerTeam: { means: [18.5, 21, 21.9], teamLo: 8, teamHi: 40 },
  hrPerTeam: { means: [104.2, 81.2, 91.3], teamLo: 52, teamHi: 164 },
  sbPerTeam: { means: [65.9, 68.3, 76.8], teamLo: 33, teamHi: 110 },
  csPerTeam: { means: [32.2, 31, 31.8], teamLo: 14, teamHi: 52 },
  sbPct: { means: [0.6715, 0.6879, 0.7074] }, // リーグ合算 SB/(SB+CS)
  shPerTeam: { means: [101.1, 110.7, 92.8], teamLo: 57, teamHi: 137 },
  sfPerTeam: { means: [31.1, 31.1, 31.6], teamLo: 20, teamHi: 47 }, // 3年とも31前後で極めて安定
  gdpPerTeam: { means: [97.4, 98.6, 87.2], teamLo: 66, teamHi: 120 },
  bbPerTeam: { means: [407, 379.7, 379.9], teamLo: 282, teamHi: 494 },
  hbpPerTeam: { means: [51.3, 47.3, 49.6], teamLo: 25, teamHi: 65 },
  soPerTeam: { means: [1035.8, 997.8, 1039.6], teamLo: 846, teamHi: 1173 },
  ePerTeam: { means: [73.8, 71.2, 69.2], teamLo: 52, teamHi: 96 },
  dpDefPerTeam: { means: [115.6, 115.5, 105], teamLo: 83, teamHi: 133 }, // 守備側併殺（ライナー併殺等も含む＝シムのGDPより広い）
  // 派生: 安打内訳（2B/H）= 0.173 / 0.168 / 0.165 → NPBは概ね 0.16-0.18
  b2PerHit: { means: [0.173, 0.168, 0.165] },
  b3PerHit: { means: [0.016, 0.018, 0.019] },
};

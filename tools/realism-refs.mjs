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

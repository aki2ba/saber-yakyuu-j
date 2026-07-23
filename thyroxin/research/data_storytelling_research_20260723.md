# 「データで野球を面白く語る人たち」研究 — 人気コンテンツの型とゲーム内翻案 — 2026-07-23

> 目的: 赤味噌・野球研究所のような日本のセイバー系/データ系発信者、Rob Friedman・Baseball Savant・
> FanGraphsのようなMLB系データ発信者の「バズるデータ語り」の型を調査し、本ゲームの
> **三層構造（真値/観測成績/スカウト等級。真値は非開示）**の制約内で「データ語り」機能へ翻案する。
> 前回調査（`baseball_game_mechanics_research_20260723.md`）はゲームメカニクス一般（信頼度・育成・
> 演出）で、そのQ1〜Q11は既に大半が実装済み（`progress.md` 2026-07-23参照）。本書は**指標の見せ方・
> 語り方**という新しい切り口で、既存指標在庫（Part 0）×既存演出インフラ（news.mjs/storylines.mjs/
> coachReports.mjs/gallery.mjs等）の上に積む提案を行う。
>
> **制約の補足（ユーザー訂正・2026-07-23）**: 開発中の現行UIに出ている能力値表示は**削除・置換しない
> （現状維持）**。「能力値を見せない」のは将来のデプロイ版の話であり、今回のR1〜R8はそれとは独立に
> 「**新規に提案するデータ語り機能そのものを、能力値に依存せず観測成績(statline・打球データ)と
> スカウト等級だけで成立させる**」という設計方針を取る（＝将来デプロイ版で能力値表示を隠しても、
> R1〜R8はそのまま機能し続けるように作る）。以下のPart3の提案はいずれも既存の能力値表示には
> 一切触れず、新設する語り機能の入力を観測成績/スカウト等級のみに限定している。

---

# Part 0: 前提 — このゲームが既に算出している指標の在庫

`src/sim/metrics.mjs`（`playerBatting`/`playerPitching`/`playerBaserunning`）と`src/sim/fielding.mjs`
（`uzrComponents`）、`src/engine.mjs`のエクスポート一覧を確認した。**一球・一プレー粒度の副産物として
（鉄則4）既に以下が観測成績statlineから湧いている**（＝真値を一切参照しない集計。全て今回の提案の
入力として使える）:

- **打撃**: AVG/OBP/SLG/OPS/ISO/BABIP/wOBA/wRAA/wRC+（パーク補正版wRC+PFも）/OPS+/SecA/K%/BB%
- **期待値系（B3a）**: `xba`/`xslg`/`xwoba`（打球の期待out率・塁打分布から。rng抽選前に累積＝
  「不運/幸運」を語れる）
- **打球質**: `barrelPct`/`hardHitPct`/`sweetSpotPct`/`evAvg`/`evMax`、GB/LD/FB/PU%、Pull/Cent/Oppo%
- **規律系（一球データの副産物）**: Zone%/O-Swing%/Z-Swing%/SwStr%/CSW%/Contact%/F-Strike%
  （`statline.mjs`の`pitches/swings/whiffs/zonePitches/oZonePitches`等から`metrics`が算出）
- **投手**: ERA/FIP/xFIP/SIERA/kwERA/K-BB%/LOB%/ERA-・FIP-・xFIP-（パーク補正版も）/被打球分類/HR-FB/QS
- **走塁**: wSB/UBR（シナリオ別RE24分解）/wGDP/BsR/XBT%
- **守備**: UZR成分（RngR/ErrR/ARM/DPR/rSB/フレーミング）、OAA
- **文脈（B2・2パスRE行列/WE表/LI表から）**: RE24/WPA/LI（aLI/pLI/gmLI）/Clutch/SD(シャットダウン)/
  MD(メルトダウン)
- **打撃スプリット（B3b）**: 対左/対右・得点圏(RISP)・ホーム/ビジター
- **チーム**: ピタゴラス期待勝率・luck（幸運度）
- **二軍（ファーム）**: `league.farm`の観測statlineも同一の`metrics.mjs`関数群で算出可能
  （`market.mjs`の`farmPerfBonus`が実例＝`farmLc`＝二軍リーグ定数を渡して`uzrRuns`/`playerBaserunning`
  を二軍水準で評価している）
- **既存の演出インフラ**（今回の提案が乗る土台）: `news.mjs`（週次ダイジェスト・notable見出し・
  性格別文体）、`storylines.mjs`（`playerStoryOf`/`draftClassHeadlines`/`specialDaysOf`）、
  `coachReports.mjs`（Q2＝育成方針の観測トレンド文章化・**前半/後半split・サンプル不足で沈黙という
  ガード**が既に確立済みパターン）、`gallery.mjs`（殿堂/二つ名/記録アルバム）、`trust.mjs`（Q1＝
  観測ベースの3段階ラベル表示パターン）

**含意**: 指標の「在庫」は既に非常に豊富（Savant/FanGraphsが公開しているほぼ全指標＋文脈指標まで）。
不足しているのは**指標を選んで語る「編集」レイヤー**——どの指標を、どの選手について、いつ、
どんな文体で見せるか。これがPart3提案の核心。

---

# Part 1: 発信者・コンテンツ調査（出典付き）

## 1-1. 日本のセイバー系/データ系発信者

### 赤味噌（中日ドラゴンズ関連の情報発信アカウント）
調査の結果、赤味噌は厳密には「セイバー指標解説」アカウントではなく、**外国人選手の獲得予測・
移籍情報を独自データで的中させる「情報系」アカウント**であることが判明した（当初想定と異なるため
訂正して記載）。2018年から活動し、公式データブック・データサイトを使い自作Excelで選手情報を整理、
出場予定選手と対戦相手を見て試合を分析するスタイル。2023年5月、中日のウンベルト・メヒア獲得を
的中させたことで一気に注目され、フォロワー15万人超・トレンド入り複数回を記録した。
**バズった型**: 「予言の的中」——データに基づく獲得予測が後に現実と一致することで信頼が爆発的に
積み上がる（＝**予言型**、Part2の型⑤に相当）。
出典: [Number Web: 中日の赤味噌さんは何者？](https://number.bunshun.jp/articles/-/857623) /
[中日新聞: フォロワー11万人 赤味噌とは](https://www.chunichi.co.jp/article/758572) /
[新・なんJ用語集wiki: 赤味噌](https://wikiwiki.jp/livejupiter/%E8%B5%A4%E5%91%B3%E5%99%8C)

### 野球研究所（プロ野球をデータで研究するブログ）
「野球研究所」と呼ばれるような多種多様な分析をするブログ（`l-data-daily.com`）。埼玉西武ライオンズを
中心にデータで研究する個人ブログとして継続運用されている。直接記事本文の取得はBot対策で不可
だったが、検索結果からブログの位置づけ（NPB個人ブログのデータ分析ジャンルの代表格の一つ）は確認できた。
出典: [プロ野球をデータで研究するブログ（野球研究所）](https://l-data-daily.com/)

### お股ニキ（@omatacom）
野球経験は中学止まりだが、膨大な試合観戦とデータ分析に基づく感性でTwitter上の選手評・采配評を
発信し続け、フォロワー数万人規模の人気アカウントに成長。ダルビッシュ有ら現役プロ選手約40名が
参加するオンラインサロンでピッチング理論を指導するまでに至った、**「素人の視点×圧倒的なデータ観察量」
というプロウト（Pro+Amateur）ポジションの成功例**。
**バズった型**: 「素人だが観察が鋭すぎる」という**意外性のポジショニング**＋「あの投手にこの助言が
実際に採用された」という**実証（予言型の別形態）**。
出典: [中日スポーツ: お股ニキ氏インタビュー](https://www.chunichi.co.jp/article/184664) /
[moonOMT: お股ニキについて](https://moonomt.com/about)

### DELTA / 1.02 (One Point Zero Two)
2011年設立のセイバーメトリクス専門集団DELTAが運営する「1.02 Essence of Baseball」は、UZR・WARなど
守備指標・総合指標を含む集計値と分析コラムを公開。書籍『プロ野球を統計学と客観分析で考える
デルタ・ベースボール・リポート』シリーズ、『よくわかるセイバーメトリクス』も刊行し、**「一次データの
専門集団が定期コラムで指標を解説する」という権威型・教育型コンテンツ**の代表格。有料の週次
ニュースレター「1.02 Weekly Report」も運営。
**バズった型**: 教育型（指標そのものの解説）と、専門家による「今季の隠れた優良守備」のような
一歩踏み込んだ分析コラムの両輪。
出典: [1.02 Essence of Baseball](https://1point02.jp/) /
[DELTA公式: よくわかるセイバーメトリクス](https://deltagraphs.co.jp/books/yokuwakarusabermetrics)

### なんJ / まとめサイトのデータスレ文化
なんJ（なんでも実況J）系掲示板では「なんJ野球指標」のような独自ランキングスレが定期的に立ち、
まとめサイト（`nanj-matome.com`「データスレ」カテゴリ等）に集約される。東京大学野球部アナリストが
note記事で「なんJ野球指標」を検証するなど、**在野の指標ランキング文化がプロのアナリストにも
参照される逆輸入現象**が起きている。典型的な型は「WARランキング1位」「防御率ランキング1位返り咲き」
のような**極端値の速報的共有**（Part2の型①）。
出典: [note: 【雑魚検証】なんJ野球指標を考える](https://note.com/light_bison1314/n/n7a46ec618a36) /
[なんJまとめアンテナ: データスレ](http://nanj-matome.com/c/data)

## 1-2. MLB系データ発信者

### Rob Friedman（PitchingNinja）
2014年開設、2026年時点でフォロワー56万人超の「野球界で最も有名なSNSアカウントの一つ」。
投球のスロー映像・GIFに回転軸や腕の角度、球速などのデータをテキストで重ねる**「映像×一言データ」**
の型を確立。本人は「フォーマルな分析資格に頼らない、独学の観察」を強みとし、"超人的なものが
好きなだけ"と語る——**専門用語より「これは異常だ」という驚きの感情を前面に出す**編集方針。
出典: [Wikipedia: Rob Friedman](https://en.wikipedia.org/wiki/Rob_Friedman_(baseball_analyst))

### Codify Baseball
投手アナリティクスに特化したパイオニア（創業者Michael Fisher）。ヒートマップによるゲームプランニング・
ピッチデザインを、300人以上のMLB投手へのコンサルティングという実績とともに発信。
**「データが実際に選手を強くした」という実証の型**をSNS発信の裏付けにしている。
出典: [MLB.com: Fischer on Codify Baseball](https://www.mlb.com/video/fischer-on-codify-baseball)

### Foolish Baseball（YouTube「Baseball Bits」シリーズ）
16bit風レトロゲーム美術で複雑なセイバーメトリクスを一般ファンにも分かる形へ翻訳する動画エッセイ。
1本あたり15〜20分、更新頻度は3〜4週に1本だが**数十万再生を安定して稼ぐ**。単一選手・単一チーム・
リーグ全体のいずれについても「なぜこの現象が起きたか」を高度な統計で説明する構成——**「謎解き型」の
物語構造**（現象の提示→違和感→データによる解明）を確立している。
出典: [HypeAuditor: Foolish Baseballのデータ](https://hypeauditor.com/youtube/foolish_baseball-UCbW12JIVAdi5NugdakbU33A/) /
[Medium: How Foolish Baseball is Changing the Way Fans See the Game](https://medium.com/@zcarver2303/how-foolish-baseball-is-changing-the-way-fans-see-the-game-0102c34bb86f)

### Jomboy Media
リップリーディング（読唇術）を駆使した「ブレイクダウン動画」で著名。データそのものよりも
「その瞬間の会話・感情」を掘り下げるスタイルで、MLB公式と提携するまでに成長（YouTube登録者200万人）。
データ系というよりは**物語接続型（Part2の型④）**の極致であり、本ゲームの「物語」欄
（`storylines.mjs`の`playerStoryOf`）に近い設計思想が既に成功していることの傍証になる。
出典: [Fast Company: Jomboy Media](https://www.fastcompany.com/91209377/inside-the-growing-sports-media-empire-where-the-business-is-all-fun-and-games) /
[Wikipedia: Jomboy (sports media)](https://en.wikipedia.org/wiki/Jomboy_(sports_media))

### Baseball Savant公式 — percentileランキング（通称"the bubbles"）
選手ページを開いて真っ先に目に入るのが、各Statcast指標のリーグ内百分位を横棒バーで示す
**「バブル」表示**。青（低百分位）〜赤（高百分位）のグラデーションで、専門知識が無くても
「この選手は何が凄いか」が一目で分かる。Twitter上の議論では**このスクリーンショット自体が
議論の決め手として貼られる**——**可視化そのものがバズる単位**になっている好例（Part2の型③）。
2025年以降、新デザインでバー表示が刷新されたことも報じられている。
出典: [MLB.com: These new-look Statcast player pages are art](https://www.mlb.com/news/baseball-savant-statcast-player-pages-new-look) /
[Baseball Savant: percentile rankings](https://baseballsavant.mlb.com/leaderboard/percentile-rankings) /
[TDA Baseball: How to Analyze a Hitter's Baseball Savant Page](https://www.tdabaseball.com/post/how-to-analyze-a-hitter-s-baseball-savant-page)

### FanGraphs / RotoGraphs — xwOBA乖離コラム
「Potential 2nd Half Breakouts Using Statcast xwOBA」「Batter xwOBA Underperformers &
Overperformers」のような**定期連載コラムのフォーマットが確立**している。xwOBA自体は将来予測力が
限定的だが、**分布の裾（極端に乖離した選手）に限れば有効**という研究結果があり、「不運な好選手/
幸運な凡選手」を定期的に名指しする型がコンテンツとして定着している。
出典: [FanGraphs: Potential 2nd Half Breakouts Using Statcast xwOBA](https://fantasy.fangraphs.com/potential-2nd-half-breakouts-using-statcast-xwoba/) /
[FanGraphs: The In-Season Predictiveness of xwOBA](https://fantasy.fangraphs.com/the-in-season-predictiveness-of-xwoba/) /
[FanGraphs: Batter xwOBA Underperformers & Overperformers](https://fantasy.fangraphs.com/batter-xwoba-underperformers-overperformers-jun-2-2026/)

### MLB Pipeline — 20-80スカウティングスケール
プロスペクト紹介記事の共通言語が「20-80スケール」（20=平均以下2σ、50=平均、70-80=傑出）。
"Future Value"という**単一の要約数値**で期待をまとめつつ、ツール別（パワー/走力/制球等）の内訳も
併記する——**「まとめ数値＋内訳の物語化」の二層構造**が定着フォーマット。
出典: [FanGraphs: Scouting Explained: The 20-80 Scouting Scale](https://blogs.fangraphs.com/scouting-explained-the-20-80-scouting-scale/) /
[MLB.com: Scouting Grades](https://www.mlb.com/glossary/miscellaneous/scouting-grades)

### 週刊ベースボール — 二軍・アマ選手の逸材紹介
2026ドラフト特集などで「安定感抜群の8回の男」のような**キャッチコピー＋実績データ**を組み合わせた
プロスペクト紹介記事を定期的に掲載。また「2軍成績.com」のような専門サイトはOPS/wOBA/wRC+/ISO/WHIP
まで二軍全選手に表示し、**「次に一軍で活躍するのは誰か」を見極めるためのデータ**という明確な
編集意図を掲げている。
出典: [週刊ベースボールONLINE](https://sp.baseball.findfriends.jp/) /
[NPB 2軍（ファーム）成績 2026年](https://www.farm-stats.com/)

---

# Part 2: バズる型の抽出

調査結果を横断すると、事前仮説①〜⑥はいずれも実例で裏付けられ、加えて2つの型（⑦教育的権威型・
⑧謎解き構造型）が浮かび上がった。

| 型 | 定義 | 実例 |
|---|---|---|
| ① 極端値 | リーグ1位/最下位・percentile 99等の「端」を名指しする | なんJ「WARランキング1位」速報／FanGraphs xwOBA乖離コラム／Savantバブルの赤一色表示 |
| ② 意外性 | 無名選手×すごい指標、または「地味な打率の裏に隠れた真の実力」 | FanGraphs「不運な好打者」／週刊ベースボール二軍紹介「安定感抜群の8回の男」 |
| ③ 可視化 | スプレーチャート/変化量/percentileバーそのものが議論の証拠として貼られる | Baseball Savant「バブル」表示／PitchingNinjaの映像＋数値重畳 |
| ④ 物語接続 | 数字が選手の生き様・キャリアの文脈に接続される | Jomboy（会話の物語化）／週刊ベースボールの選手紹介コピー |
| ⑤ 予言 | 「この指標は結果より先に良化する」という将来予測の型 | 赤味噌の獲得予測的中／お股ニキの技術助言が採用された実例／FanGraphs breakoutコラム |
| ⑥ 比較 | あの有名選手・過去の名選手と同水準、という参照点による理解の補助 | MLB Pipelineの20-80スケール（"future 70 power"は既知の名選手を想起させる基準） |
| ⑦ 教育的権威型 | 専門集団が指標そのものを解説し「これを知っていると野球がもっと分かる」という信頼を積む | DELTA/1.02のコラム・書籍シリーズ |
| ⑧ 謎解き構造型 | 「なぜこの現象が起きたのか」を提示→違和感→データで解明、という物語の型式 | Foolish Baseball「Baseball Bits」 |

**共通する設計原則**: いずれの型も「**驚き（極端値・意外性）を先に見せ、その驚きの根拠として
データを後出しする**」という順序を取る。逆に「データを提示してから結論を言う」講義形式は
バズらない（Foolish Baseballも謎→解明の順）。また②③⑤は特に相性が良く、
**「無名選手の極端な観測乖離を可視化しつつ将来を予言する」**というのがMLB/NPB双方で最も強い
複合パターンだった（FanGraphs xwOBA乖離コラム、週刊ベースボール二軍紹介、Savantバブルはいずれも
この三位一体）。

---

# Part 3: 本ゲームへの適用提案 R1〜R8

前提: すべて**観測成績（statline）・打球集計・スカウト等級のみ**を入力とし、真値（trueAbility）を
一切参照しない（鉄則3）。既存の`coachReports.mjs`のパターン（サンプル不足時は沈黙する・
`hashSeed`独立座標でテンプレ選択・保存フィールド追加なし＝毎回`playerSeason`/`rt.playerGameLog`から
再計算）を踏襲する設計とする。

## R1. 週次/月次「データ小ネタ」アナリストコラム 〔優先度: 高〕

- **元ネタの型**: ①極端値＋⑦教育的権威型（なんJ「ランキング1位」速報・FanGraphs xwOBA乖離コラム・
  DELTA/1.02の定期コラム）。
- **具体形**: 新規`analystColumn.mjs`（`coachReports.mjs`と同型のモジュール）。週または月の節目で、
  規定打席/規定投球回に到達した選手群を対象に、`playerBatting`/`playerPitching`の出力
  （`barrelPct`/`xwoba`/`csw`系/`clutch`等）から**リーグ内の外れ値を1〜2件**抽出し、
  テンプレ文（「〇〇のBarrel%が規定到達者でリーグ1位。地味な打率(.XXX)に騙されるな」
  「〇〇のCSW%がリーグ屈指——投球内容は数字が語る好投手」）で文章化する。極端値の選定は
  `qualifiedPA`/`qualifiedIP`（既存config定数）でサンプル保証済みの母集団に限定。テンプレ選択・
  対象指標の選び方は`hashSeed(masterSeed,'analystcolumn',year,week)`独立座標。既存ニュースタブの
  週次ダイジェスト（`news.mjs`の`weeklyDigest`）へ追記する形で表示。
- **実装コスト**: 小〜中（新規モジュール1本。統計抽出ロジック＋テンプレ束。既存`playerBatting`等の
  出力をそのまま使うため新規指標計算は不要）。
- **鉄則リスク**: 低。表示層のみ・観測statlineのみ参照・エンジン非改変・較正不変・乱数非消費
  （テンプレ選択のみhashSeed消費、既存独立座標の作法と同型）。

## R2. 二軍の逸材データ紹介（ファームスポットライト） 〔優先度: 高〕

- **元ネタの型**: ②意外性＋⑤予言（週刊ベースボールの二軍逸材紹介・2軍成績.comのwOBA/wRC+全選手
  表示・FanGraphs breakoutコラム）。
- **具体形**: 新規`farmSpotlight.mjs`。`league.farm`の当季観測ライン（`rt.farm.stats`。
  `market.mjs`の`farmPerfBonus`が既に同じデータソースを昇格査定に使っている＝流用実績あり）から、
  `farmLc`（二軍リーグ定数。既存`deriveLeagueConstants`で導出可能）で`playerBatting`/`playerPitching`
  を計算し、**「観測成績が良いのにスカウト等級（層3）がまだ低い」or「若年×極端な指標
  （高K/9・高Barrel%等）」を1〜2名検出**して「二軍のこの選手、数字はもっと上を指しています」型の
  紹介文を生成する。ドラフト/FA画面のスカウト等級表示（既存の「見立て」表示ロジック）と対比させる
  ことで**「数字と評価の乖離」という三層構造ならではの語り**が成立する（真値は一切見せない＝
  観測とスカウト等級という2つの層2/層3のズレだけを語る）。表示は既存ニュースタブに新設セクション
  「🔭ファーム便り」、または選手モーダルのファーム成績欄に付記。
- **実装コスト**: 中（`farmLc`算出＋外れ値検出ロジック＋テンプレ束。`market.mjs`の既存パターンを
  流用できるため新規性は低い）。
- **鉄則リスク**: 低。観測statline＋既存スカウト等級（層3・元々UI表示済み＝新規露出ではない）のみ
  参照。真値非参照。表示層のみ・較正不変。

## R3. ブレイク予兆・regression警報（先行指標の語り） 〔優先度: 高〕

- **元ネタの型**: ⑤予言（FanGraphs「xwOBA乖離」「2nd Half Breakouts」コラム・お股ニキの技術予測）。
- **具体形**: `coachReports.mjs`と同じ「前半/後半split」パターンを流用した新規`regressionWatch.mjs`。
  対象は自チーム全選手（`coachReports`と異なり育成方針に紐付かない全選手版）。**xwOBA−wOBA乖離**
  （`playerBatting`の`xwoba - woba`）・**BABIP乖離**（`babip`とリーグ平均の差）・**CSW%の前半→後半
  改善幅**（`playerPitching`の`csw`相当を`coachReports`の`battingHalfSplit`と同型のhalf-split関数で
  分割）を検出し、乖離が閾値超の選手を「打率はまだ振るいませんが、xwOBAは既に一段上——数字が先に
  良化しています」のように文章化する。真値のブレイク判定（`breakout.mjs`）は一切参照しない
  ——**観測データの乖離という統計的事実だけ**から語ることで、三層構造と自然に整合する
  （「本当にブレイクするか」はプレイヤーが自分の目で確かめる余地を残す＝予言の当たり外れという
  ゲーム的緊張感が生まれる）。
- **実装コスト**: 中（乖離計算は既存フィールドの引き算のみ。half-split関数は`coachReports.mjs`から
  抽出して共通化するのが望ましい）。
- **鉄則リスク**: 低。観測statlineの乖離のみ・真値非参照・表示層のみ・較正不変。

## R4. percentileスライダー可視化（Savant風・観測成績の百分位） 〔優先度: 高〕

- **元ネタの型**: ③可視化（Baseball Savantの"bubbles"）。
- **具体形**: 選手モーダルの成績タブに、リーグ内の同ポジション/役割群を母集団とした**観測成績の
  百分位バー**（`barrelPct`/`evAvg`/`xwoba`/`kPct`/`bbPct`/`chase(O-Swing%)`等・投手なら`csw`/
  `whiffPct`/`kPct`/`bbPct`等）を横棒＋グラデーション色で表示する。**数値レーティング（能力値）を
  一切使わず、その年のリーグ内観測成績の順位（0-100%）だけ**で算出するため、デプロイ制約
  （能力値非表示）に完全適合する。既存`metrics.mjs`の出力をそのままリーグ全体で集めて
  percentileRank関数（新規の小さな純関数）に通すだけで実現でき、UIはCSSバーのみ（新規指標計算は
  不要）。
- **実装コスト**: 中（UI実装が主。バックエンドは1関数＋既存出力の並べ替えのみ）。
- **鉄則リスク**: なし〜低。観測成績の相対順位のみ・真値非参照・エンジン非改変・較正不変。

## R5. 「球団史の名手級」比較コメント 〔優先度: 中〕

- **元ネタの型**: ⑥比較（MLB Pipelineの20-80スケール・"future 70 power"のような既知選手を想起させる
  基準）。本ゲームは架空選手のみで実在MLB/NPB選手との比較はできないため、**自球団の殿堂/記録
  （既存`gallery.mjs`の殿堂・記録アルバム）を参照点に翻案**する。
- **具体形**: `gallery.mjs`の殿堂入り基準データを使い、現役選手の観測ペース（例: 通算本塁打の
  年間ペース）が球団歴代記録保持者の同年齢時点ペースに並んでいる場合、「〇〇（歴代2位・通算XX本）
  に並ぶペースです」と一言添える。完全に既存データ（`careerStats`・`gallery.mjs`の集計）の比較のみ
  で、新規保存フィールド不要。
- **実装コスト**: 小〜中（既存`gallery.mjs`の歴代記録データに対する年齢調整済みペース比較関数を
  1本追加）。
- **鉄則リスク**: 低。確定済み過去データ同士の比較のみ・表示層・較正不変。

## R6. スプレーチャート/EV-LA散布図の可視化 〔優先度: 中〕

- **元ネタの型**: ③可視化（PitchingNinjaの映像＋数値重畳・Statcastのスプレーチャート文化）。
- **具体形**: 選手モーダルの打球タブに、既存の`bbPull`/`bbCent`/`bbOppo`（方向）と`gbPct`/`ldPct`/
  `fbPct`/`puPct`（打球種）をSVGの簡易扇形/散布図として可視化する。生の一球データは鉄則8
  （§17生イベント非永続）によりシーズン終了後は残らないため、**シーズン内はリアルタイムに集計値から
  再構成、シーズン終了後は集計比率のみ保持**という既存の器（`createBattingLine`の`bbPull/bbCent/
  bbOppo`等）の範囲で実現する（生打球ログを新たに永続化する必要はない）。
- **実装コスト**: 中（SVG描画の新規実装。バックエンドの新規計算は不要＝既存集計比率のみ使用）。
- **鉄則リスク**: 低。集計済みの既存フィールドを可視化するだけ・エンジン非改変・較正不変。

## R7. 「この一球/この登板」ハイライト文（CSW%・シャットダウン登板の一言化） 〔優先度: 中〕

- **元ネタの型**: ①極端値×④物語接続（PitchingNinjaの「これは異常だ」という驚きの一言化）。
- **具体形**: 既存の`sd`（シャットダウン登板・1試合WPA≥+0.06）/`md`（メルトダウン）や、
  `playerGameLog`の1試合ボックスから、当日の登板で**CSW%やSwStr%が極端に高かった投手**を検出し、
  日次進行ダイジェストに「〇〇、CSW% XX%の圧巻登板」のような一言見出しを追加する。
  `detectGameNotables`（`news.mjs`既存関数）に新しい検出パターンを1つ足す形で、既存の`notableHeadline`
  性格別文体（P6性格→文体接続）ともそのまま接続できる。
- **実装コスト**: 小（既存`detectGameNotables`への条件追加＋テンプレ）。
- **鉄則リスク**: なし。既存の1試合ボックス集計のみ参照・表示層・較正不変。

## R8. 月間「隠れWPAリーダー」カード（クラッチ職人の発掘） 〔優先度: 低〕

- **元ネタの型**: ②意外性×①極端値（「勝率貢献度は地味な選手が実は一番効いている」という
  FanGraphs/なんJ双方に見られる語り）。
- **具体形**: 月次で、WAR上位ではないが`wpa`/`clutch`（既存B2文脈指標）が上位の選手を1名検出し、
  「打率は目立たないが、勝利への貢献(WPA)はチーム屈指」というカードをニュースタブに追加する。
  R1（週次コラム）の月次版という位置づけで、同じ`analystColumn.mjs`に「月次モード」として統合
  実装するのが効率的（新規モジュール不要）。
- **実装コスト**: 小（R1モジュールへの追加関数）。
- **鉄則リスク**: なし。観測B2指標のみ参照・表示層・較正不変。

---

## 提案一覧サマリ（表）

| # | 提案 | 元ネタの型 | 優先度 | コスト | 鉄則リスク |
|---|---|---|---|---|---|
| R1 | 週次/月次アナリストコラム（極端値・意外性の自動発掘） | ①極端値/⑦教育的権威型 | 高 | 小〜中 | 低 |
| R2 | 二軍の逸材データ紹介（ファームスポットライト） | ②意外性/⑤予言 | 高 | 中 | 低 |
| R3 | ブレイク予兆・regression警報 | ⑤予言 | 高 | 中 | 低 |
| R4 | percentileスライダー可視化（Savant風） | ③可視化 | 高 | 中 | なし〜低 |
| R5 | 球団史の名手級比較コメント | ⑥比較 | 中 | 小〜中 | 低 |
| R6 | スプレーチャート/EV-LA可視化 | ③可視化 | 中 | 中 | 低 |
| R7 | 「この一球/この登板」ハイライト文 | ①極端値/④物語接続 | 中 | 小 | なし |
| R8 | 月間隠れWPAリーダーカード | ②意外性/①極端値 | 低 | 小（R1に統合可） | なし |

---

## 特に推す上位3件

1. **R1（週次アナリストコラム）**: コストが最小（既存`playerBatting`/`playerPitching`の出力を
   そのまま使う・`coachReports.mjs`と同型の実装パターンが既に確立済み）にも関わらず、調査で
   最も繰り返し確認された型「①極端値の名指し」を直接実装する。DELTA/1.02の定期コラム、なんJの
   ランキング速報、FanGraphsのxwOBA乖離コラムいずれもこの型の反復であり、**投資対効果が最も
   高い**。ニュースタブという既存の受け皿（`weeklyDigest`）にそのまま載せられる点も実装障壁を
   下げている。

2. **R2（二軍の逸材データ紹介）**: ユーザーが例示した「今、二軍ではこの選手が面白いですよ！」を
   最も直接的に実現する提案。週刊ベースボールの二軍紹介記事・2軍成績.comの実例が示すように、
   二軍データの語りは日本の野球メディアで既に確立された人気ジャンルであり、かつ**本ゲームの
   三層構造（観測とスカウト等級の乖離を語れる）と設計思想レベルで完全に一致する**——他のどの
   ゲームメカニクス提案よりも「このゲームでしか出せない語り」になりうる。`market.mjs`の
   `farmPerfBonus`が既に同じデータパイプラインを内部利用している実績があり、実装リスクも低い。

3. **R4（percentileスライダー可視化）**: ユーザーが名指しで要求した可視化要素であり、
   Baseball Savantの"bubbles"がSNS上で議論の決め手として使われる実例が示す通り、
   **可視化そのものが語りの補助線になる**——R1/R2/R3のテキスト提案の説得力を底上げする
   横断的なインフラになる。実装は新規指標計算が不要（既存出力の百分位化のみ）で、デプロイ制約
   （能力値非表示）にも構造的に適合する（百分位は観測成績の相対順位であって能力値ではない）ため、
   鉄則リスクが最も低い提案の一つでもある。

---

## 出典まとめ（Part1 URL一覧）
- 赤味噌: https://number.bunshun.jp/articles/-/857623 / https://www.chunichi.co.jp/article/758572 / https://wikiwiki.jp/livejupiter/%E8%B5%A4%E5%91%B3%E5%99%8C
- 野球研究所: https://l-data-daily.com/
- お股ニキ: https://www.chunichi.co.jp/article/184664 / https://moonomt.com/about
- DELTA/1.02: https://1point02.jp/ / https://deltagraphs.co.jp/books/yokuwakarusabermetrics
- なんJデータスレ: https://note.com/light_bison1314/n/n7a46ec618a36 / http://nanj-matome.com/c/data
- Rob Friedman/PitchingNinja: https://en.wikipedia.org/wiki/Rob_Friedman_(baseball_analyst)
- Codify Baseball: https://www.mlb.com/video/fischer-on-codify-baseball
- Foolish Baseball: https://hypeauditor.com/youtube/foolish_baseball-UCbW12JIVAdi5NugdakbU33A/ / https://medium.com/@zcarver2303/how-foolish-baseball-is-changing-the-way-fans-see-the-game-0102c34bb86f
- Jomboy Media: https://www.fastcompany.com/91209377/inside-the-growing-sports-media-empire-where-the-business-is-all-fun-and-games / https://en.wikipedia.org/wiki/Jomboy_(sports_media)
- Baseball Savant percentile: https://www.mlb.com/news/baseball-savant-statcast-player-pages-new-look / https://baseballsavant.mlb.com/leaderboard/percentile-rankings / https://www.tdabaseball.com/post/how-to-analyze-a-hitter-s-baseball-savant-page
- FanGraphs xwOBA乖離コラム: https://fantasy.fangraphs.com/potential-2nd-half-breakouts-using-statcast-xwoba/ / https://fantasy.fangraphs.com/the-in-season-predictiveness-of-xwoba/ / https://fantasy.fangraphs.com/batter-xwoba-underperformers-overperformers-jun-2-2026/
- MLB Pipeline 20-80スケール: https://blogs.fangraphs.com/scouting-explained-the-20-80-scouting-scale/ / https://www.mlb.com/glossary/miscellaneous/scouting-grades
- 週刊ベースボール/2軍成績.com: https://sp.baseball.findfriends.jp/ / https://www.farm-stats.com/

## 参照（本リポジトリ内）
- `CLAUDE.md`（三原則・鉄則。特に鉄則3=三層構造・真値非開示、鉄則4=指標は後付けしない、鉄則8=生イベント非永続）
- `thyroxin/research/baseball_game_mechanics_research_20260723.md`（前回調査・Q1〜Q11の実装状況）
- `thyroxin/progress.md`（2026-07-23エントリ: Q1〜Q11のうちQ1/Q2/Q3/Q4/Q8/Q9/Q10/Q11の8本実装済み、
  Q5/Q6/Q7/Q12が未着手）
- `src/sim/metrics.mjs`（`playerBatting`/`playerPitching`/`playerBaserunning`＝本提案群の指標入力源）
- `src/sim/fielding.mjs`（`uzrComponents`＝守備成分の入力源）
- `src/model/statline.mjs`（観測成績の生カウント器の定義）
- `src/engine.mjs`（指標関数の公開API一覧）
- `src/game/coachReports.mjs`（Q2・半期split＋サンプル不足時沈黙という設計パターンの先例。
  R1/R3が踏襲すべきテンプレ）
- `src/game/market.mjs`（`farmPerfBonus`＝二軍観測データの評価パイプラインの先例。R2が流用すべき
  `farmLc`導出パターン）
- `src/game/gallery.mjs`（Q4/Q8・殿堂/記録アルバム。R5の参照点データ）
- `src/game/news.mjs`（`weeklyDigest`/`detectGameNotables`/`notableHeadline`＝R1/R7の表示先）
- `src/game/trust.mjs`（Q1・観測ベース3段階ラベル表示の先例）

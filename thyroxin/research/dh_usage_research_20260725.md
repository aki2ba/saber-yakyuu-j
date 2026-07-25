# 調査: 実球団はDH枠をどう運用しているか — 「DH専任スラッガーの育成・獲得」は本当に存在するのか

- 調査日: 2026-07-25
- 目的: 本ゲームが全リーグDH制へ統一したことを受け、「DH適性の評価・DH型選手の育成/市場値付け」をゲーム機構として追加する価値があるかを、現実の球団運用の裏取りによって判断する。
- スタンス: 先入観で肯定しない。「現実にはそんな運用はしていない」という結論も同格に扱う。

---

## 結論（先出しサマリー）

**「DH専任スラッガーを狙って育成・指名する」という概念は、NPB・MLBいずれの実務にもほぼ存在しない。** DHは「守備適性を使い切った後の着地点」（外国人スラッガー・実績ベテラン・故障明け・休養ローテの受け皿）として事後的に生まれる枠であり、ドラフトや育成の出発点として設計されるポジションではない。むしろ「DH専念＝守備価値ゼロ」はFA/トレード市場やドラフト評価において**明確なマイナス材料**として扱われている。

一方で、**DHを固定の専任1人ではなく複数選手で分担する「回し運用」、および休養ローテの受け皿としてのDH活用は、NPB・MLBともに典型的な実態**であり、これは本ゲームの起用AI（`usage.mjs`）の設計思想（担当制＋challenger share）とすでに方向性が一致している。

本ゲームは調査の結果、**すでに現実的な部分（fWAR式のDH位置補正 -17.5runs）を実装済み**であり、追加投資すべき新規ギャップは薄いと判断する（詳細は「本ゲームの現状とギャップ」参照）。

---

## 1. NPBパ・リーグのDH運用実態（2015-2025）

### 1.1 専任固定 vs 分担 — 分担が基本形

2025年パ・リーグ各球団のDH起用実態（検索で確認できた範囲）:
- ソフトバンク: 山川穂高（移籍後）を中心に、近藤・中村など複数選手が併用
- 日本ハム: レイエスが112試合とDHの主力だが、これは1シーズンでの数字であり全打席を専有しているわけではない
- 楽天: 外国人のフランコ・ボイト・ゴンザレスがそれぞれ90試合超を分担
- オリックス: 森・西川らが中心となるが単独専任ではない

2018年西武の例（DHが最も色分けされていた時期の一例）: 山川穂高が647打席（チーム3位の出場機会）、栗山巧が363打席（同7位）、メヒアが234打席で「DH専門」として登録——**1チーム内で3人以上がDH打席を食い合う**のが実態であり、1人が独占する構図ではない。

ソフトバンクではデスパイネが2017年〜2022年ごろまで主力DHとして複数年起用された例があり、こうした「助っ人スラッガーが数年にわたりDHの主軸を張る」パターンは存在する。しかし、これは「専任固定」というより「複数年にわたり打撃が最良だった選手が結果的にDH最多起用になり続けた」というだけで、シーズン内では併用先（1B兼任等）が常にいる。

### 1.2 起用される選手の属性

高校野球ドットコムの記事（セ・リーグDH制導入は本当にドラフトを変えるのか、というテーマ）は、**「パ・リーグのDHは外国人選手や実績組の起用がほとんど」**と明言している。つまり、DHは「新人・育成対象を最初からDH前提で使う枠」ではなく、「すでに実績のある助っ人・ベテランの着地点」として機能している、というのがNPB内部の共通認識である。

### 1.3 セ・リーグも2027年からDH制導入（本ゲームの意思決定と同時期の実例）

2025年8月4日、NPBはセ・リーグが2027年シーズンからDH制を採用すると正式発表した（1975年のパ・リーグ導入以来50年ぶりのルール統一）。榊原定征コミッショナーは「育成」「戦術」「観客満足度」全てにプラスと説明しているが、これは主に「打席機会の増加による若手・打撃専念選手の出場枠拡大」という文脈であり、「DH専任選手を育てる」という個別戦略への言及ではない。

### 1.4 学術的知見: DH制はチーム勝率にほぼ影響しない

名古屋大学大学院（清水詩乃・鈴木泰博准教授、2026年2月発表）は、NPB過去10年分のデータとWAR指標を用いて統計的に検証し、**「DH制の有無によるチーム勝率への影響はどのシーズンでもプラスマイナス1%以内」**、勝敗を分けるのは「チーム全体でどれだけWARを積み上げているか」の方だと結論づけている。DH制の有無自体は戦略的に大きな差を生む変数ではない、という外部エビデンス。

---

## 2. MLBユニバーサルDH後（2022-）の実態

### 2.1 専任DHは全体の少数派、しかも導入後さらに減少傾向

- 2022年（ユニバーサルDH元年）: 400打席以上をDHで記録した選手はNelson Cruz, Shohei Ohtani, J.D. Martinez, Giancarlo Stanton, Franmil Reyes, Yordan Alvarezの**6人**。30球団中6球団＝**20%程度**が「専任に近いDH」を置いていた計算。
- 2023年: 450打席以上のDHはわずか**4人**、110試合以上DH出場は**3人**（Ohtani, Ozuna, Meneses）にまで減少。ロースター26人枠拡大・DH機会倍増（両リーグ化）にもかかわらず、**専任DHはむしろ減少**した（The Ringer, 2024）。
- 2023年、ジャイアンツは1シーズンで**10人**、オリオールズは前年に**14人**をDHとして起用——「専任」からは程遠い分担運用が主流。
- 2023年のDH生産性上位4球団は「1人が55%以上のDH打席を占有」だったが、下位4球団は「誰も40%を超えない」——つまり**専任化するかどうかは「たまたま突出して打てる選手がいるか」の結果**であり、専任化自体を狙って作られる体制ではない。

### 2.2 DHの主な使い方は「休養ローテ」

複数の記事が一致して述べているのは、**多くの球団がDH枠を「4番手外野手や主力野手の半休（守備負担だけ抜いてバットは残す）」に使っている**という点。フルタイムの守備を免除しつつ打撃だけ出場させる、という「休養ローテの受け皿」がDHの主要な使われ方であり、「専任スラッガーの椅子」としての運用は一部の突出したチームに限られる。

---

## 3. 育成・獲得戦略としてのDH

### 3.1 ドラフト: 「DH前提指名」はほぼ存在しない

高校野球ドットコムの記事は「セ・リーグDH制導入で本当にドラフトは変わるのか」という問いに対し、**パ・リーグの実例（DHは外国人・実績組がほとんど）を根拠に懐疑的な見立て**を示している——ドラフト時点でDH前提の指名戦略が機能する余地は薄い、という趣旨。

MLBの2026年ドラフト評でも、守備適性を欠く強打の大学生選手について「守備がひどく、DHにしかなれないかもしれない。これは彼の総合評価にとって大きな打撃（body blow）であり、打撃で並外れていないと帳尻が合わない」といった扱われ方をしている。**「DH行き」は評価を押し上げる材料ではなく、押し下げるリスク要因**として語られており、「DH前提で育てる」戦略は確認できなかった。

### 3.2 FA/トレード市場: DH専念は明確な値引き材料

- **J.D. Martinez**: 「守備につけないことがFA市場で長期間売れ残った主な理由」と報じられている。2022年ドジャース1年$10M、2024年メッツ1年$12M（市場推定$15.4Mを下回る）と、**専念DH化が進むにつれ短期・値切り契約が定着**した。
- **Nelson Cruz**: 2022年ナショナルズと1年$15M契約後、成績低下に伴い2023年パドレスとは1年**$1M**まで急落。守備という「保険」を持たないDH専念選手は、成績が落ちた瞬間の市場価値下落が急激。

これはFanGraphsの位置補正（後述）が示す「DH=最も価値の低いポジション」という評価と整合的であり、**市場は現実にDH専念スラッガーを打撃力の割に安く値付けしている**。「DH型選手を積極的に高く獲得する」動きではなく、逆に「DHしかできない」ことがディスカウント要因になっている。

---

## 4. セイバー的な定説

### 4.1 ポジション調整: DHは守備スペクトラム最下位（-17.5 runs/162試合）

FanGraphsのfWAR計算式におけるポジション補正（162試合換算）:

| ポジション | 補正 (runs) |
|---|---|
| 捕手 | +12.5 |
| 遊撃手 | +7.5 |
| 二塁 | +2.5 |
| 中堅 | +2.5 |
| 三塁 | +2.5 |
| 左翼/右翼 | -7.5 |
| 一塁 | -12.5 |
| **DH** | **-17.5** |

理由: リーグ平均打撃の選手が守備につかないなら、それはreplacement level（代替可能水準）に近いという前提。守備位置スペクトラムの最下位に置かれる。

### 4.2 「DHペナルティ」: 守備につかない日の打撃低下（別概念）

ポジション補正とは別に、Tom Tango・Mitchel Lichtman・Andrew Dolphin（"The Book"）が提唱した**DHペナルティ**という実証的知見がある: **同じ選手でも、DHとして出場した試合は守備につきながら出場した試合よりwOBA換算で約17ポイント（約4-5%）低い**。原因は「試合への身体的・精神的な関与度の低さ」と推測されている（守備で試合に関与し続けるほうがリズムを保ちやすい、という仮説）。Phil Birnbaumのブログ（2019）がこの効果を再確認している。

ただし正直に付記すると、SABR（Mains, 出典タイトルのみ確認）には「消えていったDHペナルティ」という趣旨の記事も存在し、**効果量が時代によって変動している可能性**が示唆される。したがって「一貫して常に4-5%」と断定するにはやや注意が必要な、係数が不確実な効果と見るべき。

---

## 5. 本ゲームの現状とギャップ

`src/sim/usage.mjs`・`src/sim/team.mjs`・`src/sim/war.mjs`・`src/model/positions.mjs`・`src/game/market.mjs` を確認した。

- **`POSITION_ADJUST_PER_162G.DH = -17.5`**（`src/model/positions.mjs`）: FanGraphsの値と完全一致。DHが守備スペクトラム最下位という定説（§4.1）は**すでに正しく実装済み**。
- **`buildDepthChart`（`src/sim/team.mjs`）**: 編成時、8守備ポジションを埋めた残り野手のうち`hitScore`最大の選手をDHに割当てる。これは「守備適性を狙って捨てた選手」ではなく「単純に一番打てる余り者」というロジックだが、結果として現実の「守備できない強打者がDHに回る」の近似にはなっている。
- **`usage.mjs`の`selectLineup`**: DHは`chart.positionRank`ではなく全野手プール（`fielders`）から選ばれ、`assign.DH`にも他ポジション同様regular/challenger/shareの担当制が適用される。**DHを「専任固定」ではなく緩やかな担当制＋見直しで回す**、という設計方向性は§1.1・§2.2で確認した現実の「回し運用」と整合的。
- **`effEval`（`defWobaAt`）**: DHは守備0点固定であり、DHペナルティ（§4.2の「守備につかない日の打撃低下」）は一切モデル化されていない。
- **休養の実装**: 現状は「休養＝完全ベンチ（`resting.add(pid)`）」であり、現実の主要パターンである「守備の主力を休ませつつDH枠にスライドさせてバットは残す」という運用（§2.2）は反映されていない。DHは他ポジションと並列の独立枠として扱われ、他ポジションの休養選手の受け皿にはなっていない。
- **`market.mjs`**: DH固有の評価ロジックは見当たらない（grep 0件）。おそらくWARベースの評価に一本化されており、`war.mjs`のposAdj経由で間接的に「DH専念選手は同じ打撃でも査定が下がる」効果が反映されていると推測される（明示的な追加ロジックはなし）。

---

## 6. 提言: B-7（DH適性評価・起用AI・市場値付け）は何をやる価値があるか

### 入れない方がよい（現実に根拠が無い/薄い）

1. **「DH専任育成」という概念そのもの**（DH前提のドラフト指名、DH適性を伸ばす専用育成パス等）: §3.1の通り、現実にこの戦略は確認できず、むしろ「DH行き」はネガティブな評価材料。ゲームにこの機構を入れると実態と逆方向の学習をユーザーに与える。**入れる価値なし。**
2. **DHペナルティ（日次打撃低下）の新規ノブ化**: §4.2の通りエビデンスはあるが効果量が時代依存で議論含み。一球粒度シムに「その日DHかどうか」で成績を上下させる追加ノブを入れるコスト（較正リスク増）に見合う根拠の強さがない。**優先度低・見送りが妥当。**
3. **`market.mjs`へのDH専用値引きロジックの新設**: すでにWAR/posAdj経由で-17.5runsが間接的に効いている可能性が高く、屋上屋になるリスク。まずは現状のWARベース評価で十分と判断できる。

### すでに妥当・維持でよい

4. **`positions.mjs`のDH位置補正-17.5runs**: FanGraphsの定説と一致。**変更不要、維持。**
5. **`usage.mjs`のDH担当制（regular/challenger/share）**: 「専任固定ではなく複数選手で緩やかに分担」という現実の運用（§1.1・§2.1）と方向性が一致。**変更不要。**
6. **`buildDepthChart`の「余り者の中で一番打てる選手をDHに」ロジック**: 「守備を使い切った選手がDHに着地する」という現実の構図（§1.2・§3.1）の妥当な近似。**変更不要。**

### 手を入れる価値が（小さいが）ある候補

7. **休養ローテのDHスライド**: 現状「休養＝完全ベンチ」だが、現実の主要パターン（§2.2）は「守備免除だがバットは残す＝DH枠に回す」。`usage.mjs`の休養ロジックを「他ポジションの休養選手をDH候補プールに合流させる」よう軽く拡張する余地はある。ただし三原則③（やきゅつく的な楽しさ）への寄与は薄く、地味な内部ロジック精緻化に留まるため、**優先度は低いが、着手するなら実装コストも小さい**、という位置づけ。

### 総括

DH関連で「本当にやっているか疑わしい」ユーザーの直感は正しい。**「DH専任スラッガーの育成・獲得」は現実の球団運用として裏取りできなかった**（むしろ逆方向のエビデンスが複数見つかった）。一方、本ゲームがすでに実装しているDH位置補正・担当制ローテーションは現実の運用実態と整合しており、**B-7として新規に大きな機構を足す必要性は薄い**。唯一検討に値するのは「休養時にDH枠へスライドさせる」という小さな挙動改善だが、これも三原則②（近似の精度）への寄与としては限定的であり、緊急度は低い。

---

## 出典

- [2025シーズン ホークスDH戦線と若手野手｜やっさん (note.com)](https://note.com/kkkunderhand/n/n544e23197a7f)
- [1 日本プロ野球のリーグ格差是正可能性 ～ドラフト会議とDH制度が生み出すリーグ間の実力差～ (高知工科大学)](https://www.kochi-tech.ac.jp/library/ron/pdf/2018/03/15/a1190470.pdf)
- [山川穂高 個人年度別成績 (NPB.jp)](https://npb.jp/bis/players/21425139.html)
- [Ａ．デスパイネ 個人年度別成績 (NPB.jp)](https://npb.jp/bis/players/03505139.html)
- [セ・リーグDH制導入で本当にドラフトは変わるのか？ パ・リーグDHは外国人や実績組の起用がほとんど (高校野球ドットコム)](https://www.hb-nippon.com/articles/8539)
- [「セントラル・リーグ 2027年シーズンからの指名打者制（DH制）採用決定」のお知らせ (NPB.jp)](https://npb.jp/news/detail/20250804_05.html)
- [「セ・リーグDH制採用（2027年シーズンより）」に対する榊原定征コミッショナーのコメント (NPB.jp)](https://npb.jp/news/detail/20250804_06.html)
- [日本プロ野球の「DH制」はチームの勝率に影響しない～WAR指標を用いた10年分のデータで統計的に検証～ (名古屋大学)](https://www.nagoya-u.ac.jp/researchinfo/result/2026/02/dhwar10.html)
- [同上 プレスリリースPDF (名古屋大学)](https://www.nagoya-u.ac.jp/researchinfo/result/upload_images/20260210_i.pdf)
- [野球の「DH制」はチームの勝率には大きく影響しない 名古屋大学大学院 (Yahoo!ニュース／テレビ朝日系ANN)](https://news.yahoo.co.jp/articles/3e3eada989b339acf79400ee0dd9335b6162a8d2)
- [MLB Commissioner: Universal Designated Hitter Coming in 2022 (InsideHook)](https://www.insidehook.com/sports/mlb-commissioner-universal-designated-hitter-2022-season)
- [nl teams with best dh production in 2022 (MLB.com)](https://www.mlb.com/news/nl-teams-with-best-dh-production-in-2022)
- [The DH Is Universal, but Good DHs Are Rare (The Ringer, 2024)](https://www.theringer.com/2024/03/29/mlb/mlb-designated-hitters-universal-dh-decline)
- [Baseball Therapy: The Timeshare DH (Baseball Prospectus)](https://www.baseballprospectus.com/news/article/25107/baseball-therapy-the-timeshare-dh/)
- [Position Adjustments (FanGraphs Sabermetrics Library)](https://blogs.fangraphs.com/position-adjustments/)
- [The MVP and the DH Adjustment (FanGraphs)](https://blogs.fangraphs.com/the-mvp-and-the-dh-adjustment/)
- [WAR for Position Players (FanGraphs Sabermetrics Library)](https://library.fangraphs.com/war/war-position-players/)
- [Evidence confirming the DH "penalty" (Phil Birnbaum, Sabermetric Research, 2019)](http://blog.philbirnbaum.com/2019/09/evidence-confirming-dh-penalty.html)
- [Mains: The designated hitter penalty that went away (SABR)](https://sabr.org/latest/mains-the-designated-hitter-penalty-that-went-away/)
- [J.D. Martinez contract: Former Dodgers DH signs 1-year deal with Mets (True Blue LA)](https://www.truebluela.com/2024/3/21/23938148/jd-martinez-mets-contract)
- [J.D. Martinez Contract Details, Salaries, & Earnings (Spotrac)](https://www.spotrac.com/mlb/los-angeles-dodgers/jd-martinez-8690/)
- [Nelson Cruz reaches 1-year, $15M deal with Washington Nationals (ESPN)](https://www.espn.com/mlb/story/_/id/33497939/nelson-cruz-reaches-1-year-deal-washington-nationals-source-says)
- [Nelson Cruz, Padres Reportedly Agree to 1-Year Contract in MLB Free Agency (Bleacher Report)](https://bleacherreport.com/articles/10037300-nelson-cruz-padres-reportedly-agree-to-1-year-contract-in-mlb-free-agency)
- [Nelson Cruz | MLB Contracts & Salaries (Spotrac)](https://www.spotrac.com/mlb/player/_/id/5398/nelson-cruz)

### 本ゲーム内で参照したファイル（コード変更なし・確認のみ）
- `/home/user/saber-yakyuu-j/src/sim/usage.mjs`（DH起用ロジック: L27-94, L280-371）
- `/home/user/saber-yakyuu-j/src/sim/team.mjs`（`buildDepthChart`のDH割当: L140-204）
- `/home/user/saber-yakyuu-j/src/sim/war.mjs`（`posAdjRuns`: L17-31）
- `/home/user/saber-yakyuu-j/src/model/positions.mjs`（`POSITION_ADJUST_PER_162G.DH = -17.5`: L5-36）
- `/home/user/saber-yakyuu-j/src/game/market.mjs`（DH固有ロジックはgrep 0件）
- `/home/user/saber-yakyuu-j/src/config.mjs`（全リーグDH制化に伴う較正コメント各所）

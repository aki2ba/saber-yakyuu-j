# 走塁指標リファレンス（一次情報ベース）

作成: 2026-07-10 / 調査手法: deep-research（fan-out検索 → 一次情報fetch → 3票の敵対的検証 → 合成）を2ラウンド
（1ラウンド目=BsR/wSB/UBR/Sprint Speed/Statcast Baserunning Run Value/B-Ref Rbaser・Rdpの基礎確定、
　2ラウンド目=wGDP式・Baseball Prospectus・NPB(1point02.jp)・XBT%・損益分岐点・Statcast追加指標を狙い撃ち）

このドキュメントは **`src/sim/metrics.mjs` の `playerBaserunning` / `src/sim/game.mjs` の `resolveAdv`・`attemptSteal` /
`src/config.mjs` の `tuning.run`・`tuning.gdp`・`tuning.steal` を検証・改修するための正典**である。
実装を変える前に必ずここを参照し、**出典のない数値をコードに書かない**こと。
`fielding_metrics_reference.md` §0/§7 の走塁節を置き換え・拡張する形で独立ファイル化した。

---

## 0. 出典のティア定義（`fielding_metrics_reference.md` §0 と同一基準）

| ティア | 定義 | 該当 |
|---|---|---|
| **一次/権威** | 指標の考案者・公表主体そのもの | FanGraphs Library、FanGraphs blog（MGL/Tango本人）、MLB.com Statcast Glossary、Baseball Savant、Baseball Prospectus glossary/記事、Baseball-Reference の説明ページ、1point02.jp（DELTA/データスタジアム）、NPB.jp 公式 |
| **二次** | 一次情報を解説する専門媒体 | 専門記事・書籍・報道 |
| **未検証** | 個人ブログ・まとめサイト | 数値の根拠にしない |

各主張には検証状況を付す。`[3-0]` は敵対的検証で3票中3票が「反証できず」、`[2-1]`は多数決で生存、
`[確認できず]`は複数回の調査でも一次情報が見つからなかったもの。

---

## 1. BsR（Base Running Runs Above Average）

### 1.1 定義・成分 `[3-0 / 一次]`

FanGraphs の走塁総合指標。WAR の走塁成分。

> "BsR = wSB + UBR + wGDP"
> "It is the combination of Weighted Stolen Base Runs (wSB), Weighted Grounded Into Double Play Runs (wGDP), and Ultimate Base Running (UBR)"
> "BsR is simply wSB, UBR, and wGDP added together with no further adjustments."

- 出典: https://library.fangraphs.com/offense/bsr/ （一次）
- 出典: https://library.fangraphs.com/offense/off/ （一次・同一式で独立確認）
- 出典: https://library.fangraphs.com/war/war-position-players/ （一次・WAR定義ページでも同一式）

UBR/wGDP は **Mitchel Lichtman（MGL）** が考案し FanGraphs に提供した指標。
> "UBR and wGDP are statistics developed by Mitchell Lichtman and provided to FanGraphs."

wGDP が3成分目として追加された正確な年は本調査では**確認できず**（複数の検証エージェントが
背景知識として「2016年頃」に言及したが、専用クレームとして一次情報で3票検証されたものではない＝参考情報止まり）。

### 1.2 解釈目安表 `[3-0 / 一次]`

| 評価 | BsR |
|---|---|
| Excellent | **+8** |
| Great | +6 |
| Above Average | +2 |
| Average | 0 |
| Below Average | −2 |
| Poor | −4 |
| Awful | −6 |

- 出典: https://library.fangraphs.com/offense/bsr/ （一次）

**注意（敵対的検証で判明した誤読リスク）**: この表は「解釈のためのルールオブサム（大まかな目安）」であり、
「フルシーズンの実測レンジそのもの」ではない。実際、B-Ref の Rbaser 実測値（§8.4）では
Ian Kinsler が2011年に **+8.0**（B-Refの走塁定義でwGDP相当のRdpを含まない値）を記録している一方、
FanGraphs 側の BsR（wGDP込み）は年によってこれを上回りうる。
「最高の走者でも年+8〜10 run が上限」という通説は、**この目安表そのものではなく実分布（§8.4）を根拠にすべき**。

---

## 2. wSB（Weighted Stolen Base Runs）

### 2.1 完全な式 `[3-0 / 一次]`

> "wSB = (SB * runSB) + (CS * runCS) – (lgwSB * (1B + BB + HBP – IBB))"
> "lgwSB = (SB * runSB + CS * runCS) / (1B + BB + HBP – IBB)"

- 出典: https://library.fangraphs.com/offense/wsb/ （一次）

`lgwSB` の分母 `1B + BB + HBP − IBB` は「一塁に到達した回数」＝盗塁機会の近似。
これに選手自身の機会数を掛けてリーグ平均基準を作り、選手の実際の wSB から差し引いて中心化する
（リーグ総和 wSB ≈ 0）。

### 2.2 run 値の定数 `[3-0 / 一次]`

| 定数 | 値 | 可変性 |
|---|---|---|
| `runSB`（盗塁成功の得点価値） | **+0.2** | **全シーズン固定** |
| `runCS`（盗塁死の得点価値） | **−(2 × RunsPerOut + 0.075)** | **シーズンごとに可変** |

> "the run value of a stolen base is set at .2 runs for all seasons."
> "runCS = – (2 x RunsPerOut + 0.075)"
> "Runs Per Out is simply runs scored in the season divided by outs in the season."

- 出典: https://library.fangraphs.com/offense/wsb/ （一次）

RunsPerOut = そのシーズンの総得点 ÷ 総アウト数。得点環境が高いほど `|runCS|` が大きくなる
（＝盗塁死のコストが上がる）。2014年の実例では RunsPerOut≈0.151 で `lgwSB≈0.00377`。

---

## 3. UBR（Ultimate Base Running）

### 3.1 定義・スコープ `[3-0 / 一次]`

> "Ultimate Base Running (UBR) is a component FanGraphs uses to account for the value a player adds to their team via base running on non-stolen base plays."
> "UBR does not account for stolen bases and caught stealings, which are dealt with by wSB."

盗塁・盗塁死は含まない（wSB の管轄）。**独立変数は「結果（進塁したか / アウトになったか）」** であり、
打球速度や守備者の肩は UBR の直接の入力ではない（結果として現れた進塁・アウトを RE で評価する）。

- 出典: https://library.fangraphs.com/offense/ubr/ （一次）

### 3.2 算出方法 `[3-0 / 一次]`

各プレーの**実際の期待得点変化**を、その塁-アウト状況×打撃イベント種別における**リーグ平均の期待得点変化**
と比較した差分で評価する。

> "you take the actual run expectancy change relative to the average run expectancy change for that event"

ワークト例: 二塁走者の単打時、平均的な進塁が+0.7とき、生還して+0.9になったら走者に+0.2。

> "No matter the year, this statistic will always have zero UBR as league-average."

### 3.3 解釈目安表 `[3-0 / 一次]`

| 評価 | UBR |
|---|---|
| Excellent | **+6** |
| Great | +4 |
| Above Average | +1.5 |
| Average | 0 |
| Below Average | −1.5 |
| Poor | −4 |
| Awful | −6 |

- 出典: https://library.fangraphs.com/offense/ubr/ （一次）

---

## 4. wGDP（Weighted Grounded Into Double Play Runs）

### 4.1 GDP機会の定義 `[3-0 / 一次]`

> "If a player is in 20 double play opportunities (man on first, less than two outs) and never hits into a double play, he is more valuable than a player who hits into five double plays..."

**GDP機会 = 「走者一塁・2アウト未満」の打席**であり、**ゴロを打った打席に限定されない**。
ゴロに限定されるのは分子（GIDPとしてカウントされる条件）の方であり、機会（分母）はゴロ以外も含む。

> "wGDP does not include line drive double plays"（この一文はGIDPの**結果**からライナー併殺を除外する規定であり、
> 機会の定義をゴロに絞る規定ではない）

- 出典: https://library.fangraphs.com/offense/wgdp/ （一次・複数回の独立WebFetchで逐語一致）

### 4.2 算出方法 `[3-0 / 一次]`

> "To find a player's wGDP, we take the average rate of GDP in GDP opportunities and apply it to the number of opportunities the player had. If they have fewer than average GDP, they get a bonus and if they have more, we take runs away."
> "The actual calculation involves subtracting the run value of the extra out. The player is already charged for the out they make themselves, but this now charges them for getting the base runner out as well."

（訳）リーグ平均のGDP発生率を選手の機会数に適用し、平均より少なければ加点・多ければ減点。
実際の計算は「余分なアウト（走者もアウトになった分）」の run 価値を差し引く方式。

**FanGraphs は明示的な係数（B-Ref の Rdp が使う .44 のような単一 run/DP 値）を一切公表していない。**
ページ本文の数値は例示（20機会・5併殺）と評価目安表のみ（§4.3）。

- 出典: https://library.fangraphs.com/offense/wgdp/ （一次。全文verbatim取得を含む複数回の独立フェッチで係数非公開を確認）

### 4.3 解釈目安表 `[3-0 / 一次]`

> "The numbers will bounce around year to year, but generally the range of wGDP looks like this:"
> "The range is generally pretty small."

| 評価 | wGDP |
|---|---|
| Excellent | **+2** |
| Great | +1.5 |
| Above Average | +1 |
| Average | 0 |
| Below Average | −0.5 |
| Poor | −1 |
| Awful | **−2.5** |

- 出典: https://library.fangraphs.com/offense/wgdp/ （一次）

**注意（敵対的検証で判明した誤読リスク）**: 「実測レンジは −2.5〜+2」という解釈は**過大解釈として2件が反証された**。
この表は BsR/UBR/WAR 同様の**主観的なルールオブサム**（区分の目安）であり、実測の最小最大値ではない。
反証の根拠として、FanGraphs 自身のブログが Billy Butler の単年 wGDP **−4.0（2013）/ −4.2（2015）**を報告している
（"The Surprising Double-Play Machine" 記事、blogs.fangraphs.com）。**目安表の外側（特に負方向）に実測値が出うる。**

### 4.4 現行実装との整合性

`src/sim/metrics.mjs` の `wGDP = (lgGDPrate × gdpOpp − gdp) × |runGDP|` は、
「リーグ平均GDP率を機会数に適用し、実際のGDPとの差を run 換算する」という §4.2 の哲学と**構造的に一致**している。
一方 `src/sim/game.mjs:729` は `gdpOpp` を **`bType === 'GB'`（ゴロ）の打席に限定**してインクリメントしており、
§4.1 で確認した「機会はゴロに限定されない」という原典の定義と異なる（詳細は §12.3）。

---

## 5. 盗塁の損益分岐成功率（Break-Even Stolen Base Success Rate）

### 5.1 一次情報の値 `[3-0 / 一次]`

> "on average, you need to steal successfully about two-thirds of the time to be positively impacting your team"
> "stolen bases are good, but being caught on the bases has a larger negative impact"
> "Stealing 40 bases while being caught 25 times is not as valuable as stealing 20 bases and being caught twice"

- 出典: https://library.fangraphs.com/offense/bsr/ （一次）

wSB ページも整合する定性的目安を示す:

> "you want to have at least twice as many SB as CS to break even, but that number bounces around based on the run environment"

- 出典: https://library.fangraphs.com/offense/wsb/ （一次）

**確定できるのは「約2/3（≈66.7%）」という一次情報の言明のみ。**
「67〜75%」という幅は**敵対的検証で2件が反証**した — 75%側の上限は The Book（Tango/Lichtman/Dolphin）や
FanGraphsブログ別記事（blogs.fangraphs.com/breaking-down-stolen-base-break-even-points/）由来の数値であり、
`library.fangraphs.com/offense/bsr/` 自体が述べている数値ではない（出典の混同＝過大帰属として棄却）。

### 5.2 線形加重からの代数的導出（本ドキュメントの計算・一次情報の直接記述ではない）

wSB の期待値がゼロになる点として損益分岐点を定義すると:

```
p × runSB + (1 − p) × runCS = 0
p = |runCS| / (runSB + |runCS|)
```

`runSB=0.2` 固定・`runCS=−(2×RunsPerOut+0.075)` を代入すると、`fielding_metrics_reference.md` §7.2 に既出の
実例（2016年 runCS≈−0.41、2014年 runCS≈−0.377）を使えば:

| 年 | runCS | 損益分岐点 |
|---|---|---|
| 2014 | −0.377 | 0.377/(0.2+0.377) ≈ **65.4%** |
| 2016 | −0.41 | 0.41/(0.2+0.41) ≈ **67.2%** |

いずれも一次情報の「約2/3」と整合する。**得点環境（RunsPerOut）が高いほど `|runCS|` が大きくなるため、
損益分岐点は上がる**（これは式からの演繹であり、一次情報が直接「得点環境依存の方向」を明言しているわけではない
— wSBページの "bounces around based on the run environment" が定性的に示唆するのみ）。

### 5.3 確認できなかったこと `[確認できず]`

- 塁上・アウトカウントごと（RE24状態遷移）の損益分岐点変動 — FanGraphs/Tango が線形加重ではなく
  状況別RE24から損益分岐点を出している一次記述は見つからなかった
- MLB公式（Statcast）が算出する「Steal Success Probability」モデルの損益分岐点との対応関係

---

## 6. Statcast の走塁指標

### 6.1 Sprint Speed / Bolt `[3-0 / 一次]`

> "Introduced during the 2017 season, Sprint Speed is a Statcast metric that aims to more precisely quantify speed by measuring how many feet per second a player runs in his fastest one-second window."
> "Approximately seven full-effort strides can be captured over the course of a one-second window."
> "The Major League average on a 'competitive' play is 27 ft/sec, and the competitive range is roughly from 23 ft/sec (poor) to 30 ft/sec (elite)."
> "Any run with a Sprint Speed of at least 30 ft/sec is known as a Bolt."

季節平均は「適格走塁（qualified runs）」上位約2/3の平均。適格走塁は次の2カテゴリ:
1. 本塁打以外で2塁以上進んだ走塁（長打時に2塁から進んだ走塁は除外）
2. 弱い打球（topped/weakly hit）での本塁→一塁走塁

- 出典: https://www.mlb.com/glossary/statcast/sprint-speed （一次）
- 出典: https://baseballsavant.mlb.com/leaderboard/sprint_speed （一次）
- 出典: https://www.mlb.com/glossary/statcast/bolt （一次）

**ポジション別平均は確認できず。**

### 6.2 Home to First / 90-foot Running Splits `[3-0 / 一次]`

> "Home to First readings measure the time elapsed from the point of bat-on-ball contact to the moment the batter reaches first base."
> "While Sprint Speed incorporates runs of two bases or more on non-homers... and home-to-first runs on 'topped' or 'weakly hit' balls, a player's 90-foot splits only include the latter."

- 出典: https://www.mlb.com/glossary/statcast/home-to-first （一次）
- 出典: https://www.mlb.com/glossary/statcast/90-foot-running-splits （一次、Wayback Machine経由確認）

**右打者/左打者別のリーグ平均値は確認できず。**

### 6.3 Baserunning Run Value（Runner Runs）/ Basestealing Run Value `[3-0 / 一次]`

Statcastの走塁総合指標。盗塁と非盗塁進塁を通じた走者価値を run で表す。

> "A Statcast metric designed to express the overall value of a baserunner, measured in runs created (or lost) via stealing bases and taking extra bases on the basepaths"
> "Each steal opportunity is assigned a probability of being successful or not, based on the pitcher and catcher... a stolen base or advance via a balk worth +0.2 runs... a caught stealing or pickoff worth -0.45 runs"
> "For non-steal baserunning plays, an estimated success probability is generated... using inputs that include runner speed, outfielder throwing arm, runner position on the basepaths and outfielder distance from both the ball and the bases... whether the runner successfully takes the extra base, is thrown out or does not attempt to advance (holds)"

（訳）盗塁機会ごとに対戦投手×捕手ベースの成功確率を付与し、成功（盗塁/ボーク進塁）=+0.2、
失敗（盗塁死/牽制死）=−0.45 を run 換算。非盗塁進塁は走者速度・外野手の肩・走者の塁上位置・
外野手のボール/塁への距離から成功確率を推定し、実際の結果（進塁/刺殺/自重）との差を累積する。

- 出典: https://baseballsavant.mlb.com/leaderboard/baserunning-run-value （一次）
- 出典: https://baseballsavant.mlb.com/leaderboard/basestealing-run-value （一次）
- 出典: https://www.mlb.com/glossary/statcast/baserunning （一次）

例: Trea Turner 2016-24 通算 +55runs（内訳 盗塁28run + 追加進塁27run）。

**注目**: この確率モデルの入力（走者速度・外野手の肩・距離）は、`fielding_metrics_reference.md` §11.2 の
Distance-Time モデル（守備側の Statcast OAA）と**同じ設計思想**。現行シムの守備は既にこのモデルへ移行済みだが
（§12.4）、走塁側（`resolveAdv`）はまだ単純ロジスティック（速度+IQ+相手肩）であり、幾何モデルではない。

### 6.4 確認できなかった追加指標 `[確認できず]`

- Lead Distance / Secondary Lead / Jump（2023年以降にBaseball Savantが公開したとされる新指標）の正式な定義
- Steal Success Probability モデルの入力詳細（Basestealing Run Value の背後にあるモデルと同一かは不明）
- UBR / BsR / Sprint Speed の年度間相関（year-to-year correlation）と、信頼性に必要な機会数

---

## 7. Baseball Prospectus の走塁指標

### 7.1 レガシー体系: BRR = GAR + SBR + AAR + HAR + OAR `[2-1 / 一次]`

> "BRR breaks down baserunning into five components based on advancements on stolen bases (SBR), non-hit balls on the ground (GAR), non-hit balls in the air (AAR), hits (HAR), and other advancement opportunities (wild pitches, passed balls, balks—OAR)."

- 出典: BP記事 "Overthinking It: How the Mets Got Great (at Taking the Extra Base)"（baseballprospectus.com, article 21474）（一次）

5成分の内訳（BP公式サイトの Anubis ボット対策で直接 glossary ページの逐語確認は一部困難だったため、
以下は複数の一次記事・アーカイブから再構成）:

| 成分 | 定義 | 出典 |
|---|---|---|
| **SBR**（EqSBR） | 盗塁企図・牽制死を multi-year Run Expectancy matrix で評価。固定run値ではなく状況依存 | Wayback Machine保存のBP legacy glossary `[一次]` |
| **GAR**（Ground Advancement Runs） | 非打球=ゴロアウトでの走者進塁を評価 | BP記事 "Schrodinger's Bat: The Whole, the Sum, and the Parts" `[medium]` |
| **AAR**（Air Advancement Runs） | 一塁走者(二三塁空き)・二塁走者(三塁空き)・三塁走者、いずれも2アウト未満で外野が捕球したライナー/ポップ/フライでの進塁を評価。**先頭走者のみ対象** | BP原論文 "Schrodinger's Bat: An Air of Advancement"（article 5346）`[一次]` |
| **HAR**（Hit Advancement Runs） | 単打での1塁→・2塁→進塁、二塁打での1塁→進塁を評価。park補正あり、multi-year RE Matrix ベース | BP glossary（間接確認・r.jina.ai reader経由）`[medium]` |
| **OAR**（Other Advancement Runs） | 暴投・捕逸・ボークでの進塁 | BP記事21474（上記引用に含まれる） `[一次]` |

> EqSBR: "Equivalent Stolen Base Runs. The number of theoretical runs contributed by a baserunner or baserunners above what would be expected given the number and quality of their baserunning opportunities. EqSBR is based on a multi-year Run Expectancy matrix and considers both stolen base attempts and pick-offs."

- 出典: Wayback Machine（2017-09-17アーカイブ）保存の BP legacy glossary `?mode=viewstat&stat=470` （一次）

### 7.2 【重要】2024〜2025年に指標体系が刷新された `[2-1 / 一次]`

> "Our overarching running metric is split into two categories: DRBa, which reflects the value of a runner after contact, and DRBn, their value when there's no contact, namely, stealing and advancing on passed balls."

- 出典: https://www.baseballprospectus.com/news/article/97926/bp-announcements-an-exciting-update-to-our-leaderboards/ （2025-04-24公開・一次）

BP は走塁を **DRBa**（接触後の進塁価値＝GAR/AAR/HARに相当）と **DRBn**（非接触＝盗塁・パスボール進塁、
SBR/OARに相当）の**2分類へ移行**した。DRC+ の説明ページ自体には走塁指標の詳細説明はなく、
「Baserunning Leaderboard」へのリンクのみ。

> DRC+ページを2回直接WebFetchした結果、"neither pass found any mention of BRR, EqBRR, or components (GAR/SBR/AAR/HAR/OAR)"

- 出典: https://www.baseballprospectus.com/drc-deserved-runs-created/ （一次）

DRBa/DRBn の概念自体は2025年4月の記事が初出ではなく、2024年2月の "Modeling the Bases" 記事で
先行導入されていた形跡がある。**GAR/OAR の名称が現在も公式に使われているか（廃止されたか）は完全には確認できず。**

### 7.3 確認できなかったこと `[確認できず]`

- BRR が本当に GAR+SBR+AAR+HAR+OAR の**単純合計**か（式そのものは1件のBP記事で確認できたが、
  重み付けや正規化の有無は未確認）
- DRBa/DRBn の具体的な算出式
- BP指標のNPB版・日本語一次情報での言及

---

## 8. Baseball-Reference の Rbaser / Rdp

### 8.1 Rbaser（走塁 runs） `[3-0 / 一次]`

> "Baserunning runs come from two places: Stolen Bases and Caught Stealing runs as calculated above for wRAA... and Non-Basestealing baserunning which includes items like 1st to 3rd on singles, outs on the bases, tagging up on fly balls, scoring from third on a ground ball"
> "This explanation describes the techniques used to estimate non-SB/CS baserunning contributions during the play-by-play era, 1931 to the present."

- 出典: https://www.baseball-reference.com/about/war_explained_position.shtml （一次。直接WebFetchは403のためWayback Machine経由で確認）

2成分:
1. **盗塁/盗塁死のrun**（wRAAの線形加重枠組みで算出。打撃Rbatから分離して走塁に計上）
2. **非盗塁走塁**（単打での1→3塁、走塁死、犠飛でのタッグアップ、ゴロでの3塁からの生還等）— **1931年以降のプレーバイプレー時代のみ推定可能**

### 8.2 Rdp（併殺回避得点） `[3-0 / 一次]`

> "The difference in runs scored between a double play and a double play avoided is, on average, .44 runs."
> "R_gidp = .44 x ( GIDP_OPPS_player * GIDP_RATE_lg - GIDP_player )"

- 出典: https://www.baseball-reference.com/about/war_explained_position.shtml （一次）

**B-Ref は1併殺あたり run 値として `.44` を明示的に公表**（FanGraphs wGDP は非公開・§4.2）。
Rbaser とは別建ての会計。

### 8.3 実分布（フルシーズン・2011年）`[3-0 / 一次]`

| 指標 | 最高 | 最低 |
|---|---|---|
| Rbaser | **+8.0**（Ian Kinsler） | −5.5（Andre Ethier） |
| Rdp | **+4.7**（Johnny Damon） | −4.8（Albert Pujols） |

これが「最高の走者でも年+8〜10 run が上限」という通説の**実データ裏付け**（§1.2の目安表ではなく実測値）。

---

## 9. NPB の走塁指標（1point02.jp / DELTA）

### 9.1 UBR の定義 `[3-0 / 一次]`

> 「盗塁、盗塁死を除く走塁での貢献を得点化した指標。リーグの平均的な走者と比べてどれだけ多く走塁で得点を生み出したかを表す。」

- 出典: https://1point02.jp/op/gnav/glossary/gls_explanation.aspx?eid=20048 （一次）

FanGraphsのUBR定義（§3.1）と概念的に一致。

### 9.2 【重要】1point02.jp の BsR は2成分のみ = UBR + wSB（wGDP を含まない） `[3-0 / 一次]`

> 「当サイトではUBRとwSBの合算値をBsR(Base Running)として、走塁の総合評価値としている。」

- 出典: https://1point02.jp/op/gnav/glossary/gls_explanation.aspx?eid=20048 （一次。340KBのページ全文を走査し wGDP の出現0件を確認済み）

**FanGraphsの3成分（UBR+wSB+wGDP、§1.1）とは異なり、1.02はwGDPをBsRに含めていない。**
NPB向けに実装する場合、どちらの定義に寄せるか（あるいは両方を別掲するか）は設計判断が必要（§13）。

### 9.3 盗塁の定性的評価 `[3-0 / 一次]`

> 「盗塁については成功の利得よりも失敗の損失が大きく成功率を考えると活用する意義に乏しいこと」

- 出典: https://1point02.jp/op/gnav/glossary/gls_explanation.aspx?eid=20013 （一次。RE24解説ページ）

このページには具体的な run 値（0.20/−0.40相当）の記載はない。**盗塁のrun値（既存正典
`sabermetrics_glossary.md` §6.2）は別ページ**（https://1point02.jp/op/gnav/glossary/gls_explanation.aspx?ecd=204&eid=20049 、
「盗塁得点は通常0.20前後、盗塁死得点は−0.40前後」）が根拠であり、本ラウンドでも既存記述と矛盾しない。

### 9.4 確認できなかったこと `[確認できず]`

- NPBのリーグ平均: 1球団あたり年間盗塁数、盗塁成功率（セ・パ別、年度別）
- NPBの走塁得点（UBR/BsR）の実分布・上位選手の実数値
- 1.02が「盗塁得点」「盗塁死得点」「その他走塁得点」を**個別の指標名として**公表しているか
  （UBR/wSBという名称そのものはFanGraphsのライセンス移植だが、日本語の別称で公表している可能性は未調査）

NPB.jp公式は捕手の盗塁阻止率ページ（`fielding_metrics_reference.md` §6.4で既確認・
https://npb.jp/bis/2024/stats/lf_csp2_c.html）と同様の命名規則で個人盗塁数・チーム盗塁数のページを
持つ可能性が高いが、本ラウンドの調査時間内には確認が完了しなかった。**追加調査が必要。**

---

## 10. XBT%（Extra Bases Taken Percentage）

### 10.1 確認できなかったこと `[確認できず]`

正式な定義（分子・分母）、MLBリーグ平均値、状況別（単打での1→3塁・2→本塁、二塁打での1→本塁）成功率は、
**本ラウンドの調査では一次情報から確定できなかった**。関連クレーム2件は敵対的検証で **0-3** の反証となり不採用。

- Baseball-Reference公式ブログ（baseball-reference.com/blog/archives/10867.html）由来とされたクレームは反証された
- Baseball Prospectus新リーダーボード由来とされたクレームも反証された

**現行シムの `xbt`（`advTaken/advOpp`、metrics.mjs）は、UBRのシナリオ別機会（adv2h1b/adv1h2b/adv1t3b/tag）を
全合算した独自の近似値であり、B-Ref/BPいずれの公式XBT%とも分子分母の定義が異なる可能性がある。**
実測値は §12.2 を参照。名称の妥当性（"XBT%"を名乗ってよいか）は要検討。

---

## 11. 年度間相関・信頼性

### 11.1 確認できなかったこと `[確認できず]`

UBR / BsR / Sprint Speed の年度間相関（year-to-year correlation）、信頼性に必要な機会数・打席数は、
2ラウンドの調査を通じて一次情報から確認できなかった。`fielding_metrics_reference.md` §4（UZRの年度間相関≈0.5・
フレーミング0.70で例外的に安定）に相当する走塁版の数値は**要追加調査**。

三層構造（鉄則3）を守るなら、起用AI/球団AIが走塁指標を参照する際の回帰係数は、この数値が確定するまで
守備UZRの回帰係数（`fielding_metrics_reference.md` §11.9・約50%回帰）を暫定的に流用するのが妥当。

---

## 12. 現行実装との突き合わせ

### 12.1 実測: 現行シムが出す走塁指標の分布（6シード平均・143試合・規定打席到達者）

`measure_bsr.mjs`（本調査で作成した計測スクリプト）による実測:

| 指標 | リーダー | 最下位 | リーグ総和 |
|---|---|---|---|
| BsR | +9.24 | −5.63 | 0.00 |
| UBR | +3.80 | −3.03 | 0.00 |
| wSB | +6.31 | −2.72 | 0.00 |
| wGDP | +2.61 | −2.90 | −0.00 |

**リーグ総和がすべて0近傍＝中心化が正しく機能している（§2.1/§3.1/§4.2の設計と整合）。**

BsRリーダー +9.24 は §8.3 の実測上限（B-Ref Rbaser最高+8.0、FanGraphsの目安表Excellent=+8、§1.2）と
**近い水準**で、過大でも過小でもない。ただし §1.2 で述べた通りこれは「目安表」との比較であり、
FanGraphsのBsR（wGDP込み）自体の実測レンジは本調査で確認できていないため、暫定的な健全性チェックに留まる。

### 12.2 実測: 盗塁・XBT%・GDP率・損益分岐点

| 指標 | 実測値 |
|---|---|
| SB/球団（シーズン合計） | 98.5 |
| CS/球団 | 39.6 |
| 盗塁成功率 | 71.3% |
| 盗塁王（個人シーズン最高SB） | 48.3（`CALIBRATION_TARGETS.leaders.sb: [30,65]` の帯内） |
| XBT%相当（`advTaken/advOpp` 全シナリオ合算） | 25.8% |
| GDP率（`gdp/gdpOpp`） | 39.5% |
| `lc.runCS`（リーグ導出値） | −0.379 |
| 損益分岐盗塁成功率（§5.2の式で`lc.runCS`から算出） | 65.5% |

**盗塁成功率71.3% > 損益分岐点65.5%** ＝ シム内で盗塁は平均して正の得点期待値を持つ戦略として成立しており、
§5.1の一次情報（"about two-thirds"≈66.7%が損益分岐）と整合する健全な状態。

GDP率39.5%は、現行実装の `gdpOpp` がゴロ打席のみに限定されているため（§4.4・§12.3）、
「ゴロを打った上で併殺になった率」という狭い分母の値であり、**公式GIDP率（走者一塁・2アウト未満の
全打席を分母とする、通常10〜12%程度とされる指標）とは定義が異なる**ため直接比較できない。

### 12.3 【設計上の齟齬】`gdpOpp` がゴロ打席に限定されている

`src/sim/game.mjs:729` は次の条件でのみ `gdpOpp` をインクリメントする:

```js
if (bType === 'GB' && bases[0] && outsBefore < 2) {
  bStat.baserunning.gdpOpp++;
  ...
```

§4.1 で確認した FanGraphs の原典定義（「機会 = 走者一塁・2アウト未満の打席」でありゴロに限定されない）
とは異なり、現行実装は機会（分母）自体をゴロ打席に絞っている。

**この設計の是非は判断が分かれる**:
- 「ゴロを打った時点で初めて併殺が物理的にありうる」という意味では実務上合理的（三振・四球・フライでは併殺は起きない）
- 一方、B-Ref/FanGraphsの原典が示す「機会＝状況（塁・アウト）で決まり、打球結果に依存しない」という定義とは
  厳密には異なる。この違いは wGDP の値そのものには影響しない（分子分母ともゴロに絞られているため率は同じ計算ができる）が、
  「機会数」の絶対値が原典の定義より小さくなる

**現状ではバグではなく設計選択として妥当だが、原典との差異として明記しておく。** 修正するなら、
機会は「走者一塁・2アウト未満の全打席」に広げ、GDP発生条件（分子）だけをゴロに絞る形に直す必要がある。

### 12.4 【見つかったバグ】`baserunning.outsOnBase` が宣言されているが一度も加算されていない

`src/model/statline.mjs:153` の `createBaserunningLine()` は `outsOnBase`（走塁死カウンタ）を宣言しているが、
`grep -rn "outsOnBase" src/` で他に一致箇所がない＝**この集計フィールドは常に0のまま、どこからも書き込まれない**。

実際の走塁死自体（`resolveAdv` の `ADV_OUT` 分岐、`attemptSteal` の盗塁死）は正しく発生しアウトとしてカウントされる
（実測: 6シード平均で外野補殺による走塁死=リーグ計 約120件/球団10.5件、§fielding_metrics_reference.md 相当）。
**壊れているのは「走塁死の専用カウンタへの計上漏れ」であり、試合結果・アウトカウントには影響しない
（決定論・較正53指標には非影響）が、`baserunning.outsOnBase` を将来 Rbaser 型の走塁死ペナルティ表示や
UI表示に使おうとすると常に0を返す死んだフィールドになっている。**

### 12.5 run値の一致確認

| 定数 | 一次情報（§2.2） | 現行実装（`config.mjs`） | 判定 |
|---|---|---|---|
| `runSB` | +0.2 固定 | `tuning.run.runSB: 0.2` | ✅ 一致 |
| `runCS` | −(2×RunsPerOut+0.075) 可変 | `lc.runCS` が `leagueConstants.mjs` でこの式そのままリーグ実測から導出（`config.mjs`の`-0.4`はフォールバックのみ） | ✅ 一致（既に正しく実装済み） |
| wGDPの1DPあたりrun値 | FanGraphsは非公開（§4.2）。B-Refは.44（§8.2） | `tuning.gdp.runGDP: -0.42` | ⚠ FanGraphsは係数非公開のため直接比較不可。B-Refの.44とは近い値で参考程度に整合 |

### 12.6 UBRのシナリオ分解はBPのAAR/HAR分類に近い

現行実装の `playerBaserunning`（`metrics.mjs`）はUBRを4シナリオ（`adv2h1b`/`adv1h2b`/`adv1t3b`/`tag`）に分解して
それぞれリーグ平均で中心化する。これはFanGraphsの単一UBR（§3.2、シナリオ非公開の単一指標）よりも、
**BPのGAR/AAR/HAR分類（§7.1・打球種別ごとに進塁価値を分ける設計思想）に近い**。

具体的な対応:
- `adv2h1b`（単打での二塁走者本塁突入）・`adv1h2b`（二塁打での一塁走者本塁突入）・`adv1t3b`（単打での一塁走者三塁進塁）→ HAR（安打での進塁）相当
- `tag`（外野フライでのタッグアップ）→ AAR（air-ballでの進塁）相当

**この設計は原典のどれか一つの完全コピーではなく、UBRの哲学（RE差分で評価・リーグ平均中心化）を
BP流のシナリオ分解で実装したハイブリッドである。** 出典不明の独自係数ではなく、UBR・AAR・HARいずれの
原典の考え方とも矛盾しないため、設計として妥当と判断できる。

### 12.7 Statcast型の確率モデルとの差

§6.3で確認したStatcastの非盗塁進塁評価は「走者速度・外野手の肩・走者位置・外野手のボール/塁への距離」から
**プレーごとの成功確率**を幾何的に推定する。現行実装の `resolveAdv`（`game.mjs`）は
`p = clamp(baseProb + (tool-50)×ubrSlope − armSup, 0.05, 0.95)` という単純ロジスティックであり、
`fielding_metrics_reference.md` §11.2 で守備側に導入された Distance-Time モデル（打球ごとの幾何演算）に相当する
仕組みを走塁側はまだ持たない。**これは「壊れている」わけではなく、守備で行ったのと同様の高忠実度化を
走塁側にも適用するかどうかの将来の設計判断（§13）。**

---

## 13. 未決の疑問（残）

- **NPBのリーグ平均盗塁数・成功率・XBT%相当・走塁得点の実分布**（§9.4）。NPB.jp公式に個人/チーム別の
  盗塁数ページがある可能性が高く、`fielding_metrics_reference.md` §6.4 と同じ手法（`npb.jp/bis/{year}/stats/`
  配下のURLパターン探索）で追加確認できる見込み。
- **BPのBRR=GAR+SBR+AAR+HAR+OARが単純合計かどうか**（§7.3）と、DRBa/DRBnへの移行が完了しているか。
- **XBT%の正式な分子分母定義**（§10）。現行実装の`xbt`フィールドとの整合を取るには追加調査が必要。
- **損益分岐点の塁/アウト状況別変動**（§5.3）。RE24状態遷移からの導出は本調査では確認できず。
- **UBR/BsR/Sprint Speedの年度間相関**（§11）。三層構造の回帰係数設計に必要。
- `gdpOpp`をゴロ限定のままにするか、原典どおり全打席（走者一塁・2アウト未満）に広げるか（§12.3）の設計判断。
- `1point02.jp`のBsR定義（UBR+wSBの2成分、wGDPなし）とFanGraphsの3成分のどちらに実装を寄せるか（§9.2）。
- `baserunning.outsOnBase`を実際に配線するか、使われないなら宣言ごと削除するか（§12.4）。

---

## 14. 変更履歴

- 2026-07-10: 初版。
  - MLB一次情報（BsR/wSB/UBR/wGDP/Statcast Baserunning Run Value/Sprint Speed/B-Ref Rbaser・Rdp）を
    deep-researchの敵対的検証（2ラウンド・計214エージェント）で確定
  - Baseball Prospectus（BRR/EqBRR/GAR/SBR/AAR/HAR/OAR、DRBa/DRBnへの体系移行）を一次記事・アーカイブから再構成
  - NPB（1point02.jp）のUBR/BsR定義（wGDPを含まない2成分）を確認
  - 現行実装（`metrics.mjs`/`game.mjs`/`config.mjs`）を実測・突き合わせ、`gdpOpp`のゴロ限定・
    `outsOnBase`未配線を発見（§12）
  - 計測スクリプト: `measure_bsr.mjs`（走塁指標分布・損益分岐点）/ `kill.mjs`（外野補殺・走塁死件数）

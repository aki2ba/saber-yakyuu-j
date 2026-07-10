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

### 6.4 【第3ラウンドで判明】Statcastの走塁指標は名称が3〜4系統に分かれており混同しやすい

`baseballsavant.mlb.com`／`mlb.com/glossary/statcast/` には、似た名前の走塁指標が複数並存する。
実装時に取り違えないよう、判明した範囲で整理する。

| 指標名 | 対象範囲 | 確認状況 |
|---|---|---|
| **Basestealing Run Value** | 盗塁・牽制死のみ（§6.3） | `[3-0 / 一次]` |
| **"Baserunning"**（別名 Baserunning/Throwing Value） | 打球に対する追加進塁のみ。**盗塁を含まない** | `[3-0 / 一次]` |
| **Baserunning Run Value**（"Runner Runs"） | 盗塁＋打球進塁の統合値（§6.3で確認済み） | `[3-0 / 一次]` |
| **Net Bases Gained**（2024年新設） | 盗塁・ボーク進塁の加点、盗塁死・牽制死の減点による純増塁数（run換算前の**塁数**単位） | `[3-0 / 一次]` |

> "This does account for extra bases taken by batters or runners on batted balls; it does not include stolen bases, as it's about taking extra bases against fielders."（"Baserunning"指標について）

- 出典: https://www.mlb.com/glossary/statcast/baserunning （一次）

> "Every runner is given credit for his advances via steals and balks, and penalized for his outs made via caught stealings and pickoffs, based on the success probability of all those stolen base opportunities. The difference between a player's base advances vs. average and his outs created vs. average is his Net Bases Gained."

- 出典: https://www.mlb.com/news/breaking-down-statcast-s-new-baserunning-stats （一次・2024年12月公開）

**Net Bases Gained は Basestealing Run Value の「run換算前（塁数単位）」の下位指標である可能性が高いが、
両者の数式的な対応関係を明示した一次情報は見つからず、この対応づけは本ドキュメントの推測に留まる。**

### 6.5 確認できなかった追加指標 `[確認できず]`

- **Lead Distance / Secondary Lead**（2023年以降にBaseball Savantが公開したとされる新指標）の正式な定義・測定タイミング。
  2つの異なるアプローチで試行したが、いずれも敵対的検証で反証された（`[1-2]` / `[0-3]`）
- Steal Success Probability モデルの入力詳細（Basestealing Run Value の背後にあるモデルと同一かは不明）

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

### 7.3 【第3ラウンドで判明】成分数に食い違いがある: 4成分 vs 5成分 `[3-0 / 一次]`

BP自身の一次資料2本を突き合わせた結果、**BRR/EqBRRの正式な構成成分数が資料間で食い違う**ことが判明した。

**2006年の原論文**（"Schrodinger's Bat: The Whole, the Sum, and the Parts"）のテーブルは
`Year, Team, Opps, EqGAR, Opps, EqAAR, Opps, PO, CS, EqSBR, Opps, OA, EqHAR, Total` という列構成で、

> "we added up the various baserunning metrics we've been formulating all summer to come up with a total number of theoretical runs contributed on the bases"

**Total = EqGAR + EqAAR + EqHAR + EqSBR の4成分合計**であり、この記事本文に **EqOAR という語は一切登場しない**
（「EqOARが2006年記事に存在する」というクレームは敵対的検証で反証済み）。

- 出典: https://www.baseballprospectus.com/news/article/5523/schrodingers-bat-the-whole-the-sum-and-the-parts/ （一次）

**一方、後年の記事**（"Between the Numbers: The Need for Spd"）は明確に5成分と述べる:

> "EqBRR is comprised of stolen bases (EqSBR), ground advancement (EqGAR), air advancement (EqAAR), hit advancement (EqHAR), and 'other' advancement (EqOAR)"

- 出典: https://www.baseballprospectus.com/news/article/11336/between-the-numbers-the-need-for-spd/ （一次）

**EqOARが後年追加された成分か、2006年記事が単に言及を省いただけかは本調査では断定できない。**
実装するなら5成分版（EqOAR込み）を採用し、OAR（暴投・捕逸・ボークでの進塁）分は
現行シムでは独立に捕手ブロッキング指標（`fielding_metrics_reference.md` §7.7）側で処理されている点に注意。

### 7.4 参考: Speed Score(Spd) と EqBRR成分の横断的相関（年度間相関ではない） `[3-0 / 一次]`

2007-2009年チームレベル集計での相関係数（r）:

| 成分 | Spdとの相関(r) |
|---|---|
| EqBRR（総合） | **.63** |
| EqSBR（盗塁） | .60 |
| EqHAR（安打進塁） | .29 |
| EqGAR（ゴロ進塁） | .12 |
| EqAAR（フライ進塁） | .11 |
| EqOAR（その他） | .06 |

- 出典: https://www.baseballprospectus.com/news/article/11336/between-the-numbers-the-need-for-spd/ （一次）

**注意**: これは「Spd（見た目の速さの指標）とEqBRR各成分がどれだけ相関するか」という**横断的（クロスセクション）
相関**であり、§11で扱う「同一指標が年をまたいでどれだけ再現するか」という**年度間相関**とは別物。
EqSBR（盗塁）がSpdと最も強く相関し、EqGAR/AAR/OAR（打球進塁系）は弱いという構造は、
「足の速さは盗塁には直結するが、打球進塁の巧拙は走塁IQ等の別要因が支配的」という解釈と整合する。

### 7.5 確認できなかったこと `[確認できず]`

- 現行のBP公式glossary（`baseballprospectus.com/glossary/`）にEqOARの正式な算出式・run値が掲載されているか
  （Anubis bot対策で直接確認できず、legacy版アーカイブでの再現も限定的）
- DRBa/DRBn（2024-25年の新体系、§7.2）の具体的な算出式
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

### 9.4 NPB公式（npb.jp）の盗塁実数値 `[一次]`

> **2026-07-10追記**: 初版では「NPB.jpに存在する可能性が高いが未確認」としたが、第3ラウンドでURLパターンを
> 特定し実数値を確認できた。

**URLパターン** `[3-0 / 一次]`: `https://npb.jp/bis/{年}/stats/lb_sb_c.html`（盗塁個人リーダーズ・セ）/
`lb_sb_p.html`（パ）/ `lb_cs_c.html`・`lb_cs_p.html`（盗塁刺個人リーダーズ）/ `tmb_c.html`（チーム打撃成績。
盗塁・盗塁刺列を含む）。捕手盗塁阻止率ページ（`fielding_metrics_reference.md` §6.4の`lf_csp2_c.html`）と
同系統の命名規則。

**個人盗塁王の実数値** `[3-0 / 一次]`:

| 年 | リーグ | 選手 | 盗塁 | 備考 |
|---|---|---|---|---|
| 2024 | セ | 近本光司（阪神） | **19** | 1944年以来・2リーグ制以降で最少の盗塁王 |
| 2024 | パ | 周東佑京（ソフトバンク） | **41** | 盗塁死13でパ・リーグ最多も兼ねる |
| 2025 | セ | 近本光司（阪神） | **32** | 3年連続盗塁王・自己最高成功率。2位上林誠知(中日)27／3位三森大貴(DeNA)22／4位中野拓夢(阪神)19／5位タイ 羽月隆太郎(広島)・岡林勇希(中日)17 |

- 出典: https://npb.jp/bis/2024/stats/lb_sb_c.html 、 https://npb.jp/bis/2024/stats/lb_sb_p.html 、 https://npb.jp/bis/2025/stats/lb_sb_c.html （一次）

**チーム別盗塁・盗塁刺（2024年セ・リーグ）** `[2-1 / 一次]`:

| チーム | 盗塁 | 盗塁刺 | 成功率（算出値） |
|---|---|---|---|
| ヤクルト | 67 | 16 | 80.7% |
| DeNA | 69 | 27 | 71.9% |
| 巨人 | 59 | 25 | 70.2% |
| 中日 | 40 | 27 | 59.7% |
| 広島 | 66 | 51 | 56.4% |
| 阪神 | 41 | 35 | 53.9% |
| **セ・リーグ計/平均** | **342（57.0/球団）** | **181（30.2/球団）** | **65.4%** |

- 出典: https://npb.jp/bis/2024/stats/tmb_c.html （一次。**成功率列自体はページに存在せず、SB/(SB+CS)からの派生計算値**）

**セ・リーグ計の成功率65.4%は、本ドキュメント§5.2で算術的に導出した損益分岐点（65〜67%）とほぼ一致する。**
NPBの実際の盗塁企図が経済合理的な水準に収束していることの傍証になる。

**注意**: 2024年はセ・リーグの盗塁数が歴史的に少ない年（盗塁王19個が史上最少タイ）だったため、
上表のチーム別数値・リーグ平均は**長期的なNPB平均としては低めに出ている可能性がある**。
複数年度の平均を取る追加調査が望ましい。

### 9.5 確認できなかったこと `[確認できず]`

- NPBの走塁得点（UBR/BsR）の実分布・上位選手の実数値（1.02の会員限定コンテンツの可能性）
- 1.02が「盗塁得点」「盗塁死得点」「その他走塁得点」を**個別の指標名として**公表しているか
- パ・リーグのチーム別盗塁・盗塁刺実数値（本ラウンドではセ・リーグの`tmb_c.html`のみ確認。
  パ・リーグは`tmb_p.html`等の対応URLで追加確認できる見込み）
- 複数年度（2020〜2025年）にわたる盗塁数・成功率のトレンド

---

## 10. XBT%（Extra Bases Taken Percentage）

> **2026-07-10追記**: 初版では「確認できず」としたが、直接WebFetchの403を見て早期に諦めていたのが原因だった。
> Wayback Machine / r.jina.aiプロキシ経由での再取得を徹底した第3ラウンドで、定義文とリーグ実測値を確定できた。

### 10.1 定義 `[3-0 / 一次]`

> "XBT%, which is the percentage of time that a baserunner advances more than 1 base on a single or more than 2 bases on a double."

（訳）走者が単打で1塁を超えて進塁する、または二塁打で2塁を超えて進塁する割合。

- 出典: https://www.baseball-reference.com/blog/archives/10867.html （一次・Baseball-Reference公式ブログ「What does XBT% really tell us?」。直接WebFetchは403だがr.jina.aiプロキシとWebFetchの2経路で逐語一致を確認）

### 10.2 リーグ平均値 `[3-0 / 一次]`

| 時点 | XBT%リーグ平均 |
|---|---|
| 2023年フルシーズン | **42%** |
| 2011年開幕〜4/26（部分サンプル） | 41% |

- 出典: https://www.baseball-reference.com/leagues/majors/2023-baserunning-batting.shtml （一次。生HTMLの`data-stat="extra_bases_taken_perc"`属性から直接抽出）
- 出典: https://www.baseball-reference.com/blog/archives/10867.html （一次。"The league average so far this year is 41%... Generated 4/26/2011."）

### 10.3 確認できなかったこと `[確認できず]`

分子・分母の**厳密な**算入規則は依然確認できず（敵対的検証で**1-2**の反証）:
- 単打・二塁打で本塁まで生還した場合（1塁→本塁、2塁→本塁）の算入方法
- 本塁打自体が機会・分母から除外されるか
- 併殺のリスクがある状況（例: 一塁に走者がいて進塁を自重せざるを得ない場面）が機会から除外されるか

**現行シムの `xbt`（`advTaken/advOpp`、metrics.mjs）は、UBRのシナリオ別機会（adv2h1b/adv1h2b/adv1t3b/tag）を
全合算した独自の近似値であり、B-Refの公式XBT%とは分子分母の厳密な定義が異なる可能性が残る**
（大枠の「単打・二塁打で1つ余分に進塁できたか」という発想は一致）。実測値は §12.2 を参照。

---

## 11. 年度間相関・信頼性

### 11.1 UBR/BsRの年度間相関係数は「有力候補記事に不在」であることを確認 `[3-0 / 一次 × 3記事]`

第3ラウンドで、UBR/BsRの年度間相関を扱っていそうなFanGraphsブログ記事3本を直接精査し、
**いずれにも数値が掲載されていないことを逐語で確認**した（＝存在しないことの証明ではなく、
この3本の有力候補には無いという限定的な不在実証）。

| 記事 | 確認結果 |
|---|---|
| "Ultimate Base Running Primer"（2011） | 将来の改良点（OBP調整・外野ゾーン追加）には言及するが年度間相関の議論なし |
| "A Long Needed Update on Reliability"（2017） | "For BsR and UZR, I don't have the granular play-by-play or game-by-game data." と明記し、著者自身が計算対象外としている |
| "Running and Runs: A Look at BsR Data"（2011） | "year to year" "correlate" "correlation" "consistent" "reliability" "repeat" いずれのキーワードも本文に出現せず。内容はチーム/選手別の累積UBR紹介（Pujols +20.7等）に留まる |

- 出典: https://blogs.fangraphs.com/ultimate-base-running-primer/ 、 https://blogs.fangraphs.com/a-long-needed-update-on-reliability/ 、 https://blogs.fangraphs.com/running-and-runs-a-look-at-bsr-data/ （いずれも一次）

**"A Long Needed Update on Reliability" の著者自身が「BsR/UZRの粒度細かいデータを持っていない」と明言している**
ことは重要な傍証で、FanGraphs内部でもBsR/UZRの年度間相関を体系的に算出した記事が（少なくとも2017年時点で）
存在しなかった可能性を示唆する。

### 11.2 Sprint Speedは「年度間でよく相関する」という定性的言及のみ `[2-1 / 二次（孫引き）]`

> "Sprint Speed correlates well from year to year; it doesn't require a large sample to become reflective of true talent (Petriello compares speed to fastball velocity)"

- 出典: https://blogs.fangraphs.com/what-can-speed-do/ （FanGraphsがMLB.com記者Mike Petrielloの記事を要約したもの。Petriello本人の一次記事は406エラー、Wayback Machine経由も本環境では取得不可のため**孫引きの域を出ない**）

**具体的な相関係数（r値）は確認できなかった。**

### 11.3 実装への含意

三層構造（鉄則3）を守るなら、起用AI/球団AIが走塁指標を参照する際の回帰係数は、この数値が確定するまで
守備UZRの回帰係数（`fielding_metrics_reference.md` §11.9・約50%回帰）を暫定的に流用するのが妥当。
Sprint Speed相当の「純粋な足の速さ」は年度間で安定しやすい（速球の球速に類似）という定性的示唆はあるため、
UBR/BsR（走塁判断・結果に依存し年度間変動が大きい可能性）とSprint Speed相当（身体能力・安定）を
**同じ回帰係数で扱わない方が原典の趣旨に近い**可能性がある。

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

**NPB実測との比較（§9.4）**: シムのSB/球団=98.5・成功率71.3%に対し、NPB実測（2024年セ・リーグ）は
SB/球団=57.0・成功率65.4%。**シムはNPB実測より盗塁企図数が多く成功率も高い**
（ただし2024年セ・リーグは史上最少の盗塁王が出た低盗塁の年であり、長期平均としては控えめに出ている可能性がある。
`CALIBRATION_TARGETS.leaders.sb: [30,65]` は個人盗塁王を対象とした帯であり、シムの実測48.3はこの帯内で
PASSしている。チーム総量・成功率は較正目標に入っていないため、この差が「較正上の問題」かどうかは
現時点では未判定。§13の追加調査（複数年度平均）を待って判断すべき）。

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

3ラウンドの調査を経て、多くの項目は解消したが、なお以下が残る:

- **XBT%の分子分母の厳密な算入規則**（§10.3）: 本塁打時・封殺リスク時の機会除外可否。定義文と
  リーグ平均値は確定したが、エッジケースの正確な数え方はB-Ref公式グロッサリー等の追加確認が必要。
- **BPのEqOARが正式な5成分目として現行も使われているか**（§7.3/§7.5）: 2006年記事は4成分、後年記事は
  5成分と食い違う。現行のBP公式glossaryページを再確認できれば解消する可能性がある。
- **DRBa/DRBn（BPの2024-25年新体系）の具体的な算出式**（§7.5）。
- **Statcast Lead Distance / Secondary Lead の正式な定義**（§6.5）: 2回の試行がいずれも反証された。
- **UBR/BsR/Sprint Speedの年度間相関の具体的なr値**（§11.1/§11.2）: 3本の有力候補記事には不在と確認できたが、
  他の記事（The Hardball Times等）や、Petrielloの一次記事の別経路での取得はまだ試していない。
- **損益分岐点の塁/アウト状況別変動**（§5.3）。RE24状態遷移からの導出は本調査では確認できず。
- **NPBの走塁得点（UBR/BsR）の実分布・パ・リーグのチーム別盗塁数・複数年度トレンド**（§9.5）。
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
- 2026-07-10（第3ラウンド追記）: ユーザーから「XBT%は明らかに定義があるはず、他の未確認項目も含め
  再調査してほしい」との指摘を受け、直接WebFetchの403/406で早期に諦めていた項目をWayback Machine /
  r.jina.aiプロキシ経由で再調査（103エージェント）。
  - **XBT%**（§10）: 定義文とリーグ平均値（2023年42%）を確定。分子分母のエッジケースのみ未確認として残す
  - **NPB実数値**（§9.4）: npb.jp公式のURLパターン（`lb_sb_c/p.html`等）を特定し、2024-2025年の
    個人盗塁王・セ・リーグチーム別盗塁数を確定。セ・リーグ2024年の実測成功率65.4%が
    本ドキュメント§5.2の損益分岐点導出値（65〜67%）とほぼ一致することを確認
  - **BP GAR/BRR**（§7.3）: 2006年記事(4成分)と後年記事(5成分)の食い違いを発見・明記。
    Spd-EqBRR成分別相関（クロスセクション）を追加
  - **Statcast命名の混乱**（§6.4）: "Baserunning"（盗塁を含まない）と"Baserunning Run Value"（盗塁を含む
    統合指標）が別物であることを整理。Net Bases Gained（2024新設）を追加確認
  - **年度間相関**（§11）: UBR/BsRは有力候補3記事のいずれにも数値が存在しないことを確認（不在の実証）。
    Sprint Speedは孫引きの定性的言及のみ
  - Lead Distance/Secondary Leadは2回目の試行でも確認できず「確認できず」のまま

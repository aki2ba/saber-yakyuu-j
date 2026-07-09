# 守備・走塁指標リファレンス（一次情報ベース）

作成: 2026-07-09 / 調査手法: deep-research（fan-out検索 → 一次情報fetch → 3票の敵対的検証 → 合成）＋ 追加サブエージェント調査

このドキュメントは **`src/sim/fielding.mjs` / `battedBallResult.mjs` / `config.mjs` の守備指標を作り直すための正典** である。
実装を変える前に必ずここを参照し、**出典のない数値をコードに書かない**こと。

---

## 0. 出典のティア定義

| ティア | 定義 | 該当 |
|---|---|---|
| **一次/権威** | 指標の考案者・公表主体そのもの | FanGraphs Library、MGL(Mitchel Lichtman) の UZR Primer、MLB.com Statcast Glossary、Baseball Savant、Tom Tango のブログ / MLB Technology Blog、Fielding Bible / BIS、Baseball Prospectus、DELTA / 1.02 |
| **二次** | 一次情報を解説する専門媒体 | 専門記事・書籍・報道 |
| **未検証** | 個人ブログ・まとめサイト | 数値の根拠にしない |

以下、各主張には検証状況を付す。`[3-0]` は敵対的検証で3票中3票が「反証できず」を意味する。

---

## 1. UZR（Ultimate Zone Rating）

### 1.1 成分定義 `[3-0 / 一次]`

UZR は次の4成分の run 合計。

| 成分 | 定義（原典） | 付与対象 |
|---|---|---|
| **RngR** (Range Runs) | "get to balls hit in his vicinity" — 周辺打球への到達能力 | 全野手 |
| **ErrR** (Error Runs) | "errors as compared to an average fielder" | 全野手 |
| **ARM** | "runs an outfielder saves with their arm by preventing runners from advancing" | **外野手のみ** |
| **DPR** (Double-Play Runs) | "turning double-plays" | **内野手のみ** |

> UZR = "range runs, outfield arm runs, double play runs and error runs combined"

したがって **外野手 = RngR + ErrR + ARM**、**内野手 = RngR + ErrR + DPR**。
**ARM と DPR は UZR の正規成分であり、除外してはならない。**

- 出典: https://library.fangraphs.com/defense/uzr/ （一次）
- 出典: https://blogs.fangraphs.com/glossary/ （一次）

**捕手には UZR が付かない。** 4成分にフレーミング/ブロッキング/盗塁阻止が含まれないため。
（「付かない理由」の明示的な原典記述は本調査では確認できず＝未検証）

### 1.2 run 換算 `[3-0 / 一次]`

MGL（UZR 考案者）本人の記述:

> "convert .75 plays into runs by multiplying .75 by the difference between an average hit in that location and the average value of an air ball out"

- 外野の典型値: 平均的な安打 ≈ **+.56 run**、平均的な打球アウト ≈ **−.27 run** → 差 ≈ **.83 run**
- **試合状況中立**: "we don't vary the value of the hit or out based on the outs or base runners"

つまり UZR の run/play は「その打球位置の平均安打価値 − 平均アウト価値」であり、アウトカウントや走者状況では変えない。

- 出典: https://blogs.fangraphs.com/the-fangraphs-uzr-primer/ （一次・考案者本人）

### 1.3 【最重要】担当野手の割り当て `[3-0 / 一次]`

**これが現行実装と原典が最も乖離している点。**

MGL の UZR Primer に逐語で:

> "it is possible for 2, 3 or even 4 fielders to receive negative credit when a ball drops for a hit"
>
> "the LF'er is responsible for 40% (10/25) ... the CF'er, 60% (15/25)"
>
> "when a ball is caught and turned into an out by one fielder, no other fielder gets docked any runs"

**規則:**
1. **安打が落ちた場合** → そのバケット（ゾーン × 打球種別 × 打球速度）を各ポジションが捕る**相対頻度で比例配分**して、**2〜4人**の野手にマイナスを課す。
   - 例: そのバケットを LF が 10%、CF が 15% 捕るなら、分母 25% で LF に 40%、CF に 60% の責任。
2. **アウトにした場合** → **その1人だけ**にプラス。他の野手は一切減点されない（ball-hogging を抑制するため）。
3. バケットの平均アウト率が低いほど（＝誰も捕れない打球ほど）、落ちたときの各野手の減点は小さくなる。

- 出典: https://blogs.fangraphs.com/the-fangraphs-uzr-primer/ （一次・考案者本人）

### 1.4 スケール解釈目安（MLB・フルシーズン） `[3-0 / 一次]`

| UZR | 評価 |
|---|---|
| **+15** | ゴールドグラブ級 (Gold Glove Caliber) |
| **+10** | 優 (Great) |
| **+5** | 平均以上 (Above Average) |
| **0** | 平均 (Average) |
| **−5** | 平均以下 |
| **−10** | 拙 (Poor) |
| **−15** | 劣悪 (Awful) |

- 出典: https://library.fangraphs.com/defense/uzr/ （一次）
- **注: これは MLB(162試合) の目安。NPB(143試合) の実分布は §6 を参照。**

---

## 2. Statcast OAA（Outs Above Average）と FRV（Fielding Run Value）

### 2.1 外野 Catch Probability `[3-0 / 一次]`

主要入力:
- **opportunity time**: "Opportunity time starts when the ball is released by the pitcher"
  （※打球がバットに当たった瞬間ではなく、**投手のリリース**から測る）
- **distance needed**: "the shortest distance needed to make the catch"（最適ルートでの最短到達距離）
- **direction**（2017年に追加・前後左右）
- **wall までの距離**（2018年に追加）

※「距離・時間・方向の3要素」とする記述もあるが、Catch Probability の専用glossaryは**壁との近接を含む4要素**を挙げる。3要素とする主張は敵対的検証で**反証された（3票中3票が refute）**。

- 出典: https://baseballsavant.mlb.com/leaderboard/catch_probability （一次）
- 出典: https://www.mlb.com/glossary/statcast/catch-probability （一次）

### 2.2 内野 OAA — Distance-Time モデル `[3-0 / 一次]`

Tom Tango（Statcast 指標の設計者）による MLB Technology Blog:

> "The core Distance-Time model still applies."
>
> "the **Opportunity Distance**, which is how much distance the fielder has to cover to reach the ball (whether he has to charge in, run back, or move laterally)"
>
> "proximity of the fielder's starting location to the eventual path [of the ball]"

MLB.com glossary の4要素:
1. 打球到達点（**intercept point**）までの距離
2. そこへ行くのに使える**時間**
3. 到達点から**走者の向かう塁までの距離**
4. **フォースプレーでは打者走者の Sprint Speed**（データ無い新人は リーグ平均 27 ft/sec ≈ 8.23 m/s を代入）

- 出典: https://www.mlb.com/glossary/statcast/outs-above-average （一次）
- 出典: https://technology.mlblogs.com/introducing-infield-outs-above-average-6467e61a98dc （一次・Tango本人）

### 2.3 【最重要】OAA の確率重み付け `[3-0 / 一次]`

> "If you make the out, then your value-added is the difference between 100% and the out probability. So, if the out probability was 60%, and you made the out, you get 40%, or **+0.40 outs**."
>
> "If you don't make the out ... [it is] the negative of the out probability ... you get **negative 60%**."

MLB.com OAA glossary（外野の例）:
> "if an outfielder has a ball hit to him with a 75 percent Catch Probability ... and he catches it, he'll receive a **+.25** credit. If he misses it, he'll receive **−.75**, reflecting the likelihood of that ball being caught by other outfielders."

**式:**
```
捕球した   → OAA += (1 − p)
捕れなかった → OAA += (0 − p) = −p
   ただし p = その野手にとってのそのプレーの捕球（アウト化）確率
```

**帰結（これがシムに欠けている性質）:**
- 捕球確率 **5%** の絶望的な打球を捕れなくても **−0.05** しか減らない ＝ **ほぼ無罰**
- 捕球確率 **95%** の凡プレーを落とすと **−0.95** ＝ ほぼ1アウト分を失う
- 「誰にも捕れない打球は、誰の責任にもならない」が**確率重み付けから自動的に導かれる**

- 出典: https://technology.mlblogs.com/introducing-infield-outs-above-average-6467e61a98dc （一次・Tango本人）
- 出典: https://www.mlb.com/glossary/statcast/outs-above-average （一次）

### 2.4 FRV（OAA → run 換算） `[3-0 / 一次]`

**MLB.com 公式 FRV glossary が固定単価として明記**（context-neutral・プレーごとに可変ではない）:

| 成分 | run 換算 |
|---|---|
| Outs Above Average (range) — **外野** | **1 out = .9 runs** |
| Outs Above Average (range) — **内野** | **1 out = .75 runs** |
| Fielder Throwing | 1 = **1 run** |
| Catcher Blocking | 1 = **.25 run** |
| Catcher Throwing（盗塁1阻止） | 1 = **.65 run** |
| Double Plays | 1 = **.4 run** |
| Catcher Framing | 1 strike saved = **.125 run**（8ストライク = 1 run） |

> "Outs Above Average (range): 1 out = .9 runs (outfielders) // 1 out = .75 runs (infielders)"

**→ 現行実装の `runPerOutInfield: 0.75` / `runPerOutOutfield: 0.9` は一次情報で正当。** コメントの「Statcast FRV」も正しい出典表記だった。

**Tango の補足**: 昔は内野をスライス別に（2B/SS = .75、1B/3B = .80、差 .050）していたが、Statcast 実測では中間内野 vs 角内野の run/out 差は **約 .015** しかない（内野手が責任を負う安打はほぼ単打だから）。**→ 内野内でポジション別に differ させる根拠は薄い。一律 0.75 でよい。**

- 出典: https://www.mlb.com/glossary/statcast/fielding-run-value （一次）
- 出典: http://tangotiger.com/index.php/site/comments/statcast-lab-is-there-a-different-run-value-needed-based-on-the-infield-slice （一次・Tango本人）

---

## 3. ポジション補正（Positional Adjustment）

`[3-0 / 一次]` FanGraphs WAR が用いる値（**フルシーズン162試合あたり run**）:

| Pos | run |
|---|---|
| C | **+12.5** |
| SS | **+7.5** |
| 2B | **+2.5** |
| 3B | **+2.5** |
| CF | **+2.5** |
| LF | **−7.5** |
| RF | **−7.5** |
| 1B | **−12.5** |
| DH | **−17.5** |

- 出典: https://library.fangraphs.com/misc/war/positional-adjustment/ （一次）
- 出典: https://library.fangraphs.com/fangraphs-library-glossary/ （一次）

**注記（FanGraphs 自身の但し書き）**: これらは約10年前に導出された値で、「DH補正は負に過ぎる／捕手はやや大きい可能性」と自認されている。

**⚠ 未解決の疑問**: 合成レポートは「162試合 = **1,458** 守備イニングあたり」と記述した。一方、現行実装 `POSITION_ADJUST_PER_1350` は **1350** イニングで割っている（Baseball-Reference 系の慣行）。
- 1458 が正なら、現行実装は補正を **1458/1350 = 1.08 倍（8%）過大に**与えている。
- フルシーズンNPB捕手で `12.5 × 1287/1350 = 11.92` vs `12.5 × 1287/1458 = 11.03` → 約 **0.9 run ≈ 0.1 WAR** の差。
- **この点は FanGraphs の原典で再確認が必要（本調査では決着せず）。**

**NPB 適用時の注意**: 143試合スケールへの換算方法、NPB でのポジション難易度が MLB と同じか、については確定的な一次情報を確認できず。

---

## 4. 信頼性・回帰（reliability / regression）

`[3-0 / 一次]`

### 4.1 UZR の年度間相関と回帰

MGL の UZR Primer:
> UZR の年度間相関は **約 .5**（OPS は "almost .7"）
>
> 1シーズンの UZR は真の実力推定のため **約半分に回帰**させよ（"regress UZR halfway ... cut it in half"）
>
> 1ヶ月で +10 なら **85%回帰**させて +1.5 と考えよ

FanGraphs Library:
> 結論を出すには **3年分**が望ましい。**50イニング程度では判断不可**。

### 4.2 指標横断の年度間 Spearman 相関（2016-2022・移籍者サブセット）

| 指標 | year-to-year Spearman |
|---|---|
| RDA (Range Defense Added) | **0.43** |
| **OAA** | **0.31** |
| **DRS** | **0.23** |
| **UZR** | **0.15** |
| FRAA | **0.12** |

- 出典: https://www.baseballprospectus.com/news/article/80209/prospectus-feature-introducing-range-defense-added/ （一次）
- 注: 移籍者限定サブセットのため、全体母集団ではやや高くなる（＝この数値はノイズを過大評価する方向）。

### 4.3 シムへの含意

**単年 UZR は、真の守備力の指標としては半分がノイズである。**
シム内では真値(trueAbility)が存在するため、観測される UZR は「真値 + 相応のノイズ」でなければならない。
現行実装の UZR は二項抽選ノイズのみで、実測 UZR が持つ計測誤差・ゾーン誤差・ポジショニング交絡を持たない可能性がある。
三層構造（真値 / 観測成績 / 球団評価）において **UZR は「観測成績」層** に属すべき。

---

## 5. 現行実装との突き合わせ

### 5.1 実測: 現行シムが出す UZR 分布

3シーズン（seed 20260701-03）・守備400イニング以上の選手を集計。

```
pos  n     UZR_max  UZR_min   UZR_sd  |  RngR_max  ErrR_max  ARM_max  DPR_max  frame_max
C    40       26.9    -16.1      8.9  |       1.6       0.4      0.9      1.1       26.4
1B   40        6.7     -9.1      4.0  |       8.3       2.2      1.2      3.1        0.3
2B   46       18.2    -12.4      6.0  |      17.1       3.2      0.8      2.9        0.5
3B   45       14.9    -11.6      5.7  |      17.5       2.2      1.6      1.6        0.2
SS   49       13.9    -16.7      6.9  |      12.6       3.3      2.4      2.3        0.4
LF   52       14.8    -12.6      6.8  |      15.6       2.2      4.8      1.3        1.6
CF   53       24.6    -19.3      8.6  |      27.7       3.8     11.4      1.9        0.8
RF   48       16.8     -9.7      6.1  |      15.7       2.1     10.7      1.0        0.2
```

**FanGraphs 目安（+15＝ゴールドグラブ級 / −15＝劣悪）に対し、CF は +24.6 〜 −19.3、C は +26.9 〜 −16.1 と大きく逸脱。**
実測の UZR 標準偏差は CF 8.6 / C 8.9 run。現実のフルタイム野手の UZR SD はおよそ 5〜6 run 程度で、明らかに散らばりすぎている。

### 5.2 【根本原因】expOut の分布が「難易度」ではなく「打球種別」で決まっている

`resolveBattedBall` が返す `expOut` の分布（**単一の打者×投手**で 198,665 打球を生成。
リーグ全体の分布ではないが、expOut が打球種別でほぼ決まる構造は打者に依らない）:

```
  0.0–0.1    0.0%
  0.1–0.2    0.0%
  0.2–0.3    3.1%  ###
  0.3–0.4   19.2%  ###################
  0.4–0.5    2.9%  ###
  0.5–0.6    0.0%
  0.6–0.7    2.7%  ###
  0.7–0.8   20.8%  #####################
  0.8–0.9   33.8%  ##################################
  0.9–1.0   17.5%  #################

  両極 (p<0.1 or p>0.9) : 17.5%
  中間 (0.3<=p<0.7)     : 24.9%

打球種別ごとの expOut レンジ:
  FB: n= 52171  min=0.595 mean=0.855 max=0.990
  GB: n= 83788  min=0.595 mean=0.809 max=0.984
  LD: n= 50121  min=0.186 mean=0.350 max=0.512   ← 全ライナーが「35%のプレー」
  PU: n= 12585  min=0.850 mean=0.978 max=0.990
```

**expOut は事実上「4つの打球種別バケットの平均 ± 打球速度の線形項」でしかなく、打球がどこに落ちたか（＝担当野手がそこへ到達できるか）をほとんど反映していない。**

現実の捕球確率は **両極に集中する**（大半は「捕って当然の 99%」か「誰にも捕れない 1%」で、五分五分の打球は薄い帯）。
現行シムは逆で、**全ライナーが 0.19〜0.51 の「コイントス帯」に密集**している。

### 5.3 なぜそれが UZR を壊すか（因果の連鎖）

1 打球あたりの OAA 加減点の分散は `p(1−p)` で、**p = 0.5 付近で最大**になる。
したがって、**野手の能力差がまったく無くても**、`sqrt(Σ p(1−p))` ぶんの二項ノイズが季節末の OAA に必ず残る。

各ポジションの実際の担当打球数（3シーズン・12球団を平均。そのポジションを1人がフル出場した場合）から
この構造ノイズを計算すると:

```
pos   担当打球数   平均expOut   予測ノイズSD(outs)   run/out   予測ノイズSD(runs)
1B          269        0.797                6.5       0.75                  4.9
2B          736        0.796               10.7       0.75                  8.0
3B          325        0.798                7.1       0.75                  5.3
SS          697        0.796               10.4       0.75                  7.8
LF          498        0.565                9.5       0.90                  8.5
CF          747        0.560               11.6       0.90                 10.5
RF          497        0.569                9.5       0.90                  8.5

実測 UZR_sd (400イニング以上): 1B 4.0 / 2B 6.0 / 3B 5.7 / SS 6.9 / LF 6.8 / CF 8.6 / RF 6.1
```

**予測される構造ノイズだけで、実測された UZR の散らばりの全量を説明できてしまう**（予測 ≥ 実測。
実測が下回るのは、400イニング以上のプールに出場イニングの少ない選手が混じり、その分だけ機会＝分散が小さいため）。

つまり **現行シムの UZR の散らばりは、その主要因が「打球種別の粗いバケット化」に起因する二項ノイズであり、
野手個人の Range 能力のシグナルはその中に埋もれている。**

現実の OAA でノイズが小さいのは、大半の打球が p≈0.99 か p≈0.01 で `p(1−p)≈0` だからである。
**捕球確率が両極に分布することこそが、守備指標が意味を持つ前提条件**であり、それが実装に無い。

**副次的な問題（担当打球数の偏り）**: `assignFielder` は spray 角のみで境界を切るため
（3B: `s ≤ −18`、SS: `−18 < s < 0`、2B: `0 ≤ s < 20`、1B: `s ≥ 20`）、
**2B/SS が約 700 打球、3B/1B が約 270〜325 打球**と 2.3 倍の偏りが出ている。
CF も担当角 ±10° で 747 打球と、LF/RF（各 498）の 1.5 倍。深さ（distanceM）を境界に使っていないことも含め、
守備隊形の幾何そのものが現実と乖離している。

### 5.4 ユーザー報告事象の再現と原典による裁定

> 「ev120km/h 61m の打球でセンター前ヒット。これでセンターの UZR が下がりました。影響あるのってショートの UZR なんじゃないの？」

現行実装での挙動（幾何を手で追った結果）:

| EV | LA | 打球種別 | 飛距離 | 滞空 | 担当野手 | expOut | CFが実際に必要な走速度 |
|---|---|---|---|---|---|---|---|
| 120 km/h | 18° | LD | 60.9 m | 2.10 s | **CF** | **0.390** | **17.7 m/s** |
| 120 km/h | 20° | LD | 63.9 m | 2.33 s | **CF** | **0.391** | **14.7 m/s** |
| 135 km/h | 15° | LD | 69.8 m | 1.98 s | **CF** | **0.346** | **14.2 m/s** |

（CF の定位置 98m から落下点まで走る必要距離 ÷ 滞空時間。人類の全力疾走は約 9 m/s、ボルトの最高速でも 12.4 m/s）

**つまり CF は「物理的に到達不可能な打球」を落としたことで −0.39 アウト分の減点を受けている。**

**原典による正解:**
- **Statcast OAA**: この打球の CF にとっての catch probability は **ほぼ 0**。よって落としても **−0.0x** ＝ 実質無罰。
  （"if he misses it, he'll receive −.75" の −.75 は catch probability が 75% の場合の話であり、5% なら −0.05）
- **UZR**: 安打が落ちたので、このバケットを捕る相対頻度に応じて **複数野手に比例配分**して減点する。二塁後方の浅いライナーなら SS・2B・CF が僅かずつ分け合う。**バケットの平均アウト率が低いため、各野手の減点は極めて小さい。**

**→ ユーザーの直感（「CF ではなく SS では？」）は半分正しく、より正確な答えは「誰の責任にもならない打球であり、CF も SS もほとんど減点されない」。**
現行実装が CF に −0.39 を課しているのは、原典のどちらの方式とも異なる。

### 5.5 config / 実装の個別問題

| 箇所 | 現状 | 原典 | 判定 |
|---|---|---|---|
| `field.runPerOutInfield: 0.75` | 0.75 | FRV: 内野 1 out = .75 run | ✅ **正当**（出典表記も正しい） |
| `field.runPerOutOutfield: 0.9` | 0.9 | FRV: 外野 1 out = .9 run | ✅ **正当** |
| `pitch.runPerCall: 0.125` | 0.125 | FRV: framing 1 strike = .125 run | ✅ **正当** |
| `field.runPerDP: 0.45` | 0.45 | FRV: Double Plays 1 = **.4** run | ⚠ 要修正（0.45→0.4） |
| 捕手 rSB の run 換算 | `runSB/runCS` の線形加重 | FRV: Catcher Throwing **1 SB prevented = .65 run** | ⚠ 要検討 |
| ブロッキング | **未実装**（`wp`/`pb`/`blockOpp` は集計済み） | FRV: Catcher Blocking 1 = **.25 run** | ⚠ 接続可能 |
| 野手の送球 | **未実装** | FRV: Fielder Throwing 1 = **1 run** | ⚠ 未実装 |
| `uzrRuns` = RngR + ErrR + framing | ARM/DPR を WAR から除外 | UZR = RngR + ErrR + **ARM(外野)** + **DPR(内野)** | ❌ **定義違反** |
| `armRuns += (arm−50)×0.007` | 真値を直接 run に線形変換 | ARM は「進塁を防いだ」実イベントから算出 | ❌ **鉄則4違反**（指標の後付け） |
| `assignFielder` | spray角＋種別で **1人に決め打ち** | OAA=確率重み付け / UZR=複数に比例配分 | ❌ **根本的に別物** |
| `expOut = 1 − pHit(type)` | 打球種別の平均 | その野手の catch probability | ❌ **根本原因**（§5.2） |
| `timeDifficultyAdj` / `outfieldLDTypicalDepthM` | 上記への対症療法 | — | ❌ 正しいモデルを入れれば不要 |
| `CALIBRATION_TARGETS.war.uzrTop: [20,30]` | **どこからも参照されていない**（死んだ定数） | MLB: +15 = ゴールドグラブ級 | ❌ 過大 かつ 未配線 |
| `POSITION_ADJUST_PER_1350` の値 | C+12.5 / SS+7.5 / 2B,3B,CF+2.5 / LF,RF−7.5 / 1B−12.5 / DH−17.5 | FanGraphs と一致 | ✅ 値は正当 |
| `posAdjRuns` の分母 1350 | `innings / 1350` | 1458 (=162×9) の可能性 | ⚠ **要確認**（§3 注記） |

**注: 較正53指標に守備指標は1つも含まれていない。** `uzrTop` は config に書かれているだけで `tools/calibrate.mjs` から参照されておらず、`calibrate.mjs` が守備で見ているのは `armLeader`（＝真値の線形変換＝偽の量）と `framingLeader` のみ。**守備は較正の門番を通っていない。**

---

## 6. 【未調査】次セッションで埋めるべき欠落

本調査は MLB 一次情報を満票で確定できたが、以下は **API セッション上限により未完**。**推測で埋めてはならない。**

### 6.1 NPB の UZR 実分布（最優先）
較正目標を決めるのに必須。**日本語ソースが必要。**
- 検索クエリ: `1.02 UZR ランキング` / `DELTA UZR 2024` / `NPB UZR 順位` / `デルタ 守備指標` / `菊池涼介 UZR` / `源田壮亮 UZR`
- 主要ソース: `data.1point02.jp`（有料/会員制の可能性）、`note.com/deltagraphs`、DELTA『プロ野球データブック』、蛭川皓平『セイバーメトリクス入門』
- 知りたいこと:
  - NPB の年間 UZR 最高値（ポジション別。特に 2B/SS/CF/1B）
  - 規定到達者の UZR 標準偏差
  - 143試合 vs 162試合でスケールが違うのか（単純比例か）
  - NPB の UZR は誰がどのゾーン方式で算出しているか
  - ポジション別 年間失策数の目安、捕手の盗塁阻止率（NPB平均と上位）

### 6.2 DRS の成分定義
- `rPM` / `rSB` / `rGDP` / `rARM` / `rGFP` / `rBU` / `rTHR` / `rSZ(framing)` / `rPOS` の定義とポジション対応表
- Plus/Minus システムが **1つの打球を1人に帰属させるのか複数に分割するのか**（UZR は分割する）
- PADE（Park-Adjusted Defensive Efficiency）
- 出典: https://library.fangraphs.com/defense/drs/ 、https://www.fieldingbible.com/

### 6.3 捕手フレーミングの現実的レンジ
- **1シーズンの最良/最悪は何 run か**（実測シムは +26.4 だが、現実の上限が不明）
- Statcast Catcher Framing と BP の CSAA の違い
- shadow zone の分割方法
- NPB のフレーミング公表値の有無
- 出典: https://baseballsavant.mlb.com/catcher_framing 、https://www.mlb.com/glossary/statcast/catcher-framing

### 6.4 走塁指標
- BsR = UBR + wSB + wGDP の定義、`runSB` / `runCS` の実値
- UBR が何を独立変数にしているか
- Spd（Speed Score）の正確な式
- MLB / NPB での現実的なレンジ
- 出典: https://library.fangraphs.com/offense/bsr/ 、`/ubr/` 、`/wsb/` 、`/spd/`

### 6.5 未決の疑問
- **Statcast OAA は、安打が落ちたとき「最も捕球確率の高い1人」だけを減点するのか、捕球確率が非ゼロの全野手を減点するのか。**
  glossary の "reflecting the likelihood of that ball being caught by other outfielders" は前者を示唆するが断定できず。
  → 設計上は **「最も p が高い1人に −p を課す」** が単純かつリーグ総和≈0 を保てる。
- ポジション補正の分母は 1350 か 1458 か（§3 注記）。

---

## 7. 修正方針（原典に基づく設計案）

> ⚠ これは **提案** であり、実装前に §6 の欠落（特に NPB 分布）を埋めて較正目標を確定すること。

### 7.1 中核: Distance-Time モデルによる per-fielder 捕球確率

現行の「担当野手を1人決め打ち → 打球種別平均で expOut」を捨て、Statcast OAA と同じ構造にする。

```
1. 各ポジションの守備初期位置 (x, y) を定義する（守備隊形。現行の posTypicalDepthM を2次元へ拡張）
2. 打球の幾何から、各野手 i について:
     - 外野/飛球: opportunity distance = 初期位置 → 落下点、opportunity time = hangTimeS
     - 内野/ゴロ: intercept point までの距離、打球がそこへ到達するまでの時間
     - reqSpeed_i = distance_i / time_i
3. p_i = expit( (maxSpeed_i − reqSpeed_i) / width )
     maxSpeed_i は Range レーティング（positioningIQ + reaction + speed）から導く
     → これにより p は自然に両極分布する（届く球は p≈1、届かない球は p≈0）
4. 打球のアウト確率 pOut = max_i(p_i)（最も近い野手が処理する）
5. アウト/安打の抽選は pOut で行う
6. OAA 帰属:
     アウト → 処理した野手 j に  +(1 − p_j)
     安打   → 最も p の高い野手 j に  −p_j       ← 到達不能な打球なら p_j≈0 で実質無罰
7. run 換算は現行のまま（内野 0.75 / 外野 0.9・§2.4 で一次情報確証済み）
```

これにより:
- **§5.4 のポテンヒットは CF の p≈0.02 → 減点 −0.02。ユーザーの違和感が構造的に解消される。**
- `p(1−p)` が大半の打球で≈0 になるため、**UZR の二項ノイズが自然に縮み**、FanGraphs の ±15 レンジに収まるはず。
- `timeDifficultyAdj` と `outfieldLDTypicalDepthM` という対症療法が**不要になる**。
- Range レーティングのシグナルが「五分五分の打球」に集中して効くようになる（＝守備の巧拙が意味を持つ）。

**注意**: 打球の総アウト率（BABIP）は較正53指標の根幹。`maxSpeed` / `width` / 守備隊形は、**リーグ全体の BABIP が現行と一致するよう再較正**が必要。1年目シム不変（鉄則7）を壊さないこと。

### 7.2 UZR の成分を FanGraphs 定義に合わせる

```
外野手 UZR = RngR + ErrR + ARM
内野手 UZR = RngR + ErrR + DPR
捕手     = UZR を付けない（framing / blocking / throwing を別立てで WAR に入れる）
```

- ARM / DPR を WAR の `uzrRuns` に**含める**（現在は表示のみ）
- `runPerDP` を 0.45 → **0.4**（FRV 準拠）
- 捕手の framing を UZR に混ぜるのをやめ、捕手守備 run として別勘定にする

### 7.3 ARM を真値の直訳から実イベント創発へ（鉄則4の回復）

現行: `armRuns += (arm − 50) × 0.007` ← 進塁抑止イベントが一切起きていない。

あるべき姿: 単打で二塁走者が三塁を狙う／二塁打で一塁走者が本塁を狙う場面で、
外野手の `arm` を進塁成功確率と刺殺確率に**実際に結線**し、
`ARM = (リーグ平均の期待失点) − (この外野手が実際に許した失点)` として**生カウントから創発**させる。

> `game.mjs` の `resolveAdv` は現在 arm を見ておらず、乱数も消費していない。ここを結線すると
> 進塁の実結果が変わる ＝ 較正指標（得点環境）が動く。**再較正が必要な変更**であることを織り込むこと。

### 7.4 捕手守備の完成

| 成分 | 素データ | run 換算（FRV） | 状態 |
|---|---|---|---|
| framing | `frameCalls`（一球ごと） | 1 strike = **.125** | ✅ 実装済み・係数も正当 |
| blocking | `wp` / `pb` / `blockOpp`（集計済み） | 1 = **.25** | ⚠ 未接続 |
| throwing (rSB) | `sbAllowed` / `csMade` | 1 SB prevented = **.65** | ⚠ 換算式を FRV へ |

framing の現行実測 max は +26.4 run。**現実の上限が §6.3 未調査のため、係数ではなく「平均からの逸脱コール数」の分布が過大でないか要検証。**

### 7.5 較正への配線（守備を門番に通す）

`tools/calibrate.mjs` に守備の目標帯を追加し、`uzrTop` を実際に検査する。

- 暫定案（MLB 目安ベース。**NPB 実分布の調査後に確定**）:
  - `uzrTop`: リーグ最高 UZR（400イニング以上） → `[10, 16]`（+15 = ゴールドグラブ級）
  - `uzrBottom`: リーグ最低 UZR → `[−16, −10]`
  - `uzrSd`: 規定守備者の UZR 標準偏差 → 目安 `[4, 7]`
  - `framingTop`: 現実レンジ調査後に確定

### 7.6 単年 UZR のノイズについて（設計思想）

原典（§4）: 単年 UZR の年度間相関は ≈0.5、**真の実力推定には約半分に回帰**させるべき。

シムは真値を持つため、
- **UI（コーチの見立て・球団AI）は UZR をそのまま信じてはいけない**（三層構造・鉄則3）
- 起用AI / 球団AI が UZR を参照する場合、**約50%回帰させた値**を使うのが原典に忠実
- これは「市場の非効率を仕込む」（鉄則5・守備の過小評価）とも整合する

現行実装は `market` の `wDefMean: 0.62` で守備を過小評価させているが、**回帰による不確実性はモデル化されていない**。

---

## 8. 変更履歴

- 2026-07-09: 初版。MLB 一次情報（UZR / OAA / FRV / posAdj / 信頼性）を敵対的検証つきで確定。
  現行実装の実測（UZR分布・expOut分布・担当打球数・構造ノイズ）を取得し、根本原因を §5.2〜5.4 に特定。
  NPB 分布 / DRS / フレーミングレンジ / 走塁指標は **未調査**（§6）。
  計測スクリプト: `measure_uzr.mjs` / `measure_expout.mjs` / `measure_chances.mjs`（同ディレクトリ）

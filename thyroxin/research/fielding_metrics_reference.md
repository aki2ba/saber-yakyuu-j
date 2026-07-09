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

## 6. NPB の実分布（調査結果）

### 6.1 結論: 1.02 は順位のみ公開、実数値は非公開

`data.1point02.jp`（DELTA / 1.02）は NPB UZR の実質的な公式発表元だが、
**「デルタ・フィールディング・アワード」等の無料記事では受賞選手名のみが示され、UZR 実数値は掲載されない。**
実数値が出るのは DELTA が個別分析コラムで引用したケースに限られる（詳細データは会員限定と推測）。

### 6.2 それでも確定できたこと

**DELTA 公式用語集の解釈目安** `[一次]`:
> 「平均的な守備者の UZR はゼロで、優秀な選手は **+10 や +20** といった数値に達する」
> — https://1point02.jp/op/gnav/glossary/gls_explanation.aspx?eid=20026

**実測値の断片**（日本経済新聞が DELTA 算出値を引用。`[二次]`）:
| 選手 | ポジション | 年 | UZR |
|---|---|---|---|
| 外崎修汰（西武） | 2B | 2022 | **+15.4**（12球団2B トップ） |
| ソト（DeNA） | 1B | 2022 | +7.3（12球団1B トップ） |
| 安田尚憲（ロッテ） | 3B | 2022 | +7.1（12球団3B トップ） |
| 吉川尚輝（巨人） | 2B | 2021 | +9.2（リーグトップ） |
| 菊池涼介（広島） | 2B | 2014 | +12.3（守備範囲成分）`[一次: 1.02コラム]` |

- 出典: https://www.nikkei.com/article/DGXZQODH18D9Q0Y2A111C2000000/ （二次・DELTA算出データ引用）
- 出典: https://1point02.jp/op/gnav/column/bs/column.aspx?cid=53404 （一次）

**NPB の UZR は MGL のオリジナル UZR とは別実装** `[一次: DELTA 自身が明記]`:
> 「米国で算出されている UZR と完全に同じ計算方法で算出されているわけではない」

DELTA・データスタジアムがそれぞれ独自のゾーンデータで算出。成分は RngR / ErrR / DPR / ARM（＝FanGraphs と同じ4成分）。
内野手はゴロのみ、外野手はフライ・ライナーが対象。

### 6.3 【重要】143試合スケールの換算は不要

**「UZR/143」のような正規化・スケーリングの慣行を示す資料は見つからなかった `[確認できず]`。**

しかし決定的なのは、DELTA の目安（「優秀は +10〜+20」）も実測値（外崎 +15.4、菊池 +12.3〜13.7）も、
**MLB の「+15 = ゴールドグラブ級」とほぼ同水準にそのまま収まっている**こと。

**→ 較正目標は MLB の目安（+15 = ゴールドグラブ級）をそのまま採用してよい。143/162 の比例縮小（+13.2）を行う根拠は無い。**

### 6.4 NPB の失策数・盗塁阻止率 `[一次: NPB.jp 公式]`

**2024年 セ・リーグ 遊撃手 失策数**: 門脇誠 14 / 森敬斗 12 / 長岡秀樹・矢野雅哉 9 / 木浪聖也 8 / 村松開人・小幡竜平 5 / 京田陽太・小園海斗ら 3
→ 主要遊撃手は **年間 3〜14 個**
- 出典: https://npb.jp/bis/2024/stats/lf_e6_c.html

**2024年 セ・リーグ 捕手 盗塁阻止率**: 岸田行倫 .475 / 中村悠平 .467 / 坂倉将吾 .385 / 山本祐大 .352 / 加藤匠馬 .261 / 梅野隆太郎 .216
→ **約 .22 〜 .48**
- 出典: https://npb.jp/bis/2024/stats/lf_csp2_c.html

### 6.5 取得できなかったもの `[確認できず]`
- ポジション別（特に CF/SS）の歴代最高 UZR の数値そのもの（1位の選手名までは判明、数値は非公開）
- 規定到達者の UZR 標準偏差（NPB 向けの明示的な統計値は未発見）
- 菊池涼介の UZR 歴代値の確定系列（出典間で数値が食い違う。2016年 13.7 vs 17.3 など。**断定不可**）
- 捕手盗塁阻止率の NPB リーグ平均

---

## 7. 走塁指標（BsR / UBR / wSB / wGDP / Spd）

### 7.1 定義 `[一次]`

**BsR = wSB + UBR + wGDP** — https://library.fangraphs.com/offense/bsr/
（約 10 走塁 run で 1 win 相当）

| 成分 | 定義 |
|---|---|
| **wSB** | 盗塁・盗塁死の走塁価値 |
| **UBR** | 盗塁以外の走塁貢献（安打時の進塁・タッチアップ・走塁死など） |
| **wGDP** | 併殺打の回避度 |

### 7.2 wSB の算出式 `[一次]` — https://library.fangraphs.com/offense/wsb/

```
wSB   = (SB × runSB) + (CS × runCS) − (lgwSB × (1B + BB + HBP − IBB))
lgwSB = (ΣSB × runSB + ΣCS × runCS) / (Σ1B + ΣBB + ΣHBP − ΣIBB)
runSB = +0.2   ← 全シーズン固定
runCS = −(2 × RunsPerOut + 0.075)   ← 得点環境依存で年ごとに変動
```
実例: 2016年 runCS = −0.41、2014年 runCS ≈ −0.377。実測レンジは概ね **−0.35 〜 −0.45**。

**NPB でも 1.02 が同型の指標を公表している** `[一次]`:
> 「盗塁得点は通常 **0.20 前後**、盗塁死得点は **−0.40 前後**」
> — https://1point02.jp/op/gnav/glossary/gls_explanation.aspx?ecd=204&eid=20049

**→ 現行 config の `run.runSB: 0.19` / `run.runCS: -0.38` は日米一次情報の範囲内で妥当。**
ただし `runCS` は本来 `−(2 × RunsPerOut + 0.075)` という**得点環境依存の可変式**であり、固定値にすると
時代トレンド（フェーズD）で得点環境が動いたときに乖離する。

### 7.3 UBR `[一次]` — https://library.fangraphs.com/offense/ubr/

考案者は MGL（UZR と同じ）。状況（塁上・アウトカウント・打球結果）ごとに、
走者の実際の進塁結果と、その状況でのリーグ平均的な結果との**期待得点の差分**をプレー単位で積算する。

対象7カテゴリ: ①安打時の余分な進塁 ②打者走者の余塁進塁 ③先行走者の進塁判断 ④後続走者への影響
⑤フライでのタッチアップ ⑥内野ゴロでの一塁走者 ⑦遊撃・三塁方向の打球での二塁走者

**除外**: 盗塁・盗塁死（wSB で別評価）、三塁走者のフライ以外での生還。

**独立変数は「結果（進塁したか / アウトになったか）」であり、打球速度や守備者の肩は直接の変数ではない。**

### 7.4 解釈目安 `[一次]`

| 評価 | BsR | UBR | Spd |
|---|---|---|---|
| Excellent | **+8** | +6 | 7.0 |
| Great | +6 | +4 | 6.0 |
| Above Average | +2 | +1.5 | 5.5 |
| Average | 0 | 0 | 4.5 |
| Below Average | −2 | −1.5 | 4.0 |
| Poor | −4 | −4 | 3.0 |
| Awful | −6 | −6 | 2.0 |

> 「最高レベルの走者でも年間 **8〜10 得点程度が上限**」

wGDP は概ね −2.5 〜 +2。

### 7.5 Spd（Speed Score）

FanGraphs 版は **4成分**: 盗塁成功率 / 盗塁企図頻度 / 三塁打率 / 得点率（Runs Scored %）`[一次]`
Bill James の原典は6成分（上記＋併殺回避率＋守備範囲）だが、**正確な重み付け式は確認できず** `[二次]`。

**→ 現行実装の Spd 4成分は「盗塁成功率×頻度・三塁打率・XBT%・守備位置速度」であり、FanGraphs 版と2成分が異なる**
（`得点率` の代わりに `XBT%`、加えて `守備位置速度`）。FanGraphs 版に寄せるか、独自と明記するか要判断。

### 7.6 Statcast Sprint Speed `[一次]`
- 定義: "feet per second in a player's fastest one-second window"
- リーグ平均 **27 ft/sec**（8.23 m/s）、競争レンジ **23（poor）〜30（elite）**、"Bolt" = 30 ft/sec 以上
- 出典: https://baseballsavant.mlb.com/leaderboard/sprint_speed

---


## 8. 捕手守備（フレーミング / ブロッキング / 送球）

### 8.1 Statcast Catcher Framing Runs `[一次]`

> "Catcher Framing Runs converts strikes to runs saved on a **.125 run/strike** basis, and includes **park and pitcher adjustments**."
>
> "The **shadow zone** is essentially the edges of the strike zone, roughly one ball width inside and one ball wide outside of the zone."

- 出典: https://baseballsavant.mlb.com/catcher_framing （一次）
- ランク対象条件: チーム試合あたり6テイク（見逃し）以上

**0.125 run/strike の導出** `[一次: Tango 本人]`:
> called strike の run value は shadow zone 限定で **12.6〜12.7 runs / 100球**。
> "I like round numbers" として 12.5 runs/100球 = **0.125 runs/pitch** に丸めた。
- 出典: https://tangotiger.com/index.php/site/wowy-framing-part-3-of-n-run-value-of-a-called-strike

**⚠ 訂正**: 「shadow zone を8分割し、各エリアのストライク獲得率を平均と比較」という方式は **一次情報で確認できず**。
実際は「投球のゾーン境界からの**距離**に基づく連続確率モデル」（2025年にモデル改訂）。離散8ブロックという理解は不正確。

### 8.2 【最重要】フレーミングの現実的なレンジ

**MLB 単年**:
| 選手 | 年 | Framing Runs |
|---|---|---|
| Patrick Bailey | 2025 | **+25**（MLB首位） |
| Patrick Bailey | 2024 | +16（MLB首位） |
| Francisco Alvarez | 2023 | +13.4 |
| Willson Contreras | 2023 | −10.8 |
| Edgar Quero | 2025 | −13（MLB最下位） |
| Elias Diaz | 2023 | **−18.8**（MLB最下位） |

> MLB.com: "The spread between the best and worst framers is more on the scale of **30 to 40 runs**, or three to four wins."
> （対照的に **ブロッキングの最良-最悪差は約10 runs**）

リーグ標準偏差は PITCHf/x 期で約 13 runs だが、リーグ全体の技術向上に伴い分散は縮小傾向（`[二次]`）。

**NPB（DELTA / 1.02 の独自フレーミング指標）** `[二次: 私設分析サイト]`:
| 選手 | 年 | 値 |
|---|---|---|
| 中村悠平（ヤクルト） | 2023 | +4.0点（前年 **+10.4点**） |
| 坂本誠志郎（阪神） | 2023 | +0.2点 |
| 坂倉将吾（広島） | 2023 | **−7.5点** |

**→ NPB のフレーミングのレンジは MLB より遥かに狭い（概ね ±10 点）。**
NPB 公式のフレーミング公表値は存在しない。DELTA は球種・構え・コース・投手左右・球場・球審・カウントを考慮した機械学習モデルで算出。
- 出典: https://1point02.jp/op/gnav/column/bs/column.aspx?cid=54003

**→ 実測シムの framing max = +26.4 は MLB エリート級（Bailey 2025 の +25 相当）だが、NPB 近似という本プロジェクトの目的関数からは過大。**

### 8.3 年度間相関: フレーミングは守備指標の中で最も安定

| 指標 | year-to-year 相関 |
|---|---|
| **Framing (CAFE 階層ベイズ)** | **0.70 (2012-13) / 0.71 (2013-14)** |
| UZR | ≈0.5 |
| OAA | 0.31（Spearman） |
| DRS | 0.23（Spearman） |

「フレーミングの自己相関 0.5〜0.7 は打者のスラッギング率と同水準」。
- 出典: arXiv:1704.00823 （学術）
- ただし近年はリーグ内平準化により相関自体が低下傾向（`[二次]` THT: R²=0.49 → 0.20）

### 8.4 ブロッキング / 送球 `[一次: MLB.com glossary]`

> "Catcher Blocking Runs converts blocks to runs saved on a **.25 runs/block** basis."
>
> "Catcher Stealing Runs is a translation of Caught Stealing Above Average to a run value on a **.65 runs/CS** basis,
> **the difference between a SB (+.2 runs) and a CS (−.45 runs)**."

**→ `.65 run/CS` の正体は「SB の run value と CS の run value の差」。**
これは §7.2 の `runSB = +0.2` / `runCS ≈ −0.45` と完全に整合する。捕手 rSB を実装する際、
`0.65` を天下り的に置くのではなく `runSB − runCS` から導出すべき。

- ブロッキングの最良-最悪差は **約10 runs**（フレーミングの 30-40 runs より明確に小さい）

### 8.5 BP の CSAA との違い `[二次]`
- **BP CSAA**: 全テイク球（30万球超）を対象に、捕手・投手・打者・球審を**同時に混合モデルで回帰**して捕手固有の寄与を分離
- **Statcast Framing Runs**: shadow zone 中心、球の位置ベースの確率モデル。park / pitcher 補正込み
- 両者は「完全には一致しないがかなり近い」とされるが、**定量的な相関係数は確認できず**

---

## 9. DRS（Defensive Runs Saved）

本プロジェクトは UZR/OAA 方式を採用するため参考情報。ただし **§9.2 は設計判断に直結する**。

### 9.1 成分 `[一次: FanGraphs Library]` — https://library.fangraphs.com/defense/drs/

| 略号 | 定義（原文） | 対象 |
|---|---|---|
| rPM | "evaluates the fielder's range and ability to convert a batted ball to an out" | 範囲を持つ全野手 |
| rSB | "the pitcher's contributions to controlling the running game, and gives the catcher credit for throwing out runners" | 投手 / 捕手 |
| rBU | "evaluates a fielder's handling of bunted balls in play" | 1B / 3B |
| rGDP | "credits infielders for turning double plays" | 2B / SS |
| rARM | "evaluates an outfielder's throwing arm based on how often runners advance on base hits" | 外野手 |
| rHR | "credits the outfielder **1.6 runs per robbed home run**" | 外野手 |

`rGFP` / `rSZ` / `rPOS` / `rTHR` は **一次ページで定義文を確認できず**（二次情報のみ）。

### 9.2 【設計に直結】DRS は責任を1人に集約する `[二次]`

> （2人の外野手の間を抜けた打球の例）"**only the player who was most likely to make the play gets penalized** for not doing so.
> ... if centerfielders typically catch that ball in the gap 60% of the time, but leftfielders just 35% of the time,
> **only the centerfielder gets penalized**."

**→ DRS は「最も捕球確率が高い1人」に責任を集約する。UZR の比例配分（複数野手へ按分）とは方式が異なる。**
（この対比の一次ソース＝Fielding Bible 公式解説は JS 描画で本文取得できず、**二次情報にとどまる**）

**run 換算は固定値ではなく打球ごとの期待アウト率に応じた可変値** `[二次]`:
> "If an out is made on a similar batted ball 25% of the time, a successful play earns 0.75 runs saved,
> where an unsuccessful play loses −0.25."

### 9.3 スケール `[一次]`
| DRS | 評価 |
|---|---|
| +15 | Gold Glove Caliber |
| +10 | Great |
| +5 | Above Average |
| 0 | Average |
| −5 | Below Average |

歴代単年最高: **Andrelton Simmons 2017年 41 DRS**（`[二次: Wikipedia]`）。
「トップクラスの野手は年間 **15〜20 DRS** 程度が典型」。

---

## 10. 未決の疑問（残）

- **Statcast OAA は、安打が落ちたとき「最も捕球確率の高い1人」だけを減点するのか、非ゼロの全野手を減点するのか。**
  一次情報では断定できず。ただし **DRS が明確に「1人に集約」（§9.2）** であり、
  設計上は **「最も p が高い1人に −p を課す」** を採用する（単純・リーグ総和 ≈ 0 を保てる・DRS 流儀と一致）。
- **ポジション補正の分母は 1350 か 1458 か**（§3 注記）。FanGraphs 原典で要再確認。
- `rGFP` / `rSZ` / `rPOS` / `rTHR` の一次定義。
- Statcast framing の連続確率モデルの正確な関数形。
- Bill James Spd 原典6成分の正確な重み付け式（`[確認できず]`）。
- **NPB の実 BABIP 水準**（§11.3 の目標帯を決めるのに必要。本調査では未着手）。

### 10.1 本ドキュメントが扱っていないこと（スコープ外）

req_20260708 line 5 でユーザーは、UZR/OAA の**計算方法（how）**に加えて
**更新タイミング（when）**にも言及していた:

> 「ちなみに試合中の値の調整は前日のでよくて試合終わったらその日の調整をやればいいかなと思ってます」

本ドキュメントは **how（何を計算すべきか）に徹しており、when（リーグ定数の更新頻度）は扱っていない**。
現行実装は `deriveLeagueConstants` の2パス集計でシーズン終了後に一括算出しており、
「試合中は前日のリーグ定数を使う」という設計はまだ検討されていない。**別途、意思決定が必要。**

### 10.2 実装時に確認すべき下流の影響

`assignFielder` を argmax 化すると、その戻り値を消費している箇所が影響を受ける:
- `game.mjs` の `hitFielderPos`（ARM 帰属に使用）
- `resolveBattedBall` の `fielderRangeFor(pos)` コールバック（責任野手が確定する前に呼べなくなる）

→ 各野手の `p_i` を先に全計算してから argmax を取る構造になるため、`fielderRangeFor` の呼び出し順序が変わる。
**乱数消費は変わらない設計にできるが、`npm run verify`（決定論）で必ず確認すること。**

---

## 11. 修正方針（原典に基づく設計案）

> **状態: 2026-07-09 実装完了**（コミット 1984f48 / 7c0702b / 以降）。
> 本節は設計時の記述を残しつつ、実装結果を §11.11 に追記した。

### 11.1 【最重要な気づき】OAA の会計層はすでに正しい。壊れているのは `expOut` の中身だけ

Statcast の catch probability は**野手個人の能力を含まないリーグ共通モデル**であり、
そこからの差分（実結果 − p）が OAA になる。現行実装も

- `expOut`（中立ベースライン）と `effPHit`（個人 Range 補正後）を分けている（`battedBallResult.mjs:177,190`）
- `oaaOuts += actual − expOut`（`game.mjs:625`）

という**構造は原典と一致している**。したがって修正は `expOut` の計算と `assignFielder` に**局所化できる**。
`game.mjs` の累積ロジック、`fielding.mjs` の中心化・run換算は原則そのまま使える。

### 11.2 中核: Distance-Time モデルによる per-fielder 捕球確率

```
1. 各ポジションの守備初期位置を2次元で定義（本塁からの距離 r と spray 角 θ）
2. 打球ごとに、各野手 i について:
   [空中球: LD / FB / PU]
     opportunity distance = 初期位置 → 落下点 − reach
     opportunity time     = hangTime − reaction
     p_i = expit((Smax − reqSpeed) / width)
   [ゴロ: GB]
     迎撃点 = 野手を打球ベクトルへ射影した点（Statcast の "intercept point"）
     ※ 迎撃点での打球高度が gloveHeight を超えるなら頭上を越える ＝ p_i = 0
     p_reach = expit((Smax − 横移動距離 / 打球到達時間) / width)
     p_throw = expit((打者走者の一塁到達時間 − (捕球時刻 + 持ち替え + 送球飛行)) / throwWidth)
     p_i = p_reach × p_throw          ← Statcast infield OAA の4要素すべてを含む
3. pOut = max_i p_i、責任野手 = argmax_i p_i     （§9.2 DRS の流儀）
4. アウト/安打の抽選は、責任野手の個人 Range を反映した p'_j で行う
5. OAA 帰属:  アウト → +(1 − p_j)   /   安打 → −p_j     （p_j はリーグ中立値）
6. run 換算は現行のまま（内野 0.75 / 外野 0.9・§2.4 で一次情報確証済み）
```

**内野で `p_throw` が必須**な理由: Statcast infield OAA の4要素のうち「到達点から塁までの距離」「フォース時の打者走者の足」を
落とすと、内野手が全部捕ってしまう。プロトタイプ v1（到達確率のみ）はゴロ安打率 0.040（現実 0.19）で破綻した。

### 11.3 プロトタイプの検証結果

`thyroxin/research/proto_catchprob2.mjs` を 277,757 打球で実行:

| 指標 | 現行 | 提案 v2 | 備考 |
|---|---|---|---|
| catch prob が両極 (p<0.1 or >0.9) | 17.5% | **70.8%** | 原典どおり両極分布 |
| コイントス帯 (0.3≤p<0.7) | 24.9% | **10.8%** | ここでのみ守備力が効く |
| 構造ノイズ SD (CF) | 10.5 run | **5.8 run** | ほぼ半減 |
| 構造ノイズ SD (3B) | 5.3 run | **2.2 run** | |

**out率の比較**（`compare_models.mjs`・**同一の打球ストリーム 231,446 件で両モデルを並走**）:

| | 現行 | 提案 v2 | 差 |
|---|---|---|---|
| リーグ out率 | 0.711 | **0.737** | +0.026 |
| BABIP 相当 | .289 | **.263** | **−26 ポイント** |
| GB out率 | 0.789 | 0.797 | +0.008 |
| **LD out率** | 0.339 | **0.407** | **+0.068** ← 主犯 |
| FB out率 | 0.844 | 0.875 | +0.031 |
| PU out率 | 0.967 | 0.966 | −0.001 |

**⚠ BABIP が 26 ポイント下がる。これは「微調整」ではなく打球解決エンジンの全面再較正である。**
主犯はライナー（外野手が浅いライナーを捕りすぎる）。`smaxBase` / `width` / `reachM` / 外野の守備位置深さで
調整可能だが、**得点環境そのものが動く**。§11.10 のリスク #1 を参照。

> 補足: 打球種別の安打率（GB 0.203 / FB 0.125 など）は、チューニングノブではなく**幾何から創発する**。
> これが鉄則4（指標を後付けしない）の回復である。ただし創発値を NPB 水準に合わせ込む作業が §11.10 #1。

**関連する発見**: 現行エンジンの**実シーズン BABIP は .310**（3シード平均・`compare_models.mjs`）。
`tools/calibrate.mjs` は BABIP を**表示するだけで PASS/FAIL 判定していない**（`row('BABIP', m.babip, null)`）。
守備指標と同様、**BABIP も較正の門番を通っていない**。
（NPB の実 BABIP 水準は本調査では出典未確認 ＝ **要出典**。目標帯を設ける前に調べること）

**個別打球の挙動（原典との整合）:**
```
EV120 LA18° 60.9m（ユーザー報告のポテンヒット）
   → SS p=0.014 / 2B p=0.014 / CF p=0.000
     責任 = SS、落球時の減点 −0.01   [現行: CF に −0.39]

EV150 LA35° 92.3m センター正面フライ
   → CF p=0.996（落とせば −1.00 ＝ ほぼ1アウト分の大罪）

EV130 LA−8° 遊撃正面ゴロ  → SS p=0.983（捕って当然）
EV145 LA−4° 三遊間の強いゴロ → SS p=0.855 / 3B p=0.936（ここで守備力が効く）
```

**打球種別の安打率が、チューニングノブではなく幾何から創発している。** これは鉄則4（指標を後付けしない）の回復である。

### 11.4 死ぬ config ノブ / 生まれる config ノブ

**削除（創発するので不要）:**
`bb.hitGB` / `bb.hitLD` / `bb.hitFB` / `bb.hitPU` / `bb.evHitW` / `bb.fbHitBonusM` /
`bb.timeDifficultyW` / `bb.timeDifficultyCap` / `bb.outfieldLDTypicalDepthM` / `bb.posTypicalDepthM` /
`field.rangeLogitSlope`（Smax への加算に置換）

**新設（物理量。すべて意味を持ち、出典を持つ）:**
| ノブ | 仮値 | 意味 |
|---|---|---|
| `field.positions` | 3B(34m,−33°) SS(44m,−16°) 2B(44m,+16°) 1B(33m,+35°) LF(88m,−28°) CF(98m,0°) RF(88m,+28°) | 守備隊形 |
| `field.smaxBase` | 6.9 m/s | リーグ平均野手の実効クロージング速度 |
| `field.smaxPerRating` | (要較正) | Range 1pt → Smax の増分 |
| `field.width` | 1.05 m/s | 到達ロジスティックの幅（小さいほど両極化） |
| `field.reactionS` | 0.30 s | 初動までの反応時間 |
| `field.reachM` | 1.7 m | グラブ + ダイブの到達半径 |
| `field.gloveHeightM` | 2.1 m | 内野手の頭上判定 |
| `field.gbSpeedFactor` | 0.80 | ゴロの実効水平速度 / EV |
| `field.transferS` | 0.70 s | 捕球 → リリース |
| `field.throwSpeed` | 32 m/s | 送球速度 |
| `field.runnerToFirstS` | 4.35 s | 打者走者の一塁到達（**打者 speed で可変にすべき**） |
| `field.throwWidth` | 0.22 s | 送球アウトのロジスティック幅 |

**副産物**: `runnerToFirstS` を打者の `speed` で可変にすると、**内野安打が足の速さから自然に湧く**。
現行の `gdp.speedW`（足↔併殺回避の人為的な結線）が不要になる可能性がある。

### 11.5 UZR の成分を FanGraphs 定義に合わせる

```
外野手 UZR = RngR + ErrR + ARM
内野手 UZR = RngR + ErrR + DPR
捕手      = UZR を付けない（framing / blocking / throwing を捕手守備 run として別勘定）
```
- ARM / DPR を WAR の `uzrRuns` に**含める**（現在は表示のみ）
- `field.runPerDP` を 0.45 → **0.40**（FRV 準拠）
- 捕手 framing を UZR に混ぜるのをやめる

### 11.6 ARM を真値の直訳から実イベント創発へ（鉄則4の回復）

現行: `armRuns += (arm − 50) × 0.007` ← 進塁抑止イベントが一切起きていない。

あるべき姿: 単打で二塁走者が三塁を狙う／二塁打で一塁走者が本塁を狙う場面で、外野手の `arm` を
**進塁成功確率と刺殺確率に実際に結線**し、`ARM = リーグ平均の期待失点 − この外野手が実際に許した失点` として創発させる。

> `game.mjs` の `resolveAdv` は現在 `arm` を見ておらず、乱数も消費していない。
> ここを結線すると進塁の実結果が変わる ＝ **得点環境が動き、較正53指標が全面的に動く**。

### 11.7 捕手守備の完成

| 成分 | 素データ | run 換算（FRV・一次） | 状態 |
|---|---|---|---|
| framing | `frameCalls`（一球ごと） | 1 strike = **.125** | ✅ 実装済み・係数も正当 |
| blocking | `wp` / `pb` / `blockOpp`（集計済み） | 1 block = **.25** | ⚠ 未接続 |
| throwing (rSB) | `sbAllowed` / `csMade` | 1 CS = **.65** = `runSB − runCS` | ⚠ 換算式を FRV へ |

**フレーミングは NPB 基準では過大**（§8.2）。シム実測 +26.4 に対し NPB の DELTA 公表値は概ね ±10。
係数 0.125 は正当なので、**「平均からの逸脱コール数」の分布**（`plateAppearance.mjs` の判定モデル）を絞る必要がある。

### 11.8 較正への配線（守備を門番に通す）

**現状、守備指標は較正53指標に1つも入っていない。** `uzrTop` は config に書かれているだけで未参照。
`tools/calibrate.mjs` に以下を追加し、実際に PASS/FAIL 判定する。

| 目標 | 帯 | 根拠 |
|---|---|---|
| `uzrTop`（リーグ最高 UZR・400イニング以上） | **[10, 16]** | MLB「+15=ゴールドグラブ級」。NPB 実測も外崎 +15.4 / 菊池 +12.3 で同水準（§6.2） |
| `uzrBottom`（リーグ最低 UZR） | **[−16, −10]** | 同上（対称） |
| `uzrSd`（規定守備者の UZR 標準偏差） | **[4, 7]**（暫定） | NPB の SD は**確認できず**。構造ノイズ 2〜6 run + 能力差から逆算した暫定値 |
| `framingTop`（捕手フレーミング最高） | **[5, 12]** | NPB: 中村悠平 +10.4（最大級）、坂倉 −7.5（§8.2） |
| `bsrTop`（BsR 最高） | **[6, 9]** | FanGraphs: Excellent +8、「最高でも年間8〜10 が上限」（§7.4） |

**143/162 の比例縮小は不要**（§6.3）。NPB でも +15 前後がトップという実測と一致するため。

### 11.9 単年 UZR のノイズと三層構造

原典（§4）: 単年 UZR の年度間相関 ≈ 0.5、**真の実力推定には約半分に回帰**させるべき。
フレーミングは 0.70 で例外的に安定（§8.3）。

シムは真値を持つため:
- **起用AI / 球団AI が UZR を参照する場合、約50%回帰させた値を使う**のが原典に忠実（鉄則3・三層構造）
- フレーミングは回帰を弱くしてよい（安定指標だから）
- これは「市場の非効率を仕込む」（鉄則5・守備の過小評価）とも整合する

現行実装は `market.wDefMean: 0.62` で守備を過小評価させているが、**回帰による不確実性はモデル化されていない**。

### 11.10 実装リスク

1. **これは「守備の修正」ではなく「打球解決エンジンの書き換え」である。**
   `hitGB/hitLD/hitFB/hitPU` / `evHitW` が消えて創発値になり、**BABIP が実測で 26 ポイント動く**（§11.3）。
   打率・出塁率・得点環境・ERA・53指標のすべてが再較正対象。意思決定の規模は「係数いじり」ではない。
2. **鉄則7「1年目シム不変」が守れない。** これは加齢等の多年要素ではなく、シムの中核モデルの変更だから当然。
   ただし **`npm run verify`（決定論）は維持しなければならない**。
3. 乱数消費順序が変わる。決定論は保たれるが、既存セーブデータとの互換は失われる。
4. ARM の実イベント化（§11.6）は得点環境を動かす。**§11.2 とは別コミットに分けるべき。**

---

## 12. 変更履歴

- 2026-07-09: 初版。
  - MLB 一次情報（UZR / OAA / FRV / posAdj / 信頼性）を deep-research の敵対的検証（3-0）で確定
  - 現行実装を実測（UZR分布・expOut分布・担当打球数・構造ノイズ）し、根本原因を §5.2〜5.4 に特定
  - NPB 分布（§6）・走塁指標（§7）・捕手守備（§8）・DRS（§9）を追加調査
  - Distance-Time モデルの設計案を §11 に記述し、プロトタイプで数値検証
  - 計測/検証スクリプト: `measure_uzr.mjs` / `measure_expout.mjs` / `measure_chances.mjs` / `proto_catchprob2.mjs`

### 11.11 実装結果（2026-07-09）

3コミットで §11.2 / §11.5-11.8 を実装した。

| コミット | 内容 |
|---|---|
| `1984f48` | 中核: Distance-Time モデル（`src/sim/fieldingGeometry.mjs` 新設） |
| `7c0702b` | ARM の実イベント創発 ＋ UZR構成を FanGraphs 定義へ ＋ 捕手守備の完成 |
| （本コミット） | BABIP と守備指標を較正の門番に接続 |

**設計時の予測と実装結果の差分（重要）:**

1. **「BABIP が 26 ポイント下がる」は誤りだった。**
   プロトタイプの −26pt は、後方移動ペナルティ（direction）が無い**未較正パラメータの artifact** だった。
   実際の物理ノブ（`smaxBase` / `backPenalty` / `gapDistM`）で、書き換えは**得点環境中立に着地できた**。
   BABIP は独立ノブではなく AVG/K%/HR から算術的に決まる**従属変数**であり、
   「53指標を保ったまま BABIP だけ .290 にする」ことは原理的に不可能。

2. **内野手が頭上のライナーへ走り戻って捕ってしまう**という欠陥がプロトタイプにあり、
   Statcast が 2017年に `direction` を追加した理由がそのまま再現された。`backPenalty` で解決。

3. **`assignFielder`（OAA の責任野手）と「打球を拾う外野手」（ARM の主語）は別概念**だった。
   ゴロは内野手に OAA 責任が付くが、三遊間を抜ければ球を拾うのは LF である。
   `retrievingOutfielder()` を別に用意した。

**最終的な実測値（12シード平均・較正の門番）:**

| 指標 | 実測 | 帯 | 参照 |
|---|---|---|---|
| UZR最高 | **15.85** | [11, 20] | FanGraphs +15＝ゴールドグラブ級 / NPB 外崎 +15.4 |
| UZR最低 | **−17.89** | [−22, −11] | FanGraphs −15＝劣悪 |
| UZR標準偏差 | **5.33** | [4, 7] | 現実の規定守備者 ≈5 |
| ARM上位(外野) | **5.80** | [5, 12] | — |
| 外野補殺リーダー | **6.9** | [5, 11] | NPB.jp 2025: セ6 / パ9 |
| フレーミング上位 | **10.4** | [6, 15] | NPB 中村悠平 +10.4 (2022) |
| BABIP | **0.308** | [0.298, 0.318] | ※下記の注意 |

**較正のために動かしたノブ（すべてコメントに理由を明記）:**
`field.smaxBase 6.82` / `field.smaxPerRating 0.022` / `bb.gapDistM 86.0→76.0` /
`bunt.attemptBase 0.145→0.17` / `hrScale 0.966→0.9695` / `field.runPerDP 0.45→0.40`

---

## 12. 【未解決・ユーザー判断待ち】得点環境が NPB の別時代に較正されている

実装中に発見した、**守備とは独立の大きな問題**。

NPB.jp 公式および Yakyu Cosmopolitan の生データから直接集計した NPB リーグ平均:

| 年 | AVG | OBP | SLG | OPS | BABIP | K% | HR/tm | R/tm/g |
|---|---|---|---|---|---|---|---|---|
| 2023 | .243 | .308 | .358 | .666 | .288 | .194 | 104.2 | 3.48 |
| 2024 | .243 | .304 | .344 | .648 | .290 | .188 | 81.2 | 3.29 |
| 2025 | .244 | .305 | .351 | .655 | .292 | .194 | 91.3 | 3.29 |
| **シムの目標帯** | .255–.262 | .320–.328 | .390–.410 | .715–.735 | .298–.318 | .180–.205 | 110–130 | 3.9–4.3 |

- 出典: https://npb.jp/bis/2025/stats/tmb_c.html 、https://npb.jp/bis/2025/stats/tmb_p.html （一次）
- 出典: https://www.yakyucosmo.com/batting-stats/2023-npb-team/ 等（二次・NPB.jp生データ由来）

**シムの目標帯一式は NPB 2015–19 の「飛ぶボール」時代の得点環境**であり、
三原則②「現状のセパ両リーグ近似」に照らすと、**現状（2023–25 の低反発球時代）とは別の時代を近似している。**

これを 2023–25 へ再ベースラインするなら `evBase` / `hrScale` / linear weights / 目標帯一式に及ぶ大工事になる。
**守備の作業とは独立の意思決定であり、本ドキュメントでは判断しない。**
（フェーズD の「時代トレンド」機能で低反発期を表現する道もある）

---

## 13. 変更履歴（追記）

- 2026-07-09（実装）: §11 の設計を3コミットで実装。守備指標が初めて較正の門番を通った（62指標 PASS）。
  §12 に「得点環境が NPB の別時代に較正されている」問題を記録。

# セイバーメトリクス指標 総覧（一次情報リファレンス）

作成: 2026-07-10 / 調査手法: 8領域を並行してサブエージェントが一次情報源へ直接アクセスし収集

このドキュメントは **FanGraphs / MLB.com Statcast / Baseball Savant / Baseball Prospectus / Tom Tango が扱う野球指標を網羅**する。
このゲームに実装されていない指標も含む。**実装を変える前にここを参照し、出典のない数値をコードに書かない。**

守備指標だけは分量が多いため別ファイルに詳細がある: **`fielding_metrics_reference.md`**（本書 §5 は要約＋差分）。

---

## 0. このドキュメントの読み方

### 0.1 出典のティア

| ティア | 定義 |
|---|---|
| **一次** | 指標の考案者・公表主体そのもの（FanGraphs Library、MLB.com Glossary、Baseball Savant、Tom Tango、Baseball Prospectus、Baseball-Reference、Sports Info Solutions） |
| **二次** | 一次情報を解説する専門媒体（Pitcher List、The Hardball Times、報道） |
| **未検証** | 個人ブログ・Wikipedia 単独ソース。**数値の根拠にしない** |

### 0.2 「確認できず」の意味

**推測で式や数値を書かない**というルールを厳守した。調査の結果、一次情報に到達できなかった項目は
すべて「**確認できず**」と明記してある。これは調査の失敗ではなく、**その値をコードに書いてはいけない**という警告である。

とくに以下は「原理的に非公開」であることが確認された:
- BIS の Soft%/Med%/Hard% の分類閾値（FanGraphs 自身が「BIS の企業秘密」と明記）
- SIERA の**現行版**係数（FanGraphs 自身が "Interested in calculating SIERA yourself? Good luck." と明記）
- Stuff+ / Location+ / Pitching+ / PitchingBot のモデル内部
- UBR / wGDP / DRS / FRAA / RDA / PADE の内部計算式

### 0.3 実装状況の凡例

| 記号 | 意味 |
|---|---|
| ✅ | このシムに実装済み。原典と式が一致することを確認した |
| 🟡 | 実装済みだが、原典と差異がある（または近似）。詳細は §10 |
| ⬜ | 未実装（素データは揃っている＝実装可能） |
| ⛔ | 未実装かつ実装困難（素データが無い / 原典の式が非公開 / このシムに概念が無い） |

### 0.4 調査時のアクセス障害（重要）

- `www.mlb.com/glossary/*` は WebFetch に対して**一貫して 406 を返す**。原文は curl（ブラウザ UA）や検索エンジン経由で取得した。
- `baseball-reference.com` は **403**。B-R 固有の式（OPS+ / ERA+ / bWAR 投手版）は一次原文を確認できていない。
- MLB / NPB の公式規則 PDF は取得できたが、本環境ではテキスト抽出できず、転載サイト（二次）で代替した。

---

## 1. 打撃指標（伝統系・wOBA系）

### 1.1 伝統系

| 指標 | 式 | 実装 |
|---|---|---|
| AVG | `H / AB` | ✅ |
| OBP | `(H + BB + HBP) / (AB + BB + HBP + SF)` | ✅ |
| SLG | `TB / AB`、`TB = 1B + 2×2B + 3×3B + 4×HR` | ✅ |
| OPS | `OBP + SLG` | ✅ |
| ISO | `SLG − AVG`（＝ `(2B + 2×3B + 3×HR) / AB`） | ✅ |
| BABIP | `(H − HR) / (AB − K − HR + SF)` | ✅ |
| XBH | `2B + 3B + HR` | ✅ |
| BB% | `BB / PA` | ✅ |
| K% | `K / PA` | ✅ |
| K−BB% | `K% − BB%` | ✅ |

- 出典: https://library.fangraphs.com/offense/iso/ 、https://library.fangraphs.com/offense/babip/ 、https://library.fangraphs.com/offense/rate-stats/ （すべて一次）
- OBP に**失策出塁・野選・振り逃げは算入しない**（MLB.com Glossary）
- **AVG / OBP / SLG / OPS の「優秀/平均/劣悪」の目安表は FanGraphs にも MLB.com にも存在しない**（確認できず）

**解釈目安（FanGraphs Library・一次）**

| 評価 | ISO | BB% | K% | wOBA | wRAA | wRC(600PA) | wRC+ |
|---|---|---|---|---|---|---|---|
| Excellent | .250 | 15.0% | 10.0% | .400 | 40 | 105 | 160 |
| Great | .200 | 12.5% | 12.5% | .370 | 20 | 90 | 140 |
| Above Average | .170 | 10.0% | 16.0% | .340 | 10 | 75 | 115 |
| Average | .140 | 8.0% | 20.0% | .320 | 0 | 65 | 100 |
| Below Average | .120 | 7.0% | 22.0% | .310 | −5 | 60 | 80 |
| Poor | .100 | 5.5% | 25.0% | .290 | −10 | — | — |
| Awful | .080 | 4.0% | 27.5% | — | −20 | — | — |

打者 BABIP のリーグ平均は約 **.300**。安定化に約 **800打球（実質2シーズン）** を要し、4000打席の経験者でも天井は概ね **.380**。

### 1.2 打点(RBI)がつかないケース `[一次: 公式規則 9.04]`

> "The Official Scorer shall not credit a run batted in (1) when the batter grounds into a **force double play** or a **reverse-force double play**; or (2) when a fielder is charged with an **error** because the fielder muffs a throw at first base that would have completed a force double play."

**→ 併殺打での得点、および一塁悪送球（併殺崩れ）での得点には RBI がつかない。** ✅（実装済み）

### 1.3 wOBA

```
wOBA = (wBB×uBB + wHBP×HBP + w1B×1B + w2B×2B + w3B×3B + wHR×HR)
       / (AB + BB − IBB + SF + HBP)
```
- `uBB = BB − IBB`（敬遠は打者の技量でない）
- 係数は**年ごとに変わる**（§9 に FanGraphs Guts! の実値）
- リーグ平均 wOBA が**リーグ平均 OBP と同じスケール**になるよう毎年再調整される
- 出典: https://library.fangraphs.com/offense/woba/ （一次）
- 実装: ✅（`LINEAR_WEIGHTS` × `wobaScale` の形。§10.1 に検算）

### 1.4 wRAA / wRC / wRC+ / Off / Batting Runs

```
wRAA = ((wOBA − lgwOBA) / wOBAScale) × PA
wRC  = (((wOBA − lgwOBA) / wOBAScale) + lgR/PA) × PA
wRC+ = (((wRAA/PA + lgR/PA) + (lgR/PA − PF × lgR/PA)) / (AL/NL の投手を除く wRC/PA)) × 100

Batting Runs = wRAA
             + (lgR/PA − PF×lgR/PA) × PA            ← パーク補正
             + (lgR/PA − 非投手 wRC/PA) × PA         ← リーグ補正
Off = Batting Runs + BsR
```
- wRAA は **park-neutral**（パーク補正されていない）。約 **10 wRAA = 1勝**
- wRC+ は常にリーグ平均 = 100。**ポジション補正は入らない**（WAR で別途加算）
- パークファクターは選手が本拠地で約半分の試合を戦うため、実務上「半分だけ」適用する
- 出典: https://library.fangraphs.com/offense/wraa/ 、`/wrc/` 、`/off/` （一次）
- 実装: wRAA ✅ / wRC ✅ / wRC+ ✅（park補正版 `wrcPlusPF` あり）/ Off ⬜（BsR と wRAA は別々に出している）

### 1.5 OPS+ 🟡

`OPS+ = 100 × (OBP/lgOBP + SLG/lgSLG − 1) / BPF`

**⚠ 一次原文を確認できていない。** Baseball-Reference の該当ページは 403、MLB.com は 406。
BPF（パークファクター）が式のどこに掛かるか（全体を割るのか、lgSLG にのみ掛けるのか）に**表記のバリエーションがある**。
実装する場合は要再検証。実装: 🟡（`opsPlus` あり。BPF の入り方は要確認）

### 1.6 打球方向・質（BIS 系）

| 指標 | 式 | 実装 |
|---|---|---|
| GB% / LD% / FB% | `該当打球数 / インプレー打球数` | ✅ |
| IFFB% | `内野フライ / **フライ総数**`（分母が違う） | ⬜ |
| HR/FB | `HR / FB`（**式の原文は確認できず**） | ✅（投手側） |
| Pull% / Cent% / Oppo% | フィールドを **30度ずつ3等分**。本塁打も含む | ✅ |
| Soft% / Med% / Hard% | **確認できず（BIS の企業秘密）** | ⛔ |

**Pull%/Cent%/Oppo% の解釈目安**（一次）: 平均 40/35/25、極端な引っ張り 55/25/20、極端な流し 30/30/40。
原文: "There isn't an ideal distribution."

**⚠ 最重要の注意**: BIS の **Hard%** と Statcast の **HardHit%** は**まったく別物**。
- Hard%: BIS のビデオスカウトが滞空時間・落下地点・軌道から**目視で主観分類**。閾値は非公開
- HardHit%: **打球初速 95 mph 以上**という実測の客観閾値

数値を比較してはならない。

### 1.7 規律系（Plate Discipline）

| 指標 | 式 | リーグ平均 | 実装 |
|---|---|---|---|
| O-Swing% | ゾーン外スイング / ゾーン外投球 | ~30% | ✅ |
| Z-Swing% | ゾーン内スイング / ゾーン内投球 | ~65% | ✅ |
| Swing% | 総スイング / 総投球 | ~46% | ⬜ |
| O-Contact% | ゾーン外コンタクト / ゾーン外スイング | ~66% | ⬜ |
| Z-Contact% | ゾーン内コンタクト / ゾーン内スイング | ~87% | ⬜ |
| Contact% | 総コンタクト / 総スイング | ~80% | ✅ |
| Zone% | ゾーン内投球 / 総投球 | ~45% | ✅ |
| F-Strike% | 初球ストライク / 打席 | ~59% | ✅ |
| SwStr% | 空振り / **総投球** | ~9.5% | ✅ |
| CSW% | (見逃しストライク + 空振り) / 総投球 | ~28.7% | ✅ |

- 出典: https://library.fangraphs.com/offense/plate-discipline/ （一次）
- **⚠ CSW% は FanGraphs / MLB / Savant の公式指標ではない。** 2018年に **Pitcher List** の Nick Pollack と Alex Fast が考案した二次指標。
  原文: "CSW rate does not correlate to ERA"（ERA との相関はない）。安定するのに約10先発分を要する。
- Contact% と SwStr% は**分母が違う**（前者はスイング数、後者は総投球数）

### 1.8 Clutch（打者・投手共通） ✅

```
Clutch = (WPA / pLI) − WPA/LI
```
- `WPA/pLI`: シーズン総 WPA を選手の平均レバレッジ（pLI）で割った値
- `WPA/LI`: **各プレーごとに WPA を そのプレーの LI で割った値の総和**（← 総WPA÷平均LI とは数学的に別物）

この2つの違いが Clutch を正しく理解する鍵。解釈目安: Excellent 2.0 / Great 1.0 / Average 0.0 / Awful −2.0。
**予測力に乏しく、記述的な指標**である。シーズンをまたいで高い Clutch を維持する選手は稀。

- 出典: https://library.fangraphs.com/misc/clutch/ （一次）
- 実装: ✅ `clutch: div(wpa, div(liSum, pa)) - wpaLiSum`

---

## 2. 打撃指標（Statcast 打球・スイング系）

### 2.1 Barrel（バレル）★ ✅

**定義**: EV と LA の組み合わせが、2015年以降「最低でも打率 .500・長打率 1.500」を記録している打球タイプ。

| EV | Barrel になる LA 範囲 |
|---|---|
| **98 mph 未満** | **Barrel になり得ない** |
| 98 mph | 26–30° |
| 99 mph | 25–31° |
| 100 mph | 24–33° |
| 100 mph 超 | 1 mph ごとに範囲が **さらに 2〜3° 拡大** |
| **116 mph 以上** | **8–50°**（この閾値で頭打ち） |

- 2016年の実績: Barrel 認定打球は 打率 **.822** / 長打率 **2.386**
- **101〜115 mph の各 mph 刻みの正確な LA 上下限の数表は、一次情報に存在しない**（グラフィックのみ）＝確認できず
- 出典: https://www.mlb.com/glossary/statcast/barrel （一次・本文全文確認済み）
- 実装: ✅ `isBarrel(evKmh, laDeg, m)` が「98mph 必須 + 超過 mph ぶんの線形拡大 + 8-50° でクリップ」を実装

### 2.2 打球の閾値

| 指標 | 定義 | 実装 |
|---|---|---|
| **Hard Hit** | EV **95 mph 以上** | ✅ |
| **HardHit%** | (EV≥95mph の打球) / 総打球 | ✅ |
| **Sweet Spot%** | LA **8–32°** の打球割合 | ✅ |
| **Average EV (aEV)** | 全 EV の合計 ÷ **全 BBE 数**（打席数ではない） | ✅ |
| **Adjusted EV** | `mean( max(88, 実測EV) )` — 弱い打球の影響を抑える | ⬜ |
| **EV50** | 打者=速い方50%の平均 / 投手=遅い方50%の平均 | ⬜ |
| **Max EV** | 最速の EV。**文章化された公式定義は存在しない** | ✅ |

**Hard Hit の 95mph 閾値の根拠**（2018年データ）: 95mph以上 = 打率 .524 / 長打率 1.047 / wOBA .653、95mph未満 = 打率 .219 / 長打率 .259 / wOBA .206。

**Batted Ball Event (BBE)**: 結果を生んだ打球すべて。**フェアボールは全て BBE。アウトになったファウルフライも含む。**
多くの指標の分母。ただし平均 LA の算出時は**バントを除外**する。

### 2.3 打球種別の LA 境界（Statcast） ✅

| 種別 | Launch Angle |
|---|---|
| Ground ball (GB) | **10° 未満** |
| Line drive (LD) | **10–25°** |
| Fly ball (FB) | **25–50°** |
| Pop up (PU) | **50° 超** |

- 出典: https://www.mlb.com/glossary/statcast/launch-angle （一次）
- **このシムの `battedType()` はこの境界と完全一致している。** ✅
- MLB.com 自身が "a general guideline" と表現しており、**厳密な分類アルゴリズム仕様（EV や滞空時間を併用するか）は非公開**
- **BIS の分類（人間の目視）と Statcast の分類（LA の数値境界）は方法論が違い、同じ打球で判定が食い違う**

### 2.4 期待値系

| 指標 | 定義 | 実装 |
|---|---|---|
| **xBA** | 打球ごとに EV/LA から類似打球の Hit Probability を割り当てて集計 | ✅ |
| **xSLG** | 同様に塁打ベースの期待値。**塁打換算の重み付けは非公開** | ✅ |
| **xwOBA** | **打席全体**（実際の K/BB/HBP を合算）。係数は通常の wOBA と同一 | ✅ |
| **xwOBACON** | xwOBA から K/BB/HBP を除いた「打球のみ」版 | ⬜ |
| **xISO** | **Statcast 公式指標ではない**（Savant に非掲載）。FanGraphs 系の独自指標 | ⛔ |

**⚠ xwOBA が Sprint Speed を使うのは全打球ではない** `[一次]`:
> "For the majority of batted balls, this is achieved using only exit velocity and launch angle.
> As of 2019, **'topped' or 'weakly hit' balls** also incorporate a batter's seasonal Sprint Speed."

モデル手法（2019年時点）: 弱い打球・浅い内野フライ・ゴロに **GAM**、ライナー・フライに **k-NN（約400の最近傍打球）**。
現行モデルと同一かは確認できず。

- 出典: https://www.mlb.com/glossary/statcast/expected-woba 、https://technology.mlblogs.com/an-introduction-to-expected-weighted-on-base-average-xwoba-29d6070ba52b （一次）

### 2.5 スイング系（Bat Tracking・2024-2025 導入） ⛔

このシムにはスイング軌道の概念が無いため、いずれも未実装。

| 指標 | 定義 |
|---|---|
| **Bat Speed** | インパクト時のバットのスイートスポットの速度。**バット先端から6インチの位置**で計測 |
| **Swing Length** | バレルが移動した総距離（フィート）。トラッキング開始（約150ms前）からインパクトまで |
| **Fast Swing Rate** | Bat Speed **75 mph 以上**のスイングの割合。75mph = スイング単位の生産性がリーグ平均に達する水準 |
| **Squared-Up%** | 実現EV ÷（Bat Speed と球速から物理的に決まる**理論最大EV**）。**80%以上**なら "squared-up" |
| **Blast%** | **`squared-up% × 100 + bat speed ≥ 164`**（＝両者の平均が82以上） |
| **Attack Angle** | インパクト時にバットのスイートスポットが進む**垂直**角度。**5〜20° が Ideal** |
| **Attack Direction** | 同・**水平**角度（PULL / OPPO 方向） |
| **Intercept Point** | バットがボールに最も近づいた地点。リーグ平均は打者の重心から前方 **30インチ**、本塁打時は **36〜38インチ** |
| **Swing Path Tilt** | コンタクト直前 40ms のバット軌道の地面に対する傾き |

- Squared-up 打球 = 打率 .371 / 長打率 .656、非 squared-up = 打率 .126 / 長打率 .142
- Blast 打球の平均 EV 103.5mph、HardHit率 99.9%、Barrel率 28%
- 「competitive swings」= 速い方 90% ＋「EV 90mph以上かつ Bat Speed 60mph以上」のスイング

### 2.6 飛距離・方向

| 指標 | 定義 | 実装 |
|---|---|---|
| **Projected HR Distance** | 障害物が無ければ到達した飛距離。**本塁打のみ**。放物線を外挿 | 🟡 |
| **Hit Distance (DST)** | 打球が実際に到達した地点までの距離（地面・観客席・壁・グラブ）。**全打球** | ✅ |
| **Launch Direction / Spray Angle** | **MLB 公式の定義ページが存在しない**（確認できず） | ✅（独自定義） |
| **Pull% / Straightaway% / Oppo%（Statcast版）** | Savant に列は実在するが、**左右打席ごとの角度境界は非公開** | ✅（30度3等分・BIS 準拠） |

このシムは HR 判定用の `hrDist` と落下点用の `distanceM` を分離しており、Statcast の
「Projected HR Distance（外挿）と Hit Distance（実測終着点）は別物」という区別と同型。

---

## 3. 投球指標（伝統系・ERA推定系）

### 3.1 伝統系

| 指標 | 式 | 実装 |
|---|---|---|
| ERA | `ER × 9 / IP` | ✅ |
| RA9 | `R × 9 / IP`（**自責点でなく総失点**） | ⬜ |
| WHIP | `(BB + H) / IP` | ✅ |
| K/9, BB/9, HR/9 | `値 × 9 / IP` | ✅ |
| K%, BB% | `K / TBF`, `BB / TBF`（**分母は打者数**） | ✅ |
| K−BB% | `K% − BB%` | ✅ |
| BABIP(投手) | `(H − HR) / (AB − K − HR + SF)` | ✅ |
| LOB% | `(H + BB + HBP − R) / (H + BB + HBP − 1.4×HR)` | ✅ |
| GB/FB | `GB / FB` | ⬜ |
| HR/FB | `HR / FB` | ✅ |
| QS | `IP ≥ 6 かつ ER ≤ 3` | ✅ |

- IP は `アウト数 / 3`。**FanGraphs の ERA ページ自体にこの式の明記は無い**（確認できず）
- K/9・BB/9 は分母がアウト（IP）、K%・BB% は分母が打者数。**後者の方が優れる**（FanGraphs の見解）
- **H/9 は FanGraphs Library にページが存在しない**（確認できず）

**解釈目安（FanGraphs Library・一次）**

| 評価 | ERA | WHIP | K/9 | BB/9 | K% | BB% | LOB% | FIP | xFIP | SIERA |
|---|---|---|---|---|---|---|---|---|---|---|
| Excellent | 2.50 | 1.00 | 10.0 | 1.5 | 27.0% | 4.5% | 80% | 3.20 | 2.90 | 2.90 |
| Great | 3.00 | 1.10 | 9.0 | 1.9 | 24.0% | 5.5% | 78% | 3.50 | 3.20 | 3.25 |
| Above Average | 3.40 | 1.20 | 8.2 | 2.5 | 22.0% | 6.5% | 75% | 3.80 | 3.50 | 3.75 |
| Average | 3.75 | 1.30 | 7.7 | 2.9 | 20.0% | 7.7% | 72% | 4.20 | 3.80 | 3.90 |
| Below Average | 4.00 | 1.40 | 7.0 | 3.2 | 17.0% | 8.0% | 70% | 4.40 | 4.10 | 4.20 |
| Poor | 4.30 | 1.50 | 6.0 | 3.5 | 15.0% | 8.5% | 65% | 4.70 | 4.40 | 4.50 |
| Awful | 4.60 | 1.60 | 5.0 | 4.0 | 13.0% | 9.0% | 60% | 5.00 | 4.70 | 5.00 |

- リリーバーは平均して ERA が 0.50 低く、K/9 が約3%高い。SIERA はリリーフ転向で平均 0.37 低下
- LOB% のリーグ平均は 70〜72%。**奪三振の多い投手は平均より高い LOB% を持続しやすい**
- 投手 BABIP はリーグ平均 .300、多くの投手は .290〜.310 に収束。**予測力を持つには約2,000打球（約3シーズン）を要する**

### 3.2 セーブ（SV）の成立条件 `[一次: 公式規則 9.19]` ✅

**構造上は「必須3条件 + 選択1条件」の計4条件**（俗に言う「3条件」とはズレがある）:

1. 必須: 自チームが勝った試合を**締めくくった**投手である
2. 必須: **勝利投手ではない**
3. 必須: 最低 **1/3 イニング**を投げた
4. 選択（いずれか1つ）:
   - **3点差以内のリードで登板し、最低1イニングを投げる**
   - **同点走者が塁上・打席・ネクストバッターズサークルにいる状態**で登板する
   - **最低3イニング**を投げる

- **⚠ 条項番号**: 現行 MLB 公式規則では **Rule 9.19**。「10.19」は旧版の番号。
- 公式統計としての採用は **1969年**。

### 3.3 ホールド（HLD） 🟡

**ホールドは MLB の公式統計ではない**（"The hold is not an official Major League Baseball statistic"）。
1986年に John Dewan と Mike O'Donnell が考案。ESPN / MLB.com（1999年以降）が掲載。

成立条件: ①セーブ状況で登板 ②最低1アウトを記録 ③リードを保持したまま降板し、セーブは記録しない。
降板後に後続投手がリードを失っても、既に記録されたホールドは取り消されない。

- 出典: Wikipedia（二次）。**MLB.com Glossary 本文は 406 で取得できず**

### 3.4 FIP ✅

```
FIP  = (13×HR + 3×(BB + HBP) − 2×K) / IP + cFIP
cFIP = lgERA − ((13×lgHR + 3×(lgBB + lgHBP) − 2×lgK) / lgIP)
```
cFIP は**リーグ全体の FIP がリーグ平均 ERA と一致するように毎年算出**される定数。実値は §9。

起源は Voros McCracken の **DIPS 理論**（打球がフィールドに入った後の結果を投手は再現的にコントロールできない）。
**「Tom Tango が考案」という説明は FanGraphs の FIP ページ本文には無い**（確認できず）。

- 出典: https://library.fangraphs.com/pitching/fip/ （一次）

### 3.5 xFIP ✅

```
xFIP = (13×(FB × lgHR/FB%) + 3×(BB + HBP) − 2×K) / IP + 定数
```
被本塁打を「リーグ平均の HR/FB 率をその投手のフライ数に当てはめた期待値」に置き換える。
リーグ平均 HR/FB は典型的に **9〜10%**。

**⚠ フライ数に IFFB（内野フライ）を含めるか除外するかは、一次資料に明記が無い**（確認できず）。

考案者は The Hardball Times の Dave Studeman。「あらゆる投球指標の中で将来 ERA との相関が最も高い部類」。

### 3.6 SIERA ✅（ただし重大な注記あり）

**2010年 Baseball Prospectus オリジナル版（Eric Seidman & Matt Swartz）の完全な式**:

```
SIERA = 6.145
      − 16.986 × (SO/PA)
      + 11.434 × (BB/PA)
      −  1.858 × ((GB − FB − PU)/PA)
      +  7.653 × (SO/PA)²
      ±  6.664 × ((GB − FB − PU)/PA)²      ← 符号は netGB の符号に従う
      + 10.130 × (SO/PA) × ((GB − FB − PU)/PA)
      −  5.195 × (BB/PA) × ((GB − FB − PU)/PA)
```

**⚠ 極めて重要な留保**: 上記は 2010年 BP 版（bpSIERA）の係数。
FanGraphs は 2015年に **"New SIERA"** として再構築・再較正しており、
**FanGraphs Library ページ自身が「自分で計算したい？ 幸運を祈る（"Interested in calculating SIERA yourself? Good luck."）」と明言して完全な式を公開していない。**
**現行版の正確な係数は確認できず。**

- 出典: https://www.baseballprospectus.com/news/article/10027/introducing-siera-part-1/ （一次・原典）
- 実装: ✅ このシムは 2010年 BP 版の係数をそのまま使い、`netGB × |netGB|` として**符号可変の ± 項も正しく再現**している

### 3.7 kwERA ✅

```
kwERA = 5.40 − 12 × (K% − BB%)     ※ 定数 5.40 は基準値。実運用では毎年リーグ平均 ERA に合わせて調整
```
翌年 ERA との R²: SIERA 0.158 > GBkwERA 0.154 > (FIP+xFIP)/2 0.138 > **kwERA 0.136** > xFIP 0.131 > FIP 0.124

- 出典: The Hardball Times（一次・FanGraphs系列）。**考案者クレジットは確認できず**
- 実装: ✅

### 3.8 xERA / tERA

| 指標 | 状態 |
|---|---|
| **xERA** | xwOBA を **ERAスケールへ 1:1 変換**したもの。**変換係数は一次情報に無い**（確認できず）。⛔ |
| **tERA / tRA** | StatCorner（Graham MacAree）考案。**FanGraphs は式を公開していない**（確認できず）。⛔ |

xERA は「予測的」でなく「記述的」な指標。実 ERA との乖離が大きい場合は、その原因（守備・球場・運）を個別に調査すべき。

### 3.9 ERA- / FIP- / xFIP- ✅

```
ERA- = 100 × [(ERA + (ERA − ERA × (PF/100))) / lgERA]
```
100 = 平均、**低いほど良い**（打撃指標と逆）。

**原典の具体例**: 2014年 Clayton Kershaw — ERA 1.77、PF 96、NL平均ERA 3.66 → `100 × [(1.77 + (1.77 − 1.77×0.96)) / 3.66] = 50`

- 出典: https://library.fangraphs.com/pitching/era-fip-xfip/ （一次）
- 実装: ✅（`eraMinus` / `fipMinus` / `xfipMinus` と park補正版 `*PF`）

### 3.10 Game Score ⬜

**Bill James オリジナル版（1980年代）**:
```
GS = 50 + アウト数 + 2×(4回終了後の完了イニング数) + K − H − 4×ER − 2×非自責点 − BB
```
**Tom Tango 版（Game Score v2.0）**:
```
GSv2 = 定数 + 2×アウト数 + K − 2×BB − 2×H − 3×R − 6×HR
```
定数は毎年リーグ平均が 50 になるよう調整。

解釈: 0-10 Unspeakable / 10-20 Awful / 20-30 Bad / 30-40 Poor / 40-50 Below Average / 50-60 Above Average / 60-70 Good / 70-80 Great / 80-90 Excellent / 90+ 傑出。

### 3.11 Pace ⬜

`Pace = (打席の最初の投球と最後の投球の時刻差) / (投球数 − 1)`

牽制球やマウンド訪問の時間は含まない。
**FanGraphs 自身が「Pace が実際の成績に影響するという証拠はほとんどなく、雑学（Fun Fact）程度の価値」と明言している。**

解釈目安: Fast 20.0秒 / Above Average 20.5 / Average 21.5 / Below Average 22.5 / Slow 23.5

### 3.12 QS の批判 `[二次]`

1985年に John Lowe（Philadelphia Inquirer）が考案。
- 批判1: 6回3失点 = ERA 4.50 は基準として緩い（Tim McCarver）
- 批判2: 完投4失点（ERA 4.00）の投手より、6回3失点の投手が優遇される逆転現象
- 反論: 1984〜1991年の実データでは **QS 達成試合の平均 ERA は 1.91**
</content>
</invoke>

---

## 4. 投球指標（Statcast・球種評価）

このシムには一球ごとの球質（回転・変化量）の概念が無いため、この領域はほぼ未実装（⛔）。

### 4.1 球質

| 指標 | 定義 | 典型値 |
|---|---|---|
| **Spin Rate** | リリース時のボールの回転数（rpm） | 用例に 2,500 rpm |
| **Spin Axis** | 2D の X-Z 平面上の回転軸（0〜360°）。**180° = 純粋なバックスピンのフォーシーム** | — |
| **Active Spin（Spin Efficiency）** | **移動に実際に寄与しているスピンの割合**。純粋なトップ/バックスピンなら100%。ジャイロスピンは移動にほぼ寄与しない。**算出式は非公開** | — |
| **Extension** | 投手板前端からリリースポイントまでの距離（ft） | MLB平均 **6.3 ft** → 実質54ftからリリース |
| **Arm Angle**（2024公開） | 投球腕の肩とリリース時ボールを結ぶ線と地面のなす角。**0°=完全サイドスロー、90°=完全オーバースロー** | — |
| **Movement vs Average** | **球速±2mph・Extension/リリース位置±0.5ft** の同条件球種群と比較した差分（インチ） | — |

**⚠ Pitch Movement の解釈は球種で逆になる** `[一次]`: 変化球・オフスピードは垂直移動量が大きいほど「より落ちる」が、
フォーシームは垂直移動量が大きい（バックスピンで重力より落ちにくい）ほど「より浮き上がる（伸びる）」。

**⚠ "Induced Vertical Break (IVB)"** という用語は広く流通しているが、**MLB.com Glossary 本文に正式な定義文は存在しない**（確認できず）。

### 4.2 評価モデル ⛔

| 指標 | 定義 | 内部式 |
|---|---|---|
| **Pitch Value (wFB/wSL/wCT/wCB/wCH/wSF/wKN, /C版)** | カウント遷移ごとの**得点期待値の変化**を、その球で使われた球種に割り当てて合算。/C 版は100球あたりに正規化 | 公開 |
| **Run Value (RV) / RV per 100**（Statcast） | `delta_run_exp` = 投球前後の得点期待値の差分。**走者・アウト・カウントに基づく1球単位** | 公開 |
| **Stuff+** | **物理特性のみ**（球速・変化量・リリース点・スピン・軸のずれ）。決定木ベースの機械学習 | **非公開** |
| **Location+** | **カウント・球種・コースのみ**。物理特性は入力から除外 | **非公開** |
| **Pitching+** | Stuff+ と Location+ の加重平均ではなく**第3のモデル**。打者の左右も入力に含む | **非公開** |
| **PitchingBot** | botOvr / botStf / botCmd の3モデル。**XGBoost**。平均50、10ポイント=1σ | **非公開** |

- Stuff+/Location+/Pitching+ は **100 = 平均**、**10ポイント = 球種レベルの標準偏差1つ分**
- Pitch Value には**2系統ある**: ①BIS の粗い球種分類（wFB/wSL/wCT/wCH/wSF/wKN）②PITCHf/x の細かい分類（wFA/wFT/wFC/wFS/wFO/wSI/wSL/**wCU**/wKC/wEP/wCH/wSC/wKN/wUN）。カーブは前者 wCB / 後者 wCU で**表記が異なる**
- **Run Value と Whiff% は「1球単位」、それ以外の多くの指標は「打席単位」**で定義される（Savant の qualifier 欄に明記）

### 4.3 Attack Zones（Heart / Shadow / Chase / Waste） 🟡

**一次情報（MLB.com Catcher Framing ページ）で確認できるのは簡易な区分のみ**:
- **Heart**: ストライクゾーン境界から**ボール1個分より内側**
- **Shadow**: ゾーン境界から**ボール1個分内側〜ボール1個分外側**の帯
- それ以外: ボール1個分より外側

**⚠ 広く流通している「Shadow = 左右3.3インチ・上下4インチ」「Chase = ストライクゾーンの2倍サイズの外枠まで」という
詳細な数値は、二次情報（Pitcher List, FanGraphs ブログ）にしか見当たらず、一次情報で裏取りできなかった。**

- Heart ゾーンのスイング率は約 **73%**（二次）
- **Zone 番号 11〜14 と Heart/Shadow/Chase/Waste の対応関係、および各ゾーンの平均 Run Value は確認できず**

このシムは `pitchGrid.mjs` で独自のゾーン格子を持ち、`borderCsBase` でフレーミングの境界球を定義している（独自定義）。

### 4.4 結果系

| 指標 | 式 | 実装 |
|---|---|---|
| **Whiff%** | 空振り / **スイング数** | ✅（`SwStr%` は分母が総投球数） |
| **Chase Rate (O-Swing%)** | ゾーン外スイング / ゾーン外投球 | ✅ |
| **Put Away%** | 三振 / **2ストライク時の投球数** | ⬜ |
| **Zone% / Edge% / Meatball%** | Savant に列は実在するが **Edge% / Meatball% の定義文は確認できず** | Zone% ✅ / 他 ⛔ |

### 4.5 Pitch Tempo ⬜

`Pitch Tempo` = **同一打者への、テイク（見逃し）直後の投球間隔（リリース→リリース）の中央値**。走者あり/なしで別集計。
15秒以内 = Fast、30秒超 = Slow。

**⚠ MLB.com が明記**: "Statcast's pitch tempo metric is **NOT** the same as the MLB pitch timer that was instituted in 2023."

ピッチタイマー（2023年ルール）: 走者なし15秒 / 走者あり20秒、打者は8秒マークまでに構える。
**2024年に走者あり18秒へ短縮されたという情報は一次情報で裏取りできず**（確認できず）。

---

## 5. 守備指標（要約）

**詳細は `fielding_metrics_reference.md` を参照。** ここでは本書の網羅性のための要約と、追加で判明した差分のみ記す。

### 5.1 伝統系

| 指標 | 式 | 実装 |
|---|---|---|
| **Fld%（守備率）** | `(PO + A) / (PO + A + E)` | ⬜ |
| **PO / A / E / DP** | カウント | PO/A/E ✅ / DP ✅ |
| **Total Chances (TC)** | `PO + A + E` | ⬜ |
| **Range Factor** | `RF/9 = 9 × (PO + A) / 守備イニング`、`RF/G = (PO + A) / 試合数` | ⬜ |
| **Inn（守備イニング）** | `そのポジションで記録されたアウト数 ÷ 3` | ✅ |
| **CS%（盗塁阻止率）** | `CS / (CS + SB)` | ✅ |
| **Pop Time** | `Exchange Time + Ball Flight Time`。MLB平均 **2.0秒**、優秀 <1.9秒 | ⛔ |
| **CERA** | 捕手が捕球していた間の投手陣の ERA | ⬜ |

**Fld% と Range Factor がセイバー的に不十分な理由** `[一次/二次]`:
- **Fld%** は「届かなかったボール」を分母に含めない。**守備範囲が狭く難しい打球に手を出さない選手ほど Fld% が高くなる**という逆説的なインセンティブ構造を持つ
- **Range Factor** は機会（オポチュニティ）の違い（①投手陣のゴロ/フライ比率 ②隣接ポジションの守備範囲 ③球場特性 ④DH の有無）を一切補正しない

**WP / PB の記録規則上の帰属** `[一次: 公式規則 9.13]`:
- **PB** = 捕手が「通常の努力」で処理できたはずの正規投球を後逸
- **WP** = 投球が高すぎる/低すぎる/逸れすぎる、または**捕手に届く前にワンバウンドした投球**を処理できなかった
- **⚠ 非対称性**: WP で生還した走者の得点は**自責点に算入される**が、PB で生還した走者の得点は**算入されない**

### 5.2 DRS の成分 — 本書で判明した訂正

**`fielding_metrics_reference.md` §9.1 は `rTHR` / `rPOS` を成分として挙げていたが、これは誤りだった。**
Sports Info Solutions（開発元）と FanGraphs Library の一次情報で確認できた成分は次の **9つ**:

| 略号 | 定義 | 対象 |
|---|---|---|
| **rPM** | Plus/Minus Runs Saved（守備範囲とアウト転換能力）。多くの選手で DRS の大半を占める | 範囲を持つ全野手 |
| **rSB** | Stolen Base Runs Saved | 投手 / 捕手 |
| **rGDP** | Double Play Runs Saved | 2B / SS |
| **rARM** | Outfield Arms Runs Saved | 外野手 |
| **rGFP** | Good Fielding Plays Runs Saved（定型化しづらいハッスルプレー） | 全ポジション |
| **rBU** | Bunt Runs Saved | 1B / 3B / 投手 |
| **rHR** | HR Saving Catch Runs Saved（**1本 = 1.6 run**） | 外野手 |
| **rSZ** | Strike Zone Runs Saved（BIS 版フレーミング） | 捕手 |
| **rCERA** | Adjusted Earned Runs Saved | 捕手 |

- **`rTHR` は捕手送球が rSB に統合されていることとの混同**、**`rPOS` は WAR の Positional Adjustment との混同**と考えられる
- 出典: https://www.sportsinfosolutions.com/2019/04/02/what-is-strike-zone-runs-saved/ 、https://library.fangraphs.com/defense/drs/ （一次）

### 5.3 Catch Probability の★区分 `[一次]`

| 区分 | 捕球確率帯 |
|---|---|
| **5-Star** | 0〜25% |
| 4-Star | 26〜50% |
| 3-Star | 51〜75% |
| 2-Star | 76〜90% |
| 1-Star | 91〜95% |
| （★なし = routine） | 96〜100% |

- 出典: https://www.mlb.com/glossary/statcast/catch-probability （一次）
- **このシムの Distance-Time モデルは、捕球確率が両極（p<0.1 / p>0.9）に 70.8% 集中する。**
  Statcast の★区分でいえば「routine（96%+）」と「5★（0-25%）」に大半が入る、現実的な分布である

### 5.4 Outfielder Jump の3成分 `[一次]` ⛔

投球リリース後**最初の3秒間**で、正しい方向にどれだけ距離を稼げたか（フィート）。

| 成分 | 何を測るか |
|---|---|
| **Reaction（反応）** | 最初の **1.5秒間**に（方向を問わず）移動した距離。一歩目の速さ |
| **Burst（加速）** | 続く **1.5〜3.0秒**に（方向を問わず）移動した距離。加速力 |
| **Route（ルート）** | 3秒間トータルで「全方向への移動距離」と「正しい方向への移動距離」を比較。ルートの直進性 |

3成分は加算的ではなく、最初の3秒間の**内訳分解**である。

### 5.5 その他

| 指標 | 式 | 実装 |
|---|---|---|
| **DER** | `1 − (H + ROE − HR) / (PA − BB − SO − HBP − HR)` | ⬜ |
| **Def**（FanGraphs） | `Fielding Runs + Positional Adjustment` | 🟡（分けて保持） |
| **RZR** | `Plays Made / BIZ（Balls In Zone）` | ⛔ |
| **OOZ** | ゾーン外で成功させたプレー数 | ⛔ |
| **PADE / TZ / FRAA / RDA** | **いずれも内部式が非公開** | ⛔ |

**Def の解釈目安**（一次）: 0=平均、+20 Excellent / +12 Great / +4 Above Average / −4 Below Average / −12 Poor / −20 Awful。約 10 run = 1勝。

---

## 6. 走塁指標

### 6.1 BsR = UBR + wSB + wGDP ✅

**解釈目安（FanGraphs Library・一次）**

| 評価 | BsR | UBR | wGDP | Spd |
|---|---|---|---|---|
| Excellent | +8 | +6 | +2.0 | 7.0 |
| Great | +6 | +4 | — | 6.0 |
| Above Average | +2 | +1.5 | — | 5.5 |
| Average | 0 | 0 | 0.0 | 4.5 |
| Below Average | −2 | −1.5 | — | 4.0 |
| Poor | −4 | −4 | −1.0 | 3.0 |
| Awful | −6 | −6 | −2.5 | 2.0 |

「**最高レベルの走者でも年間 8〜10 run 以上は積み増せない**」。約 10 run = 1勝。

### 6.2 wSB ✅

```
wSB   = SB × runSB + CS × runCS − lgwSB × (1B + BB + HBP − IBB)
lgwSB = (ΣSB × runSB + ΣCS × runCS) / (Σ1B + ΣBB + ΣHBP − ΣIBB)
runSB = +0.2                        ← 全シーズン固定
runCS = −(2 × RunsPerOut + 0.075)   ← 得点環境依存で年ごとに変動
```

**runSB / runCS の年次実値**（FanGraphs Guts!・一次）:

| 年 | runSB | runCS |
|---|---|---|
| 2022 | 0.200 | −0.397 |
| 2023 | 0.200 | −0.422 |
| 2024 | 0.200 | −0.405 |
| 2025 | 0.200 | −0.410 |
| 2026 | 0.200 | −0.416 |

- **lgwSB の年次実値は Guts! に非掲載**（確認できず）
- このシム: `runSB: 0.19` / `runCS: -0.38`。**日米の一次情報の範囲内だが、`runCS` を固定値にしている**（原典は得点環境依存の可変式）→ §10.4

### 6.3 UBR ⬜（このシムは近似実装）

考案者は Mitchel Lichtman（UZR と同じ）。**盗塁・盗塁死を除く**走塁プレーを、状況（base-out state）別の
期待得点変化で評価する。**内部の具体的な数式は FanGraphs も非公開**（確認できず）。

対象プレー: ①安打での進塁欲張り／アウト ②打者走者の余塁進塁 ③先行走者の進塁判断 ④後続走者への影響
⑤フライでのタッチアップ ⑥内野ゴロでの走者進塁 ⑦三塁絡みの一部状況

**除外**: 盗塁・盗塁死（wSB で別評価）。

### 6.4 盗塁の損益分岐点 `[一次: FanGraphs ブログ・Josh Goldman]`

| 状況 | アウト数 | 損益分岐点 |
|---|---|---|
| 二塁盗塁 | — | **70〜75%** |
| 三塁盗塁 | 0 | 78% |
| 三塁盗塁 | 1 | 69% |
| 三塁盗塁 | 2 | 88% |
| 本盗 | 0 | 87% |
| 本盗 | 1 | 70% |
| 本盗 | 2 | 34% |
| ダブルスチール(2・3塁) | 0 | 64% |
| ダブルスチール(2・3塁) | 1 | 60% |
| ダブルスチール(2・3塁) | 2 | 76% |

**「70-75%」という有名な数字は二塁盗塁限定の経験則**であり、三塁盗塁・本盗では大きく異なる。
`BEP = −runCS / (runSB − runCS)` のような**閉じた式は一次資料に無い**（確認できず）。

### 6.5 Spd（Speed Score） ⛔（このシムからは撤去済み）

**FanGraphs 版 = 4成分の平均**: 盗塁成功率 / 盗塁企図頻度 / 三塁打率 / 得点率。**守備位置の項は含まない。**

FanGraphs 自身の評価: "**a bit of an outdated stat** at this point, as it doesn't account for all aspects of baserunning"。
run above average スケールでないことを認め、**UBR の使用を推奨**している。

**⚠ 正確な重み付け数式は FanGraphs Library に記載が無い。** Bill James 原典（1987 Baseball Abstract）の6成分の式は
**Wikipedia 単独ソースでしか見つからず、裏取りできなかった**（walksaber.blogspot.com は原典を引用せず、athletepath.com は 403）。

Wikipedia が示す式（**未検証・採用してはならない**）:
```
F1 = 20 × ((SB+3)/(SB+CS+7) − 0.4)
F2 = (1/0.07) × √((SB+CS)/(1B+BB+HBP))
F3 = 625 × (3B/(AB−HR−K))
F4 = 25 × ((R−HR)/(H+BB+HBP−HR) − 0.1)
F5 = (1/0.007) × (0.063 − GDP/(AB−HR−K))
F6 = 守備位置別（P=0, C=1, 1B=2, 2B/3B/SS/OF は (PO+A)/G ベース）
最終値 = 各 factor を 0〜10 にクリップ後、6つの単純平均
```
※ 一般に流布する式（F3 の係数 500）と Wikipedia（625）で**係数が食い違う**。F4 の分母定義も揺れる。

**→ このシムは Spd を撤去した**（`ace5d4a`）。理由は `fielding_metrics_reference.md` §15。

### 6.6 Statcast 走塁

| 指標 | 定義 | 実装 |
|---|---|---|
| **Sprint Speed** | 最速1秒間の秒速（ft/sec）。MLB平均 **27**、レンジ **23（poor）〜30（elite）** | 🟡（真値 speed が対応） |
| **Bolt** | **30 ft/sec 以上**の走塁 | ⛔ |
| **Baserunning Run Value** | 盗塁価値 + 進塁価値。**進塁 +0.2 run / アウト −0.45 run（固定）** | ⬜ |
| **Secondary Lead** | 投手リリース時の、塁と走者の重心との距離 | ⛔ |
| **First Step / Burst** | 盗塁時のジャンプ。**定義文の一次確認は 406 で失敗** | ⛔ |
| **XBT%（Extra Bases Taken）** | **Statcast 版の正確な定義・式は確認できず**。伝統的には B-R / Bill James Handbook 系 | ✅（独自定義） |

**⚠ wSB / UBR と Statcast Baserunning Run Value の違い**:
FanGraphs の wSB は `runCS` を**年ごとに可変**（−0.40〜−0.42）とするのに対し、**Statcast は −0.45 で固定**している。
また Statcast は進塁を UBR のような複数プレー種別の平均対比ではなく、**単一の確率モデル**で統合評価する。

### 6.7 BP の BRR / EqBRR ⛔

`EqBRR = EqGAR + EqSBR + EqAAR + EqHAR + EqOAR`（Dan Fox 考案）
- **EqGAR** ゴロアウト時の進塁 / **EqSBR** 盗塁 / **EqAAR** フライアウト時の進塁 / **EqHAR** 安打時の進塁 / **EqOAR** 暴投等
- Fox 本人の記述: 盗塁は "a high-risk and low-reward endeavor"、安打時の進塁（EqHAR）こそ "where the real opportunity lies"
- **各成分の正確な数式は非公開**（確認できず）

---

## 7. 価値指標・文脈指標（WAR / WPA / RE24 / LI）

### 7.1 fWAR 野手 `[一次]`

```
WAR = (Batting Runs + Base Running Runs + Fielding Runs
       + Positional Adjustment + League Adjustment + Replacement Runs) / (Runs Per Win)

Replacement Runs = (570 × (MLB Games / 2,430)) × (Runs Per Win / lgPA) × PA
```

**解釈目安（FanGraphs Library・一次）**

| WAR | 評価 |
|---|---|
| 0〜1 | Scrub |
| 1〜2 | Role Player |
| 2〜3 | Solid Starter |
| 3〜4 | Good Player |
| 4〜5 | All-Star |
| 5〜6 | Superstar |
| 6+ | MVP |

**投手版の解釈目安表は一次情報に存在しない**（確認できず）。

### 7.2 fWAR 投手 `[一次]`

```
dRPW  = ((((18 − IP/G) × (AL/NL の FIPR9)) + ((IP/G) × pFIPR9)) / 18 + 2) × 1.5
Replacement Level（勝率換算・1試合あたり） = 0.03 × (1 − GS/G) + 0.12 × (GS/G)
LI Multiplier = (1 + gmLI) / 2                    ← リリーフのみ

fWARp = [ ((lgFIP − FIP) / pitcher-specific RPW) + Replacement Level ] × (IP/9)
        × Leverage Multiplier（リリーフのみ） + League Correction
```
- **代替水準は先発 0.12 / リリーフ 0.03 wins/9IP**（GS/G で按分）
- **League Correction**（リーグ全体を430 WAR に合わせる補正）の正確な公開式は確認できず

### 7.3 Replacement Level `[一次]`

> "we believe that a team making the MLB minimum would win about **29.7%** of its games in a given year, or roughly **47-48 per team**.
> Multiply that by 30 and you have something between 1,430 and 1,440, leaving about **1,000 games up for grabs** out of the 2,430."
> "Those 1,000 available wins are the 'wins above replacement.' Those get divided up with **57% going to position players and 43% going to pitchers**."

**→ 代替水準 = 勝率 .294（48勝114敗）。リーグ全体で 1,000 WAR。野手 570 / 投手 430。**

2013年以前は FanGraphs（.265）と Baseball-Reference（.320）で異なっていたが、**.294 に統一**された。

### 7.4 Runs Per Win (RPW) `[一次]` ✅

```
静的（野手・リーグ全体）: RPW = 9 × (MLB Runs Scored / MLB Innings Pitched) × 1.5 + 3
動的（投手ごと）:        dRPW = ((((18 − IP/G) × lgFIPR9) + ((IP/G) × pFIPR9)) / 18 + 2) × 1.5
```
通常 **9〜10**。良い投手ほど RPW は低くなる。
FanGraphs は「Tom Tango の式を簡略化したもの」と説明。**Tango 本人のオリジナル式の原文は未取得**。

- 実装: ✅ このシムの `rpw = 1.5 × R/G(per team) + 3` は、`9 × (Runs/IP) = R/G(per team)` なので**上の静的式と数学的に同一**

### 7.5 ポジション補正 `[一次]` 🟡

**162 守備試合 = 1,458 イニングあたり run**:

| Pos | run |
|---|---|
| C | +12.5 |
| SS | +7.5 |
| 2B / 3B / CF | +2.5 |
| LF / RF | −7.5 |
| 1B | −12.5 |
| DH | −17.5 |

FanGraphs 自身の但し書き: 約10年前に導出された値で、「DH補正は負に過ぎる／捕手はやや大きい可能性」。
**最新の再算出時期は不明**（"about a decade ago" という相対表現のみ）。

**✅ 2026-07-10 に一次情報で決着し、修正済み。** 原文:
> "Positional adjustments are calculated based on a full 162 games, which **equates to 1,458 defensive innings**.
> So if a first baseman plays 1,214 innings with -12.5 positional adjustment for a full season,
> his adjustment for that period will be **-10.4 runs**."
>
> "Positional Adjustment = ((Innings Played/9) / 162) * position specific run value"

検算: `−12.5 × 1214/1458 = −10.41` ✓ ／ `−12.5 × 1214/1350 = −11.24` ✗

**1,350 イニングは Baseball-Reference の慣行であり、しかも値のセット自体が別物**
（C +9 / SS +7 / 2B +3 / CF +2.5 / 3B +2 / LF・RF −7 / 1B −9.5 / DH −15）。
**FanGraphs の値に B-R の分母を掛けてはならない。**

### 7.6 RE24 と 24状態の期待得点表 `[一次: Tom Tango]`

```
RE24（当該プレー） = RE(終了時の塁状況) − RE(開始時の塁状況) + 当該プレーでの得点
```
24状態 = 塁状況8通り（空塁/一塁/二塁/三塁/一二塁/一三塁/二三塁/満塁）× アウト数3通り。

**Run Expectancy Matrix（Retrosheet 1950-2015、期間別）**

| 塁状況 | 期間 | 0アウト | 1アウト | 2アウト |
|---|---|---|---|---|
| 空塁 | 1993-09 | 0.547 | 0.293 | 0.113 |
| 空塁 | **2010-15** | **0.481** | **0.254** | **0.098** |
| 一塁 | 2010-15 | 0.859 | 0.509 | 0.224 |
| 二塁 | 2010-15 | 1.100 | 0.664 | 0.319 |
| 三塁 | 2010-15 | 1.350 | 0.950 | 0.353 |
| 一二塁 | 2010-15 | 1.437 | 0.884 | 0.429 |
| 一三塁 | 2010-15 | 1.784 | 1.130 | 0.478 |
| 二三塁 | 2010-15 | 1.964 | 1.376 | 0.580 |
| 満塁 | 2010-15 | 2.292 | 1.541 | 0.752 |

- 出典: https://www.tangotiger.net/re24.html （一次）
- **年代・得点環境で数値が変動する**（1993-2009 は "steroid era" で高い）。**NPB に適用するならそのリーグの実データから再計算すべき**
- 実装: ✅ このシムは `deriveTables` の2パス集計で**自リーグの実データから RE 行列を導出**している（正しいアプローチ）

### 7.7 WPA / Win Expectancy / LI

| 指標 | 定義 | 実装 |
|---|---|---|
| **WPA** | `WE(終了時) − WE(開始時)`。加算的 | ✅ |
| **+WPA / −WPA** | WPA を正／負のプレーに分解（FanGraphs 表示名は Win/Loss Advancement） | ⬜ |
| **WPA/LI** | **各プレーごとに WPA を そのプレーの LI で割った値の総和**。文脈非依存の価値 | ✅ |
| **Clutch** | `(WPA / pLI) − WPA/LI` | ✅ |
| **REW** | `RE24 / RPW`（勝利スケール） | ⬜ |
| **cWPA** | `(ゲーム勝率の変化) × (その試合の勝敗が優勝確率に与える差分)`。**B-R 独自**（Dan Hirsch, 2020） | ⛔ |

**Win Expectancy の算出**: **明示的な数式は存在しない**。「過去の類似局面（スコア差・イニング・アウト・塁状況・得点環境）における
実際の勝率の経験的集計」。**FanGraphs 表示の WE / LI / RE データはすべて TangoTiger.com からのライセンス**であり、
WE・LI・RE24 は**同一の一次データソースに基づく一体のシステム**である。

**Leverage Index**: 「その場面で起こりうる全プレー結果について WE の変化量を発生確率で加重平均し、平均的な場面のスイング幅で割る」。
**平均は常に 1.0**。LI < 0.85 = low leverage、LI > 2.0 = high leverage。**実際の試合状況の10%が LI>2、60%が LI<1。**
**厳密な数式は FanGraphs Library に非掲載**（Tango の解説へのリンクのみ）＝確認できず。

| 略号 | 定義 | 実装 |
|---|---|---|
| pLI | 選手の全出場イベントの平均 LI | ✅ |
| gmLI | 投手が**試合に登板した時点**の LI | ✅ |
| exLI | 投手が**降板した時点**の LI | ⬜ |
| inLI | 投手が各イニング開始時点の平均 LI | ⬜ |
| phLI | 代打で起用された時点の平均 LI | ⬜ |

### 7.8 Shutdowns / Meltdowns ✅

```
Shutdown: 1登板の WPA ≥ +0.06
Meltdown: 1登板の WPA ≤ −0.06
```
セーブ機会に依存しないため、セットアッパー等の評価に有効。

### 7.9 fWAR / bWAR / WARP の違い `[一次]`

| | ベースライン | 守備指標 |
|---|---|---|
| **fWAR**（FanGraphs） | **FIP** | UZR |
| **bWAR**（Baseball-Reference） | **実際の失点（RA9）をチーム守備力で補正** | DRS |
| **WARP**（Baseball Prospectus） | **DRA**（フレーミング・守備等を統制した回帰モデル） | FRAA |

**WAR の絶対値がサイトごとに大きく異なる主因はここにある。**

---

## 8. チーム・リーグ・環境・記録規則

### 8.1 ピタゴラス勝率

| 版 | 指数 |
|---|---|
| **原型（Bill James）** | `Win% = RS² / (RS² + RA²)`（指数 = 2） |
| **Pythagenport**（Clay Davenport） | `指数 = 1.50 × log10((RS+RA)/G) + 0.45` |
| **Pythagenpat**（David Smyth / "Patriot"） | `指数 = ((RS+RA)/G)^0.287`（Smyth版）/ `^0.29`（Patriot版） |

**⚠「1.83」は固定値ではなく、Pythagenport の可変指数が正常な得点環境で 1.8 前後に収束することからくる俗称。**
1.83 / 0.287 / 1.50×log10+0.45 という数値は**一次資料で確認できず**（Wikipedia 等の二次集約のみ）。

- MLB.com は "initial formula" として指数 2 を明記（一次）
- 実装: ✅ `pythag()` あり

### 8.2 BaseRuns `[一次: FanGraphs Library]` ⬜

```
Raw BaseRuns = (A × B) / (B + C) + D
A = H + BB + HBP − 0.5×IBB − HR
B = 1.1 × [1.4×TB − 0.6×H − 3×HR + 0.1×(BB + HBP − IBB) + 0.9×(SB − CS − GDP)]
C = PA − BB − SF − SH − HBP − H + CS + GDP
D = HR
```
**BaseRuns には複数の公開版がある**。上記は FanGraphs Library が採用する係数（B項に1.1倍）。

### 8.3 Park Factor（FanGraphs の 5-Year Regressed）`[一次]`

```
1. iPF = H × T / ((T − 1) × R + H)      H=対象球場のホーム得点/試合, R=ロード得点/試合, T=球団数
2. (iPF + 1) / 2                        全体統計への適用形に変換
3. Final PF = 1 − (1 − iPF) × X         X = 0.6[1年] / 0.7[2年] / 0.8[3年] / 0.9[4年以上]
4. 最大5年分のデータを使用
```
**全 WAR で 5年 regressed PF を採用。**

**⚠ FanGraphs は「左右打者別の park factor は価値測定（WAR等）には適用すべきでない」と明記している。**

### 8.4 DER `[一次: MLB.com]` ⬜

```
DER = 1 − (H + ROE − HR) / (PA − BB − SO − HBP − HR)
```
リーグ平均は概ね **.690〜.700**。「Baseball-Reference の DefEff と MLB.com の DER は定義が微妙に異なる」との記述があるが、
**正確な差分は確認できず**。

### 8.5 記録規則

| 項目 | 規則 | 内容 |
|---|---|---|
| **自責点(ER)** | 9.16 | イニングを失策なしで再構成し、投手に有利な判断をする。**暴投・ボークは投手のみの責任として自責点に算入**。捕手の打撃妨害で出塁した打者はその後生還しても自責点にしない |
| **勝利投手** | 9.17 | "credit as the winning pitcher that pitcher whose team assumes a lead while such pitcher is in the game...and does not relinquish such lead" |
| **セーブ** | **9.19** | §3.2 参照（必須3 + 選択1 の計4条件） |
| **RBI** | 9.04 | §1.2 参照 |
| **犠打** | 9.08 | "before two are out, the batter advances one or more runners with a bunt and is put out at first base..." |
| **規定打席** | 9.22 | **試合数 × 3.1**（162試合なら502） |
| **規定投球回** | 9.22 | **試合数 × 1.0**（162試合なら162） |

- **⚠ 自責点判定における「パスボール」特有の扱いの原文は確認できず**（§5.1 の WP/PB 非対称性は規則 9.13 由来）
- **⚠ 犠飛(SF)・失策(E)・野選(FC)・完投/完封の条文原文は確認できず**（MLB 公式規則 PDF のテキスト抽出に失敗）

### 8.6 NPB 固有

- **規定打席 = チーム試合数 × 3.1**（端数四捨五入。2008年までは切り捨て）
- **規定投球回 = チーム試合数 × 1.0**
- 枠組みは MLB の Rule 9.22 と同一
- **⚠ NPB と MLB の記録規則の相違点は確認できず**（NPB 公認野球規則 PDF の内容抽出ができなかったため）
- 出典: Wikipedia（**二次**）。NPB 公式 PDF の所在（https://npb.jp/scoring/officialrule_900.pdf）は確認済み

---

## 9. リーグ定数の実値（FanGraphs Guts!） `[一次]`

出典: https://www.fangraphs.com/guts.aspx?type=cn （2026-07-09 取得時点のスナップショット）

| 年 | wOBA(lg) | wOBAScale | wBB | wHBP | w1B | w2B | w3B | wHR | R/PA | R/W | cFIP | runSB | runCS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2023 | .318 | 1.204 | .696 | .726 | .883 | 1.244 | 1.569 | 2.004 | .122 | 10.028 | 3.255 | .200 | −.422 |
| 2024 | .310 | 1.242 | .689 | .720 | .882 | 1.254 | 1.590 | 2.050 | .117 | 9.683 | 3.166 | .200 | −.405 |
| 2025 | .313 | 1.232 | .691 | .722 | .882 | 1.252 | 1.584 | 2.037 | .118 | 9.774 | 3.135 | .200 | −.410 |
| 2026（途中） | .317 | 1.232 | .700 | .731 | .891 | 1.260 | 1.593 | 2.042 | .120 | 9.903 | 3.120 | .200 | −.416 |

**cFIP の年次推移**: 2015 3.134 / 2016 3.147 / 2017 3.158 / 2018 3.160 / 2019 3.214 / 2020 3.191 / 2021 3.170 / 2022 3.112 / 2023 3.255 / 2024 3.166

**⚠ 注意点**
- 取得できたのは **MLB 全体の単一値**。**AL/NL 別に分かれた係数列は確認できず**
- **lgwSB の年次実値は Guts! に非掲載**（確認できず）
- Baseball Prospectus には**別概念の「cFIP」**（Contextual FIP、100スケール指標）が存在する。**混同注意**

---

## 10. このシムの実装との照合（検算結果）

### 10.1 wOBA linear weights ✅

このシムの `LINEAR_WEIGHTS` は「**アウト基準の run value**」であり、FanGraphs が公表する wOBA 係数は
**wOBA scale を掛けた後の値**である。別物なので直接比較してはならない。掛け合わせて比較すると:

| | シム × wobaScale(1.277) | FanGraphs 2024 | 差 |
|---|---|---|---|
| wBB | 0.702 | 0.689 | +1.9% |
| wHBP | 0.741 | 0.720 | +2.9% |
| w1B | 0.894 | 0.882 | +1.4% |
| w2B | 1.277 | 1.254 | +1.8% |
| w3B | 1.622 | 1.590 | +2.0% |
| wHR | 2.107 | 2.050 | +2.8% |
| **R/W (rpw)** | 9.451 | 9.683 | −2.4% |
| **cFIP** | 3.283 | 3.166 | +3.7% |
| **lgR/PA** | 0.110 | 0.117 | −6.0% |

**すべて 3〜6% 以内で一致。** 得点環境の差（このシムは NPB 相当の目標帯）を考えれば妥当。

### 10.2 一致を確認できた式

| 指標 | 検証 |
|---|---|
| **LOB%** | `(H+BB+HBP−R) / (H+BB+HBP−1.4×HR)` — 原典と完全一致 |
| **kwERA** | `5.40 − 12×(K%−BB%)` — 原典と完全一致 |
| **Clutch** | `(WPA/pLI) − WPA/LI` — 原典と完全一致 |
| **SD / MD** | `1登板 WPA ≥ +0.06 / ≤ −0.06` — 原典と完全一致 |
| **RPW** | `1.5 × R/G + 3` は FanGraphs の `9×(R/IP)×1.5 + 3` と数学的に同一 |
| **Barrel** | 「EV 98mph 必須 + 超過 mph ぶんの LA 範囲拡大 + 8-50° クリップ」— 原典の構造と一致 |
| **打球種別の LA 境界** | GB<10° / LD 10-25° / FB 25-50° / PU>50° — Statcast と完全一致 |
| **RBI の併殺除外** | 公式規則 9.04 と一致 |
| **SIERA** | 2010年 BP 版の係数と完全一致。しかも `netGB × |netGB|` として**符号可変の ± 項も正しく実装** |
| **FRV の run 換算** | 外野0.9 / 内野0.75 / DP 0.4 / framing 0.125 / 捕手送球 0.65 / ブロッキング 0.25 — すべて一致 |
| **BsR = UBR + wSB + wGDP** | 恒等式をテストで固定済み |

### 10.3 ポジション補正の分母 ✅（2026-07-10 修正済み）

- 旧: `POSITION_ADJUST_PER_1350` を `innings / 1350` で按分 ← **FanGraphs の値に Baseball-Reference の分母を掛けていた**
- 新: `POSITION_ADJUST_PER_162G` を `innings / 1458` で按分（§7.5 の原文と実例で決着）

FanGraphs 公式ページの実例（一塁手 1,214イニング → −10.4）を回帰テストで固定した（`test/war.test.mjs`）。
影響: フルシーズン NPB 捕手で `11.92 → 11.03 run`（**7.4% 縮小**）。

### 10.4 runCS を得点環境依存の可変式へ ✅（2026-07-10 修正済み）

- 旧: `run.runCS: -0.38`（固定値）
- 新: `leagueConstants` が `runCS = −(2 × RunsPerOut + 0.075)` を実データから導出（`lc.runCS`）
  - `RunsPerOut = リーグ総得点 / リーグ総アウト数`
  - このシムでの導出値は **−0.394 〜 −0.404**（FanGraphs 2024 の −0.405 とほぼ一致）
- `runSB` も原典どおり **0.2 固定**に（旧 0.19）

wSB / ARM / rSB はいずれもリーグ平均で 0 に中心化されるため、**WAR の総量は動かない**（Σ は不変）。

### 10.5 代替水準を wins で定義し直した ✅（2026-07-10 修正済み）

FanGraphs の野手代替水準:
```
Replacement Runs = (570 × (MLB Games / 2,430)) × (Runs Per Win / lgPA) × PA
```
**`Runs Per Win` が掛かっている**ことに注意。これを RPW で割ると
`代替 wins = (570 × Games/2430) × (PA / lgPA)` となり、**得点環境にもリーグ総打席にも不変**である。
（代替水準は勝率 .294 で定義される概念なので、不変であるべきは「勝利」）

**旧実装の欠陥**: 投手は `(IP/9) × replPer9` と **wins 単位**で持っていたのに、
野手だけ `repl = (PA/600) × replBatterPer600` と **run 単位**で持ち rpw で割っていた。
**シム内部で単位が食い違っていた。**

**実測された害（フェーズDの時代トレンドは9年周期で実際に走っている・`era.offenseAmpKmh: 0.8`）**

| 時代 | R/G | rpw | 旧: 総WAR | 新: 総WAR |
|---|---|---|---|---|
| 打高 (evBase +0.8) | 4.25 | 9.375 | **409.0** | 412.6 |
| 中立 | 4.03 | 9.048 | 418.9 | 415.2 |
| 投高 (evBase −0.8) | 3.93 | 8.900 | **420.2** | 413.0 |
| **打高↔投高の振れ幅** | | | **11.1 WAR** | **0.4 WAR** |

得点が減るほど総WARが増えるという逆向きの挙動で、**同一セーブ内で1年目の WAR 6.0 と
9年目の WAR 6.0 が同じ価値ではなかった**。

**修正**: `leagueConstants` が `replHitterWinsTotal = replHitterWinsPerTeamGame × Σ(チーム試合数)` を持ち、
`hitterWAR` は `代替wins = replHitterWinsTotal × (PA / lgPA)` を打席比で按分してから rpw を掛けて run へ戻す。
＝ **リーグ全体の代替勝利の総量を固定**（FanGraphs 完全準拠）。回帰テスト（`test/era.test.mjs`）で
「野手の代替勝利は得点環境に対して厳密に不変」を固定した。

### 10.6 【新発見・未修正】このシムの代替水準は勝率 .245 であって .294 ではない 🟡

上の修正で総WARは安定したが、**その水準そのものが原典と違う**ことが分かった。

```
リーグ総勝利 836（12球団 × 143試合・引分あり）
総WAR 415.2 → 代替チームの総勝利 = 836 − 415.2 = 420.6 → 1チームあたり 35.0 勝
→ このシムの代替水準の勝率 = .245
```

**FanGraphs の代替水準は .294**（`sabermetrics_glossary.md` §7.3）。
`.294` なら代替総勝利は 504.5 で、**総WAR は 331 になるはず**。実際の 415.2 は **25% 過大**。

つまり、このシムのすべての選手の WAR が約 25% 水増しされている。

**⚠ 単純に直せない理由**: 投手WAR王（帯 [5.5, 8]・実測 5.7）は、その **55%（3.14 WAR）が代替水準ボーナス**
（170IP の先発なら `(170/9) × 0.166 = 3.14`）で占められている。代替水準を .294 へ引き上げると
投手WAR王が 5.07 まで落ちて帯を割る。**根本には「投手の FIP のばらつきが狭すぎてエースが平均から離れない」
という別の較正問題がある。**

修正するには 総WAR / 野手WAR王 / 投手WAR王 / WAR下限 の目標帯を一式で引き直す必要がある。
**ユーザー判断が要る。**

### 10.7 【要修正】DRS の成分名

`fielding_metrics_reference.md` §9.1 の `rTHR` / `rPOS` は**一次情報で確認できなかった**。
正しくは **rPM / rSB / rGDP / rARM / rGFP / rBU / rHR / rSZ / rCERA** の9成分（§5.2）。

### 10.8 実装していないが素データが揃っているもの（⬜）

Fld% / Range Factor / Total Chances / DER / RA9 / GB/FB / IFFB% / Swing% / O-Contact% / Z-Contact% /
Put Away% / Game Score / Off（統合値）/ REW / +WPA・−WPA / exLI・inLI・phLI / BaseRuns / CERA /
Adjusted EV / EV50 / xwOBACON / Baserunning Run Value

### 10.9 【新発見・未修正】投手の球速が一球シミュレーションに結線されていない 🟡

`trueAbility.pitching.velocityKmh` を消費しているのは次の4つだけ:
- `sim/team.mjs` の `starterScore` / `relieverScore`（起用の並び順）
- `game/market.mjs` / `game/roster.mjs` の球団評価
- `game/aging.mjs` / `game/breakout.mjs` / `game/injury.mjs`（能力変動・故障負荷の代理変数）

**`plateAppearance` / `pitchGrid` / `battedBall` は球速をまったく読まない。**
球種の `whiff` / `contactQuality` / `hrSuppress` は `generatePitcher` が球速とは独立に抽選している。

実測: 全投手の `velocityKmh` に +10km/h しても、リーグ ERA は 3.79 のまま **1ミリも動かない**。

**帰結**: フェーズD の時代トレンド `era.veloPerYear: 0.5`（平均球速の経年上昇・上限 +10km/h）は、
**得点環境をまったく動かさない**。「球速が上がって投高になる」という時代の物語が成立していない。
三原則②（現状のセパ両リーグ近似）の観点で要検討。

### 10.10 このシムに概念が無いもの（⛔）

Bat Tracking 全般（Bat Speed / Swing Length / Squared-Up% / Blast% / Attack Angle 等）、
球質全般（Spin Rate / Spin Axis / Active Spin / Extension / Arm Angle / Movement）、
Stuff+ / Location+ / Pitching+ / PitchingBot、Pitch Value（wFB 等）、Pop Time、Outfielder Jump、
Sprint Speed（真値 speed で代替）、Secondary Lead、cWPA、PADE / TZ / FRAA / RDA / RZR / OOZ

---

## 11. 一次情報で確認できなかったもの 総覧

**この一覧にある数値・式をコードに書いてはならない。**

### 11.1 原理的に非公開（企業秘密・モデル内部）
- BIS の Soft% / Med% / Hard% の分類閾値（FanGraphs 自身が「BIS の企業秘密」と明記）
- **SIERA の現行版（2015年 "New SIERA" 以降）の係数** — FanGraphs 自身が "Good luck." と明記
- Stuff+ / Location+ / Pitching+ / PitchingBot のモデル内部
- UBR / wGDP の内部計算式（FanGraphs は概念説明のみ）
- DRS の内部計算式、PADE / Total Zone / FRAA / RDA の数式
- tERA / tRA の完全な計算式
- Active Spin の算出式、xBA / xSLG の重み付け
- Catcher Throwing (CSAA) の確率モデル、Arm Value の run 換算式

### 11.2 アクセス障害で未確認（再挑戦の価値あり）
- **OPS+ / ERA+ の正確な式**（Baseball-Reference 403）— とくに BPF が式のどこに掛かるか
- **bWAR 投手版（RA9WAR）の守備補正式**（B-R 403）
- **WARP（Baseball Prospectus）の完全な合成式**、DRA の回帰式
- **Leverage Index の厳密な数式**（Tango 原典 tangotiger.com）
- **Runs Per Win の Tango オリジナル式**
- **Win Expectancy テーブル**の数値
- **MLB / NPB 公式規則の英語条文原文**（PDF テキスト抽出失敗）— 犠飛 / 失策 / 野選 / 完投・完封
- **NPB と MLB の記録規則の相違点**

### 11.3 一次情報が存在しない（or 別ソースの指標）
- **CSW%** — FanGraphs / MLB / Savant の公式指標ではなく **Pitcher List（2018）**の指標
- **xISO** — Statcast 公式指標ではない（Savant に非掲載）
- **Launch Direction / Spray Angle** — MLB 公式の定義ページが存在しない
- **"Induced Vertical Break"** — 慣用表現。MLB.com Glossary に定義文なし
- **Max EV** — Savant にフィールドは実在するが文章化された定義なし
- **Bill James Speed Score の6成分の式** — Wikipedia 単独ソース、しかも流布する式と係数が食い違う
- **Attack Zones の詳細な数値境界**（3.3インチ/4インチ）— 二次情報のみ
- **Barrel の 101〜115 mph 各刻みの LA 数表** — 原典はグラフィックのみ
- **AVG / OBP / SLG / OPS の「優秀/劣悪」目安表** — そもそも存在しない
- **H/9** — FanGraphs Library にページが存在しない
- **GR（リリーフ登板数）** — 定義・式ともに一次資料で確認できず
- **lgwSB の年次実値** — Guts! に非掲載
- **wOBA 係数の AL/NL 別分割値** — Guts! は MLB 全体の単一値のみ

### 11.4 帰属が確認できないもの
- **FIP の考案者が Tom Tango** — 広く言われるが FIP ページ本文に記載なし
- **kwERA の正式な考案者**
- **ホールドが MLB 公式統計でない** ことは確認済み（1986年 John Dewan / Mike O'Donnell 考案）

---

## 12. 変更履歴

- 2026-07-10: 初版。8領域（打撃伝統/打撃Statcast/投球伝統/投球Statcast/守備/走塁/価値・文脈/チーム・規則）を
  並行調査し、一次情報に基づいて統合。実装状況（✅🟡⬜⛔）を付与し、§10 にシムとの照合結果を記録。
  - **検算の成果**: wOBA linear weights がFanGraphs と 3% 以内で一致、SIERA が 2010年 BP 版原典と完全一致
    （符号可変の ± 項まで）、LOB% / kwERA / Clutch / SD-MD / RPW / Barrel / 打球種別LA境界 が原典と一致
  - **判明した不一致**: ポジション補正の分母 1350 vs 1458（§10.3）、`runCS` を固定値にしている（§10.4）、
    `fielding_metrics_reference.md` の DRS 成分名 rTHR/rPOS が誤り（§10.5）

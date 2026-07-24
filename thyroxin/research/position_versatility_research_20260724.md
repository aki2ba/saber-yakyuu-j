# 複数ポジション適性の実証調査とモデル設計提案（2026-07-24）

方針: **一次情報（Bill James系スペクトラム論・Fangraphs/Baseball Prospectus・Statcast実例）優先、NPBは公開実例で代理**（ユーザー判断・§req_2③）。
調査タスク。**コード変更なし**（本ドキュメントのみ）。

---

## Part 1: 現実のデータ・定説調査

### 1. 守備スペクトラムの定説（Bill James Defensive Spectrum）

**序列**（易→難、DHを左端に含める版）:
`DH – 1B – LF – RF – 3B – CF – 2B – SS`（Cは特殊枠として別掲されることが多い）

- Bill Jamesの定義: 「各ポジションを覚えるのに必要な生の能力（スピード・敏捷性・反応速度・送球）で並べた配列」。「その存在は合理的に否定できない事実」と明言（James自身の言）。
  根拠として「遊撃手は二塁手より打たない、二塁手は中堅手より打たない、中堅手は一塁手より打たない」という打撃と守備の**トレードオフの経験則**を挙げている。
- **含意①（右ほど守備要求が高く、打撃要求は低い）**: スペクトラム右側（SS/2B/CF側）は守備で価値を出すため打撃基準が緩い。左側（1B/LF/DH側）は守備価値が乏しいため打撃で埋め合わせる必要がある。
- **含意②（加齢は右→左へ滑る）**: 年齢とともに運動能力（特にスピード・反応）が落ちるアスリートは、右側の難ポジから左側の易ポジへ移る。左から右へのコンバート（1B出身の選手がSSを覚える等）はほぼ起こらない、というのがスペクトラムの一方向性。
- FanGraphsのポジション調整値（WARの`Positional Adjustment`）は、このスペクトラムを**ほぼそのまま定量化**したもの（162試合・1,458守備イニング換算のrun値）。本リポジトリの`src/model/positions.mjs`の`POSITION_ADJUST_PER_162G`（C+12.5〜DH−17.5）と`POSITION_DIFFICULTY`（C,SS,CF,2B,3B,RF,LF,1B＝難→易）は、**この定説をすでに定数として内蔵済み**（出典の値と一致、コード内コメントにも明記あり）。
- **SS-2B-3Bの精密な難度差**（Baseball Prospectus, "Baseball Therapy" 系の分析）: SSは2Bより約3.0 run、3Bより約2.8 run難しい一方、**2Bと3Bはほぼ同格**（difficulty差ほぼゼロ）。この非対称性は「2B/3Bは代替可能ペア、SSだけ一段上」という直感と整合する。
- **2B/SSの隣接性の中身が異なる**: 2Bは守備範囲要求はSSより緩いが、**併殺の反転（pivot）で走者の突っ込みを受ける度胸と反射**という別種の技能を要求する。「SSに肩が足りない」選手が2Bへ回る、という定型的スカウティング語彙がある（肩の強さがSS→2Bの主な分水嶺）。

Sources:
- [Defensive spectrum — Wikipedia](https://en.wikipedia.org/wiki/Defensive_spectrum)（検索結果要約経由）
- [Positional Adjustment | Sabermetrics Library — FanGraphs](https://library.fangraphs.com/misc/war/positional-adjustment/)
- [WAR for Position Players | Sabermetrics Library — FanGraphs](https://library.fangraphs.com/war/war-position-players/)
- [Baseball Therapy: The Crack in the Defensive Spectrum | Baseball Prospectus](https://www.baseballprospectus.com/news/article/28408/baseball-therapy-the-crack-in-the-defensive-spectrum/)
- [Baseball Therapy: Reimagining the Defensive Spectrum | Baseball Prospectus](https://www.baseballprospectus.com/news/article/41948/baseball-therapy-reimagining-the-defensive-spectrum/)
- [Defensive spectrum — Grokipedia](https://grokipedia.com/page/Defensive_spectrum)

### 2. 実際の兼任守備の統計

一次データベース（Baseball-Reference Stathead / Statcast）の集計値そのものへの直接アクセスは検索経由では確認できなかったため、**実例と定性的傾向**を積み上げる形で裏取りした（確度: 中〜高、定量的な「兼任率n%」は未確認＝要注記）。

- **2024年 Willi Castro（Twins）**: 同一シーズンに5ポジションで25試合以上先発した**史上初の選手**。内訳: SS 56試合・2B 39試合・CF 30試合・LF 30試合・3B 26試合。
  → **注目点**: 5ポジションのうち4つがスペクトラム中央〜右寄り（SS/2B/3B/CF）で、**1Bと捕手は含まれない**。LFのみ左寄りだが、CF兼任者が周辺のLF/RFも守るのは外野内では自然な波及（後述）。
- **Tommy Edman（Cardinals, 2020）**: 3B/SS/2B/RF/LFで先発。**内野の中央〜右側全部＋外野コーナー**という、スペクトラム上「隣接し合う一塊」を守るパターン。
- **Christopher Morel（Cubs）**: 2年間で6ポジション経験＋DH。近年のMLBでは「守備適性の芯を持たない」新世代ユーティリティ像も出現（DH起用が多い＝守備価値より打撃価値を重視する起用）。
- **Ben Zobrist（元祖スーパーユーティリティ）**: 2009年に8ポジションを経験、主に2B/RF/SS。**「守備範囲・反応の要る中央系ポジション」を横断する**という共通パターンがここでも見える。
- **歴史的極値**: Rex Hudler・Denny Hocking（2000年）は「投手・捕手以外の全ポジション」を１シーズン内でこなした記録がある。ただしこれは**稀少事例**として語られる（「全部守れる」選手は歴代でも数えるほど）。
- **捕手からの離脱・捕手への転入はどちらも稀**（下記4節で詳述）。1B専任経験者のうち捕手経験がある割合はごく僅少（1.5%程度という分析事例あり）。

**共起ペアの定性ランキング（実例からの帰納・確度中）**:
1. **SS-2B-3B（内野中央〜右トライアングル）**: 最頻出。守備範囲・グラブ捌きの技能ベースが共通（後述4節でNPB分析も同旨）。
2. **CF-LF-RF（外野3ポジション）**: 外野内はほぼ完全代替可能。走力があればどこでも守れるとされ、コーナー間（LF-RF）は事実上ノーコスト、CFとの往復は加齢/守備範囲の分だけコストが乗る。
3. **3B-1B**（コーナー内野同士）: 頻出だが「上」から「下」への一方向が主（3B出身がキャリア終盤に1Bへ回る）。
4. **OF-1B**（外野出身の一塁転向）: 加齢によるコンバートの典型（後述3節）。
5. **2B-SS**は隣接だが**肩の強さ**という単一のボトルネックで分水嶺ができる非対称ペア。
6. **C-任意ポジション**・**P-野手**は事実上ゼロ（後述4節）。

Sources:
- [Willi Castro / MLB.com news on 5-position 2024 season](https://www.mlb.com/) （検索結果要約: "MLB star player position switches in 2024"）
- [Here are the most versatile LDS rosters — MLB.com](https://www.mlb.com/news/2020-playoff-teams-with-most-versatile-roster)
- [Player Profile: Ben Zobrist — The Hardball Times, FanGraphs](https://tht.fangraphs.com/player-profile-ben-zobrist/)
- [Multi-Position Elligibility Value: Intro & Literature Review — RotoGraphs](https://fantasy.fangraphs.com/multi-position-elligibility-value-intro-literature-review/)
- [Utility player — Wikipedia](https://en.wikipedia.org/wiki/Utility_player)

### 3. キャリア内のポジション移動の定石

- **典型的コンバート経路**（加齢＝スペクトラム右→左）:
  - `SS → 3B → 1B`（例: Alex Rodriguezは2004年にSS→3Bへ、以降キャリア終盤にかけて守備価値が漸減。Carlos Correaも2020年代半ばにMetsでSS→3Bへの転向合意）
  - `CF → コーナー外野(LF/RF) → 1B/DH`（例: Matt Kemp, Andrew McCutchen。「スピードで稼いでいた選手ほど、スピードの陰りとともにコーナーへ押し出される」）
  - `2B/3B → 1B`（守備範囲より捕球の正確さで守れる1Bへの受け皿的転向）
  - `C → 1B`（捕手は身体的消耗が最大のポジションのため、キャリア後半に1B転向する例が多い。ただし技能的には遠いポジションなので「捕手をやめて1Bへ」という**一方向の逃げ道**であり、1Bから捕手への逆流はほぼ無い）
- **若手の「とりあえずSS/CFで育てて下位互換ポジへ」慣行**: スカウティングの定型思想として、アマチュア〜マイナー時代は運動能力最優先でSS・CFに置き、プロで打力・パワーが伸びた/守備適性が伸び悩んだ段階で3B・2B・コーナー外野・1Bへ「格下げ」する。これは**スペクトラム上を右→左に滑らせる**、まさに本タスクのモデル化対象そのものである。
- **反対方向（左→右）の転向はほぼ存在しない**: 1B出身選手が後年SSやCに挑戦する例は実質皆無。スペクトラムは「片道切符」。

Sources:
- [Versatility in the Field: A history of key MLB players changing positions — Call to the Pen](https://calltothepen.com/posts/history-of-key-mlb-players-changing-positions-betts-fisk-rose-01hpjbdzr7j3)
- [Baseball Trade Values: Explaining the value decline of aging center fielders](https://www.baseballtradevalues.com/articles/explaining-the-value-decline-of-aging-center-fielders)
- [MLB Dodgers: Race at second base — converting shortstops before season starts](https://www.mlb.com/dodgers/news/race-at-second-base-dodgers-converting-shortstops-before-season-starts/c-68476278)
- [Eight MLB players changing position for 2025 — CBS Sports](https://hoopshype.games.cbssports.com/mlb/news/eight-mlb-players-changing-position-for-2025-rafael-devers-jose-altuve-clay-holmes-and-more/)

### 4. 特殊性（C・SS・1B/DH・投手）

- **捕手（C）は転入元がほぼ存在しない孤立ポジション**: 「捕手の代わりになれるのは捕手だけ」という格言的言明があり、実証分析でも1B専任経験者のうち捕手も守った割合は**1.5%程度**、しかもレギュラー3塁手で捕手を兼ねた例（Jordan Pacheco, 2012）が「ほぼそれだけ」と評されるほど稀。
  → **設計含意**: Cはスペクトラム上の「連続変数」として扱うと実態を誤る。**独立した特殊クラスタ**（スペクトラム距離に関係なく他ポジからの適性がほぼゼロ）として扱うのが定説に忠実。
- **SSも準特殊**: 前述の通りSSは2B/3Bとの差が約3 runと大きく、「SSを守れるかどうか」は肩の強さ・反応速度という閾値的な資質でほぼ二値的に決まる（できる/できないがはっきり分かれる）。ただし**SSができる選手は2B・3Bが高確率でできる**（逆は成立しにくい）という非対称含意がユーザー問題意識とも一致。
- **1B/DHは受け皿**: 守備難度最低（1B）または守備なし（DH）のため、**あらゆるポジションからの終着点**になる。1Bは「守備範囲要求はほぼゼロだが、悪送球を拾う・タッチプレーの正確さは独立技能」という特殊性はあるものの、転向コストは全ポジション中最小。
- **投手の野手兼任は例外中の例外**: 二刀流ルール（MLB, 2020年代）は「投手として20イニング以上・野手として20試合以上（各3打席以上）」という高い閾値を要求する特別区分。史上でBabe Ruth以降、100イニング＋200打席規模の二刀流はShohei Ohtaniまで実質皆無だったとされる。
  → **設計含意**: 投手の野手適性・野手の投手適性は本モデルの対象外（ゲーム中で扱う必要性が薄い＝req_2③のやきゅつく的な楽しさとしてOhtani型の激レア二刀流を将来的に扱うとしても、通常のポジション適性モデルとは別軸で良い）。

Sources:
- [Baseball Therapy: The Crack in the Defensive Spectrum — Baseball Prospectus](https://www.baseballprospectus.com/news/article/28408/baseball-therapy-the-crack-in-the-defensive-spectrum/)
- [MLB two-way player rules](https://www.mlb.com/news/mlb-two-way-player-rules)

### 5. ユーティリティ選手の分布感

- **MLB**: 「5ポジション25試合以上」級の真の超ユーティリティ（Willi Castro型）は**史上初**と報じられるほど稀＝12球団×MLB30球団換算でも**リーグ全体で年1人出るかどうか**のレベル。一方「3ポジション程度をこなすベンチユーティリティ」はプレーオフ進出チームのベンチには**1チーム1〜2人**が定番（2020年プレーオフの"most versatile roster"特集で複数チームが名指しされる程度の頻度）。
- **NPB**: 検索で確認できた実例（確度中・一次データの集計値は未確認）:
  - **鈴木大地（楽天）**: 2019年に1B・3B・外野・2B・SSと**ほぼ内野全ポジ＋外野**を守った実績を持つ、内野出身の代表的ユーティリティ。
  - **木村拓也（日本ハム→広島→巨人）**: 「投手以外の全て」を守れたと評される、NPB屈指の万能選手。
  - **元木大介（巨人）**: 内野全ポジ＋左翼を守った実例。
  - NPBのユーティリティ選手分析（二次情報・note等）では「本職は二遊間の内野手であることが多い」傾向が指摘されている。理由として「内野特有のグラブ捌きは外野守備より習得コストが高いが、外野への打球対応は守備練習で後天的に克服しやすい」＝**内野中央（2B/SS）を基点に外野へ拡張する方が、外野を基点に内野中央へ拡張するより低コスト**という非対称性が示唆されている。これはMLBの実例（SS/2B出身のZobrist・Castro・Edmanが外野もこなす）とも整合する。
- **球団あたりの人数感（推定・確度中）**: 支配下選手数十名規模のロスターにおいて「2ポジション以上を実戦レベルで守れる野手」は控え含め**数名〜1/3程度**、「3ポジション以上」は**1〜3名**、「ほぼ全部（C・P以外6-7ポジ）」に達する真の万能選手は**在籍0〜1名が通常**（複数在籍は稀）。

Sources:
- [NPB歴代ユーティリティープレーヤーランキング — スポーツナビ](https://sports.yahoo.co.jp/column/detail/2026030200006-spnavi)
- [ユーティリティプレイヤーの必要性を考える｜しらす — note](https://note.com/shirasuniki/n/ne06ec73a6e9d)
- [鈴木大地 (野球) — Wikipedia](https://ja.wikipedia.org/wiki/%E9%88%B4%E6%9C%A8%E5%A4%A7%E5%9C%B0_(%E9%87%8E%E7%90%83))
- [Here are the most versatile LDS rosters — MLB.com](https://www.mlb.com/news/2020-playoff-teams-with-most-versatile-roster)

### 調査の限界（正直な申告）

- Baseball-Reference Stathead / Baseball Savantの**生の兼任率（%）データ**には検索経由でアクセスできなかった（WebFetchが本セッションの環境要因で403となり一次ページを直接開けなかった）。上記の「共起ペア頻度感」「球団あたり人数感」は**複数の実例・二次分析からの帰納**であり、定量的な確度は中程度に留まる。将来コード側で実際に調整ノブを校正する際は、可能であれば別途Stathead等の集計値で裏取りすることを推奨する。
- NPBの兼任統計は一次データベース（NPB.jp個人成績等）を選手ごとに集計すれば取得可能だが、本調査では時間的に代表選手の実例確認に留めた。

---

## Part 2: 本ゲームへのモデル設計提案

### 現状モデルの実装確認

- `src/generate.mjs` `generateFielder()`: 全`FIELD_POSITIONS`（8ポジ）に対し`positionProf[p] = draw(rng, 24, 5)`で**フラットに独立抽選**→主ポジのみ`draw(rng, 60, 8)`で上書き。35%確率で**ランダムに選んだ1ポジのみ**`draw(rng, 48, 8)`でブースト（`alt`はFIELD_POSITIONSから完全一様抽選＝スペクトラム上の隣接性を一切考慮しない）。
  → 主ポジがSSでもCが`alt`に選ばれうる、CFの選手が1Bにブーストされうる、といった**現実に反するランダム性**を内包する。
- `src/model/positions.mjs`: `POSITION_DIFFICULTY = ['C','SS','CF','2B','3B','RF','LF','1B']`（難→易）が**既に定義済み**で、`buildDepthChart`の配置順・較正のPositionAdjustにも使われている。**スペクトラム自体はコードにすでに存在する**が、`generateFielder`の`positionProf`生成には接続されていない。
- `src/sim/team.mjs` `posRankScore`: `positionProf[pos]`に守備素材(Range)と打撃を加重して算出。この関数自体はどのポジでも動くので、**positionProfさえスペクトラム構造で生成されれば、posRankScore/buildDepthChart/usage.mjsの日次配置ロジックは無改修で恩恵を受ける**（＝正しい生成データを与えるだけで一軍内配置は良くなる）。
- `src/game/roster_moves.mjs`: `farmCandidates`（238行目）・`sameType`（421行目）・IL入替候補選定（274行目）の**3箇所すべてが`q.primaryPos === like.primaryPos`の完全一致でゲート**（昇格・トレード時の同型探索・IL入替候補探索）。ここがユーザー提示の監査結論「外野相互候補化」等が刺さる箇所。
- **オフの正式コンバート（案D）は現状未実装**（`src/game`配下に「コンバート」「convert」に該当する処理なし）。

### 設計方針の共通基盤: スペクトラム距離

`POSITION_DIFFICULTY`の並び順を1次元の座標とみなし、2ポジション間の「スペクトラム距離」を**配列インデックスの差**として定義する（Cは特殊枠として別処理、後述）。

```
インデックス:  SS=0  CF=1  2B=2  3B=3  RF=4  LF=5  1B=6   （Cを除いた7ポジ・難→易）
```

※ 現行`POSITION_DIFFICULTY`の並びは `C, SS, CF, 2B, 3B, RF, LF, 1B`。Part1の知見（SS-2B-3Bが最頻出クラスタ、CF-corner OFがクラスタ、2B-3Bはほぼ同格）を踏まえると、**この並びは1次元の線形距離としてはやや不正確**（SSと2Bの間にCFが挟まる配置は、実際の共起頻度＝SS-2B-3Bの内野トライアングルの近さを過小評価する）。3案とも、この点を「距離定義の補正」として扱うか現状維持かで違いが出る（後述）。

---

### 案A: 生成モデルをスペクトラム基盤で全面刷新（高リスク・高再現度）

**内容**:
- `positionProf`生成をスペクトラム距離ベースの期待値減衰関数に置き換える。
  ```
  positionProf[p] = draw(rng, base(distance(primaryPos, p)), sd(distance))
  ```
  距離0（主ポジ）= 60/sd8（現行維持）、距離1（隣接: SS↔2B・2B↔3B・CF↔LF/RF等）= 45〜48/sd7、距離2以上 = 24〜30/sd5へ漸減。
- Cと1B/DHは特殊端点として別式（Part1の知見どおりCは他ポジからの適性をほぼゼロに固定＝孤立クラスタ、1Bはどの距離からもボーナス＋αの受け皿補正）。
- 「ユーティリティ型」の分岐確率（現行35%）を、内野中央クラスタ（SS/2B/3B）出身は外野への拡張を得意とする非対称重み（Part1§5のNPB知見）で調整。
- 距離定義そのものをPOSITION_DIFFICULTYの単純な線形順ではなく、**内野トライアングル(SS-2B-3B)クラスタ＋外野クラスタ(CF-LF-RF)の2クラスタ＋橋渡し(3B-1B, CF-2B, OF-1B)**という**グラフ構造**に置き換える（1次元順序では表現できないSS-2B-3Bの三者近接とCF-2Bの遠さを両立させるため）。

**適格判定**: `positionProf[p] >= 閾値`（例: 35）で「守れる」とする単純なゲート。生成が現実分布に寄っているので閾値判定自体はシンプルでよい。

**加齢コンバート接続**: 加齢で`primaryPos`をスペクトラム上1〜2段階「易」側へ再抽選する際、新しい`positionProf`をこの生成式で引き直せば整合が取れる（生成式と加齢式が同じ距離関数を共有）。

**較正リスク（高）**:
- `positionProf`の平均・分散が変わる＝`posRankScore`の分布が変わる＝`buildDepthChart`の配置・**1年目シーズンのUZR/OAA帯**（`CALIBRATION_TARGETS.uzrTop/uzrBottom/uzrSd`）に直結する。
- 「主ポジ以外の平均が上がる」設計（隣接ポジは45〜48）だと、**代替可能な守備固め・платoonの選択肢が増え、守備指標の分布自体がシフトする**恐れが高い。
- CLAUDE.md鉄則7「1年目シム不変」に抵触しうる＝**52較正指標の再較正が事実上必須**。`npm run calibrate`のUZR関連3指標だけでなく、ポジション別の打撃分布（スペクトラム右側は打力が下がる設計との整合）にも波及しうる。
- 変更規模が生成コアに及ぶため、`npm run verify`（決定論同一性）自体は通るが、**較正収束の作業量が最大**。

---

### 案B: 生成は不変・起用判定だけスペクトラム化（低リスク・部分的改善）★必須案

CLAUDE.mdのタスク指示にある「生成は不変・起用判定だけスペクトラム化する低リスク案」に該当。

**内容**:
- `generateFielder`の`positionProf`生成ロジックは**一切変更しない**（既存の乱数列・分布を保つ＝1年目シム・52較正指標に無影響）。
- 変わるのは「このポジションを守れるか」の**判定則**のみ。`farmCandidates`・`sameType`（`roster_moves.mjs`）・IL入替候補選定の3箇所にある`q.primaryPos === like.primaryPos`を、
  ```
  isEligible(q, targetPos) =
    q.primaryPos === targetPos ||                          // 主ポジ一致
    spectrumDistance(q.primaryPos, targetPos) <= 1 ||       // スペクトラム隣接（外野内3ポジ相互・SS-2B-3B等）
    q.trueAbility.fielding.positionProf[targetPos] >= THRESHOLD  // 既存positionProfが偶然その閾値を超えている（ユーティリティ枠の35%ブースト分を拾う）
  ```
  に緩和する。CはPart1の知見どおり例外扱い（`spectrumDistance`を無視し、`q.primaryPos === 'C'`のみ許可＝孤立クラスタを尊重）。
- 監査結論で名指しされた「外野相互候補化」はこの緩和の**部分集合**として自然に実現する（CF-LF-RFの`spectrumDistance<=1`が真になる）。
- `callupScore`（`evaluateProspect`ベース）に監査の**案C＝守備フィット減点**を足す: `targetPos`と`q.primaryPos`が不一致の場合、`positionProf[targetPos]`の観測値（スカウトノイズ込み）に応じた減点項を加える。これにより「守れなくはないが本職ではない」選手は選ばれるが、微妙にスコアが下がる＝**現実の"コンバート起用は本職より一段落ちる"感覚**を再現。

**適格判定**: 上記`isEligible`。閾値は`config.mjs`の`tuning.moves`に新設（例: `crossPosThreshold: 35`）。

**加齢コンバート接続**: 既存の`positionProf`生成をそのまま使い、案Dのオフコンバート（後述）が`primaryPos`を書き換えた後は自動的に`isEligible`の主ポジ一致判定が新primaryPosに追従する。**別途フックは不要**。

**較正リスク（最小）**:
- `positionProf`の値も分布も**一切変えない**ため、**1年目シーズンのUZR/OAA帯・打撃分布は完全不変**（鉄則7を厳守）。
- 変化するのは「昇格/IL入替/トレード候補の探索範囲が広がる」ことのみ＝**登録入替の頻度・組み合わせの多様性**に効くが、これはシーズン中の運用（軍配再編の柔軟性）であって較正53指標が直接参照する量ではない。
- ただし、探索範囲が広がることで「守備フィットの低い選手が昇格しやすくなる」→一軍の平均守備力がわずかに下がる可能性はゼロではない（守備フィット減点が効いていれば軽微）。**`npm run realism`のUZR/OAA帯WATCH項目としての観測を推奨**（GATE化は次段階）。
- 実装範囲が`roster_moves.mjs`＋`positions.mjs`の距離関数追加のみで完結＝**変更差分が小さく、レビュー・敵対的検証コストも低い**。

---

### 案C: 案Bを土台に、生成もスペクトラム構造へ「非破壊的」拡張（中リスク・段階導入）

案Aの理想形と案Bの安全性のギャップを埋める中間案。**config.mjsのtuningフラグで段階導入**し、較正が壊れたら即座に案Bへロールバックできる設計。

**内容**:
- `generateFielder`の**乱数の引き方の順序・種類は変えず**（既存のrng呼び出し列を保つ＝決定論の後方互換）、「ユーティリティ確率でブーストするalt決定」だけをスペクトラム重み付き抽選に変更する。
  ```
  // 現行: const alt = FIELD_POSITIONS[rng.int(FIELD_POSITIONS.length)];  ← 完全一様
  // 変更: 距離に反比例した重みで抽選（例: distance0除外・distance1は重み4・distance2は重み2・distance3+は重み1）
  const alt = weightedPick(rng, FIELD_POSITIONS.filter(p => p !== primaryPos), (p) => altWeight(primaryPos, p));
  ```
  Cは`primaryPos==='C'`のとき`alt`抽選プールから除外（孤立クラスタ）、他ポジから`alt==='C'`が選ばれる確率もゼロにする。
- ベースの`draw(rng, 24, 5)`フラット部分は**変更しない**（他ポジ適性の下限床は不変）。変わるのは「35%の当たりくじがどのポジに乗りやすいか」の**重みだけ**であり、rng消費列の型（1回のint抽選）は保たれるため乱数列への影響は局所的。
- 監査結論の「外野相互候補化」は、CF/LF/RF間で`altWeight`を高く設定することで生成段階から底上げされる。

**適格判定**: 案Bの`isEligible`をそのまま使う（生成が現実的になった分、閾値判定の的中率が上がる）。

**加齢コンバート接続**: 案Bと同じくオフコンバートが`primaryPos`を書き換えるだけで自動追従。加えて、コンバート時に**新positionProfを距離ベースで底上げする**（例: 新primaryPosの`positionProf`を60へ、旧primaryPosを距離1つぶん減衰させて保持＝「元SSは3B適性が最初から高い」を明示的に表現）着地点をここに置ける。

**較正リスク（中・局所的）**:
- 影響範囲は「35%抽選に当たった選手のうち、どのポジがブーストされるか」の**内訳の偏り**のみ。ブーストされる人数（35%という母数）・ブースト量（`draw(rng,48,8)`）は不変なので、**リーグ全体のpositionProf平均・分散はほぼ不変**（外野内相互やSS-2B-3B内で偏りが生まれるだけ）。
- 影響が出るとすれば「外野の中でCF適性を持つLF/RF専任者が増える」ことによる**守備固め采配・終盤の守備シフトの発生頻度**の変化程度。UZR/OAA帯への影響は案Aよりずっと小さいが、**ゼロではない**ため`npm run calibrate`＋`npm run realism`を通し、UZR関連3指標を確認する運用は必須。
- 決定論（`npm run verify`）は「rng呼び出しの回数・型」が変わらない範囲であれば通る設計にできる（`weightedPick`を`rng.int`1回の中に収める実装にすること）。

---

### 比較表

| 観点 | 案A: 生成全面刷新 | 案B: 起用判定のみ（★必須・低リスク） | 案C: 生成の重み付けのみ（段階導入） |
|---|---|---|---|
| 変更範囲 | `generateFielder`のpositionProf式全体 | `roster_moves.mjs`のゲート条件＋距離関数新設 | `generateFielder`のalt抽選重みのみ |
| 1年目シム不変（鉄則7） | ✗ 破る可能性が高い | ○ 完全保持 | △ ほぼ保持（局所的偏りのみ） |
| 較正53指標への影響 | 大（再較正ほぼ必須） | なし〜極小 | 小（UZR系のWATCH確認は必要） |
| 決定論(`npm run verify`) | 通るが乱数列は変わる | 完全不変 | rng呼び出し型を保てば不変 |
| 監査結論「外野相互候補化」の実現 | ○（生成段階から） | ○（判定緩和で実現） | ○（生成の重みで自然に増幅） |
| SS-2B-3B・CF-OFクラスタの再現度 | 高（グラフ構造で明示） | 低（判定則に距離1採用のみ反映、実データ分布は反映されず） | 中（生成の重みに反映されるが値の絶対水準は現行踏襲） |
| C/SSの特殊性の扱い | 専用式で明示 | isEligibleで例外扱い | alt抽選プールから除外で明示 |
| 加齢コンバート（案D）との接続 | 生成式共有で自然接続 | primaryPos更新のみで自動追従（フック最小） | primaryPos更新＋新旧positionProfの明示的シフトを追加可能 |
| 実装・検証コスト | 高（生成コア＋較正収束） | 低（roster_moves.mjsの1関数＋距離定義） | 中（generate.mjsの1箇所＋較正確認） |
| 案C(監査)＝守備フィット減点付きcallupScore | 別途要実装 | 本提案の一部として同時実装を推奨 | 別途要実装（案Bの上に乗せる） |
| 案D(監査)＝オフの正式コンバート | 生成式再利用で実装しやすい | 別途新規実装（primaryPos書き換え＋距離減衰） | 生成式の重みを再利用して実装しやすい |

### 推奨案

**第一段階として案B（生成不変・起用判定のみスペクトラム化＋守備フィット減点付きcallupScore＝監査の案C相当）を最優先で実装する。**

理由:
1. CLAUDE.md鉄則7「1年目シム不変」・鉄則2「config集約」を厳守しつつ、監査で指摘された**具体的な穴（外野相互候補化の欠如・primaryPos完全一致ゲート）を過不足なく塞げる**。
2. `positions.mjs`にはすでに`POSITION_DIFFICULTY`という**現実の定説に忠実なスペクトラム定数が実装済み**であり、これを`spectrumDistance()`関数として一段抽象化して`roster_moves.mjs`から呼ぶだけで済む＝**新しい"発明"をせず既存資産を配線するだけ**（req_1の設計思想とも整合）。
3. 較正・決定論への影響がゼロに近いため、**検証コストが最小で三原則②（起用の妥当性）に即座に効く**。

**その上で、案C（生成の重み付けのみ・段階導入）をフェーズD/E相当の次段階として追加投入することを推奨する。**

理由:
1. 案Bだけでは「SS適性が高い選手ほど3Bも高い」という**生成段階の相関構造そのもの**は現実に追いつかない（判定則が緩くても、母集団のpositionProf自体はフラット→スカウトノイズを乗せた`callupScore`の精度が本質的に頭打ち）。案Cで生成にスペクトラム構造を持たせることで、**评価・査定の"地力"が上がる**。
2. 変更が「alt抽選の重み」という**局所的パラメータ**に閉じるため、較正への影響を`npm run calibrate`＋`npm run realism`で確認しながら**config.mjsのtuningフラグで段階的にロールアウト**できる（壊れたら即案Bへフォールバック）。
3. 加齢コンバート（案D＝オフの正式コンバート、未実装）を実装する際、**案Cの重み関数をそのまま新positionProf生成に再利用できる**ため、実装の二重化を避けられる。

**案A（生成全面刷新＋グラフ構造クラスタリング）は採用を保留し、将来「守備の市場非効率（鉄則5: 球団AIが守備を過小評価する）」をさらに作り込むフェーズで再検討する。** 現時点では較正コストに見合うだけの三原則上のメリット（③やきゅつく的な楽しさ、②近似の精度向上）が、案Cとの差分では限定的と判断した。

### 実装時の注意点（次段階への申し送り）

- `spectrumDistance(posA, posB)`は`positions.mjs`に新設し、`POSITION_DIFFICULTY`ではなく**専用のクラスタ定義**（内野トライアングル{SS,2B,3B}・外野トライアングル{CF,LF,RF}・橋渡し{3B-1B, CF-2B, OF-1B}、Cは孤立）を使うこと。現行`POSITION_DIFFICULTY`の1次元順序をそのまま距離に流用すると、Part1で確認した「SS-2B-3Bの近さ」「CF-2Bの遠さ」を歪める。
- 閾値・重み（`crossPosThreshold`・`altWeight`等）は必ず`config.mjs`の`tuning`に集約（鉄則2）。
- Cの例外処理は判定則・生成重みの両方で**必ず明示的に排除**すること（Part1§4の実証: 1B経験者の捕手兼任率1.5%程度＝スペクトラム距離に基づく連続的減衰では過大評価してしまう）。
- 変更後は`npm test`→`npm run calibrate`（案Bのみなら影響ほぼ無いはずだが、鉄則にある通り必ず実施）。案Cを乗せる場合は追加で`npm run realism`のUZR/OAA関連WATCH項目を確認すること。

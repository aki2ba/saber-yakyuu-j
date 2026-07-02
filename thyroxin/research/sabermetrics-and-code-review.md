# セイバー指標の文献的正確性 ＆ 実装コード レビュー

> 対象: `saber-yakyuu-j`（フェーズ1完了時点 / ENGINE_VERSION 0.1.3-metrics）
> 方法: 多エージェント調査（概念11本＝Web文献照合、コード監査5次元、敵対的検証、完全性クリティック）
> 位置づけ: 「細部は後で詰める」ための**現状の正確性カタログ**。修正はここから優先度付けして着手する。

---

## 0. 総合評価（クリティック所見の要約）

設計思想（**二段パイプライン**＝規律層PA→打球EV/LA→球場ジオメトリ、**2パスのリーグ定数導出**、**決定論RNG**、**生カウントからの指標創発**）は一貫しており、**打撃・投手の"レート系"指標は較正後に信頼できる中核**をなす。

ただし実装レベルで、**生成される能力軸のかなりの部分が結果計算に結線されておらず"飾り"になっている**（守備range全般・捕手framing・走塁steal/hold/IQ・投手hrSuppress・左右プラトーン）。加えて**投手の登板/勝敗/セーブ/ホールドのカウント系に実バグ**がある。

### セイバー的信頼度（カテゴリ別）

| カテゴリ | 信頼度 | 根拠 |
|---|---|---|
| リーグ〜個人の**打撃レート**（AVG/OBP/SLG/wOBA/wRC+） | **中〜妥当** | 較正帯を満たす。式構造も文献と同型。ただしwOBA線形ウェイトの基準点ズレ（後述B-2） |
| 投手の**FIP/ERA/K%/BB%** | **中〜妥当** | 式・定数導出は文献整合。較正済み |
| **守備指標（OAA/UZR）** | **低（プレースホルダ）** | 守備能力が結果に未結線＝純粋な運（M1）。run換算も未実装 |
| **走塁指標（wSB/UBR/wGDP）** | **未実装** | SB/CS/GDPが一度も生成されない（M2）。フェーズ2予定 |
| **投手の登板/勝敗/SV/HLD** | **低（バグあり）** | 幽霊リリーフ・引分未計上・継承走者誤帰属（A-1〜A-5） |
| **HR被弾の投手差** | **低** | hrSuppressが未使用で全投手同一被弾率（M3） |

**結論**: 「AVG/OBP/SLG/wOBA/wRC+ とFIP/ERA」は現状でも読める。「守備・走塁・救援役割・個人の勝敗/SV」に触れる数字は現状スコアブックとして信用しない方がよい。

---

## ✅ 適用済み修正（本レビュー直後 / ENGINE 0.1.3）

「今すぐ直す価値」の実バグを修正済み（tests 74/74・較正12/12 PASS・スモークOK を確認）:
- **A-2/A-4** 引分G/GS未計上 → 付与ループをearly-return前へ。実測 総GS **1678→1716**（正）。
- **A-1/A-5** 幽霊リリーフ → `flushPitcher`で実登板(bf>0)のみログ。実測 総SV **~249→498**（回復）、登板G水増し解消。
- **A-9** 投手contactQuality未生成 → `createPitch`で生成。`evPitchSuppress`が有効化し**投手ERA分布が2.48〜5.99に拡大**（従来は投手差なし）。
- **A-8** deepAssign → null上書きの例外解消＋葉オブジェクトを`clone`複製（ディープコピー契約を完全化）。
- **B-8** `hitLD` 0.607→**0.66**（文献整合）。上記2件の得点環境変化と併せ**再較正**（hrScale/hitGB/進塁を微調整）→ 全12指標PASS維持。
- 回帰テスト2件追加（G/GS・SV整合、deepAssign null/複製）。

残りは Part D の「フェーズ2で結線」「WAR実装時」に送る（守備結線・走塁生成・hrSuppress結線・TTO規模・wOBAウェイト等）。

---

## Part A. 確認済みコードバグ（原文照合で検証済み）

| # | 深刻度 | 箇所 | 内容 |
|---|---|---|---|
| **A-1 / A-5** | **major** | `game.mjs` maybeChangePitcher | **幽霊リリーフ**: 半イニングの第3アウト直後に交代判定(`outs>=3`)が発火し、1球も投げていない投手がログ末尾に積まれる。実測(seed=2026)で**決着839試合中472試合で勝者ログ末尾が0アウトの幽霊**、本来セーブ資格の**約54%(289件)が無効化**、幽霊flush 753件で登板(G)が水増し。 |
| **A-2 / A-4** | **major** | `game.mjs` assignDecisions | **引分でG/GS未計上**: `if(home.score===away.score) return;` の後ろに登板/先発付与ループがあるため、引分試合の全投手G・先発GSが加算されない。実測 総GS=1678（正=1716、差38=引分19×2先発）。 |
| **A-3** | minor | `game.mjs` 得点帰属 | **継承走者の誤帰属**: 回途中で交代した前任投手の残した走者の生還が、後続投手のERAに課される。 |
| **A-6** | minor | `season.mjs` buildSchedule | **ホーム/ビジター不均衡**: `k%2`でホスト側が常に低インデックス球団に固定 → T1=77本拠地…T12=66。9回裏省略と絡み集計に球団相関バイアス。 |
| **A-7** | minor | `build.mjs` IMPORT_RE | 正規表現が行頭アンカー無しで、コメント中の「import」に食いつき次の`from`まで貪欲削除（現状無害だが潜在バグ）。 |
| **A-8** | nit | `config.mjs` deepAssign | `null`上書きで例外（`typeof null==='object'`）＋上書き値を参照のまま挿入（ディープコピー契約の一部欠落）。 |
| **A-9** | **major** | `generate.mjs` createPitch呼出 | **contactQuality未生成**: 投手の被コンタクト質を設定せず既定50固定 → `meanContactSuppress`が常に50 → `evPitchSuppress`（"較正済み"ノブ）が全投手で無効化＝EV抑止の投手差が消失。**生成軸の配線交差**。 |
| **A-10** | nit | `calibrate.mjs` | 規定打席443をハードコード（config.qualifiedPAと二重定義）、規定0件で`Math.max(...[])=-Infinity`。 |

### A の推奨修正（安価で効果大）
1. **A-2/A-4**: G/GS付与ループを引分early-returnの**前**に移す。
2. **A-1/A-5**: 交代判定で「実登板(bf>0)しない投手はログに積まない/G加算しない」、セーブ判定は`bf>0`の実際の最終投手を対象に。
3. **A-9**: `createPitch`に`contactQuality`を生成（control/hrSuppressと相関）。
4. **A-8**: `deepAssign`に`over[k]!==null`ガード＋葉は`clone()`複製。
5. A-3/A-6/A-7/A-10 は中〜低優先（構造改善時に）。

---

## Part B. セイバー概念の文献的正確性（11概念）

| 概念 | 判定 | 一行所見 |
|---|---|---|
| **log5 / オッズ比** | 合理的簡略化 | 加法ロジット形は Bill James log5 と**数学的に等価**（diff<3e-17で検証）。K/BB/HBP独立算出→残余IN_PLAYは多項softmax標準と異なるが実用的 |
| **wOBA / 線形ウェイト** | ⚠️**要検討** | ウェイトが"平均基準(RE24)"で、FanGraphsの"アウト基準"でない → wOBAscale 1.78 vs 標準1.25、**BB過小/HR過大**の系統バイアス |
| **wRAA / wRC+** | 合理的簡略化 | 式構造・リーグ平均100アンカー・2パス導出は正しい。絶対値はFG比で約68%に圧縮（内部整合は保持） |
| **FIP / DIPS** | 合理的簡略化 | 式・定数導出(C=lgERA−lgFIPraw)・係数13/3/2は文献整合。`replFipMult=1.216`は**文献に根拠なし**、IBB未減算（現状無害） |
| **WAR（計画）** | 合理的簡略化 | repl=13.3はNPB妥当値~17より約20%低。replFIP×1.216に出典なし・先発/救援区別なし。posAdj分母1350/1458の混在。CF>2Bは posAdj上は同値 |
| **BsR（計画）** | 合理的簡略化 | 損益分岐75%は現代コンセンサス~69-70%より高い（1990年代の旧ルール）。CS≈−0.4はMLB値、NPBは−0.32 |
| **UZR / OAA** | 合理的簡略化 | 失策別成分化は文献整合。だが**守備能力が未結線＝純粋な運**（M1）。run換算(内野0.75/外野0.90)未実装 |
| **打球 EV/LA / xBA** | 合理的簡略化 | `hitLD=0.607`は文献~0.68-0.70より**約10pp低い**。EV/LA独立生成は物理の負相関を無視。飛距離モデル(carry=0.6)は妥当 |
| **対戦巡目 TTO** | 合理的簡略化 | ペナルティが**文献の1/3〜1/5**（実証+0.008-0.013 wOBA/巡 vs 実装~0.002-0.003）。**BB増加チャンネルが欠落** |
| **得点環境 / RPW** | ⚠️要検討 | RPW式・BABIP基準は正確。だが`singleScore2=0.31`/`doubleScore1=0.25`はMLB実データ(~55-61%/~50-60%)から乖離（進塁簡略化を相殺する"キャンセル型較正"、RBI王~145の症状） |
| **加齢曲線** | 合理的簡略化 | 方向性は文献整合（速球/走力早落ち）。peakAgeが投手/野手同一、"選球眼は伸びる"がdeclineRateに未反映（フェーズ3課題） |

### 概念別の詳細

#### B-1. log5 / オッズ比合成 〔合理的簡略化〕
- **実装**: `rates.mjs` の `log5(L,ΔB,ΔP)=expit(logit(L)+ΔB+ΔP)`、`ratingDelta=slope*(rating-50)/10`。K/BB/HBPを独立ロジスティックで算出し `pInPlay=1−pK−pBB−pHBP`。
- **文献**: Bill James log5 `P=(A·B/L)/(A·B/L+(1−A)(1−B)/(1−L))` はオッズ比で `logit(P)=logit(A)+logit(B)−logit(L)`＝我々の加法ロジットと**完全等価**（Bradley-Terry/Elo/Rasch同値）。多項拡張はsoftmax正規化が標準。
- **乖離**: (major)独立3事象→残余方式は多項同時分布と異なるが、極端能力でもpK+pBB+pHBP=0.70で0.95キャップ内。(minor)`kStuff`が20-80レンジを超えうる（whiff80×160km/hでΔ=0.845>上限0.66）。(minor)HBPに打者側効果なし。(minor)`log5()`がデッドコード。
- **推奨**: 理想は4事象(K/BB/HBP/IN_PLAY)の多項正規化。次善は`kStuff`に`min/max`クリップ追加。`ratingDelta`線形写像と0.95キャップは変更不要。

#### B-2. wOBA / 線形ウェイト / wOBAscale 〔⚠️要検討〕
- **実装**: `LINEAR_WEIGHTS={bb:0.33,hbp:0.36,b1:0.47,b2:0.78,b3:1.09,hr:1.40}`、分母`AB+BB+HBP+SF`、`wobaScale=lgOBP/lgRawPerPA≈1.78`。
- **文献**: FanGraphsは**アウト基準(runs above out)**のウェイト（2015: BB=0.55,1B=0.70,HR=1.65）を使い、wOBAscale≈1.15-1.25。我々の値は**平均基準(RE24)**（BB=0.29+out補正なし）。
- **乖離**: (major)実効wOBAウェイトが**BB−15%/HR+22%**とFG標準からずれ、**BB型打者を系統的に過小評価**。(major)`wobaScale≈1.78`はFGの1.25と定義が別物でコメントが誤解を招く。(minor)分母にIBB含む。
- **検証**: isReal=true（minor）。内部整合は保たれ選手ランキング順序・リーグ平均100は正しいため、架空NPB内比較には実害小。**外部FG値と絶対比較したいなら**要修正。
- **推奨**: `LINEAR_WEIGHTS`をアウト基準（bb:0.60,b1:0.74,b2:1.06,b3:1.35,hr:1.67付近）へ。理想は2パス目でシム自身のRE24からrun value動的生成（コード自身がコメントで予告）。

#### B-3. wRAA / wRC+ 〔合理的簡略化〕
- 式の骨格（FGノーパーク版と同構造）・リーグ平均100・2パス導出は正しい。絶対値はFG比で約68%に圧縮（wRC+150→≈134）だが内部整合完全。パークファクター未適用は対称12球団では合理的。**短期変更不要**。

#### B-4. FIP / DIPS / FIP定数 〔合理的簡略化〕
- FIP本体・定数導出(C=lgERA−lgFIPraw)・係数13/3/2・HBP包含・2パス動的再導出は**すべて文献整合、修正不要**。
- (major)`replFipMult=1.216`は文献に該当式なし・先発/救援区別なし → NPBは1.20-1.30が理論妥当。動的導出するか出典を補記。(minor)IBB未減算（p.ibbが常に0のため現状無害、敬遠実装時に`3*(bb+hbp−ibb)`へ）。

#### B-5. WAR フレームワーク（計画・未実装） 〔合理的簡略化〕
- (major)`repl=(PA/600)×13.3`はNPB143試合の妥当値~17より約20%低（"初期値・較正対象"と明記済）。(major)`replFIP=lgFIP×1.216`に公開文献なし。(minor)posAdj分母は1350(BR)/1458(FG)混在、コードは`games×9=1287`で正しく処理。(minor)難易度序列CF>2BはposAdj上は同値。
- **推奨**: WAR実装時にreplを較正導出値(16-18 runs/600PA)へ、replFIPを先発0.12/救援0.03 wins/game方式へ、posAdj分母をドキュメントで明示。**143試合再スケール設計自体は正しく変更不要**。

#### B-6. BsR（wSB/UBR/wGDP・計画） 〔合理的簡略化〕
- BsR=wSB+UBR+wGDP はFanGraphs式と一致（DELTA NPBはwGDPなし2成分）。
- (minor)損益分岐75%は現代~69-70%より高い（1990年代旧ルール）。(minor)CS≈−0.4はMLB値、NPB DELTAは−0.32。(minor)"UBR総量>wSB"の一次文献根拠は乏しい（高盗塁環境では逆転しうる）。
- **推奨**: 実装時にrun環境から`runCS=−(2×RunsPerOut+0.075)`を2パス導出（NPBで自動的に≈−0.38）。損益分岐も導出値に。

#### B-7. UZR / OAA 〔合理的簡略化だが未結線〕
- 失策別成分化・OAAをレンジに限定はMLBAM OAAと整合。だが**resolveBattedBallが野手を引数に取らず、Speed/Reaction/PositioningIQがpHitに未接続**＝oaaOutsは個人能力信号ゼロ（純粋ノイズ）。run換算(内野0.75/外野0.90 run/out)未実装。1年UZRのノイズは文献(相関~0.5、3年推奨)と整合。
- **推奨(フェーズ2)**: 野手能力から個人effective pHitを算出しexpOutはリーグ平均のまま→差分が能力信号に。run換算を位置別乗数でconfig化。

#### B-8. 打球モデル EV/LA / バレル / xBA 〔合理的簡略化〕
- (minor)**`hitLD=0.607`が文献~0.68-0.70より約10pp低い**（最大の数値乖離）。(minor)EV/LA独立生成は物理の負相関(Nathan 2016)を無視。(minor)LA=1-9°で飛距離式が不連続。(minor)バレル明示実装なし。(minor)高LA域でキャリー過小。
- **推奨**: `hitLD`を0.66-0.68へ。飛距離モデル(carry=0.6, 100mph/26°≈122m)は物理的に妥当で維持。

#### B-9. 対戦巡目 TTO 〔合理的簡略化〕
- (major)**ペナルティが文献の1/3〜1/5**（実装~0.002-0.003 vs 実証+0.008-0.013 wOBA/巡）→先発の長期起用へのペナルティが現実より薄い。(major)**BB増加チャンネルが欠落**（wOBA重み大のBBを省略）。(minor)球種レパートリー相互作用未実装（config明記のフェーズ2）。(minor)EVペナルティ+0.7km/h/巡の文献根拠未確認。
- **推奨**: `bbPerTime`を追加（+0.015-0.020 logit/巡）、`kPerTime`を0.025→0.06-0.08へ、またはEV/BB複合でwOBA+8-10/巡になるよう再較正。

#### B-10. 得点環境 / RPW / 未自責点 / 進塁 / BABIP 〔⚠️要検討〕
- RPW式(1.5×RG+3)・BABIP基準(0.300)は**正確**。未自責点機構(errorInInning)も正しい。
- (major)`singleScore2=0.31`/`doubleScore1=0.25`はMLB実データ(~55-61%/~50-60%、2アウトで76%)から大きく乖離。(minor)一塁走者が単打で必ず二塁止まり(1B→3Bの可能性ゼロ)。
- **検証**: isReal=false（意図的補正）。「一塁走者が必ず2塁止まり→塁上に走者が溜まる→進塁率を下げて相殺」という**キャンセル型較正**。RBI王~145の構造的高さはこの歪みの症状。
- **推奨**: `singleScore2≈0.50-0.55`/`doubleScore1≈0.45-0.55`に戻し、代わりに**1B→3Bを~30%で実装**＋アウト数依存(2アウトで生還率大)。塁打状況の分布を実態に近づける（UBR精緻化2-5の前でも粗く導入価値あり）。

#### B-11. 加齢曲線 / ピーク年齢 / 生存バイアス 〔合理的簡略化〕
- 方向性は文献整合（速球/走力早落ち・技巧遅い）。(minor)peakAgeが投手/野手同一N(27,2)（文献では投手27-31）。(minor)"選球眼は加齢で伸びる"がdeclineRate式に未反映（フェーズ3のシーズン進行ロジックに委任）。(minor)生存バイアスは引退ロジック(フェーズ3)実装で自動発現。
- **推奨**: フェーズ3実装時に能力別カーブ（選球眼/走塁IQ/ポジIQは改善方向）、先発/救援でpeakAge分離を検討。

---

## Part C. 構造的所見：「未結線の能力軸」（クリティック M1-M8）

**生成されるが結果計算に使われていない能力・イベント**（＝現状は"飾り"）:

| # | 深刻度 | 未結線の内容 | 帰結 |
|---|---|---|---|
| M1 | major | 守備range全般（speed/reaction/arm/positioningIQ/framing）※handsのみ失策に使用 | OAA/UZR/守備WARが純粋な運 |
| M2 | minor | 盗塁/盗塁死/併殺（sb/cs/gdp）が一度も生成されない | 走塁価値・GB併殺が丸ごと欠落、走者が溜まり得点環境膨張 |
| M3 | minor | 投手hrSuppressが生成されるが未使用 | 全投手が同一HR被弾率（FIPの主役HRに投手差が出ない） |
| M4 | minor | 敗戦は常に先発、HLD/BSは常に0 | W-L記録が構造的に偏る（先発が負け過剰、救援は負けない） |
| M5 | minor | 継投が「最少投球回」のみで質・レバレッジ無視 | 実質クローザー役なし、SVがラウンドロビン配布 |
| M6 | minor | タッグアップ成功率100%（深さ無視） | 浅いフライ/内野ライナーでも三塁走者生還＝犠飛過剰 |
| M7 | nit | 左右プラトーンが完全欠落、スイッチは右固定 | 一次オーダー効果(~.020-.030 wOBA)が反映されない |
| M8 | nit | 球場gapDistM(116)が死にコンフィグ、コメントと実装不一致 | 左右中間が最深という現実が未反映 |

※ M1/M2 の多くは**フェーズ2/3で実装予定**（計画通り）。ただし「現状の守備・走塁・救援の数字は能力信号を持たない」ことは明確に認識すべき。M3（hrSuppress）とM4-M6は計画外の実装ギャップで、優先的に埋める価値がある。

---

## Part D. 優先度付きアクション（提案）

### 今すぐ直す価値（安価・明確なバグ / セイバー的信頼を損なう）
1. **A-2/A-4** 引分でG/GS未計上 → ループをearly-return前へ（数行）
2. **A-1/A-5** 幽霊リリーフ（SV54%無効化・G水増し）→ 実登板bf>0のみ計上（小改修）
3. **A-9** contactQuality未生成 → 生成追加（evPitchSuppressを活かす）
4. **A-8** deepAssign null/参照コピー → clone＋nullガード
5. **B-8** hitLD 0.607→0.66-0.68（文献整合、要再較正）

### フェーズ2で結線する（計画通り＋今回判明のギャップ）
6. **M1/B-7** 守備能力→pHit結線＋OAA→UZR run換算（フェーズ2-6/2-7）
7. **M2/B-6** 盗塁・併殺の生成＋wSB/UBR/wGDP（フェーズ2-3〜2-5）
8. **M3** hrSuppressをHR判定へ結線（投手のHR差を出す）
9. **B-9 TTO** ペナルティを文献規模へ（BB増加追加、kPerTime引上げ）＋較正
10. **B-10** 進塁ルールを実態化（1B→3B ~30%、singleScore2/doubleScore1を戻す）＋アウト数依存＋再較正

### WAR実装時（フェーズ2-8/2-9）に整える
11. **B-2** wOBA線形ウェイトをアウト基準へ（またはRE24動的導出）
12. **B-5** repl=13.3→較正導出値(~17)、replFIPを先発/救援方式へ、posAdj分母を明文化
13. **M4/M5** 勝敗の妥当化・継投AIの質考慮（レバレッジはフェーズ4）

### 低優先 / 文書整合
14. A-3(継承走者) / A-6(ホーム均衡) / A-7(bundler正規表現) / A-10 / M7(プラトーン) / M8(球場gap) / B-11(加齢はフェーズ3)

---

## 付録: 参考文献（トピック別）

**log5 / マッチアップ確率**
- Log5 — Wikipedia https://en.wikipedia.org/wiki/Log5
- Matchup Probabilities in Major League Baseball (SABR) https://sabr.org/journal/article/matchup-probabilities-in-major-league-baseball/
- Bias in the log5 estimation (Morey-Cohen 2015, JSA) https://journals.sagepub.com/doi/10.3233/JSA-150005
- Increasingly Complex Matchup Models (arXiv 2511.17733) https://arxiv.org/html/2511.17733v1
- Bayesian batter/pitcher matchup (PMC6192592) https://pmc.ncbi.nlm.nih.gov/articles/PMC6192592/
- Nuclear penalized multinomial regression (Powers et al. 2018) https://arxiv.org/pdf/1706.10272
- A Short Digression into Log5 (THT/FanGraphs) https://tht.fangraphs.com/a-short-digression-into-log5/

**wOBA / wRAA / wRC+ / 線形ウェイト**
- FanGraphs: wOBA https://library.fangraphs.com/offense/woba/
- FanGraphs: Guts!（wOBAscale年別） https://www.fangraphs.com/guts.aspx?type=cn
- FanGraphs: Deriving wOBA https://library.fangraphs.com/the-beginners-guide-to-deriving-woba/
- FanGraphs: Linear Weights https://library.fangraphs.com/principles/linear-weights/
- FanGraphs: wRAA https://library.fangraphs.com/offense/wraa/
- FanGraphs: wRC and wRC+ https://library.fangraphs.com/offense/wrc/
- TangoTiger: Run Expectancy Matrix 1950-2015 https://tangotiger.net/re24.html

**FIP / DIPS**
- FanGraphs: FIP https://library.fangraphs.com/pitching/fip/
- Wikipedia: Fielding independent pitching https://en.wikipedia.org/wiki/Fielding_independent_pitching
- Deriving FIP — Ben Wiener (2024) https://blog.benwiener.com/baseball/2024/02/25/fip.html
- FanGraphs: DIPS https://library.fangraphs.com/principles/dips/
- SABR: The Many Flavors of DIPS https://sabr.org/journal/article/the-many-flavors-of-dips-a-history-and-an-overview/
- Tangotiger: Reconstructing FIP http://tangotiger.com/index.php/site/comments/improving-war-reconstructing-fip

**WAR / 代替水準 / 位置補正 / RPW**
- FanGraphs: WAR for Position Players https://library.fangraphs.com/war/war-position-players/
- FanGraphs: Positional Adjustment https://library.fangraphs.com/war/positional-adjustment/
- FanGraphs: WAR for Pitchers https://library.fangraphs.com/war/calculating-war-pitchers/
- FanGraphs: Replacement Level https://library.fangraphs.com/misc/war/replacement-level/
- FanGraphs: Unifying Replacement Level https://blogs.fangraphs.com/unifying-replacement-level/
- Baseball-Reference: Position Player WAR https://www.baseball-reference.com/about/war_explained_position.shtml
- Tangotiger Wiki: WAR https://tangotiger.net/wiki_archive/WAR.html
- NPB WARによる勝率分析 (PMC12857964) https://pmc.ncbi.nlm.nih.gov/articles/PMC12857964/
- THT: Re-Examining WAR's Defensive Spectrum https://tht.fangraphs.com/re-examining-wars-defensive-spectrum/
- FanGraphs: Converting Runs to Wins https://library.fangraphs.com/misc/war/converting-runs-to-wins/
- TangoTiger Wiki: Runs Per Win https://tangotiger.net/wiki_archive/Runs_Per_Win.html

**走塁 BsR / wSB / UBR / wGDP**
- FanGraphs: wSB / UBR / wGDP（Sabermetrics Library 各項）https://library.fangraphs.com/offense/woba/（BsR系はLibrary offense配下）
- The Book (Tango/Lichtman/Dolphin, 2007) Chapter 上の走塁・損益分岐議論

**守備 UZR / OAA**
- FanGraphs: UZR https://library.fangraphs.com/defense/uzr/
- The FanGraphs UZR Primer https://blogs.fangraphs.com/the-fangraphs-uzr-primer/
- MLB: Outs Above Average https://www.mlb.com/glossary/statcast/outs-above-average
- MLB: Fielding Run Value https://www.mlb.com/glossary/statcast/fielding-run-value
- FanGraphs: An Annual Reminder About Defensive Metrics https://blogs.fangraphs.com/an-annual-reminder-about-defensive-metrics/

**打球 EV/LA / バレル / 飛距離物理**
- Baseball Savant: Statcast Metrics https://baseballsavant.mlb.com/statcast-metrics-context
- THT: The Physics of Barreled Balls https://tht.fangraphs.com/the-physics-of-barreled-balls/
- FanGraphs: Batted Ball Types (GB/LD/FB) https://library.fangraphs.com/offense/batted-ball/
- Nathan et al.: Oblique Collisions (arXiv 1610.03464) https://arxiv.org/pdf/1610.03464
- Alan Nathan: Baseball Aerodynamics https://baseball.physics.illinois.edu/aero.html

**対戦巡目 TTO**
- Lichtman: Everything About the TTO Penalty (BP) https://www.baseballprospectus.com/news/article/22156/
- Lichtman: Pitch Types and the TTO Penalty (BP) https://www.baseballprospectus.com/news/article/22235/
- SABR: Lichtman TTO penalty https://sabr.org/latest/lichtman-the-penalty-for-pitchers-going-through-the-batting-order/
- Bayesian analysis of TTO (JQAS) https://www.degruyterbrill.com/document/doi/10.1515/jqas-2022-0116/html

**得点環境 / BABIP / Pythagenpat / 進塁**
- MLB: BABIP https://www.mlb.com/glossary/advanced-stats/babip
- FanGraphs: Run Expectancy Matrix Reloaded https://blogs.fangraphs.com/the-run-expectancy-matrix-reloaded-for-the-2020s/
- Wikipedia: Pythagorean expectation https://en.wikipedia.org/wiki/Pythagorean_expectation
- WalkSaber: Runs Per Win from Pythagenpat http://walksaber.blogspot.com/2009/01/runs-per-win-from-pythagenpat.html

**加齢曲線**
- FanGraphs: Aging Curve https://library.fangraphs.com/principles/aging-curve/
- FanGraphs: Pitcher Aging Curves https://blogs.fangraphs.com/pitcher-aging-curves-introduction/
- Baseball Prospectus: The Delta Method, Revisited https://www.baseballprospectus.com/news/article/59972/the-delta-method-revisited/
- 1point02: NPBにおける年齢曲線 https://1point02.jp/op/gnav/column/bs/column.aspx?cid=53486

---

## 第2次監査（2026-07-01・多エージェント＋実測敵対的検証）

「勝敗・UZRと同種＝シミュ結果がセイバー的に狂う欠陥」を全8サブシステムで洗い出し、各指摘を独立ハーネス（seed 11/22/33）で反証検証。**実欠陥12件を確認**（打撃指標 wOBA/wRAA/wRC+ は0件＝健全）。

### A群: 指標の値そのものが誤り（**修正済 / ENGINE 0.2.4-audit-a**）
- **A1 DH守備位置ペナルティのデッドコード化**（war.mjs / game.mjs / positions.mjs）: DHは `positionOuts` を持たず `posAdjRuns` が -17.5 を一度も参照せず、posAdj=0 で満額 wRAA+repl を受領。seed11の野手WAR王が無守備DH(10.64)。→ **修正**: DHに攻撃側ハーフのアウト数を `positionOuts.DH` として計上し -17.5/1350 を適用（≈-16run）。WAR王 10.64→8.3、seed22はWAR王がDH→捕手に逆転。`mainPosition` のDH→'C'誤判定（C2）も同時解消。
- **A2 盗塁死(CS)が投手IPに未計上**（game.mjs attemptSteal）: 恒等式 `Σ守備アウト(除DH)/8 − Σ投手アウト = 総CS` が破綻し投手IPが約1.2%過少→ERA/K9/BB9が上振れ。→ **修正**: CS成立時に現投手 `pitching.outs++` と `fielding.cur.outs++`。恒等式回復、ERA 3.97→3.84等。
- **A3 失策がUZRに無反映＋失策打球のOAA二重基準**（fielding.mjs / leagueConstants.mjs）: `uzrRuns` に ErrR 成分が無く hands 能力が守備価値に corr≈-0.05（無影響）。→ **修正**: ポジション中心化した ErrR（`errCenterPerInn` × `runPerError=0.5`）を `uzrRuns` に合成。OAAは範囲成分（失策前判定）のまま維持し二重計上回避。corr(hands,UZR) → +0.17。
- **再較正**: A1がDHから正しく約10WARを除いた分、代替水準 `replBatterPer600` を 16→18 に再較正（総WAR 174→186∈[175,205]、野手比 0.51→0.54∈[0.53,0.57]）。打撃・投球指標は不変で全PASS。

### B群: 挙動が非現実的（**修正済 / ENGINE 0.2.4-audit-a**）
- **B1 二塁打過剰(357-381/目標210-250)＋三塁打過少(4/目標15-30)**（battedBallResult.mjs decideBases）: 空中84m超を一律二塁打化、三塁打は\|spray\|>35ライン際限定＋脚力非依存。→ **修正**: `decideBases` を距離ベースに再設計（`gapDistM=90`未満は単打、`tripleDistM=94`以上×\|spray\|>18は打者speed依存で三塁打化）、FBヒット加点閾値を `fbHitBonusM=84` に分離しBABIP環境を保持、`runnerSpeed` を打球へ伝播。→ 2B/球団 211-229∈[210-250]、3B ~18∈[15-30]。決定論ユニットテスト追加（`decideBases` を検証用にexport）。
- **B2 抑え役不在でセーブ分散（SV王8-10/実30-40）**（game.mjs pickReliever）: 投球回最少で選ぶ負荷分散のため締め投手が固定されず。→ **修正**: `closerId=bullpen[0]` を固定し、9回以降のリード1-3点で `maybeBringLeverageReliever` が抑えを、8回で setup を優先起用。→ SV王 39-44（目安30-40上限やや超だが健全な集中）。
- **B3 ホールド/ブローンセーブが常に0（dead stat）**（game.mjs assignDecisions）: hld/bs が一度も加算されない。→ **修正**: 救援の登板時/退場時リード差（`enterDiff`/`exitDiff`/`enterInning`）を記録し、7回以降リード1-3で登板→リード保持降板にHLD、リード吐き出しにBSを付与。→ HLD王 33-40∈[30-45]、BS 51-66（リーグ計）。
- **B4 完投・完封が構造的に不可能**（game.mjs maybeChangePitcher）: 先発 `outs>=21` 強制降板でIP上限189。→ **修正**: 一律降板を撤廃し `pitches>=82+stamina*0.6 || runs>=6 || (outs>=18 && runs>=4)` の球数/失点連動に緩和。完投時 `cg++`（無失点なら `sho++`）。→ 完投 19-27/完封 5-12（リーグ計）、最大IP ~200。
- **B5 捕手守備がフラット（framing能力が完全死蔵）**（fielding.mjs / game.mjs）: `framingRuns` は宣言のみ。→ **修正**: 守備クレジット時に `framingRuns += (framing-50)*framePerInning*(outs/3)` を捕手へ計上し、`uzrRuns` に合成。→ 捕手UZRが±15で分離、能力→守備runの結線が成立。
- **B6 assignFielderがCF/2Bに打球過集中**（battedBallResult.mjs）: CFが全打球の27.6%でUZR振れ±34と過大。→ **修正**: 外野バンドを±15→±10に狭め（`s<=-10→LF / s<10→CF / else RF`）。→ CFのUZR振れが縮小、機会の過集中緩和。

### C群: 微修正・潜在（**修正済**）
- **C1 wSB中心化欠落**（metrics.mjs / leagueConstants.mjs）: `lgwSB×(1B+BB+HBP-IBB)` の基準控除が無くBsRが正へ微偏り。→ **修正**: `deriveLeagueConstants` に `lgSB/lgCS/lgSBOpp` を追加し、`playerBaserunning` で `wSB = SB×runSB+CS×runCS − lgwSBrate×機会` と中心化。リーグwSB総和≈0。※C2（mainPositionのDH→C誤判定）はA1で解消済。
- **B/C群 再較正**: B1で二塁打を正しく削った結果SLG/ERA/得点が古い（膨張二塁打前提の）目標を下回ったため、走者生還率（`singleScore2 0.42→0.56` / `doubleScore1 0.36→0.50`）と `gapDistM`/`hitFB` で得点環境を再収束。→ AVG.261 OBP.326 SLG.391 HR118 ERA3.69 得点4.01 が全て目標域内。全102テストPASS・決定論一致・ビルド/スモークOK。
- **C3 posAdjの分母/1350固定**: FanGraphs慣例上むしろ妥当・影響≤0.09WAR＝ほぼ無視可。

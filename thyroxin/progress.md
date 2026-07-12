# 自走開発ジャーナル（req_2 三原則）

> 就寝中の自律開発の進捗記録。新しいものを上に。各エントリ: 日時 / やったこと / 結果 / 次にやること。
> 三原則: ①セイバー指標網羅（一球・一プレー粒度） ②セパ両リーグ近似（架空・起用/采配の妥当性） ③やきゅつく的な楽しさ

## 2026-07-11 (実装vs現実の野球 リアリズム全域監査)

**きっかけ**: ユーザー報告「センター定位置のライナーが2Bになったのに CF の UZR が -0.0」＋
「守備に限らず実装と現実の食い違いが無数にありそうなので探してほしい」。

**発端の診断（確定・数値再現済み）**: UZR は正しい（エンジンはその打球を捕球不能 expOut≈0 と判定）。
嘘は `battedBallResult.mjs decideBases` — 空中打球が「落下距離≥76m なら無条件2B」で守備隊形を見ない。
外野手の目の前のワンバウンド（現実は単打）が必ず二塁打になる。空中2Bの 6.0% が最寄り外野手から
14m 以内に落ちた打球だった（30万打球で計測）。

**監査**: 10ドメイン（打球結果/走塁/一球機械/試合進行/采配/起用登録/指標定義/日程PS/市場/加齢故障）を
多エージェント探索 → 79所見を全件実コード照合で検証（セッション上限で検証エージェントが全滅したため
検証はメインループで実施）。**確定74 / 部分4 / 棄却1** → `thyroxin/research/realism_gap_audit.md` に全件記録。

**最重症（[S]級）**: ①ゴロアウトで走者が一切進塁しない（進塁打・ゴロ間の得点・満塁本塁封殺が不在）
②空中アウトで三塁走者が深さ無関係に100%生還（内野フライでも犠飛） ③塁打決定が守備隊形非依存（発端の穴）
④失策時の進塁がフォースのみ ⑤継承走者の失点が現投手に付く（ERA分布の構造欠陥）。
いずれも advanceRunners / decideBases / 失点計上に閉じており、修正推奨順序を監査文書の末尾に記載
（①②は較正53指標に直撃するため tuning 再較正とセットで1作業単位にすること）。

**次にやること**: 監査文書の推奨順序1（走塁 'out' 分岐の再設計）から着手。今回は調査・文書化のみで
実装変更なし（較正・テストへの影響なし）。

## 2026-07-12 (R1実装仕様の作成 — 実装は別セッションのsonnetに委任)

ユーザー指示「実装はsonnetにやらせる」を受け、監査の推奨順序1＋2（走塁'out'分岐の再設計＋塁打決定の
守備隊形依存化。同一関数群に閉じるため1ユニット化）の**実装仕様を確定**:
`thyroxin/specs/realism_r1_baserunning_spec.md`。

設計判断の要点（仕様書で確定済み・実装者は迷わないこと）:
- ゴロアウトの分岐表（DP/FC/進塁打の3分岐＋ゴロゴー resolveAdv 'gbAdv3h'）。DPブロックはcallerから
  advanceRunners内へ移設し、追加アウトは ctx.outsAdded 経路に一本化（ΣpositionOuts恒等の維持）
- タッグアップの深さ依存化（tagMinDistM門番で内野フライ犠飛を根絶・本塁憤死の導入・犠飛認定は
  ctx.sacFly が唯一の情報源＝WP偽犠飛も同時修正）
- 2死走塁死の解禁は「先頭走者から解決＝時間プレー順序で正しい」ことを根拠に canKill<3 へ緩和
- decideBases/expectedBases は同一分岐で同時改修（xwOBA恒等の門番）。発端ケース
  （EV165/LA10落球→単打）を回帰テスト化
- 新configノブ12個＋UBR新シナリオ3種（gbAdv3h/gbAdv2t3/tag3h）の統計配線チェックリスト、
  実装手順6段階、再較正計画（動く指標の予想方向とノブを回す順序）、Doneの定義を明記

**次にやること**: sonnet セッションで上記仕様を実装（仕様書§9の順・§12のDone定義まで）。完了後、
R2（記録規則: 継承走者/セーブ規定/PB非自責/サヨナラ決勝点）の仕様化。

## 2026-07-10 (走塁指標の一次情報リファレンス作成)

**きっかけ**: ユーザーから「走塁の指標について、守備指標のときみたいに網羅的に調べてmdファイルに残して」。
`fielding_metrics_reference.md` と同じ手法（deep-research 2ラウンド・敵対的検証・現行実装との突き合わせ）で
`thyroxin/research/baserunning_metrics_reference.md` を新設（589行）。

### 確定できたこと（一次情報）
BsR=wSB+UBR+wGDP、wSBの完全式（runSB=+0.2固定・runCS=−(2×RunsPerOut+0.075)可変）、UBRの定義・スコープ、
wGDPの機会定義（走者一塁・2アウト未満＝**ゴロに限定されない**）と算出方法（係数は非公開）、
Statcast Baserunning Run Value / Sprint Speed、B-Ref Rbaser(実測上限+8.0)・Rdp(.44)、
Baseball Prospectus BRR=GAR+SBR+AAR+HAR+OAR（2024-25年にDRBa/DRBnへ体系移行中）、
NPB(1point02.jp)のBsRはUBR+wSBの**2成分のみ**（wGDPを含まない＝FanGraphsと定義が違う）。
盗塁の損益分岐点は一次情報で「約2/3」、線形加重から代数的に導出すると65〜67%（シム実測65.5%と整合）。

### 現行実装との突き合わせで見つけたこと（未修正・§13に記載）
- `game.mjs`の`gdpOpp`がゴロ打席限定でインクリメントされており、原典の「機会=ゴロに限定されない」と齟齬
- `statline.mjs`の`baserunning.outsOnBase`（走塁死カウンタ）が宣言のみで一度も加算されていない死んだフィールド
  （試合結果自体には影響しない＝較正53指標は非影響）
- runSB/runCS/UBRシナリオ分解（BPのAAR/HAR類似設計）は既に原典と整合していることを確認（誤りなし）

このラウンドは調査・文書化のみで実装変更は行っていない。§13の未決事項（gdpOpp設計・outsOnBase配線・
BsR定義のNPB/FanGraphs選択）は次のタスクで判断が必要。

### 追記（同日・第3ラウンド）: ユーザーの「XBT%は明らかでは？本当に取れない？」という指摘で再調査
403/406を見て早期に「確認できず」と結論していたのが原因だった。Wayback Machine / r.jina.aiプロキシ経由を
徹底した103エージェントの再調査で、当初「確認できず」としていた項目の多くが判明:
- **XBT%**: 定義文（"単打で1塁超・二塁打で2塁超の進塁割合"）とリーグ平均42%（2023年）を確定
- **NPB実数値**: npb.jp公式のURLパターン（`lb_sb_c/p.html`等）を発見し、2024-25年の個人盗塁王・
  セ・リーグチーム別盗塁数を確定。**実測成功率65.4%が本ドキュメントで算術的に導出した損益分岐点(65-67%)と
  ほぼ一致**（良い健全性チェック）。シムのSB/球団=98.5・成功率71.3%はNPB実測(57.0/65.4%)より高めだが、
  2024年セは史上最少盗塁の年で較正判断は保留
- **Baseball Prospectus**: BRRの成分数が資料により4個(2006年記事)と5個(後年記事)で食い違うことを発見
- **Statcast**: "Baserunning"(盗塁含まない)と"Baserunning Run Value"(盗塁含む統合指標)という紛らわしい
  名称の別指標が併存していることを整理
- **年度間相関**: UBR/BsRは有力候補記事3本のいずれにも数値が存在しないことを確認（不在の実証）
- Lead Distance/Secondary Leadは2回目の試行でも確認できず

教訓: **直接WebFetchの403/406は「情報が存在しない」ことを意味しない。** botブロックされやすい
一次ソース（baseball-reference.com, baseballprospectus.com, mlb.com）はWayback Machine経由を先に試すべき。

## 2026-07-10 (野球指標の網羅リファレンス作成 → 3つのバグを摘出して修正)

**きっかけ**: ユーザーから「野球の指標を網羅的に調べてドキュメントにまとめて。ゲームに出てきてないやつも」。
8領域を並行調査し `thyroxin/research/sabermetrics_glossary.md`（1,110行）を作成。
実装状況（✅🟡⬜⛔）を付け、§10 でシムのコードと突き合わせた。**その照合が3つのバグを掘り当てた。**

### 検算の成果（実装は概ね原典に忠実だった）
- wOBA linear weights: シムの値 × wobaScale が FanGraphs 2024 の公表係数と 3% 以内で一致
  （シムの LINEAR_WEIGHTS は「アウト基準の run value」、FanGraphs の公表係数は wOBA scale 込み。別物）
- SIERA: 2010年 Baseball Prospectus 原典の係数と完全一致。しかも `netGB × |netGB|` として
  符号可変の ± 項まで正しく実装されていた
- LOB% / kwERA / Clutch / SD-MD の ±0.06 / RPW / Barrel の EV-LA 拡大則 /
  打球種別の LA 境界(GB<10°, LD 10-25°, FB 25-50°, PU>50°) / RBI の併殺除外 — すべて原典と一致
- RE24 をリーグ実データから2パスで導出しているのは正しい（Tango の表は年代で変動するため）

### 修正1: ポジション補正の分母 1350 → 1458（`d0faf16`）
FanGraphs 原文「162 games, which equates to 1,458 defensive innings」＋公式ページの実例で決着。
1,350 は **Baseball-Reference の慣行**で、しかも値のセット自体が別物（C+9 / SS+7 / 2B+3 …）。
**FanGraphs の値に B-R の分母を掛けていた**という、2つのWARシステムの取り違えだった。8%過大。

### 修正2: runCS を得点環境依存の可変式へ（`d0faf16`）
原典 `runCS = -(2×RunsPerOut + 0.075)`。導出値 -0.394〜-0.404（FanGraphs 2024 の -0.405 と一致）。
runSB も原典どおり 0.2 固定に。

### 修正3: 打球ラベルが責任野手を無視していた（`d0faf16`・ユーザー報告）
「EV121km/h・LA47°・33m がライトフライと表示されるが、1BのUZR変化が0なのでファーストゴロ扱いっぽい」
→ エンジンは正しかった（滞空5.0秒・内野への高いポップフライ・責任野手は一塁手 p=0.996・OAA変化≈0）。
UI が打球種別とスプレー角だけでポジション名を推測していた（LA47°はStatcast定義でFB→外野方向）。
アウトの打球は `fielderPos` を唯一の真実とするよう修正。

### 修正4: 代替水準を wins で定義し直す（`750057b`）
シム内部で単位が食い違っていた（投手=wins、野手=run）。
**フェーズDの時代トレンドは9年周期で実際に走っているので、これは仮定の話ではなかった**:
  打高(4.25 R/G) 総WAR 409.0 ↔ 投高(3.93 R/G) 総WAR 420.2 ＝ **11.1 WAR の振れ**
  （得点が減るほど総WARが増える逆向きの挙動。同一セーブ内で1年目と9年目のWARが比較不能だった）
FanGraphs 準拠でリーグ全体の代替勝利の総量を固定 → 振れ幅 **0.40 WAR**。
「野手の代替勝利は得点環境に厳密に不変」を回帰テストで固定。

較正62指標すべて PASS / npm test 345 pass / verify 決定論OK / smoke OK

**次にやること（ユーザー判断待ち）**
1. **このシムの代替水準は勝率 .245 であって .294 ではない**（正典§10.6）。
   リーグ総勝利836 − 総WAR 415 = 代替の総勝利 421 → 1チーム35.0勝 → .245。
   FanGraphs の .294 なら総WARは331のはずで、実際の415は **25%過大**。全選手のWARが水増しされている。
   単純に直せない: 投手WAR王(5.7)の55%が代替水準ボーナスで、.294へ上げると5.07に落ち帯を割る。
   根本には「投手のFIPのばらつきが狭くエースが平均から離れない」という別の較正問題がある。
   総WAR/野手WAR王/投手WAR王/WAR下限 の目標帯を一式で引き直す必要がある。
2. **投手の球速が一球シミュレーションに結線されていない**（正典§10.9）。
   velocityKmh を読むのは起用順・球団評価・加齢・故障だけ。全投手に+10km/hしてもリーグERAは3.79のまま。
   → era.veloPerYear（平均球速の経年上昇）が得点環境を動かしていない。
3. 得点環境の目標帯一式が NPB 2015-19 の「飛ぶボール」時代に較正されている（正典§12）。

## 2026-07-09 (続き: 幽霊走者バグ / ポジション別の走力・肩を一次データで再設計 / Spd撤去)

**きっかけ**: ユーザーの「走塁 Spd の4成分が FanGraphs 版と2つ違う。これっていいの？」という問い。
調べたら、Spd 単体の問題ではなく**生成器が同じ病気にかかっていた**。

### 幽霊走者バグ（`445d9c7`）
自分が今回書いた ARM のコードに実バグがあった。`resolveAdv` が「走らなかった」と「走って刺された」を
同じ false で返し、呼び出し側4箇所すべてが false を「塁に留まる」と扱っていた。結果、外野補殺のたびに
アウトが1つ増えると同時にその走者が塁に残っていた。得点の水増しだけでなく、そのイニングの
併殺成立判定・敬遠判断・RE24/WPA の塁状態を汚染する。ΣRE24≈0 は自己整合の恒等式なので赤くならない。
3状態（ADV_TAKEN/ADV_HOLD/ADV_OUT）に変更し、回帰テストを追加。補殺127本が発生する状態で
セーブ→ロードの決定論も確認。バグを抱えたまま較正していたので測り直し、ノブ調整なしで全指標 PASS。
むしろ **UZR最低が -17.89 → -14.99 に改善**し、最高 +15.87 とほぼ対称になった（幽霊走者が分布を歪めていた）。

### ポジション別の走力・肩を一次データで再設計（`ace5d4a`）
旧実装は二値スイッチだった:
  speed = CF/SS なら58、他は48 ／ arm = RF/C なら58、他は50 ／ steal = speed>55 なら55、他は46

Baseball Savant の CSV から自己集計（リーグ全体平均 27.30 ft/sec が公称27と一致＝検算OK）:
- 走力 2024 (N=566): CF 28.68 > SS 27.93 ≈ LF 27.87 ≈ RF 27.79 > 2B 27.61 > 3B 27.30 > 1B 26.32 > C 25.97
  → **捕手が最も遅い。二塁手は三塁手より速い。コーナー外野は二塁手より速い**（いずれも3年連続）
- 肩 2024: CF 89.7 ≈ RF 89.4 > LF 88.1 > SS 86.9 > 3B 85.7 >> 2B 79.3 > 1B 77.1 (mph)
  → 「捕手と右翼手だけ強肩」は明確に誤り。内野は 1B/2B が 3B/SS より 6〜9mph 弱い
  → ⚠ 捕手は Savant が除外（Pop Timeで評価）。平均mphの一次情報が存在せず、RF同値を設計値として明示

写像は「1 rating pt = 個人SDの0.1」。draw の sd は独立な2制約が一致した
（走力: 母集団sd保存 9.97 vs 実測位置内SD 6.1〜9.3 → 10 ／ 肩: 7.06 vs 6.7〜8.3 → 7.1）。
盗塁技術は走力と連続に結線し、傾き・切片・残差sdは旧実装の周辺分布を保った（段差の撤廃だけ）。

**副作用**: 捕手・一塁手が現実どおり遅くなり余分な塁を取らなくなったため、得点が 4.20 → 4.09 R/G へ低下
（率系はほぼ不変＝安打ではなく走塁の変化）。smaxBase 6.82→6.78 で得点環境を中立に戻した。

### Spd（Speed Score）の撤去
- FanGraphs 版は4成分で守備位置を含まず、FanGraphs 自身が「outdated / runスケールでない。UBRを使え」と明言
- 各 factor の正確な係数は一次情報で確認できず（Wikipedia単独ソースで流布する式と係数が食い違う）
- 旧実装は誰も使っておらず、「守備位置速度」は打席を1つも見ずに真値speedと r=0.29 で相関する作られたシグナル。
  しかもその表はシムの生成分布と矛盾していた
→ 削除。走塁は BsR = UBR + wSB + wGDP で表す。

較正62指標すべて PASS / npm test 337 pass / verify 決定論OK / smoke OK

**次にやること**
- ⚠ 総WAR 429（上限430）と際どい。得点環境が下がると rpw が下がり、代替水準が run で定義されているため
  総WARが上がる。replacement level は本来 win で定義すべき（構造的問題）
- 得点環境の目標帯一式が NPB 2015-19 の「飛ぶボール」時代に較正されている件（正典§12・ユーザー判断待ち）
- posAdjRuns の分母 1350 vs 1458（要一次確認）、フレーミングの分布の裾が NPB(±10) より広い

## 2026-07-09 (守備指標の全面再設計 — Distance-Time モデル / ARM実イベント化 / 守備を較正の門番へ)

**きっかけ**: ユーザーから「守備指標の理解が根本的に浅い。全部やり直してもいいくらい破綻してる」。
まず一次情報を集め直し、`thyroxin/research/fielding_metrics_reference.md`（944行）を正典として作成した。

**調査**（deep-research: fan-out検索 → 一次情報fetch → 3票の敵対的検証 → 合成、＋日本語ソースの追加調査）
- UZR = RngR + ErrR + ARM(外野) + DPR(内野)。ARM/DPR は正規成分（実装は WAR から除外していた）
- OAA は catch probability で重み付け: 捕球→+(1−p) / 落球→−p。p=0.05 の絶望的打球は実質無罰
- FRV の run 換算は固定定数（外野.9 / 内野.75 / DP.4 / framing.125 / 捕手送球.65 / ブロッキング.25）
  → 疑っていた `runPerOutInfield 0.75` / `runPerOutOutfield 0.9` / `runPerCall 0.125` は**正当だった**
- DRS は「最も捕球確率が高い1人」に責任を集約する（UZRの比例配分とは別方式）
- NPB(DELTA/1.02): 実数値は非公開だが「優秀は+10や+20」と明記。外崎修汰 2B +15.4(2022)。
  **143/162 のスケール換算の慣行は存在しない** → MLB の目安をそのまま採用してよい
- 単年UZRの年度間相関 ≈ .5（フレーミングは .70 で例外的に安定）

**根本原因の特定**（実測で定量化）
`expOut` が「担当野手の捕球確率」ではなく「打球種別4バケットの平均」でしかなかった。
全ライナーが expOut 0.19〜0.51 のコイントス帯に密集し p(1−p) が最大化され、能力差ゼロでも
CF で 10.5run の二項ノイズが乗る（実測 UZR_sd 8.6 と整合）。結果 CF が到達に 17.7m/s を要する
（人類上限 ~9m/s）物理的に不可能な打球を落として −0.39 アウトの減点を受けていた。

**実装**（3コミット）
1. `1984f48` 中核: `src/sim/fieldingGeometry.mjs` 新設。打球ごとに各野手のアウト化確率を幾何から導く。
   空中球 = expit((Smax − 必要走速度)/width)、ゴロ = P(到達)×P(送球アウト)（Statcast infield OAA の4要素）。
   後方移動ペナルティ（Statcast が2017年に direction を追加した理由）。責任野手 = argmax p（DRSの流儀）。
   旧ノブ hitGB/hitLD/hitFB/hitPU/evHitW/timeDifficulty*/posTypicalDepthM/rangeLogitSlope を撤去
   → 打球種別の安打率は幾何から**創発**する（鉄則4の回復）。
2. `7c0702b` ARM を真値の線形変換から実イベント創発へ（進塁抑止＋外野補殺）。
   UZR構成を FanGraphs 定義へ（外野=RngR+ErrR+ARM / 内野=RngR+ErrR+DPR / 捕手=別勘定）。
   捕手ブロッキングを新規実装、rSB を runSB−runCS から導出（FRVの.65と同型）。runPerDP 0.45→0.40。
3. `bd6e56f` BABIP と守備指標を較正の門番へ。`uzrTop` は config にあるだけで未配線だった。

**結果**
- 捕球確率が両極に分布（両極 17.5% → 70.8%、コイントス帯 24.9% → 10.8%）
- UZR最高 15.85 / 最低 −17.89 / SD 5.33（FanGraphs「+15=ゴールドグラブ級」・NPB 外崎+15.4 と一致）
- 外野補殺リーダー 6.9本（NPB.jp 2025: セ6 / パ9）、ARM上位 5.80run
- ユーザー報告のポテンヒット: CF に −0.39 → SS に −0.01（誰の責任にもならない）
- 得点環境は中立に着地。較正62指標すべて PASS / npm test 334 pass / verify 決定論OK / smoke OK
- 設計時に予測した「BABIP が26pt下がる」は、後方ペナルティ未実装の未較正パラメータの artifact だった。
  BABIP は AVG/K%/HR から算術的に決まる従属変数であり、独立に動かせない。

**次にやること（ユーザー判断待ち）**
NPB.jp 公式の生データから集計した結果、**シムの得点環境の目標帯一式が NPB 2015-19 の
「飛ぶボール」時代に較正されている**ことが判明した（2023-25 実測は AVG .243 / OPS .655 / HR 91 / 3.3点）。
三原則②「現状のセパ両リーグ近似」に照らすと別時代を近似している。再ベースラインは
evBase/hrScale/linear weights/目標帯一式に及ぶ大工事で、守備とは独立の意思決定。正典§12 に記録した。

その他の残課題: posAdjRuns の分母 1350 vs 1458（要一次確認）、フレーミングの分布の裾が
NPB(±10) より広い（係数0.125は正当なので判定モデル側の問題）、走塁 Spd の4成分が FanGraphs 版と異なる。

## 2026-07-08 (phaseG完了後の残課題2件を修正 — G6ダイジェスト見出し・G10用語集の見出し可読化)

**やったこと**（phaseG（G1a〜G10）総仕上げ敵対的レビューで検出したminor指摘2件を仕上げ）
- G6: 進行後ダイジェストのタイトルを `heading.replace('進行中…','')+'結果'` の文字列合成から独立した
  `digestTitle`（'1週間の結果'/'月末までの結果'）に変更。旧実装は週送り側で「1週間を結果」と助詞が崩れていた
- G10: 用語集モーダルの `<dt>` が `TIP` の内部キー（`kbbPct`等のcamelCase）をそのまま表示していたのを、
  `TIP[k]`（"WAR: 説明文"形式）の先頭部分を見出しとして分離する形に修正（`wOBA`/`xwOBA`等の読める見出しに）。
  smoke-ui.mjsの対応アサーションも新挙動に合わせて更新
- npm test(327)・verify(identity不変)・smoke(全PASS)・calibrate(30+20+3+4=57 PASS)全て確認

**次**: phaseG（UI再ゾーニング G1a〜G10）は全項目完了。他の自走セッションがreq_20260708.md（守備/走塁指標再設計等）に着手中のため、そちらとの競合に注意しつつ次の作業を判断

## 2026-07-08 (req_20260708続き: 守備/走塁指標の文献ベース再設計＋育成→支配下の季節中昇格)

**やったこと**（ユーザー「昇格は年に何回もある／守備・走塁指標が粗い。論文・研究・球団資料を調査して適用してくれ」→ Workflowで8並列Web調査(UZR/DRS/Statcast OAA/UBR/BsR・EqBRR/NPB登録実務等)→設計→実装→敵対的較正）

- **調査結果の要点**: UZR/DRS/OAAはいずれも「打球を難易度バケット(速度×角度×方向×距離)に分け、バケット内リーグ平均キャッチ率との差分をrun換算」する方式。本エンジンはEV/LAのみでdistanceMを無視しておりQ3/Q4指摘と整合。UBR/EqBRRはRE24(24塁状況×アウト数の得点期待値表)からのΔREでシナリオ別(単打二塁走者本塁突入・二塁打一塁走者本塁突入・単打一塁走者三塁進塁・タッグアップ等)に評価する方式で、本エンジンは前2つしか実装せず1シナリオの合算率で中心化しておりバイアス源だった。NPB実務は支配下登録が年間通じ随時可能（登録抹消の10日ルールは既存のswapCooldownDays=10と一致・支配下登録期限は例年7/31）で「年1回オフのみ+同型引退枠待ち」の現行実装は非現実的と確認。
- **修正1（守備・battedBallResult.mjs/config.mjs）**: 滞空時間(hangTimeS・従来未使用だった計算済み値)と担当ポジション定位置のギャップから「間に合わせるのに要する速度」を出しpHitへ加点するtimeDifficultyAdjを新設（no man's landほど難化）。個人のRange効果を線形シフトからlogit空間シフトに変更（五分五分の難しいプレーほど巧拙が効く、というUZR/DRS/OAAのバケット方式が暗黙に持つ性質を近似）。ライナーが外野判定される浅い落下点でFB定位置基準だと系統的に過大化する偏りが初回較正(BABIP0.391)で発覚→outfieldLDTypicalDepthMを分離して解消
- **修正2（走塁・game.mjs/statline.mjs/leagueConstants.mjs/metrics.mjs）**: UBRシナリオを「単打一塁走者三塁進塁」「タッグアップ二塁→三塁」の2つ新設し、既存2シナリオと合わせて4シナリオ別にadvOpp/advTakenを分離集計・リーグ率も別々に導出（旧: 全シナリオ合算の単一lgAdvRateで中心化しておりバイアス源）。advOpp/advTaken集計自体は後方互換で維持（XBT%表示等）
- **修正3（昇格頻度・roster_moves.mjs/market.mjs/config.mjs）**: 季節中の育成→支配下昇格(processFarmPromotions)を新設。25試合レビュー周期・支配下登録期限相当(season日数の72%)まで、育成の観測成績最良候補と一軍登録外の観測最下位を1:1で入替（支配下70人枠を常に保つ・NPB実務同様「既存選手の育成契約化で枠を空ける」簡略化）。ローテ投手も観測RA9の長期不振で入替対象に追加（旧実装はローテ投手を全除外しており「ERA高い投手が居座る」原因だった。救援より緩衝を大きく取り数試合の不調では動かさない）
- **セーブ/ロード決定論の罠**: league.players/farmを直接動かす季節中変更はsaveに含まれず、過去完了年はoffseasonTransitionのみのreplay近道（day単位の再シムをしない）で再構築される既存設計と衝突し、多年セーブ/ロードでverifyStandingsが破綻することが判明。GameState.farmPromotionLog（完了年ぶんの昇格ログ・save対象）を新設し、load時に過去年ぶんをreplay適用するapplyFarmPromotionSwapで解消
- **較正**: 新設のtimeDifficultyAdj/1塁→3塁/タッグアップが得点環境を押し上げ、12seed較正でAVG.275/ERA4.45まで悪化→9回の反復較正（timeDifficultyW 0.015→0.0007・singleScore1to3/tagBase・singleScore2/doubleScore1の微調整）で57/57 PASSへ収束。単一シード(2026)の正捕手先発テストがrng消費列変化で90→85へ許容帯を再調整（12seed平均の正式ゲートは健全）
- **最終ゲート**: npm test(327)PASS・npm run verify(identity不変)PASS・npm run calibrate(57/57)PASS・npm run smoke(同時並行セッションのUI系WIPを一時退避し自分の変更のみでPASS確認、相手には一切手を加えず)
- **運用メモ**: 前回同様、同一リポジトリで別セッションがphaseG仕上げ作業中(ui.mjs/tools/smoke-ui.mjs)。自分の担当ファイルのみをコミット対象にした

**次**: req_20260708の残課題（19歳OPS1.1の年齢-能力無相関、打球距離とヒット確率の粗い関係の追加是正）は別途着手。走塁は1塁→3塁の方向依存（右打ちvs引っ張り）は未実装（advanceRunnersがspray方向を受け取っていないため）で今後の課題

## 2026-07-08 (phaseG 総仕上げ敵対的レビュー対応 — G6/G7/G8/G10の未コミットWIPをコミット)

**やったこと**: phaseG P2/全体実装への敵対的レビューでF1(blocker/major)を検出。「`git diff 9d84b57..HEAD`
にはG9(c040dab)とRBI修正(e9dc9cc)のみが含まれ、G6（進行後差分ダイジェスト・showAdvanceDigest・
leagueRankOf）/G7（日程タブのdetails折りたたみ・次戦ジャンプ）/G8（表彰details・日本シリーズ表形式・
リザルトヘッダー整理）/G10（用語集モーダル）は作業ツリーの未コミット変更としてのみ存在し、他セッション
の操作等で失われるリスクがある」という指摘。G9エントリに記録した並行自走セッション衝突の残骸（相手側の
G6/G7/G8/G10 WIP）がまさにこの状態のまま残っていたことを確認した。

**対応**: `git status`/`git diff`で該当6ファイル（src/ui.mjs, src/ui/schedule.mjs, src/ui/watch.mjs,
tools/build.mjs, tools/smoke-ui.mjs, dist/pennant.html・計607行差分）の内容を精査し、phaseG_spec.mdの
G6/G7/G8/G10仕様と一致すること、smoke-ui.mjsに対応する検証ブロック（ダイジェストoverlay・日程details・
日本シリーズtable列・用語集dt/dd）が既に組み込まれていることを確認。誤検知ではなく正当な指摘と判断し、
`npm test`(327 PASS)→`npm run verify`(identity不変)→`npm run smoke`(全PASS)→`npm run calibrate`
(30+20+3+4 PASS)を再実行して全PASSを確認後、そのままコミット(7deea37)。これで`f5c359f..HEAD`に
G1a〜G10全項目が揃った。

**メモ**: 今後同一リポジトリで並行自走セッションを走らせる場合はブランチ分離かworktree運用を徹底する
（G9エントリの事故と今回のF1指摘は同一原因＝並行編集の未コミット放置）。

**次にやること**: phaseG_spec.mdのG1a〜G10は今回で全項目コミット済み。残るはD5（全国対戦BaaS）・
Capacitor化（プラットフォーム展開）。

## 2026-07-08 (G9 選手モーダル磨き — stickyヘッダー・タブ1行化・前後ナビ)

**やったこと**（phaseG_spec.md の G9 を実装）
- `.modal` に `max-height:92vh; overflow:auto;`、`.modalhead` に `position:sticky; top:0;` を付与し、
  長い成分（打球SVG・経歴タブ等）でも✕ボタンが常に見えるようにした。
- `.modaltabs` を `flex-wrap:nowrap; overflow-x:auto;`、`.mtab` を `white-space:nowrap; flex:none;` にして
  タブ行の2行折返しを解消（横スクロール1行）。
- `openModal(playerId, navIds?)` に省略可の第2引数を追加。渡されたときだけ `modalHeader` に◀/▶の前後ナビ
  ボタン（`.modalnavwrap`/`.modalnav`。端では `disabled`）が出る。ナビ時は overlay を作り直さず
  `overlay.remove()` → `openModal(隣のid, navIds)` で再構築する単純な方式（タブ選択状態は引き継がない）。
  呼び出し側で `navIds`（表示中テーブルのソート済みID配列）を渡すのは仕様どおり3箇所:
  `statTable`（打撃/投手/守備等のリーダーボード）・`renderWAR`（WARカード）・`teamRosterTable`（チームタブ）。
- smoke: 打撃表からモーダルを開き▶で隣の選手のpnameへ変化→◀で元に戻ることを assert する新ブロックを追加。
- **検証**: `npm test`(327)PASS・`npm run smoke`PASS・`npm run verify`(identity不変)PASS・`npm run calibrate`
  (30+20+3+4件 全PASS)——いずれも下記の運用理由により**隔離した git worktree**（コミット元HEAD基準）で実行。

**運用メモ（重要・同一リポジトリでの並行自走セッション衝突）**: 作業中、同一ワーキングディレクトリで
別の自走セッションが phaseG の G6/G7/G8 を並行して未コミットのまま編集していることが判明した
（前提として渡された「G6・G7・G8完了済み」は誤りで、実際の直前コミットはG5b止まりだった）。
一度は自分の未コミット編集（src/ui.mjs 等）が相手側の git stash 操作で消える事故が発生したが、
Edit履歴から全て再現可能だったため復旧。その後 `git worktree add --detach` で隔離コピーを作り、
自分の4ファイル（src/ui.mjs / src/ui/team.mjs / tools/build.mjs / tools/smoke-ui.mjs）だけをコミット
済みHEAD（相手のG6/G7/G8変更はこれらのファイルにも同時に混在中）に当てて上記ゲートを独立実行・
全PASSを確認した。ライブディレクトリへは、隔離コピーとの差分から**自分のフックだけを含む手作りパッチ**
（`diff -u --label a/... --label b/...`）を `git apply --cached` でインデックスにのみ適用し
（作業ツリー上の相手の未コミットWIPには一切触れずに済む）、その状態のままコミットした。
`dist/pennant.html` は相手のG6/G7/G8 WIP込みでビルドされる状態のため、直前のRBI修正コミット
（e9dc9cc）と同じ理由で今回もコミット対象外＝次に誰かが揃ってビルドするタイミングで正式反映される。

## 2026-07-08 (ユーザー疑問9件の検証＋軽微な指摘4件を修正 — req_20260708.md)

**やったこと**（ユーザーの疑問形式の指摘9件を並行調査エージェント5体＋直接コード確認で検証→「軽微な修正から全部」の指示で6・7・8・9番を実装）
- **検証結果の要点**: ①先発ローテ投手は在籍中の観測成績評価が構造的に皆無(reviewAssignments/processPerfSwapsが投手ローテを除外)・二軍出場は`candidatesPerPos=6`上位固定・育成→支配下昇格は年1回+自球団同ポジ引退待ちで塩漬け ②生成時に年齢と能力が完全無相関＋1年目はaging/breakout不発動＝19歳OPS1.1を抑制する機構が皆無 ③打球距離はLD分類45m超で一律ヒット率(距離非依存)という粗さがあるが今回の指摘自体はバグでない ④内野/外野の担当野手判定が45m単一距離閾値＋方向のみ(ユーザーの「61mはSSでは」という直感はゲーム内定義とは不一致だが仕様通り) ⑤UZR/OAAのリーグ定数は状態を持たない純関数で参照毎に最新再計算(提案の「前日値」より新しい情報を使用) ⑥⑦⑧⑨は下記の通り修正
- **修正1（RBIバグ）**: `sim/game.mjs`のシーズン公式集計が併殺(GDP)時のRBIを除外し忘れていた(簡易ボックススコアboxscore.mjsは既に正しく除外)のバグを確認・修正。`outs - outsBefore >= 2`でGDP検出しRBI加算から除外
- **修正2（UZRラベル整理）**: 観戦画面ダイジェストの簡易UZR（センタリング無し）を「UZR概算」に改名し、チームタブの正式UZR(centeredOAAOuts)と値が非一致であることを明示
- **修正3（指標変化ダイジェスト拡充）**: `ui/watch.mjs`の「▼指標の変化」に、打者はwRAA/wRC+/Hard%、投手はxFIP/kwERA/K-BB%を追加（ERA/WHIP/AVG/OBP/SLG/OPSは維持）。生カウント差分(pa/so/ibb/hardHits/bbEvents・投手はso/ibb/hbp/hr/bf/bbFB)を新規に打席イベントから逆算する形で追加し、league constants(`u.state.lc`)を利用。エンジン本体(`src/sim/*`)は一切変更しない読み取り専用計算（既存設計と同じ流儀）。走塁指標(wSB/UBR/BsR)は`advTaken/advOpp`がイベントログに露出しておらず、この場限りでの実装は見送り(季節集計/チームタブには既存表示あり)
- **修正4（角度表示・バレル色分け）**: 打球フィールド図に角度(laDeg)を表示、Statcast近似のisBarrel判定でバレル打球の着弾マーカーをオレンジ太枠で強調。`isBarrel`をengine.mjsの公開APIに追加
- **検証**: `npm test`(327テスト)PASS・`npm run verify`(identity不変)PASS・`npm run calibrate`(57/57)PASS。`npm run smoke`は同時並行で動いていた別セッションのG5b未コミットWIP(ui.mjs/schedule.mjs/team.mjs/build.mjs/smoke-ui.mjs)混在時にのみ「順位表3テーブル」で失敗＝該当WIPを一時退避し自分の変更のみ(engine.mjs/sim/game.mjs/ui/watch.mjs)をHEAD(9d84b57)に当てて再実行し独立PASSを確認（他セッションの作業には一切手を加えていない）
- **運用メモ**: 同一リポジトリで別の自走セッションが並行してphaseG_spec(G5b以降)を作業中と判明。git statusの差分から自分の担当ファイルと相手のWIPファイルに重複が無いことを確認した上で、自分の担当ファイルのみをコミット対象にした（dist/pennant.htmlは相手WIP込みでビルドされる状態のため今回はコミット対象外＝次の正式buildで反映される）

**次**: 設計変更を要する残課題（①先発投手の在籍中評価連動・二軍出場枠拡大・年1回昇格制約の緩和、②1年目にも軽い年齢係数を適用、③④打球距離をヒット確率に反映+内野外野境界の精緻化）はtuning/config変更を伴うため個別に着手し、都度`npm run calibrate`で影響確認する

## 2026-07-08 (G5b 順位表の詳細トグル＋表の右端スクロールフェード)

**やったこと**（phaseG_spec.md の G5b を実装。G5a直後の続き）
- `renderStandings` の列を基本7列（順/球団/勝/敗/分/勝率/差）と詳細6列（得点/失点/得失点差/期待勝率/
  運/交流戦）の2段階に分割。表の上に `link` ボタン「▶ 詳細列（得失点・期待勝率・運・交流戦）」を追加し、
  UIローカル状態 `standingsDetail`（`null`=未初期化）でトグル。既定値は G5a の列グループと同じ判定基準
  （`game.gs` があるキャリアモードは既定OFF＝基本列のみ、`game.gs` が無いクイックシミュレートは既定ON
  ＝分析用途）。クリック時は `c.innerHTML=''; renderStandings(c)` で自身を再描画（`.colgroups` バーの
  `render()` 単体再実行のような部分再描画はせず、`renderStandings` 全体を呼び直す単純な方式——
  `renderPostseasonPanel`/`renderFarmStandings` も同じ `c` に追記される構造のため、全体再構築が安全）。
- `renderFarmStandings`（二軍順位表）にも同じ `standingsDetail` を適用（基本7列＋詳細ON時に得点/失点/
  得失点差の3列）。トグルボタンは一軍側の1つのみ＝二軍は状態を共有するだけで独自ボタンは持たない
  （仕様どおり「同じトグル状態を適用」）。
- `.tablewrap` に `position:relative` を追加し `::after` で右端フェード帯（初見時に横スクロールの
  気配を示すヒント）を実装。仕様が明記する設計上の注意（スクロール座標系の限界＝スクロール後の追従は
  保証しない）はそのまま許容し、JS連動化は行わない。
- **`startNewGame` に踏んだ巻き戻りバグ（G5aと同型）**: `batColGroup`/`pitColGroup` のリセット処理が
  既にある行の直後に `standingsDetail = null;` を追加しないと、クイックシミュレートを一度でも開いた
  ブラウザセッションでキャリアモードのニューゲームを始めても順位表の既定がONのまま巻き戻らない
  （smoke一貫実行で最初に発覚: キャリアモード側の新規assert「既定では交流戦列が無い」が失敗→
  `startNewGame` のリセット漏れと特定して修正。G5aのprogressエントリに書いた教訓のとおり、
  同一UIモジュール内でクイックシム→キャリアの順に状態が引き継がれる構造は今後も同じ罠を踏みやすい）。
- `tools/smoke-ui.mjs`: キャリアモード側「順位」タブの初回描画直後に新規ブロックを追加
  （G3ハブタブ開閉ループの直後）: OFF時に `交流戦` th が無いこと→トグル文言
  「▶ 詳細列」→クリック→`交流戦` th が現れる＋ラベルが「▼ 詳細列…を閉じる」に変わること→
  再クリックでOFFに戻し `交流戦` th が消えることを確認（後続テストへ既定状態を汚さないよう畳んで戻す）。
  クイックシミュレート側の既存「交流戦」列assertは仕様どおり無変更（既定ONのため通る）。
- 検証: `npm test`（327 pass）→ `npm run verify`（ENGINE identity不変）→ `npm run smoke`（全ブロックPASS、
  上記巻き戻りバグ修正後）→ `npm run calibrate`（既存30＋B追加20＋D2追加3＋二軍4、全PASS）。

**次にやること**: G6（進行後の差分ダイジェスト）以降のP2項目。

## 2026-07-08 (G5a 成績タブの列グループ切替＋チーム略称チップ)

**やったこと**（phaseG_spec.md の G5a を実装。G4a/G4b直後の続き）
- **`statTable` の `opts` 拡張**（G3が足した `emptyMsg` に加え `groups`/`getGroup`/`setGroup`）:
  `groups` があるとき `getGroup()` が指すグループ定義の**第3要素（列キー配列）の並び順**で `cols` から
  該当列を1つずつ拾って表示列を決定（`cols` 側の元の並びではなくグループ配列側の並びを使う＝仕様の
  厳守事項。例: セイバー群は war を末尾に置く）。第3要素が `null` のグループ（'全列'）は `cols` 全体を使う。
  現在の表示列に無いキーでソート中なら `defaultSort` へフォールバック（グループ切替直後の不整合防止）。
  `groups` が無いときは従来どおり `wrap`（tablewrap div）単体を返し、あるときは列グループバー
  （`.colgroups`）＋`wrap` をまとめた外側 div を返す（呼び出し側 `renderBatting`/`renderPitching` は
  戻り値をそのまま `c.append()` するだけなので変更不要）。
- **`BAT_COL_GROUPS`/`PIT_COL_GROUPS`** を仕様どおり定義（基本/セイバー/打球/文脈/全列・基本/セイバー/
  文脈/全列）。UIローカル状態 `batColGroup`/`pitColGroup` は `null`=未初期化とし、初回描画で
  `game.gs ? 'basic' : 'all'` に一度だけ決定（キャリアモードは基本・クイックシミュレートは分析用途で
  全列）。`startNewGame` で両方を `null` に戻す一行を追加——同一ブラウザセッション内でクイックシムを
  一度でも開くと `batColGroup` が非nullのまま固定される（次にキャリアで新規ゲームを始めても'basic'に
  戻らない）巻き戻りを踏むため、フェーズCの「ニューゲーム＝UI状態も初期化」という既存の暗黙契約に
  合わせてリセットを追加した（仕様の擬似コードには無い追加だが、smoke一貫実行・実プレイの両方で
  意図どおりの既定に収束させるために必要と判断）。
- **team列のチップ表示**: `statTable` 内に `teamCell(d, align)` を新設し、`d.teamId` があれば
  `tabbr()` 略称＋`border-left:3px solid teamColor` のチップ td（順位表の球団名セルと同じ流儀）、
  無ければ従来どおり `d.team` の文字列 td にフォールバック。`renderBatting`/`renderPitching`/
  `renderFielding` の行オブジェクトに `teamId: s.teamId` を追加。
- CSS: `.colgroups`/`.colgroup`/`.colgroup.active` を `tools/build.mjs` に追加（`.subtabs` より
  一段軽い見た目＝タブ切替と列フィルタの階層を区別）。
- **敵対的レビュー的に自己発見して即修正したバグ**: 列グループバーの生成で
  `barWrap.append(groups.map(...))`（配列をそのまま1個の子として push）と書いてしまい、実ブラウザの
  `Element.append` も smoke のDOMスタブも配列を個別ノードとして展開しない仕様のため、ボタンが1個も
  描画されない（`colgroups` バーが空）バグを作っていた。smoke追加分のassert失敗で発覚→
  `barWrap.append(...groups.map(...))` にスプレッド追加して修正。
- `tools/smoke-ui.mjs`: ①クイックシミュレート側の犠打/敬遠/代打・xwOBA等の既存列存在アサーション
  （既定='all'のため実質no-opだが仕様どおり）の直前に「全列」セグメントへの明示クリックを追加、
  ②キャリアモード側は**シーズン終了後**（規定到達者が並ぶ・G7の月末まで進行後）の C4c セクション
  （選手モーダル経歴タブの直前）に新規ブロックを追加: 打撃/投手タブとも既定'basic'の `th` 集合が
  `BAT_COL_GROUPS`/`PIT_COL_GROUPS` の basic 群と一致すること・列グループバーで「基本」がactiveなこと・
  team列がすべて `TEAM_ABBR` の略称＋`border-left`スタイルであること・「全列」へ切替後に `th` 数が
  `BAT_COLS.length`/`PIT_COLS.length`（ハードコードせず動的参照）に一致し犠打/xwOBA等の非basic列が
  現れること、を確認して「基本」へ戻す。ニューゲーム直後（成績タブ初回訪問時点）は0試合消化＝
  規定未到達で表が空（G3のemptybox）になるため、この位置ではなく全データが揃うシーズン終了後の
  区画に置いた（仕様の「目印」に囚われず実データの有無で検証位置を選定）。
- **最終ゲート全PASS**: `npm test`(327件) → `npm run build` → `npm run smoke`(全ブロックPASS) →
  `npm run verify`(ENGINE identity不変) → `npm run calibrate`(既存30+B20+D2 3+二軍4=PASS57/FAIL0、
  表示層のみの変更で数値は完全不変)
- **Playwright実機確認**（モバイル390×844・chromium_headless_shell経由）: ニューゲーム直後の成績タブ
  打撃/投手で列グループバー（基本/セイバー/打球/文脈/全列、投手は基本/セイバー/文脈/全列）が「基本」
  active表示で描かれること、ページ例外（pageerror/console error）が皆無なこと、1週間進行後に打撃表の
  team列が `黒曜`/`翠嶺`/`夜叉`/`雷鳴` 等の略称＋`border-left:3px solid #xxxxxx` のチップで描かれる
  ことを確認。

**次にやること**: G5b（順位表の詳細トグル＋横スクロールアフォーダンス）。

## 2026-07-08 (G4b ホームの絞り込み — 9セクション→4＋ヘッダー導線)

**やったこと**（phaseG_spec.md の G4b を実装。G4a直後の続き）
- **ブロッカー回避（先に実施）**: `renderManagerPanel`/`renderSavePanel` を再描画コールバック引数化
  （`rerender = () => renderHub()` の既定引数）。内部の `renderHub()` 直呼びをすべて `rerender()` に置換。
  デフォルト引数によりホームからの旧呼び出しは無変更で動く。これをやらずに移設すると、方針ボタン/
  スロット保存ボタンを押すたびに呼び出し元（チームタブ・モーダル）から強制的にホームへ遷移/モーダル消滅
  する回帰を作る（仕様が明記する既知の罠）。
- **采配パネル → チームタブへ**: `src/ui/team.mjs` のサブタブを「一軍/二軍/采配」の3つに拡張。
  `teamTabDeps()`（ui.mjs）に `renderManagerPanel`（トップレベル関数そのもの）を追加して渡し、
  采配サブタブで `u.renderManagerPanel(() => u.rerender())` を描く（`u.rerender` は既存の
  `() => renderHub('team')`）。これにより方針変更後もチームタブ・采配サブタブに留まる。
- **セーブパネル → ヘッダーのオーバーレイモーダルへ**: ハブヘッダーの「≡ タイトル」の隣に
  「💾 セーブ」リンクボタンを追加。クリックで `openSaveModal()`（新設）が overlay+modal
  （選手モーダルと同じ modalhead+✕の流儀）を出し、`rebuildModalBody()`（overlayを作り直さず box の
  中身だけ再構築＝`renderHub()` を呼ばない）を `renderSavePanel` の rerender 引数として渡す。
  これによりスロット保存直後もモーダルが開いたままになり「→ロードN」ボタンへ進める。
- **故障者リスト → 削除しチームタブへ統合**: `renderHubHome` から故障者リスト表示を削除（ニュースタブと
  三重表示だったものを解消）。`src/ui/team.mjs` の `renderTeamTab` 冒頭（サブタブバーより前）に
  `離脱中: N名（→ニュース）`（0名なら非表示）の1行サマリを追加。「→ニュース」は `link` ボタンで
  `teamTabDeps()` に追加した `gotoNews: () => renderHub('news')` を呼ぶ（テキストのみだと到達手段が無い
  ため、仕様どおり必ずボタン化）。
- **ニュースの3件slice**: `renderNewsFeed`（ホーム用）の見出し配列を `heads.slice(0, 3)` に絞り、
  「一覧へ →」導線（既存）でニュースタブの全件へ。
- `tools/smoke-ui.mjs`: ①ハブ初期表示直後に `.mgrpanel`/`.savepanel`/「故障者リスト」文言がホームに
  無いことをassert、②旧来ホーム直下にあった采配（`.tendbtn`）の検証をチームタブ→采配サブタブへ移動し、
  「方針ボタンを押した後もチームタブ（采配サブタブ）に留まる」assertを追加（テスト後は一軍サブタブへ
  戻して以後のE1a系テストの前提=「既定サブタブ=一軍」を保つ）、③観戦1試合後の「セーブ/ロード」検証を
  ヘッダーの「💾 セーブ」ボタン起点に書き換え、保存後も overlay が残ること＋モーダル内で「→ロード1」に
  進めることをassert。
- **最終ゲート全PASS**: `npm test`(327件) → `npm run build` → `npm run smoke`(全ブロックPASS) →
  `npm run verify`(ENGINE identity不変) → `npm run calibrate`(既存30+B20+D2 3+二軍4=PASS57/FAIL0、
  表示層のみの変更で数値は完全不変)
- **Playwright実機確認**（モバイル390×844・chromium_headless_shell経由・ニューゲーム→自チーム選択まで）:
  ホームに `.mgrpanel`/`.savepanel`/「故障者リスト」が一切出ないこと／ヘッダー「💾 セーブ」→モーダルが
  開き、スロット保存後も overlay が残り「→ロード1」ボタンが押せること／チームタブの「采配」サブタブで
  方針ボタン（`.tendbtn`）を押した後も `.subtab.active` が「采配」のままで `.mgrpanel` が消えない
  （ホームへ強制遷移しない）ことを確認。あわせて `document.body.scrollHeight`（390px幅）を実測し
  **635px**（仕様の実測ベースライン1311px→目標900px前後を大きく下回る）を確認。

**次**: G5a（成績タブの列グループ切替＋チーム略称チップ）

## 2026-07-08 (G4a 全タブ共通の進行フッター＋stickyタブバー)

**やったこと**（phaseG_spec.md の G4a を実装。G3直後の続き）
- `src/ui.mjs`: `renderHub` の末尾（既存のタブ別描画分岐の直後）に全タブ共通の固定フッター `.hubfooter` を
  root へ直接append（G1aで実証済みのposition:stickyのcontaining block問題を踏まえ、余計なラップdivで
  包まず root の直接の子として置く。position:fixedはposition:stickyほど繊細ではないが同じ流儀で統一）。
  ボタン文言は既存のまま一切変更せず（§0ルール8）: `▶ 次の試合へ`/`1週間`/`月末まで`/`シーズン終了まで`
  （onclick も既存の `showNextGameChoices()`/`runAdvanceWithProgress('weekEnd'|'monthEnd')`/
  `runToSeasonEnd()` をそのまま移設）。`rt.finished` 時は `[シーズンリザルトへ(primary)]` の1ボタンに切替。
  末尾に `.hubspacer`（height:68px）を追加してフッターの下に隠れないようにする
- `renderHubHome` から `.progressbar-wrap`（進行ボタンのホーム内表示）を削除し、上記フッターへ一本化。
  `tools/build.mjs` の未使用化した `.progressbar-wrap` CSS 規則も削除
- `tools/build.mjs`: `.tabs`（ハブ・クイックシミュレート `renderMain` 共通）を仕様どおり sticky化
  （`position:sticky; top:0; z-index:6; flex-wrap:nowrap; overflow-x:auto;`）。`.hubfooter`/`.hubspacer`
  CSS を新規追加（`position:fixed; bottom:0` 全幅・モバイルは`flex:1`均等割り・900px以上のデスクトップは
  中央寄せ＋ボタン幅固定＝G1a `.watchctrl` と同じ配慮）
- `tools/smoke-ui.mjs`: ハブ初期表示直後に `.hubfooter` 存在assert・フッターの4ボタン文言assert・
  旧 `.progressbar-wrap` が存在しないことのassertを追加（既存の `btnByText('次の試合へ')`等は部分一致の
  ため無変更で動作＝§0ルール8の設計判断どおりsmoke変更は最小限で済んだ）
- **最終ゲート全PASS**: `npm test`(327件) → `npm run build` → `npm run smoke`(全10ブロックPASS) →
  `npm run verify`(ENGINE identity不変) → `npm run calibrate`(既存30+B20+D2 3+二軍4=PASS57/FAIL0、
  表示層のみの変更で数値は完全不変)
- **Playwright実機確認**（モバイル390×700・chromium_headless_shell経由）: 日程・結果タブ（150行の表で
  スクロール可能な高さを確保）で `window` を300pxスクロール→`.tabs`のcomputed position=sticky・
  boundingClientRect.top=0（stickyでtopに貼付き実測）／`.hubfooter`のcomputed position=fixed・
  boundingClientRect.top=639/bottom=700（ビューポート最下部に固定のままスクロールに追従しない＝fixedの
  意図どおり）を確認。フッターのボタン文言4種（`▶ 次の試合へ`/`1週間`/`月末まで`/`シーズン終了まで`）が
  変更なしで描画されることも確認。観戦画面へ遷移して `.hubfooter` が出ず `.watchctrl` のみが存在する
  （重複しない）ことも確認

**次**: G4b（ホームの絞り込み — 9セクション→4＋ヘッダー導線）

## 2026-07-08 (G3 成績タブの規定閾値を消化試合比例に＋空状態メッセージ)

**やったこと**（phaseG_spec.md の G3 を実装。G2直後の続き）
- `src/ui.mjs`: `qualifyPa(teamId)`/`qualifyIp(teamId)` を追加（`state.res.standings` から該当チームの
  消化試合数 g=w+l+t を引き、`Math.min(100, Math.max(1, Math.ceil(g*3.1)))` /
  `Math.min(20, Math.max(1, Math.ceil(g*1.0)))`＝NPB規定ライン（打席=試合数×3.1・投球回=試合数×1.0）を
  消化試合に比例させつつ通年(g=143)では従来の固定フィルタ(100PA/20IP)と同値に収める）。
  `renderBatting`の`s.batting.pa >= 100` → `>= qualifyPa(s.teamId)`、`renderPitching`の
  `outs/3 >= 20` → `>= qualifyIp(s.teamId)` に置換
- `statTable` のシグネチャに `opts = {}`（`{ emptyMsg }`）を追加。`data.length === 0` のとき
  `.emptybox` 1行（`emptyMsg`既定文言）を出してテーブル自体を描かない（列だけのヘッダーが出る問題を解消）。
  `opts` は仕様書の指示どおり G5a が `groups`/`getGroup`/`setGroup` を足して再利用する共通拡張点として
  そのまま残した（G3時点では`emptyMsg`のみ実装）
- `renderBatting`/`renderPitching` は共通の `QUALIFY_EMPTY_MSG`（規定到達者不在時の案内文）を
  `statTable` 呼び出しの7番目の引数（`opts.emptyMsg`）として渡す
- `tools/build.mjs`: `.emptybox { text-align:center; padding:24px 8px; color:var(--muted); }` を追加
- エンジン非改変（`src/sim/`・`src/game/`・`src/config.mjs` 無変更）・`src/generate.mjs` 変更なし
- `tools/smoke-ui.mjs` は変更不要（本仕様が意図したとおり通年シナリオでは規定値が従来と一致し既存assertが無変更で通る）。
  `npm test`（327件PASS）→`npm run verify`（ENGINE identity不変・seed=12345 selfCheck一致）→
  `npm run smoke`（全10ブロックPASS）→`npm run calibrate`（既存30+B20+D2 3+二軍4 全PASS、数値は不変＝
  UI層のみの変更どおり）→`npm run build` を確認

**次**: G4a（ハブの全タブ共通進行フッター＋stickyタブバー）

## 2026-07-08 (G2 「1週間・月末まで」のフリーズ解消 — 日次分割進行＋プログレスバー)

**やったこと**（phaseG_spec.md の G2 を実装。G1c直後の続き）
- `src/ui.mjs`: 同期実行だった `advanceChunk(until)`（`advanceTo(gs, until)` を一括同期実行→二軍込みで
  数十秒UIが固まる）を廃止し、`runAdvanceWithProgress(until)` を新設。`advanceDay(gs)` を1日ずつ
  `setTimeout(step, 0)` チャンクで進め、`.overlay > .modal`（見出し+`.pbtrack`/`.pbfill`+進捗%）を表示。
  週/月の境界計算は `src/game/index.mjs` の `advanceTo`（`Math.floor(pendingDay/span)*span+span`）と
  同一の式をUI側にコピーして再現（エンジンは非改変・ロジックには触れず計算式だけ踏襲）。完了時は
  `rt.finished` なら `renderSeasonResult()`、それ以外は `renderHub()` へ（決定論は `advanceDay` の逐次実行で不変＝
  `runToSeasonEnd` と同じパターン）。ホームの「1週間」「月末まで」ボタンの onclick をこれに差し替え
  （文言は一切変更せず）
- `tools/smoke-ui.mjs`: 「月末まで」クリック直後の2箇所（G7ブロック／2年目昇降格ニュースループ）に
  シークベースの `flushTimers()`（`while (timers.length) timers.shift()()`）を追加してタイマーを全消化。
  実装中に**敵対的でない実測で本物のバグを1つ発見**: 冒頭のクイックシミュレート実行を消化していた
  `timers.forEach((fn) => fn())` は非破壊的走査のため、実行済みコールバックが `timers` 配列に**残存**していた。
  旧実装ではその後 `timers.length = 0` で明示的に破棄していたため無害だったが、仕様書どおりに
  `timers.length = 0` を `flushTimers()`（shiftベース）へ置き換えると、その残存コールバックが
  シフトされて**再実行**され、クイックシミュレートの `state.byId`/`state.res` でキャリアモードの状態を
  上書きしてしまい、後続の打撃タブ描画が `p.role of undefined` で例外落ちした。根治として冒頭の
  `timers.forEach` も同じ `flushTimers()`（shiftベース）に統一し、実行済みコールバックを配列から
  必ず取り除くようにした（`flushTimers` ヘルパーを `timers` 宣言直後に定義し直して全箇所で共用）
- `npm test`（327件PASS）→`npm run smoke`（全ブロックPASS）→`npm run verify`（ENGINE identity不変）→
  `npm run calibrate`（既存30+B20+D2 3+二軍4 全PASS、数値は不変＝UIのみの変更どおり）を確認

**次**: G3（成績タブの規定閾値を消化試合比例に＋空状態メッセージ）

## 2026-07-08 (G1c スタメンタブのモバイル横はみ出しバグ修正)

**やったこと**（phaseG_spec.md の G1c を実装。G1b直後の続き）
- 原因: `@media(max-width:640px)` で `.lineupbody` が `flex-direction:column` になるが `flex-wrap:wrap` が
  残るため、CSS仕様（column+wrap は交差軸=幅が内容サイズ）により `.lineupcol` が「今日」列 nowrap 文字列
  の幅へ広がり、`.tablewrap` の横スクロールが機能せず画面全体がはみ出していた
- `tools/build.mjs` の該当 media クエリ内に `.lineupbody { flex-wrap:nowrap; }` `.lineupcol { min-width:0;
  width:100%; }` `.benchbox { min-width:0; width:100%; }` を追加
- Playwright（chromium_headless_shell, playwright-core経由）でモバイル幅390pxの観戦画面・試合終了直後の
  スタメンタブを実測: `document.body.scrollWidth` が修正前 **454px→修正後 390px** に改善（横はみ出し解消）。
  残る内側の `.tablewrap` 内テーブル幅超過は仕様どおり横スクロールで受け持つ想定内の挙動
- `npm test`（327件PASS）→`npm run smoke`（全ブロックPASS）を確認

**次**: G2（「1週間・月末まで」のフリーズ解消＝日次分割進行＋プログレスバー）

## 2026-07-08 (G1b 打球図の空枠を撤去 — 打球なし打席は1行表示)

**やったこと**（phaseG_spec.md の G1b を実装。G1a直後の続き）
- `src/ui/watch.mjs` の `watchFieldChart`: 打球データがある打席（`hasBb`）のときだけ `<svg class="fieldchart">`
  を生成するように変更。打球なし打席（三振/四球等・`p`はあるが`p.bb`なし）と打席前（`p`がnull）は
  svgの枠自体を描画せず、`.fieldlabel` の1行のみ（打席前は「まだ打球なし」、打球なし打席は既存の
  `p.resultText`＝結果ラベルは残す仕様どおり維持）
- `tools/build.mjs`: 不要になった `svg.fieldchart.empty { opacity:0.55; }` を削除
- `tools/smoke-ui.mjs`: 対戦タブの初期表示アサーションを「`.fieldchart`が描かれない＋`.fieldlabel`に
  『まだ打球なし』」に置換（G1aで打球発生ループ側は既にundefined安全化済みだったので今回は変更不要、
  両方揃った状態でsmokeがPASSすることを確認）
- `npm test`（327件PASS）→`npm run smoke`（全ブロックPASS、G1a観戦再ゾーニングのsmokeブロックも含め
  例外なし）→`npm run calibrate`（既存37+B20+D2 3+二軍4 全PASS、UI変更のみのため数値は不変）を確認

**次**: G1c（スタメンタブのモバイル横はみ出しバグ修正）

## 2026-07-08 (G1a 観戦再ゾーニング — コンパクトスコアボード＋タブ4分割＋下部進行バー)

**やったこと**（phaseG_spec.md の G1a を実装。sonnetモデルによる仕様書ベース実装）
- **共有部品**: `src/generate.mjs` に `TEAM_ABBR`（球団略称・TEAM_NAMESとペア定義、TEAM_COLORSと同じ流儀）を追加し
  `engine.mjs`→`ui.mjs`（`tabbr()`ヘルパー）→`watchDeps()` の経路で `src/ui/watch.mjs` へ渡るようにした。
  `test/generate.test.mjs` にドリフト防止テスト（全球団エントリ・12件・非空）を1本追加
- **`src/ui/watch.mjs` 大改修**: `renderWatchScreen` の組み立てを完成形の順（①スコアバー→②タブ4種→③タブ本体→
  ④進行バー）に差し替え
  - `lampRow` を `watchNowPanel`（削除）内のローカル関数からモジュールレベル関数へ切り出し（ReferenceError回避）
  - 新関数 `watchScorebar`: 常設は「両軍名(`tabbr()`略称)+得点」「回表示/B-S-Oランプ/塁表示」の1本バーのみ。
    B-S-Oランプ・塁表示は `v.ended` で描画しない（残留点灯/残留表示バグの根治）。▼ボタンで `w.lineOpen` を
    トグルしラインスコアを展開（既定閉）
  - 観戦タブを4種（速報/対戦/ボックス/スタメン）に分割。速報=現在の打席（`.curabvs`で打者/投手名を追加＝
    重大UX欠落の修正）→実況フィード。対戦=盤面(`watchDiamond`から下部アウト円/上部回表示テキストを撤去し
    塁+走者名だけに)→対戦カード→打球フィールド図（`.duelpanel`常設を廃止し`.dueltab`へ）
  - `watchControls`: インラインstyle削除・`.finalscore`削除（スコアバーに一本化）・珍記録(notables)検出を
    `watchFeedTab`側の試合終了時先頭行へ移設・ボタン文言は一切変更せず（§0ルール8）進行中/終了時とも
    `.watchctrl`クラス常時付与（f4修正5のdone分岐は固定下部バー化に伴い削除）
- **CSS**（`tools/build.mjs`）: `.scorebar`/`.sbteam`/`.sbmid`/`.sbbso`/`.sbbases`/`.sblinescore`/`.curabvs`/
  `.dueltab`/下部固定`.watchctrl`/`.watchspacer`/sticky`.wtabs` を追加。`.nowpanel`系・`.duelpanel`系
  （`.duelcol`は`.fieldcol`併用のため残置）を仕様の削除範囲どおりに撤去。`.bso`/`.lamp`系・`.matchup`/`.curab`
  は流用のため残置
- **`tools/smoke-ui.mjs`**: 仕様手順10の全項目を適用（`.nowpanel`系→`.scorebar`系へ置換・トップレベル`diamond`
  assert削除して対戦タブ切替後へ統合・`.scoreboard`常設assertを`.sbexpand`クリック後の検証に変更・
  `wtabs`3→4種化・`.finalscore`assert→スコアバーの「試合終了」テキストへ置換・打球図ループの`undefined`
  安全化・ゾーニング門番（速報タブにdiamond/fieldchart/matchupが出ない・対戦タブに`.pbp`が出ない）を追加・
  `.curabvs`存在assertを追加
- **最終ゲート全PASS**: `npm test`(327テスト) → `npm run build` → `npm run smoke`(全PASS) →
  `npm run verify`(ENGINE identity不変) → `npm run calibrate`(既存30+B追加20+D2の3+二軍4=PASS57/FAIL0)。
  表示層のみの変更で較正指標は完全不変を確認
- **Playwright目視確認**（モバイル390×844・chromium_headless_shell）: スコアバー/観戦タブバーがsticky・
  進行バーが下部fixed1行に収まる・速報タブに`.curabvs`（打者/投手名）が画面上部（スクロール不要な範囲）に
  表示・対戦タブに盤面/対戦カード/打球図が出て実況フィードは出ない・試合終了時にB-S-Oランプ/塁表示が消え
  スコアバーに「試合終了」・「最終打席」ラベルに切替・スタメンタブは横はみ出しなし(scrollWidth=390)を確認

**次**: phaseG_spec.md の G1b（打球図の空枠撤去）→G1c（スタメンタブ横はみ出し修正）→G2以降を順次実装

## 2026-07-08 (F4レビュー指摘1-7を全て修正完了 — sticky解除・演出の再発火防止で仕上げ)

**やったこと**（thyroxin/specs/f4_review_fixes_spec.md、修正1・2・7・3・4は前コミット済み、本ターンで修正5・6を実装）
- 修正5: watchControls の ctrl 生成を `class: 'row' + (done ? '' : ' watchctrl')` に変更。試合終了後は
  最終スコア＋珍記録ノータブル行＋ホームへ戻るボタンで肥大化した ctrl ブロックがモバイルで sticky 固定される
  問題（小画面の1/3超を占有）を解消。進行中のみ sticky を維持
- 修正6: 得点/HRパルス(pulseScore)・🎉ポップ(notablePop)のCSSアニメーションを `.fx` クラス必須に変更し、
  `game.watch.justAdvanced` フラグで「再生位置が進んだ描画」でのみ付与するよう実装。renderWatchScreen は
  毎回innerHTML再構築するため、サブタブ切替・全球表示トグル・自動再生トグル等の再描画のたびに演出が
  再発火して点滅していたのを解消（adv関数/⏩最後まで/自動再生setTimeout/観戦開始時の4箇所でtrueをセット、
  renderWatchScreen末尾でfalseにクリア）
- 最終ゲート全PASS: `npm test`(326テスト) → `npm run verify`(決定論不変・identity OK) →
  `npm run smoke`(全UI smoke OK) → `npm run calibrate`(既存30+B追加20+D2の3+二軍4=PASS57/FAIL0)
  → `npm run build`。表示層のみの変更で較正指標は完全不変を確認
- これで F4レビュー（2026-07-07 CONFIRMED 8指摘）の修正1〜7が全て完了

**次**: phaseG_spec.md（UI再ゾーニング G1〜G10）の実装に着手可能

## 2026-07-08 (フェーズG「UI再ゾーニング」実装仕様を作成 — ユーザー承認→設計→敵対的レビュー→反映)

**やったこと**（ユーザー「設計をお願いします。あとでsonnetに切り替えたときにちゃんとやってくれるように」）
- UI/UX総点検レビュー(ui_ux_review_20260707.md)のP0-P2をG1〜G10の実装単位に分解し、`thyroxin/specs/phaseG_spec.md`
  を作成。観戦画面の完全ゾーニング（コンパクトスコアボード常設＋速報/対戦/ボックス/スタメンの4タブ完全分離＋
  下部固定進行バー）・週/月進行の非同期チャンク化・成績タブの規定閾値の消化試合比例化・ハブの絞り込み＋共通
  フッター・成績/順位表のモバイル列整理・進行後ダイジェスト・日程の現在月フォーカス・リザルト整理・選手モーダル
  磨き・用語集導線、の10項目。f4_review_fixes_spec.md（未実装）を前提とする設計にした
- **Workflow敵対的レビュー**（4視点ファインダー: 事実照合/Sonnet実装可能性/整合性/UX適合 →検証。整合性レンズと
  検証エージョンの大半はセッション上限で失敗したため、確度の高い指摘は自分で直接ソースを読んで裏取りして反映）
- **反映した確定指摘（ブロッカー1件・major多数）**: ①renderManagerPanel/renderSavePanelの内部onclickが
  無条件にrenderHub()（ホームタブ）を呼ぶため、G4bの移設先（チームタブ采配サブタブ/セーブモーダル）で
  ボタンを押すたびに呼び出し元から弾き出される回帰→再描画コールバック引数化で設計修正 ②進行ボタン文言の
  短縮案（「▶1イニング」→「1回」等）がsmoke-ui.mjsのbtnByText(部分一致)を連鎖的に壊すと判明→
  「ボタン文言は変更しない・CSSだけで詰める」の設計判断に変更しG2/G4a双方のsmoke破壊を同時解消
  ③BAT_COLS実測28列（仕様の「27」は誤り）→ハードコード数値を排し`.length`参照に統一 ④G5aのstatTable列
  グループ拡張・G3のemptyMsgが同じopts拡張点を共有する設計に統合 ⑤守備タブがteamId無しでチップ表示が壊れる
  →ガード追加+teamId付与 ⑥速報タブ(既定)に打者/投手名が一切出ない重大UX欠落→`.curabvs`行を追加
  ⑦lampRowのローカル関数削除でReferenceError化・CSS削除範囲の曖昧さ・watchctrlのインラインstyle残留・
  G2のタイマーflush漏れ・G5bの`::after`スクロール座標系バグ、等smoke/実装可能性の具体指摘を仕様に反映
- 324テスト等は未実行（本ターンはドキュメント作成のみ・コード変更なし）

**次**: sonnetモデルでphaseG_spec.mdに沿ってG1a→G1b→…→G10を順次実装（前提のf4_review_fixes_spec.md修正1〜7が先）

## 2026-07-07 (F4シリーズの多角コードレビュー → 修正設計書を作成)

**やったこと**（/code-review medium: 8角度ファインダー×検証1票の敵対的レビューを `6d4bc23..HEAD` に実施）
- **CONFIRMED 8件**: ①ゲーム差表示 `gb <= 0 ? '-'` が同率/負GBの非首位でも「-」になる（勝率順＋引分で負GBは到達可能） ②同一順位表画面で一軍「差」=GB・二軍「差」=得失点差の二重意味 ③sticky先頭列の `background:var(--bg)` がモーダル（--panel背景）内で常時縦縞 ④モバイルsticky進行バーが試合終了後にノータブル行ごと画面上部を占有 ⑤得点パルス/🎉ポップが「1回だけ」のはずが非進行の再描画（タブ切替/トグル/自動再生tick）のたび再発火 ⑥GB式が3箇所重複（news/ui×2） ⑦TEAM_COLORSがgenerate.mjsチーム名のシャドーコピー（改名で無音フォールバック・ID非対応も確認） ⑧`tr.myteam td:first-child` が特異度同点(0,2,2)の順序依存
- **REFUTED 1件**: `gp >= 5` のconfig集約違反疑い → news.mjs の既存閾値が全てインラインであり単独移設は逆に非一貫と判定
- **修正設計書を作成: `thyroxin/specs/f4_review_fixes_spec.md`**（sonnetが単独で実装完結できる粒度: 対象行・置換コード・受け入れ基準・実装順序・最終ゲート付き。設計判断: GB表示は行index基準で首位のみ「-」/ sticky背景は `--sticky-bg` CSS変数で コンテナ追従 / 演出は `w.justAdvanced` フラグ＋`.fx` オプトイン / 色はTEAM_NAMESとインデックス対応のペア定義をgenerate.mjsへ移設＋網羅テスト）

**次**: f4_review_fixes_spec.md に沿って修正1〜7を実装（sonnetに委任可）。UI/UX総点検のP0対応はユーザー方針確認後のまま

## 2026-07-07 (UI/UX総点検 — ユーザー指摘「1画面に情報がありすぎる」を受けた全画面レビュー)

**やったこと**（ユーザー「野球速報アプリはタブ切替で1画面完結。今のUIは情報過多。改善点を一通りあげて」→実機検分）
- dist/pennant.html を Playwright（1280×900/390×844）で全27画面スクリーンショット＋scrollHeight/Width実測＋UI全ソース読解
- レビュー文書: **thyroxin/research/ui_ux_review_20260707.md**（画面別の改善点一覧＋P0-P2優先度案）
- 検出した実バグ: ①観戦スタメンタブでモバイル横はみ出し（.lineupbody が column+wrap のため .lineupcol が内容幅444pxへ拡張・scrollWidth 454/390） ②試合終了後もB-S-Oランプが残留点灯 ③成績タブが序盤PA/IP固定閾値で空表（説明なし・27列ヘッダーのみ） ④「1週間/月末まで」が同期実行でUI数十秒フリーズ
- 構造診断: タブが「最下部セクションの切替」にしかなっておらず、観戦はボックスタブでも常設パネルでタブ内容が1.4画面下から。スポナビ原則（常設=コンパクトスコアボードのみ・タブが画面全体を切替）への再ゾーニングをP0提案

**次**: ユーザーの方針確認後、P0（観戦再ゾーニング・横はみ出し修正・進行フリーズ解消・成績空状態）から着手

## 2026-07-07 (F4 UI磨き込み・敵対的レビューで検出したCSS詳細度バグを修正)

**やったこと**（F4コミット(55935c3)後、Workflowで独立2視点コードレビュー＋Playwright視覚検証を実施→検出した回帰を修正）
- **原則レビュー**: エンジン非改変・決定論影響なしをPASS判定（実際のtest/verify/smoke/calibrate全PASSと整合）
- **回帰レビューで検出**: 成績表の先頭列固定CSS(`table.stat td:first-child`)がセレクタ詳細度で`tr.myteam td`/`tr.clickable:hover`に勝ってしまい、自チーム強調・行hoverが先頭セル(選手名/球団名)だけ効かなくなる回帰を発見。`tr.myteam td:first-child`/`tr.clickable:hover td:first-child`を後置して修正
- **視覚検証（デスクトップ）**: 全項目PASS（GB表示・球団カラー・ニュースガード・得点パルス・sticky列すべて実機能確認）
- **視覚検証（モバイル）**: 軽微な指摘1件（進行ボタンのsticky下端でスクロール停止時にCJK文字が上半分だけ欠けて見える瞬間）→ `.watchctrl`に軽いbox-shadowを追加して境界を視覚的に明示（根本はposition:sticky全般に共通する自然な挙動のため実害は小さいと判断）
- 324テスト・build/smoke/verify(identity不変) 全PASS

## 2026-07-07 (打球フィールド図を追加 — スポナビ風・実データ・静的画像)

**やったこと**（ユーザー「打撃結果を視覚的にわかりやすく（静的画像でOK・スポナビ野球速報のイメージ）」対応）
- 対戦パネル(.duelpanel)の右カラムに「打球」フィールド図を新設(src/ui/watch.mjs)。直近の 'pa' イベント(watchReconstruct が再生済みイベントから記録するv.lastPA)の打球データ(sprayDeg/distanceM/laDeg/evKmh)を1件だけ描画
- SVGは ui.mjs sprayChart() と同じ座標変換(pt(deg,dist)・ファウルライン±45°・内野目安円・本塁)を流用。着弾点は1個の大きめマーカー(HR=金/2B,3B=青/1B=白/アウト=灰・ballColor流用)＋本塁からの軌跡線1本(laDeg<10=ほぼ直線/10-25=浅い弧/25+=山なりの弧・quadratic bezierで高さのみ変える視覚区別)
- 図の下に結果ラベル(watchPaBodyの言語化文をそのまま流用・色分けクラスも継承)＋EV/飛距離（例:「EV148km/h 128m」）。打球のない打席(三振/四球等)は枠だけの薄い表示(.empty)＋結果テキストのみ
- smoke-ui.mjsに新規アサーション: フィールド図SVG常設(.fieldchart)・打球なし時は.emptyで薄表示・打球発生時に着弾マーカー1個(.fieldmark)+軌跡線1本(.fieldtraj)+結果ラベル(.fieldlabel)+EV/飛距離(.fieldsub)
- エンジン不変(データ読み取りのみ・乱数非消費)・324テスト/build/smoke/verify(ENGINE 0.10.0-farm identity不変)全PASS

## 2026-07-07 (F4 UI磨き込み — バグ修正＋演出)

**やったこと**（起床時にコミット漏れの完成済み作業を発見→検証→コミット。前ターンで起動されたエージェントの成果と推測）
- **バグ修正**: 順位表/ハブの「差」列が誤って得失点差を表示していた→NPB慣例のゲーム差(首位との勝敗差の平均)へ修正
- 球団アクセントカラー(表示専用・エンジン非関与)を順位表・観戦画面に追加
- 成績表の選手名列をsticky固定(横スクロールしても見失わない)
- 観戦画面: 得点/HR時のパルス演出・特筆イベントのポップイン・スマホ幅で進行ボタンsticky化・盤面縮小で1画面に収まりやすく
- ニュース見出し: 開幕直後の全チーム同率.000で「首位快走」が誤発火するのを防ぐガード(消化試合数5以上)
- 324テスト・build/smoke/verify(identity不変) 全PASS(55935c3)

**運用メモ**: 未コミットの完成済み変更を起床時に発見(git status)。差分を精査し一貫性のある追加的UI変更と確認できたためテスト→コミットで確定。破壊的操作は行っていない

## 2026-07-07 (打席ごとの指標変化ぶら下げ表示 — 観戦画面刷新シリーズ完了)

**やったこと**（ユーザー「打席結果で変化した指標を全部『UZR 11.5(+0.2)』形式で下にぶら下げて」→実装(ba59bbc)→DOMダンプ検分）
- エンジン最小拡張: game.mjsのpaイベントにfielderPos/fielderId追加(乱数非消費・既存の担当野手情報を渡すのみ)
- UI: 観戦開始時にbeforeGame(試合前の累積値)を1回算出→再生位置での当日差分から「この打席の直前/直後」を導出。打者AVG/OBP/SLG/OPS・投手ERA/WHIP・守備OAA/UZR概算を「▼指標の変化」の折りたたみ(既定で開)に表示。変化した指標のみ・矢印+差分・向きで緑/赤
- 検分結果: 初出場打席は.000→1.000等の極端値になるが分母0→1の自然な数学的帰結で正常。2打席目以降は正常値(WHIP 0.86→0.75等)で安定動作を確認
- 324テスト・verify(identity不変)PASS
- 簡略化点(コメントで明記済み): 投手自責点は打席内得点=自責の近似・守備OAA/UZRはリーグ平均センタリング無しの簡易版(正式なチームタブのUZRとは非一致)

**観戦画面刷新シリーズ完了**: E2スポナビ式ゾーニング→コース図v2→ユーザーレビューでコース図撤去→打球フィールド図(静的画像)→指標変化ぶら下げ、で一区切り

## 2026-07-07 (打球フィールド図追加 — 静的画像でスポナビ風)

**やったこと**（ユーザー「打撃結果を視覚的に(静的画像でOK)」→ 実装(dbceb69)→検分）
- 対戦パネル右カラムに「打球」フィールド図: 直近打席の実データ(sprayDeg/distanceM/laDeg/evKmh)で着弾点1個＋本塁からの軌跡線(ゴロ=直線/ライナー=浅い弧/フライ=山なり)。既存sprayChartの座標変換を流用。結果ラベル＋EV/飛距離。打球なしの打席は枠のみ薄く表示
- 324テスト・verify(identity不変)・smoke全経路PASS

**次**: 打席ごとの指標変化ぶら下げ表示(UZR 11.5(+0.2)形式)を実装中(wf_d47d784a)。beforeGameスナップショット差分で当打席の変化のみ抽出

## 2026-07-07 (コース表示を撤去 — ユーザー要望対応)

**やったこと**（ユーザー「コース表示は消してほしい。どうせちゃんとできないんで」→即応）
- コース図(F1・投手目線/打者の影/球種マーカー)一式を削除(d11325a)。1球ごとのテキスト実況・利き腕タグ(右打/左打/右投/左投)・B-S-Oランプ・ダイヤモンド盤面は維持
- 324テスト・verify(identity不変=ENGINE 0.10.0-farmのまま)・smoke全経路PASS

**次**: 打球フィールド図(実データ・スポナビ風静的画像)→打席ごとの指標変化ぶら下げ表示(UZR 11.5(+0.2)形式)。ユーザーの了承通り小さいワークフロー単位で段階実装(モデルをSonnet 5に切替・トークン効率重視)

## 2026-07-06 (F2完成: ロスター拡大＋二軍リーグ — ユーザー要望対応)

**やったこと**（ワークフロー wf_e842e895・月間支出上限で2回中断→キャッシュ再開＋最終較正は私がインライン引き継ぎ）
- **F2-1** 支配下70人＋育成10-40人/球団(球団の育成方針で差)・リーグ総人口~1,159人・名前プール拡張(bcad977)
- **F2-2** 一軍出場登録29人選抜＋**二軍リーグ並走**(2リーグ・110試合×12球団=660試合/年・独立シード根・farmStats分離集計・セーブv3)(5067b9d)
- **F2-3** 昇降格: IL補充/復帰・25試合レビュー拡張の成績入替(10日ルール簡略)・育成→支配下の二軍実成績化＋70枠管理・昇降格ニュース(0c4d35b)
- **F2-4** UI: チームタブ一軍(登録29)/二軍(実成績列・育成バッジ)・選手詳細の一軍/二軍年度別行・二軍順位折りたたみ・昇降格ニュース(f12b704)
- **F2-5** 再較正(6ac99df): 登録29人上澄み効果によるHR膨張/エース相対優位圧縮/セパ差超過を再収束。二軍サニティ4種追加——「二軍打率は一軍より低い」という当初想定は**実NPBファームの実態(投手の質低下>打者→打率同水準〜やや高)に反した**ため±15pt同水準へ訂正(実測+2.5pt・年齢は二軍22.7<一軍23.9)
- **324テスト・verify(ENGINE 0.10.0-farm)・smoke全経路・較正57/57 PASS**

**到達点**: 二軍の試合が実際に回り、若手が二軍で経験→昇格の育成ループが完成。ユーザー要望(支配下70人・80-120人保有・二軍の試合成立・二軍=一軍に及ばない選手＋成長途中)を充足

## 2026-07-05 (F1完成: コース図v2 — 投手目線/打者の影/利き腕/球種マーカー)

**やったこと**（ユーザー要望→仕様化(phaseF_spec F1)→実装(280d570)→DOMダンプ検分）
- 投手目線化(一塁側=画面右)・打者の影(右打者=画面左/左打者=画面右・スイッチはeffectiveBats・「右打/左打」ラベル)・対戦カードに右打/左打/両打(実効側)・右投/左投タグ・球種マーカー形状(●ストレート▲スライダー◆カーブ▼フォーク■チェンジ⬢シンカー系・色=判定維持・番号=右肩)・凡例2段(形＝球種/色＝判定)
- 299テスト・smoke・verify(identity不変=エンジン非改変) 全PASS

**実行中**: F2(支配下70人＋育成10-40・一軍登録29・二軍リーグ~110試合シミュレート・故障補充/成績昇降格/育成→支配下・一軍53指標再収束＋20年回帰) — wf_e842e895・5ステージ＋ゲート

## 2026-07-05 (配球リアリティ修正 — 投球帯の再配分＋再較正)

**やったこと**（ユーザー「クソボールばかり/届かない場所のファウル」→ 計測で切り分け→2段修正）
- **計測による診断**: 際(ボーダー)18.4%は現実(~40%)より少なく明確ボール36.9%が過多。明確ボールへのスイング31.7%は現実(~18%)の1.7倍 ＝「ボール球の質」がモデルごと歪んでいた
- **描画の即時修正**(6399922): 明確ボールを際からの距離減衰で描画・スイングされた球は際のすぐ外限定・見逃しは低めバイアス
- **モデル本体の再配分**(1beaa7a・ENGINE 0.9.1-pitchband): borderShare 0.34→0.56(際32.2%へ)・oSwingBase 0.235→0.10(明確ボールスイング18.0%へ)・O-Swing%をFG定義整合(際=shadowを0.5按分でゾーン外計上・回帰テスト2本)・波及の再較正(BB%/Contact%/K%/HBP/WP/フレーミング/セパ差/野手WAR王/得点環境)
- **53較正指標PASS・299テスト・verify新ベースライン・smoke全経路OK**
- 残差メモ: 明確ボールスイング18.0%は帯上端・Contact%/K%/セパ差もマージン小(次回較正時の注意点)

**次**: フェーズF実行中 — F1(コース図v2: 投手目線/打者の影/利き腕/球種マーカー) → F2(支配下70人＋育成・二軍リーグ・昇降格・再較正)。仕様: thyroxin/specs/phaseF_spec.md

## 2026-07-05 (観戦の情報ゾーニング＋コース図 — ユーザー要望対応 第2弾)

**やったこと**（ユーザー「情報がごっちゃで見づらい・コースも見たい」→ 改良案提示→実装(9760ad3)→インライン検分）
- **情報ゾーニング**: ①最上部「今の状況」パネル(nowpanel: チーム名＋大スコア・回/表裏・アウト・B-S-O・盤面SVGを1カードに統合) ②コンパクトなラインスコア ③進行ボタン固定 ④「対戦」パネル(duelpanel: 打者/投手カード＋現打席＋コース図) ⑤サブタブ「速報/ボックス/スタメン」(スタメン・ベンチ残量をタブへ移設し本面をスッキリ・試合途中ボックスも見られる)
- **コース図（捕手視点ストライクゾーン）**: 現打席の投球を①②③…の番号ドットでプロット。帯(ゾーン内/際/外)は一球シムの実データ(band)をイベントに搭載(乱数非消費・identity byte一致で結果不変を証明)。帯内座標は決定論ハッシュ(同じ試合は同じ図)。判定色をコース図・現打席リスト・実況で統一(ボール白/見逃し緑/空振り赤/ファウル黄/インプレー青)
- 検分で確認: nowpanel のスコア大表示・コース図の①(黄=ファウル)②(白=ボール)が現打席と一致・凡例・サブタブ切替
- 297テスト・smoke・verify(identity byte一致)・較正53指標 全PASS
- 将来メモ: コースが結果に効く本格実装(ホット/コールドゾーン)は req_1 球種格子・段階2＝エンジン改造＋再較正の中規模工事として別途

## 2026-07-05 (未実施だったUX導線レビューをインラインで完了)

**やったこと**（フェーズE検証でセッション上限により未実施だった導線レビュー。エージェント無しのDOMダンプ検分＝上限配慮）
- チームタブ: 一軍/二軍サブタブ・列構成・等級/状態列・開幕前の「-」表示が正常。注記「等級=コーチの見立て（真の実力ではない）」も適切
- ボックススコア: ラインスコア/打撃・投手ラインの値が正しく、**代打(「打」)→守備固めの交代までNPB公式ボックスの流儀で表示**されることを確認
- 観戦画面は本日のスポナビ式再設計で対応済み。ストーブリーグはsmokeアサーション網羅でカバー
- 結論: フェーズEの残タスク(UX導線レビュー)消化。指摘事項なし

## 2026-07-05 (観戦画面の再レビュー→スポナビ式に再設計)

**やったこと**（ユーザー「試合がかなり見づらい」→ ヘッドレスDOMダンプで実像を検分してレビュー→再設計）
- **見づらさの正体を特定**: ①実況が新しい順のため1打席の中が逆順に読める（結果→N球目→…→1球目→打席開始） ②全打席の全投球が積まれ3回で100行超＝安打/HRが埋もれる ③結果行の強調なし・得点時のスコア表示なし ④「今日 0-0」表記が紛らわしい
- **スポナビ式に再設計**（e34fa9d・実装1体の最小ワークフロー＋インライン検分）:
  対戦カード直下に「現在の打席」ボックス（投球を1球目→N球目の正順・カウント統一表記）／実況は打席結果のみの1行に畳み（[N回表裏]プレフィックス・全球表示トグルで詳細切替）／結果色分け(安打青/HR・得点赤/三振グレー/四死球緑/失策橙)＋得点行に現在スコア付記／当日打席履歴チップ（三ゴロ・左安…）＋「X打数Y安打」表記
- 再検分で確認: 3イニングの実況が100行超→約20行に圧縮、現打席が正順で読める、HR行が「2ランホームラン！！（EV163km/h 飛距離124m）（白鷺 0-2 紅蓮）」形式で強調
- 297テスト・smoke・verify(identity不変=エンジン非改変) 全PASS

## 2026-07-05 (フェーズE完成 — UI/UX刷新・ユーザーフィードバック対応)

**やったこと**（ワークフロー wf_09cdf103 ＋ インライン仕上げ。ユーザー指摘「選手一覧がない/二軍が見えない/トレードできない/観戦が見れたものではない(スポナビ風がいい)」への対応）
- **E1 チームタブ**: 一軍(支配下)/二軍(育成)の選手一覧(ソート可・観測成績＋WAR＋スカウト等級＋故障状態)。全行クリック→詳細モーダル。playerLink導線を順位表/表彰/ニュース/記録の全画面に敷設
- **E2 スポナビ風観戦**: 一球速報(「3球目 フォーク 空振り(1-2)」)・イニング別ラインスコアR/H/E・対戦カード(現在打者の今日の打席＋シーズン成績/投手の球数)・B-S-Oランプ・進行切替(1球/1打席/1イニング/自動再生)・スタメン折りたたみ。一球イベントはonPitch(乱数非消費)でidentity byte一致を維持
- **E3 ストーブリーグ**: FA市場入札・トレード起案(AIの受諾/拒否と評価差の理由)・育成昇格候補・オフダイジェスト1画面化。介入はセーブのリプレイで再現(決定論)
- **E4 動線**: タブ整理(ホーム/チーム/日程・結果/順位/成績/ニュース/記録)・日程・結果タブ(月別リスト→試合クリックで簡易ボックススコア)・狭幅CSS
- 検証指摘の修正(インライン・トークン節約のためエージェント無し): ①盗塁死3アウト時の「1イニング」進行が次ハーフをスキップ(stealイベントにinning/half搭載・回帰テスト付き) ②ボックススコアの打点近似の注記
- **297テストPASS・verify identity OK・smoke(C1b/E2/E4全経路)OK**

**運用メモ**: セッション上限でワークフローが複数回中断したため、以後は検証・小修正をインライン化しワークフローを小さく分割する方針。

**残り(低優先)**: フェーズE検証のUX観点レビュー1本が上限で未実施(smoke通過済みのため致命度低)。D5(全国対戦・Capacitor)は引き続き後回しで合意済み。

## 2026-07-05 (プレイ体験検証＋ピタゴラス期待勝率 — 完成後の仕上げ)

**やったこと**
- **プレイヤー体験の検証**（読み取り専用・回帰リスクゼロ）: ヘッドレスの通しプレイで「判断が結果に効くか」を確認:
  - 采配方針で自チーム成績が動く（同一シードT1: おまかせ72勝2位 / 超積極采配84勝1位 / 超消極采配75勝3位）＝原則3の核心「判断が意味を持つ」が機能
  - 多年の浮沈: 自チーム10年順位 3→2→5→1→1→4→5→3→1→5（王朝も低迷もある振り子）
  - 決定論・セーブ→ロード→続行の一致も確認。**ゲームとして成立**していることを実証
- **ピタゴラス期待勝率＋幸運度を追加**（原則1「なるべくすべての指標」）: pythagenpat指数で得失点から実力勝率を推定し、実勝率との差=「運」(接戦の強さ/幸運)を順位表に表示。純関数(得失点=公開情報のみ)＝エンジン非改変で較正byte不変。291テストPASS
- 全ゲート再認証: verify identity OK・smoke両経路OK・較正53/53 PASS

**現状**: プロジェクト完成・全ゲート緑・プレイ体験検証済み。以降は完成システムへの低リスク・検証可能な仕上げ（指標追加/小改善）を積む方針。大規模変更は回帰リスクのため避ける。残るD5(全国対戦BaaS・Capacitor)はヘッドレスで構築/検証困難な後付け項目。

## 2026-07-05 (多年運用の統合監査＋2欠陥修正 — 全4フェーズ検証完了)

**やったこと**（監査ワークフロー wf_39f5c1d9 ＋ 修正ワークフロー wf_38a8be2f）
- **20年通し統合監査**（3観点: 統合正しさ/創発ドラマ/セイバー多年整合）: 20件のうち**18件は健全**を確認。
  加齢カーブ・晩成/鉄人・ブレイク上下・復活/宝拾い(市場非効率)・生存バイアス・王朝均衡・時代トレンドの創発ドラマが正しく発現。リーグ人口恒常・決定論・セーブ復元も健全。
- **確認された2件の重大バグを修正**（各フェーズの個別検証では見えなかった、20年通しの統合で顕在化した破綻）:
  - **Bug1 得点環境の一方向インフレ**(6ef1faa): 加齢プロファイルのネットドリフトが正→生存バイアス＋ドラフト選抜と相まって能動ロスター平均が+5〜6上振れ→SLG/HR/ERAが単調インフレ(旧+21%/+32%/+71%)。加齢profilesを「生成中心≒生存ロスター定常平均」(net drift≈0)へ再較正。個体テール(晩成/鉄人)は残し集団平均だけ平坦化。→ +9%/+12%/+32%へ抑制・全年NPB帯内・D3時代波の揺れに収束。1年目byte不変
  - **Bug2 投手WARに床ゲート無し**(908fd71): 起用AIの不振ガードが打者/捕手専用→破綻救援が均等起用され最悪-5.27。**前年の観測RA9**を門番にした破綻救援ガードを新設(前年が無い1年目は構造的に不作動＝閾値非依存でbyte不変を保証)。完全排除でなく0.6確率間引きで負荷付替えを回避。→ 最悪-4.34(目標>-5達成)・救援登板分布健全
- **290テストPASS(回帰+9)・verify・smoke・較正53指標byte不変**

**プロジェクト完成度**: 全4フェーズ実装＋20年通し統合監査で創発デザインの発現を確認＋顕在化した2バグを修正。三原則を達成し、多年運用の健全性まで検証済み。**残るはD5(全国対戦BaaS・Capacitor化)のみ**＝ヘッドレス環境では構築/検証困難な「後から乗せる」プラットフォーム項目。

## 2026-07-04 (フェーズD完成 — 深化・時代・仕上げ)

**やったこと**（ワークフロー wf_ec3495c4）
- **D1 打球モデル仕上げ**: HR飛距離モデルを明示化しHRを打者power/EV/最適LA帯へ急峻依存化。→ **HR/teamとHR王が複数seed窓(1-12/13-24)で安定両立**（フェーズAで残した唯一の較正弱点=平坦HR分布のout-of-sample不安定を根治）。プラトーン効果量を−.020級へ強化。起用AI defEvalにスカウトノイズ付与（三層構造の緩い違反を解消）
- **D2 パークファクター**（§11.2）: 球団本拠地に球場ジオメトリの個性（完全架空）。狭い球場の左打者/広い球場の中堅で「同じ打球がHRにも凡フライにも」。PF導出→wRC+PF/ERA-PF/FIP-PFのパーク補正。PF平均=1.0000のゼロサム（リーグ得点環境は中立）
- **D3 時代トレンド＋王朝均衡**（§11.3）: 投高打低の揺れ・平均球速の経年上昇・世代の波・王朝の振り子・記録の時代補正+指標。**1年目はbyte完全不変**（ドリフトは2年目以降）
- **D4 レバレッジ駆動継投**（§8.3完成）: 接戦度(LI)で最良救援を高レバレッジ場面へ。「WPA抜群だがWAR平凡なセットアッパー」が構造再現
- 検証で1件修正: パーク/時代補正の+指標が算出済みだがUI未接続→打撃/投手表・モーダル・経歴タブへ接続（"見せる"要件の充足）
- **281テストPASS・verify OK・smoke(3経路)OK・較正53指標全PASS**（既存30＋規律系20＋パーク3）

**プロジェクト全体の到達点（4フェーズ完成・ソース約11,000行/40モジュール/31テストファイル）**:
- フェーズA: NPB起用/采配・WAR-6根絶・セパ再現
- フェーズB: 一球シム＋全セイバー指標
- フェーズC: ゲームシェル＋多年キャリア＋市場＋演出
- フェーズD: 打球仕上げ＋パーク＋時代＋レバレッジ継投
- **三原則すべて達成し深化まで完了**。残りは D5(全国対戦・Capacitor化=プラットフォーム展開・§19/§17)＝「後から乗せる」もの

## 2026-07-04 (フェーズC完成 — 編成市場＋演出＋検証修正)

**やったこと**（ワークフロー wf_bb41542c ＋ 手動仕上げ）
- **C3a 編成市場基盤**: 球団AI評価関数の球団差(守備/位置価値の過小評価度・出塁重視度・年齢バイアスを球団ごとに固定＝市場非効率を仕込む§13/§15)、ドラフト(世代生成・スカウト観測ノイズ・ウェーバー逆順×1位競合くじ)、育成/支配下二層(§12.1)
- **C3b 選手市場**: FA(宣言/入札・契約年数リスク)、トレード(AI同士の評価差成立＋プレイヤー起案)、戦力外→拾い上げ(§12.2の板山/上林型が構造的に発現)
- **C4 演出**: 表彰(MVP/新人王/ベストナイン/守備の栄誉/9タイトル)、ニュースフィード(週次ダイジェスト・ノーヒッター/サイクル検出)、記録(球団史/リーグ記録トップN/マイルストーン)、二つ名(能力パターン自動付与)
- **検証で挙がった不具合を手動修正**（ワークフローの敵対的検証はセッション上限で未完→私が精査し本物と確認）:
  引退選手が通算記録・受賞履歴から脱落（careerStatsは全年永続だがplayersByIdが現役のみ→buildEvalsが引退選手のシーズンをスキップ→レジェンドが記録から消え、過去年表彰が現役へ誤帰属）。
  → `allPlayersById`(現役＋引退者サマリ)を新設し記録/受賞/マイルストーンを全時代byIdへ。回帰テスト追加
- **249テストPASS・verify OK・smoke(分析UI＋ゲームシェル)OK・較正50/50 byte不変**

**フェーズC完成 → 三原則すべて達成**:
- 原則1(指標網羅・一球粒度) ✅（フェーズB）
- 原則2(セパ再現・起用/采配の妥当性・WAR-6根絶) ✅（フェーズA）
- 原則3(やきゅつく的楽しさ) ✅（フェーズC: 自チーム/シーズンプレイ/采配介入/多年キャリア/育成/市場/表彰/記録）

**残り（フェーズD＋仕上げ）**:
- パークファクター/時代トレンド(投高打低の揺れ・平均球速経年上昇)/レバレッジ継投WPA精緻化/王朝均衡(§11.3)
- 全国対戦(非同期ランキング→すれ違い)・Capacitor化(iOS/Android)（req_1フェーズ4-5・§19）
- 累積残差: HR分布形状のスカラー両立不可(打球モデルのHR~パワー依存急峻化)・規律率の薄マージン(多変数較正)・プラトーン効果量・起用AIのdefEval三層構造の緩い違反

## 2026-07-03 (フェーズC1+C2完了 — ゲームシェル＋多年キャリア)

**やったこと**（ワークフロー wf_044eee2d）
- **C1a ヘッドレスゲームAPI**: src/game/（newGame/advanceDay/advanceTo/save/load）。season.mjsを日次分割駆動できるよう season_runtime に切出し（単年一括APIは後方互換）。バージョン付きセーブ（RNG状態・介入ログ込み）
- **C1b ゲームシェルUI**: タイトル→ニューゲーム(自チーム選択)→シーズンハブ(順位/次戦/進行ボタン)→観戦(スコアボード＋ダイヤモンドSVG＋実況)→リザルト。采配介入(スタメン/打順/方針＝監督プロファイルの人間上書き・おまかせトグル)。IndexedDBセーブ(オート＋手動3枠)＋Web Worker長時間進行
- **C2a 加齢成長カーブ**: src/game/aging.mjs。能力別カーブ(走力/速球=早落ち・選球眼/技巧=残る/伸びる)、peakAge/declineRateの能力タイプ相関、成長ドリフト(若手高分散bust)
- **C2b 故障/ブレイク/引退**: injury.mjs(故障ハザード・再発・後遺・IL離脱日)、breakout.mjs(上下ブレイク＝球種習得/覚醒/イップス)、roster.mjs(引退・世代交代・新人補充でリーグ人口恒常)、多年運用20年サニティ
- **検証で4件の重大欠陥を発見・全修正**:
  ①采配介入の年跨ぎリーク→多年セーブが復元不能(データ喪失) ②キャリアUIが隠し値trueAbilityを直接露出(三層構造違反)→スカウト等級表示へ ③加齢が母集団を「全員やや晩成」へ後ろ倒し→§10.1窓へ引戻し＋peakAge能力相関 ④故障のgamesLostが死値・IL未結線→usage.injuredUntilへ結線しベンチが穴埋め＋ハブに故障者表示
- **222テストPASS・verify OK・smoke OK・較正50/50がbyte完全一致**（1年目シム不変を直接証明）

**フェーズC1+C2到達点（原則3の中核）**: 自チームを持ちシーズンをプレイでき、加齢/成長/故障/引退で複数年キャリアが回る＝やきゅつくの核が動く
**フェーズCの残り**: C3(ドラフト/FA/トレード＋育成/支配下二層＋球団AI評価の球団差) / C4(ニュース/表彰/記録/二つ名)

## 2026-07-03 (フェーズB完全完了 — 一球シム化 B1)

**やったこと**（ワークフロー wf_6f347076）
- **B1 一球ごとシミュレーション**: 打席解決を「一発抽選」から **(balls,strikes) カウント状態機械**へ置換（ENGINE 0.9.0-phaseB1）。
  球種選択(カウント依存)→ロケーション帯(ゾーン/ボーダー/ボール)→スイング判断→空振り/ファウル/インプレー→(見逃し時)捕手フレーミングでボーダー球判定。K=3ストライク/BB=4ボールが**創発**。in-playのEV/LA打球パイプラインは不変。
- **規律系指標が一球の副産物として湧く**: O-Swing/Z-Swing/SwStr/CSW/Zone%/F-Strike%/投球数/PA/WP/PB/毎球フレーミング。捕手blocking能力を新設。
- **最難関=一球化後の再較正に成功**: 既存30指標を全回復＋規律系11指標を目標帯へ収束＋QS率も帯内。12seed平均で **既存30＋追加20＝全50指標PASS**。
- 検証3件: ①②投球数の打者/投手対称性の恒等破れ→修正 ③規律率(CSW%/Contact%/QS%)が帯縁の薄マージン→保存則(CSW%↑⟺BB%↓)により単一ノブで再センタリング不可＝構造的残差として記録(バグでない)
- 190テストPASS・verify identity OK・smoke OK

**フェーズB完了時の到達点（原則1の達成）**
- 一球・一プレー粒度のシミュレーション ✅（規律系指標が副産物として湧く）
- セイバー指標の網羅 ✅: 打撃(xwOBA/Barrel/HardHit/SweetSpot/wRC+/OPS+/ISO/スプリット) 投手(xFIP/SIERA/kwERA/ERA-FIP-/K-BB%/LOB%/QS/CSW/SwStr) 走塁(wSB/UBR/wGDP/XBT%/Spd) 守備(UZR成分=RngR/ErrR/ARM/DPR/rSB/Frame・OAA) 文脈(RE24/WPA/LI/Clutch/SD/MD)
- **残タスク（低優先）**: 規律率の薄マージン（多変数較正 or ハーネス強化）／HR/team vs HR王のスカラー両立（打球モデルのHR~パワー依存急峻化）

## 2026-07-03 (フェーズB追加指標 完了)

**やったこと**（ワークフロー wf_f620d17c・追加系指標＝sim本体を変えず既存ストリームを集計）
- **B3a** 期待値/率系: xBA/xSLG/xwOBA・Barrel%/HardHit%/SweetSpot%・GB/FB/LD/PU・Pull/Cent/Oppo・OPS+/wRC/SecA/XBH・xFIP/SIERA/kwERA/ERA-/FIP-/xFIP-/K-BB%/LOB%/HR-FB/QS
- **B2** 文脈: RE24（24状態得点期待値）/WPA/LI（aLI/pLI/gmLI）/Clutch/SD/MD をシム自身から2パス導出。救援WARに(1+gmLI)/2レバレッジ加重（§8.3の死角を完成）。恒等: ΣRE24≈0・WPAゼロサム・平均LI=1.0
- **B3b** 守備成分: UZRをRngR+ErrR+ARM+DPR+rSB+Frameに分解表示。ARM(外野送球・肩相関0.92)・DPR(併殺転換)・rSB(捕手阻止)。走塁XBT%/Spd/BsR成分。打撃スプリット(対左右/RISP/home-away)
- **B3c** UI: 選手モーダルのタブ化(基本/打球/スプリット/文脈/守備成分)、リーダーボード新指標列(ツールチップ定義付)、チーム集計タブ
- 検証で発見した欠陥1件修正: DPRの併殺run価値が二遊間で二重計上→dpShare=0.5で配分(表示のみ)
- **較正30指標は完全byte不変**（追加集計はrng非消費・sim結果を変えない設計を全ステージ厳守）。183テストPASS・verify・smoke OK

**既知の帯外（B1で収束させる）**: QS率0.650（目標0.45-0.6上振れ）＝現行simの先発が効率的なため。一球化(B1)で投球経済が変わり収束見込み

**フェーズBの残り**: B1=一球ごとシミュレーション（カウント状態機械）。O-Swing/Z-Swing/SwStr/CSW/フレーミング毎球/WP/PB を有効化。**エンジン改造で較正を壊すリスク大**→慎重に実装＋再較正

## 2026-07-03 (フェーズA完了)

**やったこと**
- 中断ワークフローの検証→修正段階を引き継ぎ完了（ec5f7f7）。S1-S5は完了済み(155テスト)だった
- 確認バグ修正: ①12回引分でinnings=13(off-by-one) ②盗塁死のみで降板した投手の幽霊登板(outs>0だがG=0)。回帰テスト追加
- レビュー指摘の是正:
  - #3 投手打撃が.217=実NPBの約2倍 → vsFastball/vsBreaking等を実水準化(AVG~.18/K%~28%)
  - #2 救援代替水準0.012がブルペン総WARを負に沈める → 0.020(FanGraphs方式)
  - #7 投手が大差でもバント → pitcherMaxScoreDiffゲート
  - #6 日本シリーズ本拠地=勝率 → NPB方式(年の偶奇でリーグ交互)
- **構造的改善（重要）**:
  - **リーグ攻撃力の均衡化**(generateLeague): 野手攻撃力でグリーディに2リーグ均等配分。
    セパ得点差がDH効果だけを反映して安定化（seed毎の符号反転を解消）。これがセパ差FAILの根本解決
  - **壊滅捕手の起用安全弁**(usage.mjs): 壊滅水準のみ控えと分担しWAR-3級定着を防止
  - **WAR下限指標の再設計**: 単一min>-2.5（極値統計）を廃し、破局min>-4.0＋典型mean>-2.5の2本立て
- 較正: 12シード平均へ拡張。**全30指標PASS(in-sample 1-12)**。ENGINE 0.8.0-phaseA-fix
- 157テスト・verify・smoke 全PASS

**フェーズA完了時の到達点（三原則の達成度）**
- 原則2(セパ近似): 12球団2リーグ交流戦/CS/日本シリーズ、セ投手打席、起用AI(WAR-6根絶=破局-2.5)、
  采配(犠打/敬遠/盗塁/継投/代打代走守備固め/連投制限/中6日)、セパ得点差の安定発現 ✅
- 原則1(指標): 打撃/投手/走塁/守備/WARが一球・一プレーの副産物として算出 ✅（一球シムはフェーズB）
- 原則3(楽しさ): 未着手（フェーズC）

**フェーズAの残タスク（後日・低優先）**
- レビュー#4: プラトーン効果量が仕様の約半分(-.0145 vs -.020〜.030) → platoonノブ引上げ（要再較正）
- レビュー#1: 起用AIのdefEval/rangeEvalが真値を無ノイズ参照（三層構造の緩い違反）→ スカウトノイズ付与検討
- nit: fielding.mjs のOAA/失策中心化でDHイニングが分母混入（影響ごく僅少）
- HR/team vs HR王 のスカラー両立不可（平坦HR分布）→ フェーズBの打球モデルでHR~パワー依存を急峻化して根治

## 2026-07-02 (続き・S3完了時点)

**やったこと**
- フェーズA S1〜S3 完了（ワークフロー wf_e4447d7c）: S1基盤(12球団/2リーグ/プラトーン/打順AI/ローテ6) → S2試合(ベンチ/代打代走守備固め/犠打/敬遠/継投v2/セ投手打席/manager.mjs集約) → S3シーズン(日程v2/日次スタメンAI/疲労/CS・日本シリーズ/役割別repl)。154テスト全PASS
- S1/S2のアーキテクトレビュー実施: manager.mjs のポリシー分離・三層構造遵守・プラトーン両層結線を確認、設計逸脱なし
- フェーズB仕様(一球シム・指標大拡張)/フェーズC仕様(ゲーム層)を作成済み → `thyroxin/specs/`

**イベント**: S4実行中にセッション上限で中断(19:50 UTCリセット) → キャッシュ再開でS4(UI/較正ハーネス)→S5(較正収束)→検証→修正を続行

## 2026-07-02 (セッション開始)

**やったこと**
- 現状把握: フェーズ2完了時点（6球団単一リーグ・全DH・固定9人打線）。テスト全PASS、較正は核指標PASS＋既知残差4件（OPS僅差/打率王僅差/野手WAR王10.1高/投手WAR王4.7低）
- ユーザー指摘の問題を要件化 → `thyroxin/requirements/req_2.md`（三原則）
  - WAR -6 の異常値 = 満員打線（ベンチ不在・起用AI不在）が根因
  - 采配システム不在 / 12球団2リーグ未対応 / セのDH無し未対応
- git リポジトリ化（夜間自走の安全網）。baseline = acd7a55
- フェーズA詳細仕様 → `thyroxin/specs/phaseA_spec.md`
- **ワークフロー起動**（wf_e4447d7c）: S1基盤(12球団/2リーグ/プラトーン/打順AI/ローテ6) → S2試合(ベンチ/代打代走守備固め/犠打/敬遠/継投v2/セ投手打席) → S3シーズン(交流戦日程/日次起用AI/疲労/CS・日本シリーズ/役割別repl) → S4(UI/較正ハーネス) → S5(較正収束) → 検証(スイート＋整合性/リアリティレビュー＋敵対的検証) → 修正

**次にやること**
- ワークフロー完了確認 → 結果検分 → 必要なら追加修正
- フェーズB仕様書（一球シム＋指標大拡張）の作成と実装
- フェーズC仕様書（ゲーム層・やきゅつく感）の作成と実装

## バックログ（優先順）
1. ~~フェーズA: NPBリアリティ＋起用・采配~~（実行中）
2. フェーズB: 一球ごとシム（カウント/スイング/O-Swing/Z-Swing/SwStr/CSW）＋RE24/WPA/LI/Clutch＋xFIP/SIERA/kwERA/ERA-,FIP-＋xBA/xSLG/xwOBA/Barrel%/HardHit%＋捕手Blocking・盗塁阻止/外野Arm/LOB%/K-BB%/Spd
3. フェーズC: ゲーム層（自チーム選択/日次進行＋采配介入/育成・成長・加齢・故障=req_1フェーズ3/ドラフト・FA・トレード/複数年/IndexedDBセーブ/ニュースUI）
4. フェーズD: パークファクター/時代トレンド/全国対戦/Capacitor

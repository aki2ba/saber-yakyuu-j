# フェーズA 実装仕様: NPBリアリティ＋起用・采配（req_2 原則2）

> 対象コード: `src/`（ESM, Node `--test`）。現状はフェーズ2完了（6球団単一リーグ・全DH・満員打線・固定9人）。
> 本仕様は5ステージ（S1〜S5）に分割。各ステージ完了時に `npm test` 全PASS＋gitコミットすること。
> 決定論を壊さない（全乱数は渡された rng 経由。`Date.now`/`Math.random` 禁止）。
> コメント・命名は既存コードの流儀（日本語コメント・§参照）に合わせる。

## 現状の構造（前提知識）

- `src/config.mjs` — 全較正ノブ。`league.numTeams=6, gamesPerSeason=140, dh:'all'`
- `src/generate.mjs` — 架空選手/球団生成。TEAM_NAMES は12球団分ある。`bats`/`throws` は生成済みだが**未使用**（M7）
- `src/sim/team.mjs` — `buildDepthChart(roster)`: 守備8人=習熟最高、DH=残り最良打者、打順=hitScore降順9人固定、ローテ5人、残り全員ブルペン（relieverScore順）
- `src/sim/season.mjs` — `buildSchedule`(総当たり)→`simulateGame`ループ。`starterIdx = 登板数 % 5`
- `src/sim/game.mjs` — 9回状態機械。`initSide`が`depth`から固定9人を展開。継投=`maybeChangePitcher`(球数/失点)+`maybeBringLeverageReliever`(8回setup/9回closer)+`pickReliever`(最少投球回)。盗塁=`attemptSteal`(選手能力のみで判断)。犠打/敬遠/代打/代走/守備固めは**存在しない**
- `src/sim/plateAppearance.mjs` — K/BB/HBP/inPlay の規律層（log5）。**左右プラトーン未接続**
- `src/sim/battedBall.mjs` — EV/LA/spray生成（tto, pitch 引数あり）
- `src/sim/war.mjs` — 野手WAR/投手WAR(FIPベース, `replFipMult=1.25`)
- `src/sim/metrics.mjs` — playerBatting/playerPitching/playerBaserunning
- `src/sim/leagueConstants.mjs` — 2パス目のリーグ定数導出
- `src/model/statline.mjs` — 生カウント器（sh/ibb フィールドは既にある・未使用）
- `src/ui.mjs` + `tools/build.mjs` — 単一HTML化。`tools/smoke-ui.mjs` ヘッドレス検証
- `tools/calibrate.mjs` — 5シード平均でNPB目標帯とPASS/FAIL判定

## 較正目標（フェーズA完了時・`tools/calibrate.mjs` を本表に更新）

12球団・143試合・2リーグ制で:

| 指標 | 目標帯 | 備考 |
|---|---|---|
| AVG / OBP / SLG | .255-.262 / .320-.328 / .390-.410 | 既存踏襲（リーグ合算） |
| OPS | .715-.735 | 下限を.715へ僅かに緩和 |
| K% / BB% | 18-20% / 7.8-8.3% | 既存踏襲 |
| HR/球団 | 110-130 | 既存踏襲 |
| ERA | 3.5-3.9 | リーグ合算 |
| 得点/球団/試合 | 3.9-4.3 | |
| **セ・パ得点差** | パ − セ = +0.1〜+0.45 点/試合 | DH差の発現（セ=投手打席） |
| 打率王 | .320-.355 | 帯を.355へ拡大 |
| HR王 | 40-55 | |
| 打点王 | 95-140 | ベンチ導入で低下想定 |
| 盗塁王 | 30-65 | |
| **犠打（リーグ計/球団平均）** | セ球団 55-110 / パ球団 30-75 | セ>パ（投手バント） |
| 敬遠（球団平均） | 10-40 | |
| 総WAR | 370-430 | 12球団×143 |
| 野手WAR比 | 0.53-0.57 | |
| **野手WAR王** | 7-9.5 | |
| **投手WAR王** | 5.5-8 | |
| **WAR下限** | 200PA以上の野手の最小WAR > **-2.5** | 「WAR-6」の根絶（起用AIの機能証明） |
| 規定打席到達 | 球団あたり 5-9人 | ベンチ運用の発現 |
| 先発IPリーダー | 150-195 | 中6日でもエースは深く |
| 登板数王（救援） | 45-65 | 連投制限下 |
| SV王 / HLD王 | 30-45 / 30-45 | 既存водно踏襲 |
| 完投（リーグ計） | 5-30 | |
| 捕手の出場 | 正捕手 100-135試合（143未満） | 休養AIの発現 |

## S1: 基盤 — config / 生成 / 編成 / プラトーン結線

1. **config.mjs**
   - `LEAGUE_DEFAULT` → `numTeams: 12, gamesPerSeason: 143, leagues: [{id:'L1', name:'セントラル系架空名', dh:false}, {id:'L2', name:'パシフィック系架空名', dh:true}]`（名前は完全架空の造語にする。例:「陽炎リーグ」「蒼天リーグ」等。'セントラル/パシフィック'は使わない）。`dh:'all'`は廃止し、**試合のDH有無=ホーム球団のリーグ規則**とする。`rotationSize: 6`（中6日）。
   - `tuning` に追加: `platoon`（同利き手ペナルティ: kLogit +0.10 / bbLogit −0.08 / EV −1.2km/h 程度を初期値に。スイッチヒッターは常に有利側）、`bunt`（試行判断・成功率テーブル）、`ibb`、`sub`（代打/代走/守備固め閾値）、`rest`（捕手/野手の休養率）、`fatigue`（連投制限・登板可否）、`usage`（観測成績ベース起用の重み・見直し間隔25試合）。
   - `CALIBRATION_TARGETS` を上表へ全面更新。
2. **generate.mjs**
   - 各チームへ `league`（前半6球団=L1、後半=L2）を付与。
   - 各チームへ**監督プロファイル** `manager: {buntTend, stealTend, ibbTend, quickHook}` を分布から生成（チーム間の采配の個性。決定論）。
   - 野手20人の内訳は現行維持。投手13人。
3. **team.mjs — buildDepthChart v2**
   - 返り値に `bench`（スタメン外野手の降順リスト）と `positionRank`（ポジションごとの候補ランキング=習熟×守備素材＋打撃考慮）を追加。
   - **打順アーキタイプ**: 1番=OBP系×俊足、2番=コンタクト/出塁、3番=最強総合、4番=最強パワー、5番=次点パワー、6-8番=残り降順、9番=DH無なら投手/DH有なら最弱野手。`hitScore`に加え `obpScore`（eye重視）/`powerScore` を用意して振り分け。
   - ローテは `cfg.league.rotationSize`（6人）。ブルペンに役割: `closer / setup8 / setup7 / middle[] / long`（relieverScore順に割当、longは最下位）。
4. **プラトーン結線（M7解消）**
   - `plateAppearance.mjs` の `paProbabilities` に `batter.bats` vs `pitcher.throws` の補正（config.tuning.platoon）。スイッチ(S)は常に逆側。
   - `battedBall.mjs` のEVにも同補正。
   - 効果量の初期値: 同利きで wOBA −.020〜.030 相当。
5. **statline.mjs**: 変更最小（sh/ibb は既存）。`batting.ph`（代打打席数）を追加。
6. テスト: プラトーンの向き（同利きでK↑BB↓）、打順アーキタイプ（4番のpower最大等）、ローテ6人、ベンチ生成、リーグ割当。既存テストの6球団前提を12球団へ更新。

## S2: 試合エンジン — ベンチ・采配・投手打席

`game.mjs` を拡張（責務は現行構造を維持し関数追加で）:

1. **initSide v2**: season から渡される「今日のスタメン」（打順・守備・先発）＋「ベンチ」「ブルペン可用リスト」を受ける。`side.bench`, `side.availableRelievers`, `side.lineupSlots`（打順スロット→現在の選手、交代履歴）を持つ。**一度退いた選手は再出場不可**。
2. **DH無し試合（セ主催）**: 打順9番に投手。投手交代時は新投手が同スロットへ。**投手への代打**（6回以降ビハインド/接戦の得点機、ベンチ最良打者）→ 次の守備で新投手。
3. **代打/代走/守備固め**（`cfg.tuning.sub` + 監督プロファイル）:
   - 代打: 7回以降(投手へは6回以降)、接戦orビハインドの得点機で、打席の弱い打者（投手含む）に対しベンチの最良打者（プラトーン込み）を投入。`batting.ph++`。
   - 代走: 8回以降・2点差以内・鈍足走者が塁上 → ベンチ最速。
   - 守備固め: 8回以降・リード1-3 → 守備最弱ポジをベンチの守備要員と交代（習熟/素材比較で優位時のみ）。
   - 交代後の守備配置・positionOuts の整合を守る（守備イニング計上は現行 `fielding.defense` 走査のまま正しく動くようにする）。
4. **犠打**（`maybeBunt`）: PA解決の前に判断。無死or一死×走者1B/2B×接戦(±2)×非強打者（または投手打席=ほぼ必ず）×監督buntTend。成功~78%(走者進塁・打者アウト・`sh++`・ABなし)、失敗~12%(先頭走者アウト)、内野安打~10%。2ストライク概念はフェーズB(一球シム)で。
5. **敬遠**（`maybeIBB`）: 一塁空き×2死or一死×終盤接戦×強打者（wOBA上位）or 次打者が投手 → `bb++, ibb++`。
6. **盗塁の采配ゲート**: 現行 `attemptSteal` に監督stealTend×状況ゲート（大差では走らない、2死×強打者では自重等）を乗せる。
7. **継投v2**（`pickReliever` 差し替え）:
   - 可用性: season から渡る `availableRelievers`（連投制限・前日投球数で除外済み）のみ。
   - 状況→役割: 9回セーブ機会=closer、8回接戦=setup8、7回接戦=setup7、ビハインド大差=long/middle下位、それ以外=middle で負荷分散。
   - 敗戦処理: 5点差以上ビハインドは long を長め(2-3回)に。
8. **試合結果に投手使用ログを返す**（pid, pitches, 登板日）→ season 側の疲労管理へ。
9. テスト: 再出場不可、代打後の守備整合、投手打席がセ主催のみ、犠打のAB非計上、IBB⊂BB、大差でclouserが出ない、等。

## S3: シーズン層 — 日程・休養・起用AI・疲労・ポストシーズン・WAR役割別repl

1. **buildSchedule v2**（season.mjs）: リーグ内 5相手×25(ホーム12or13交互) =125 ＋ 交流戦 他リーグ6相手×3 =18 → **143試合**。DH規則=ホーム球団リーグ。日付概念: スケジュールを「節」（day index）に直列化し、各チームが1日1試合・適度な休日を持つカレンダーへ（連投制限・中6日の基盤。厳密なNPB日程でなくてよいが day 単位は必須）。
2. **日次スタメンAI**（新 `src/sim/usage.mjs`）:
   - 休養: 捕手は確率的に休ませ正捕手100-135試合に。野手も低率で休養。連続出場が長いほど休養確率↑。
   - プラトーン: 相手先発の利き手で、プラトーン込み実効打力が上回るベンチがいれば入替。
   - **観測成績ベースの見直し**（25試合ごと）: 観測wOBA（回帰込み: 観測を打席数で信頼度加重し、スカウト評価=真値+scoutSeedノイズと混合）でポジション候補を再ランク。**不振のレギュラーは先発頻度が下がり、好調の控えが昇格**する（これが「WAR -6 が出ない」仕組みの本体）。急激に全交代せず頻度で徐々に。
   - 投手可用性: 前日登板×2連投→当日不可（3連投禁止）、前日30球以上→不可。先発は中5日以上のみ。
3. **ポストシーズン**（新 `src/sim/postseason.mjs`）: CS1st(2位vs3位, 2位本拠地, 2戦先勝) → CSFinal(1位に1勝アド, 4勝先取, 1位本拠地中心) → 日本シリーズ(4勝先取, 2-3-2)。延長は決着まで(引分なし)。結果を `simulateSeason` の返り値に含める（`postseason` フィールド）。レギュラーシーズン統計とは分離集計（混ぜない）。
4. **war.mjs**: `replFipMult` を廃し **役割別代替水準**（先発 0.12 / 救援 0.03 wins/9IP, FanGraphs方式, B-5）へ。`pitcherWAR = ((lgFIP−FIP)/9×IP)/RPW + (IP/9)×replPer9(役割)`。役割=GS/G比で按分。
5. **metrics.mjs**: FIPのBBから IBB を除外（`bb+hbp−ibb`ではなく FG式 `13HR+3(BB−IBB+HBP)−2K`）。SHをOBP/wOBA分母から除外していることを確認（分母=AB+BB−IBB?…FG定義: wOBA分母=AB+BB−IBB+SF+HBP。IBBの扱いを定義通りに）。
6. **リーグ別集計**: leagueStats をリーグ別にも出す（セパ得点差の較正用）。
7. テスト: 143試合×12球団=858試合、リーグ内125/交流戦18、中6日(登板間隔≥5日)、3連投なし、CS/日本シリーズの決着、役割別replの向き。

## S4: UI・較正ハーネス

1. **ui.mjs**: 順位表を2リーグ分割表示＋交流戦成績、ポストシーズン結果パネル（CS/日本シリーズの勝敗）。打撃表に SH/IBB/PH、投手表に役割(先発/救援)。選手モーダルに bats/throws 表示。
2. **calibrate.mjs**: 上の較正目標表を全実装（リーグ別得点差・WAR下限・規定到達者数・犠打セパ差・正捕手出場数を含む）。`npm run calibrate` が新目標で判定。
3. **smoke-ui.mjs**: 2リーグ順位表・ポストシーズンパネルの描画を検証項目に追加。
4. `tools/build.mjs` のバンドル対象に新モジュール（usage/postseason）を追加（IMPORT_RE の仕様に注意）。

## S5: 較正ループ

- `npm run calibrate` を回し、FAIL項目を config ノブで収束させる（最大8イテレーション）。
- 優先順: 得点環境（セパ差含む）→ HR → 分布の裾 → WAR系。
- 投手WAR王 5.5-8 へ: エース級のFIP下限(奪三振/制球の裾)・先発深投(スタミナ高で~110球)・役割別repl で到達させる。届かない場合は generate の投手能力分散を微拡大してよい（分布の裾のみ、平均は不変）。
- 収束後: config デフォルトへ焼き込み、`CONFIG_VERSION` を上げ、全テスト＋`npm run verify`＋`npm run smoke` PASS を確認してコミット。

## 設計原則の遵守事項

- **采配はすべて「監督ポリシー」経由**にする（`manager` プロファイル＋判断関数）。フェーズCで人間の采配に差し替えるフックになるため、判断ロジックは game.mjs 内に散らさず`src/sim/manager.mjs` に集約する。
- 観測成績ベース起用は**真値を直接見ない**（三層構造。観測statline＋スカウトノイズのみ）。
- 新しい定数は必ず config.tuning に置く（マジックナンバー散布禁止）。
- 走者トラッキング（誰が塁上か）は既存の playerId ベースを維持。

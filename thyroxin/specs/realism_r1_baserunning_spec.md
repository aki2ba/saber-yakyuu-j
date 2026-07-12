# R1: 走塁 'out' 分岐の再設計＋塁打決定の守備隊形依存化 — 実装仕様

> 根拠: `thyroxin/research/realism_gap_audit.md`（2026-07-11 監査）の推奨順序1＋2。
> 実装者向け（設計判断はこの文書で確定済み。迷ったらこの文書＞既存コードコメント）。
> **1作業単位 = 本仕様の全段階＋再較正PASS＋テスト更新＋progress.md＋コミット。** 途中で止めない。

## 0. スコープ

**やる**（すべて `src/sim/game.mjs` / `src/sim/battedBallResult.mjs` / `src/config.mjs` / 統計配線に閉じる）:
- A. ゴロアウトでの走者進塁（進塁打・ゴロゴー・FC・併殺間の得点）
- B. 空中アウトのタッグアップ深さ依存化（内野フライ犠飛の根絶・本塁憤死の導入）
- C. 失策(E)時の非フォース進塁
- D. アウトカウント依存の進塁＋2死の走塁死解禁（時間プレー順序）
- E. 塁打決定 `decideBases`/`expectedBases` の守備隊形依存化（発端の「目の前ポトリ2B」根絶）
- F. 記録整合: 犠飛の正しい認定（WP得点を犠飛にしない）・FC・outsOnBase配線・バント失敗の封殺条件・観戦UI整合

**やらない**（別ユニット。触るな）:
- 継承走者の失点帰属 / セーブ規定 / PB非自責 / サヨナラ決勝点（R2: 記録規則ユニット）
- 采配（スクイズ・クローザー・代打）/ 一球機械 / 日程 / 指標定義 / 市場・表彰 / 加齢・故障
- 盗塁の三盗/本盗、けん制
- gdpOpp の機会定義変更（§13 未決。今回は現行定義を維持）

## 1. 全体の不変量（鉄則・違反したら差し戻し）

1. 乱数は既存の `rng` 引数経由のみ。**消費順はコードパスに対して決定的**であること（`npm run verify` がNode↔ブラウザ同一性の門番）。旧シードとの結果一致は不要（挙動変更が目的）。
2. 新しい定数はすべて `config.mjs` の `tuning` へ（マジックナンバー散らし禁止）。
3. アウト加算は既存の `ctx.outsAdded` 経路のみ（caller が `outs`/`fielding.cur.outs`/`pStat.pitching.outs` へ反映）。**ΣpositionOuts == 8×Σpitcher.outs の恒等（test/game.test.mjs の恒等式群）を壊さない。**
4. `PA恒等式 pa == ab+bb+hbp+sf+sh`（test/game.test.mjs:264）を維持。
5. `expectedBases` は `decideBases` と**同一分岐の確率版**を維持（リーグ集計で xwOBA≈wOBA。較正 `xwobaGap` が門番）。
6. 進塁ロジックは `advanceRunners`/`resolveAdv` に集約（UIや metrics に分岐を漏らさない）。
7. 各段階ごとに `npm test` を通し、最後に `npm run calibrate` 12seed PASS まで回す（§8）。

## 2. A. ゴロアウトの走者進塁（advanceRunners 'out' × bType==='GB'）

### 2.1 呼び出し構造の変更

現在: caller(playHalf) が `advanceRunners`（走者凍結）→ 後段の DP ブロック(game.mjs:729-752)で併殺を別処理。
変更後: **ゴロアウトの分岐決定（DP/FC/進塁打）を advanceRunners 内へ移す**。ただし DPR/gdp の統計計上（dpOpp/dpTurned/gdpOpp/gdp、二遊間への帰属）は守備側の `statFor`/`defense` が要るため、`ctx` に `fieldingDefense`（=fielding.defense）と `fieldingTeamId` を追加して渡し、advanceRunners 内で計上する。caller の旧 DP ブロックは削除（`gbDp` 判定は ctx 経由で返す: `ctx.gbDp = true`）。

- 打者アウト自体のカウント（outs++/cur.outs++/pitching.outs++）は現行どおり caller（result==='out' ブロック）。**追加のアウト（DP相方・FC・走塁死）はすべて `ctx.outsAdded`** に積み、caller の既存反映コード(game.mjs:709-713)に一本化する。
  - 注意: 現行の caller は DP のアウトを直接 `outs++` していた。移設後は「打者アウト=caller、追加アウト=outsAdded」で二重計上しないこと。
- `advanceRunners` のシグネチャは維持（bType は ctx に載せる: `ctx.bType`）。テスト（test/season.test.mjs, test/fielding.test.mjs）は ctx なし呼び出しがある — **ctx なし（または fieldingDefense なし）の場合は現行挙動（凍結）にフォールバック**し、既存テストの互換を保つ。新挙動のテストは ctx 付きで書く。

### 2.2 分岐表（outsBefore = 打者アウト計上**前**のアウト数）

`outsBefore >= 2` → 打者アウトで攻守交代。走者処理なし（現行どおり）。

`outsBefore < 2` かつ **走者一塁あり**（フォース状況）:
1. `gdpOpp++`（現行位置から移設。dpOpp も 2B/SS へ現行どおり）
2. 一様乱数 u を1回引き、確率の帯で3分岐（排他）:
   - `u < pDp`（既存 `gdp.base − speed×gdp.speedW`、clamp 現行）→ **併殺**: R1 アウト（outsAdded++）＋打者アウト。gdp++/dpTurned++。`ctx.gbDp = true`。
     残走者（outsBefore+2 < 3 のときのみ）: R3 は**確定生還**・R2 は**確定三進**（時間プレー: 0死満塁の6-4-3で1点は現実準拠）。
   - `u < pDp + run.gbForceFc` → **FC（二塁封殺のみ）**: R1 アウト（outsAdded++）、**打者は一塁に生きる**（`bases[0]=batterId`、`ctx.fcBatterSafe=true`）。打者記録は現行の 'out'（ab のみ）と同じ＝追加処理不要。
     残走者: R3 → §2.3 の resolveAdv('gbAdv3h')、R2 → 確定三進（封殺が二塁で成立した時点で三塁へは投げない）。
   - それ以外 → **進塁打**: 打者アウト（一塁送球）。R1 → 確定二進。R2 → R3 が空けば確定三進（連鎖）。R3 → §2.3。
3. DP/FC 後に `outs + outsAdded >= 3` なら以降の走者処理はスキップ（イニング終了・後続の得点なし）。

`outsBefore < 2` かつ **走者一塁なし**:
- 打者アウト（一塁送球）。R3 → §2.3。R2 → 三塁が空いていれば resolveAdv('gbAdv2t3')。R1 不在なので他は無し。

### 2.3 三塁走者のゴロゴー（scenario 'gbAdv3h'）

`resolveAdv(pid, run.gbScore3, ctx, cfg, rng, 'gbAdv3h')` を流用する。3状態:
- TAKEN → runs++・R3 消滅（「ショートゴロの間に1点」）
- HOLD → 自重（三塁に残る）
- OUT → 本塁憤死: R3 消滅・`ctx.outsAdded++`。※ resolveAdv の kill 判定は外野手(def)前提なので、**ゴロでは def=null**（内野処理）。kill 経路を通すため、resolveAdv に「def なしでも killed 判定を行う」分岐を追加する: def なし時は `pKill = run.gbKillBase`（肩補正なし）・armOpp/armKill は計上しない（外野の指標を汚さない）。outsOnBase は計上する（§7）。
- 2死→ resolveAdv 冒頭の outs ガード（§5）で自動的に HOLD（ゴロ3アウト目=一塁送球でどのみち無得点）。

## 3. B. 空中アウトのタッグアップ深さ依存化

現行 game.mjs:72-88 を置換。`ctx.battedBall`（caller から bb を渡す。追加）と既存の `ctx.def`（拾う外野手・肩。caller は現行 `result==='out' && isAirOut` で構築済み）を使う。

- `bb.distanceM < run.tagMinDistM`（内野フライ/浅い飛球）→ **全走者自重**。犠飛なし。※これで「キャッチャーフライで犠飛」が根絶される。
- `bb.distanceM >= run.tagMinDistM` かつ outsBefore < 2:
  1. **R3 の本塁タッグアップ**: 基準確率 `p = clamp(run.sfBase + run.sfDistW × (bb.distanceM − run.sfPivotM), 0.05, 0.95)` を `resolveAdv(pid, p, ctx, cfg, rng, 'tag3h')` へ。
     - TAKEN → runs++・**`ctx.sacFly = true`**（犠飛認定の唯一の情報源。§7）
     - HOLD → 自重（犠飛なし・現実の「浅くて還れず」）
     - OUT → 本塁憤死（outsAdded++・外野の armKill/補殺は resolveAdv 内の既存経路で付く）
  2. **R2 の三塁タッグアップ**: 現行 tagBase 機構を維持しつつ深さゲートを共有（distanceM 条件は同じ）。scenario 'tag' のまま。三塁が空いている場合のみ（R3 が生還/憤死で空いた後も可・現行どおり）。
- 走者一塁のタッグアップは実装しない。

resolveAdv の baseProb は呼び出し側で深さ補正済みの値を渡す（resolveAdv 内部は現行どおり speed/IQ/肩補正を加算）。

## 4. C. 失策(E)時の進塁

現行の「BB/HBP と同じ押し出し」(game.mjs:52-68) から分離し、E 専用分岐にする。caller から `ctx.errorFielderPos = r.fielderPos` を渡す（E はインプレーのアウトを変換して発生するため必ず存在する）。

- **外野失策**（`IS_OUTFIELD.has(errorFielderPos)`）→ **単打相当の進塁**: 既存 '1B' 分岐と同じロジックを打者=E で実行（R3 確定生還・R2 は singleScore2 で生還判定・R1 は singleScore1to3 で三進判定・打者一塁）。RBI が付かないのは現行の `result !== 'E'` ガードで担保済み（変更不要）。
- **内野失策** → 進塁打相当: 全フォース走者は連鎖で1個進む（現行の押し出しロジック）＋ **R3 は resolveAdv('gbAdv3h')**（お手玉でも三塁走者はしばしば還る）。非フォースの R2（一塁空き）は現状維持（進まない）。

## 5. D. アウトカウント依存＋2死の走塁死解禁（resolveAdv の改修）

`resolveAdv` に以下を追加:
1. **冒頭ガード**: `ctx && ctx.outs + ctx.outsAdded >= 3` → 乱数を消費せず ADV_HOLD を返す（プレー死後の進塁禁止）。
2. **2死ボーナス**: `p = clamp(baseProb + (tool−50)×ubrSlope − armSup + (ctx.outs === 2 ? cfg.tuning.run.adv2OutBonus : 0), 0.05, 0.95)`（2死は打球と同時スタート＝進塁率上昇）。
3. **canKill の緩和**: `ctx.outs + ctx.outsAdded < 2` → **`< 3`** に変更。3アウト目の走塁死（本塁突入死など）を許可する。
   - 正当性（時間プレー）: advanceRunners は先頭走者から順に解決し、runs は解決済みぶんだけ数える。先に数えた得点は「アウトより先に本塁を踏んだ」＝公認野球規則の時間プレーと同義で正しい。フォースアウトの3アウト目（得点取り消しが必要なケース）は resolveAdv の kill では発生しない（kill は常にタッグプレー）。**この理由を resolveAdv のコメントに書き残すこと**（旧コメント「順序が壊れるため2死では刺さない」を置換）。
4. def なし kill（§2.3）: `pKill = def ? clamp(armKillBase + (arm−50)×armKillSlope, 0, armKillMax) : run.gbKillBase`。def なし時は armOpp/armAdv/armKill を触らない。

`singleScore1to3` は 0.10 → **0.26** に引き上げ（文献帯25-40%の下端。2死ボーナス込みで~0.44）。`singleScore2`/`doubleScore1` は較正で再調整（§8）。

## 6. E. 塁打決定の守備隊形依存化（battedBallResult.mjs）

`decideBases(bb, type, cfg, rng)` を `decideBases(bb, type, cfg, rng)`のまま内部刷新（bb には computeGeometry 済みの landingX/landingY/distanceM がある）。**`expectedBases` を必ず同一分岐の確率版として同時に書き換える**（§1-5）。

### 6.1 空中安打（LD/FB/PU が落ちた場合）

`fielderPositions(cfg)`（fieldingGeometry からエクスポート済み）から外野3人の座標を取得し:
- `dNear` = 落下点から最寄り外野手までの距離
- `beyond` = `Math.hypot(landingX, landingY) − 最寄り外野手の r`（正=外野手より深い）

分岐（上から評価・排他）:
1. `bb.distanceM < bb2.frontSingleMaxM`（≈内野を越えた直後の前落ち帯下限）→ 単打（現行 gapDistM 手前と同じ）。
2. **前落ち単打帯**: `beyond <= 0 && dNear <= run2b.frontDropRadiusM` → **単打**（外野手の目の前/手前のポトリ。発端の穴の修正）。
3. **頭上/後方の抜け**: `beyond > 0` → 二塁打ベース。`dNear` が小さいほど「追いつかれて単打止まり」があるため `pStay1 = clamp(run2b.behindStay1Base − run2b.behindStay1DistW × dNear, 0, 0.5)` で単打へ格下げ判定（外野手の脇をかすめた打球は追いつける）。
4. **ギャップ/ライン際**（`beyond <= 0` だが `dNear > frontDropRadiusM`）→ 転がる余地がある: `p2B = expit((dNear − run2b.gapPivotM) / run2b.gapWidthM)` で 2B、外れたら単打。
5. 三塁打: 現行条件（`distanceM >= tripleDistM && |spray| > 18`）を「2B と判定された打球」に対して現行式のまま適用（変更なし）。

### 6.2 ゴロ安打（内野を抜けた打球）

現行 `|spray|>38 × 20%` を置換:
- `pCorner = expit((|bb.sprayDeg| − run2b.gbLinePivotDeg) / run2b.gbLineWidthDeg) × clamp(run2b.gbEvBase + run2b.gbEvW × (bb.evKmh − 140), 0.2, 1)` → 二塁打（ライン際×強い打球ほどコーナーまで転がる）。
- 二塁打になったゴロのうち `|spray| > 40` かつ走者 speed 上位: `pTriple = clamp(run2b.gbTripleBase + (speed−50) × g.tripleSpeedW, 0, 0.10)` で三塁打（NPBの年数本水準。gbTripleBase ≈ 0.03）。
- それ以外 → 単打。

### 6.3 注意

- rng 消費: 分岐によって消費回数が変わってよいが、`expectedBases`（乱数非消費）と分岐条件を**文字通り同じ式**にすること。実装後、リーグ集計で `Σ(xB1,xB2,xB3)` と実塁打分布の一致を較正 `xwobaGap` で確認。
- HR帯（フェンス越え非HR）は**本ユニットのスコープ外**（audit §2 の別項目）。`decideBases` に fence を持ち込まない。
- 発端ケースの回帰テストを追加: EV165/LA10/spray0（落下 82.5m・CF手前 15.5m）→ 落ちたら**必ず単打**。

## 7. F. 記録整合

1. **犠飛**: game.mjs:720 の `isAirOut && runs > 0` を **`ctx.sacFly === true`** に置換（B で設定）。wpRuns 混入による偽犠飛が消える。スプリット計上(768行 `sacFly`)も同じフラグを使う。
2. **観戦UI**: pa イベント(game.mjs:804-832)に `sacFly: ctx.sacFly === true` と `fc: ctx.fcBatterSafe === true` を追加。`src/ui/watch.mjs` の `watchBattingDelta`(113行) の犠飛再導出 `e.result==='out' && e.runsOnPlay>0 && …` を **`e.sacFly` 直読み**に置換（再現ロジックの重複を解消）。boxscore.mjs にも SF/FC を再導出している箇所がないか grep して同様に統一。
3. **outsOnBase 配線**（既知の死にフィールド解消）: resolveAdv が ADV_OUT を返す**すべて**の経路で `bs.outsOnBase++`（盗塁死 cs は含めない=定義どおり）。
4. **バント失敗の封殺条件**(game.mjs:1049-1061): フォースが存在する時（R1 あり）のみ先頭走者封殺。**R2 単独ではフォース不成立**→ 失敗時は「打者アウト・R2 は現状維持」に変更（dab=1 は維持）。
5. **RBI**: 現行ロジック（E と gbDp は打点なし、それ以外は advRuns）で新分岐too正しい（FC/進塁打/犠飛の得点に打点が付き、併殺間の得点に付かない=公式準拠）。変更不要だが、テストで固定する。
6. **統計シナリオ配線**: 新 scenario `gbAdv3h` / `gbAdv2t3` / `tag3h` を追加する箇所（`grep -rn "adv1t3b" src test` で全列挙）:
   - `src/model/statline.mjs`: `${scenario}Opp/${scenario}Taken` フィールド追加
   - `src/sim/leagueConstants.mjs:147` scenarioTotals に追加
   - `src/sim/metrics.mjs` ubr 合算に追加。run重みは config `tuning.run` に新設: `runGbAdv3h`（≈0.45: 3塁→本塁 on out の RE 価値近似）、`runGbAdv2t3`（≈0.20）、`runTag3h`（≈0.45）。リーグΣ=0 の中心化は既存 ubrScenario 機構がそのまま効く。
   - UZR/ARM: 'tag3h' の kill は既存 armKill 経路（外野の補殺・ARM run に自然に入る）。'gbAdv3h' の kill は外野非関与（§2.3）。

## 8. config 追加ノブ（すべて `tuning` 配下・初期値は出発点＝較正で動かす）

```js
run: {
  // 既存: runSB, runCS, ubrSlope, runUBR, ...
  gbScore3: 0.55,      // 三塁走者がゴロアウトの間に生還する基準確率（<2死・非DP）
  gbAdv2t3: 0.35,      // 二塁走者がゴロアウトで三進する基準確率（三塁空き）
  gbForceFc: 0.30,     // R1ありゴロで「二塁封殺のみ（打者セーフ=FC）」になる確率（DPと排他）
  gbKillBase: 0.12,    // ゴロゴーの本塁憤死確率（内野処理・肩補正なし）
  adv2OutBonus: 0.18,  // 2死時の追加進塁ボーナス（打球と同時スタート）
  tagMinDistM: 58,     // タッグアップ試行に必要な最低飛距離（内野フライ犠飛の門番）
  sfBase: 0.62,        // 犠飛タッグアップ基準確率（sfPivotM 地点）
  sfPivotM: 85,        // 〃 の基準飛距離
  sfDistW: 0.012,      // 飛距離1mあたりの生還確率増分
  runGbAdv3h: 0.45, runGbAdv2t3: 0.20, runTag3h: 0.45, // UBR新シナリオのrun重み
  // singleScore1to3: 0.10 → 0.26 へ変更（§5）
},
run2b: { // 塁打決定の守備隊形依存化（§6）
  frontDropRadiusM: 15, // 外野手の目の前ポトリ=単打とみなす半径
  behindStay1Base: 0.35, behindStay1DistW: 0.03, // 頭上を抜けたが至近→単打止まりの確率
  gapPivotM: 14, gapWidthM: 5,                    // ギャップ球の2B化ロジスティック
  gbLinePivotDeg: 40, gbLineWidthDeg: 3,          // ゴロのライン際2B
  gbEvBase: 0.55, gbEvW: 0.012,                   // ゴロ2BのEV依存
  gbTripleBase: 0.03,                             // ゴロ3Bの基準確率（ライン際×俊足のみ）
},
```
`bb.gapDistM` は §6.1-1 の `bb2.frontSingleMaxM` として意味を引き継ぐ（名称変更 or コメント更新。76.0 のままで可）。

## 9. 実装手順（この順で。各段階で `npm test`）

1. **F-3/F-4（outsOnBase・バント封殺）** — 小さく独立。テスト追加。
2. **D（resolveAdv 改修）** — ガード・2死ボーナス・canKill<3・defなしkill。単体テスト（下記）。
3. **B（タッグアップ深さ依存）＋F-1/F-2（犠飛認定・イベント/watch整合）** — 内野フライ犠飛の根絶を確認。
4. **A（ゴロ進塁＋DP移設）＋C（E進塁）** — caller の DP ブロック削除、ctx 拡張。恒等式テスト。
5. **E（decideBases/expectedBases）** — 発端ケースの回帰テスト。
6. **再較正（§10）** → `npm run verify` → `npm run smoke` → progress.md 更新 → コミット。

既存テストの修正が必要な箇所（把握済み）:
- `test/season.test.mjs` の advanceRunners テスト群（ctx なし呼び出し=凍結フォールバックで大半は生きる。'out' 系の期待値だけ新仕様に合わせて追記）
- `test/fielding.test.mjs:147,175`（ARM/UBR系: 2死ボーナス・canKill変更の影響を確認）
- `test/game.test.mjs` の恒等式群は**無修正で通ること**（通らなければ配線バグ）

新規テスト（最低限）:
- 浅い飛球（distanceM<tagMinDistM）で R3 が絶対に還らない/犠飛が付かない
- 深い飛球で TAKEN→SF・HOLD→SFなし・OUT→outsAdded/armKill/outsOnBase が付く
- 打席中WP得点+外野フライで **SF が付かない**（偽犠飛の回帰）
- 1死三塁ゴロ: TAKEN で得点＋RBI、OUT で outsAdded、2死ゴロで無得点
- 0死満塁 DP で1点（時間プレー）／1死満塁 DP（3アウト目フォース）は advanceRunners に入る前に outsBefore+2>=3 で無得点になること
- FC: 打者が一塁に生き、outs は1増、PA恒等式維持
- 外野E で R3 生還・内野E でフォース+R3判定
- 2死1,2塁単打: R2 生還が数えられた後に R1 が三塁憤死（3アウト目）でも得点が残る（時間プレー）
- 発端ケース: EV165/LA10/spray0 の落球 → 単打（§6.3）
- expectedBases と decideBases の分岐一致（モンテカルロで xB 分布 ≈ 実分布、許容誤差付き）

## 10. 再較正（このユニットの完了条件）

動く方向の予想: SF/球団**減**（内野フライ犠飛消滅）だがゴロゴー得点で R/G は**増**方向、前落ち2B→1B化で SLG/2B **減**、走塁死増で若干の得点抑制。相殺の残差を以下の順でノブ調整:
1. まず本仕様の新ノブ（gbScore3/sfBase/tagMinDistM/frontDropRadiusM/gapPivotM）で野球的な妥当域に収める
2. 残差を既存の得点環境ノブ（singleScore2/doubleScore1 等）で吸収
3. 全体水準の最終残差のみ bb 系（evBase等）に触れる（最後の手段）

`npm run calibrate` 53指標 12seed PASS が完了条件。**2B/球団・3B/球団・SF相当・R/G・AVG/OBP/SLG・xwobaGap・セパ得点差・WAR王帯**を特に監視。1年目シム不変の鉄則（CLAUDE.md 鉄則7）は本ユニットで意図的にベースラインを更新する＝progress.md にその旨を明記すること。

## 11. 落とし穴（実装前に読むこと）

- `PA_RESULT` は再利用構造体（plateAppearance）。ctx に新フィールドを足す時は**毎打席で必ずリセット**（sacFly/fcBatterSafe/gbDp を advanceRunners 冒頭 or caller の ubrCtx 生成時に初期化）。
- `ctx.outs` は advanceRunners 冒頭で代入される（打者アウト計上**前**の値）。ゴロ分岐の「打者アウト後のアウト数」は `ctx.outs + 1 + ctx.outsAdded` で数える（criteria を outsBefore で書くか outsAfter で書くか混同しない）。
- caller の `recordBattedBallStat`（ab計上）は advanceRunners より**前**に走る。FC でも打者は ab のみ＝追加処理不要（安打にしない）。
- 観戦UI（watch.mjs）は game.mjs の計上ロジックを**複製**している箇所がある（watchBattingDelta / watchFieldingDelta）。F-2 のイベントフィールド直読み化を必ずやる。`npm run smoke` で描画確認。
- `advanceOnWildPitch`（plateAppearance）はスコープ外。触らない。
- 走者が投手（DH無し）の場合も resolveAdv は byId で trueAbility を引く（現行から同じ）。null ガード不要（塁上に居る=byId に居る）。
- コミットメッセージは `fix(baserunning): ...` 系。ローカルのみ・push しない。

## 12. Done の定義

- [ ] §9 の全段階完了・新規テスト green・既存恒等式テスト無修正で green
- [ ] `npm test` / `npm run verify` / `npm run smoke` / `npm run calibrate`（12seed PASS）
- [ ] 発端ケース（CF手前ポトリ）が単打になり、内野フライ犠飛が0件になることをシーズンシムで確認
- [ ] progress.md にエントリ追加（動いた較正指標と最終ノブ値を記録）・コミット

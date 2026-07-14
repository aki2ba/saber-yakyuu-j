# phaseH_fun_spec — 「ゲームとしての面白さ」5本柱の実装仕様（R8）

> 正典: `thyroxin/research/fun_design_evidence.md`（実例調査と設計根拠）。本書は実装仕様。
> 実装は H1→H2→H3→H4→H5A→H5B→H5C の順に**1本ずつ**（共有ファイル config/news/ui の競合回避）。
> 各柱の完了条件: npm test → calibrate → realism 全PASS ＋ 柱ごとの新規テスト ＋ progress.md更新＋コミット。

## 全柱共通の鉄則
1. 介入は必ずログ経由（`interventions`/`marketInterventions`/新設ログ）→ save/load replay で決定論再現
2. 乱数は階層シード。生成ストリームを乱さない（durability の独立シード方式が前例）
3. 1年目レギュラーシーズンのシムは不変（較正53指標非干渉）。多年要素はオフシーズン遷移のみ
4. 真値に「勝負強さ」等を持たせない。評判・ラベルは観測から湧かせる（三層構造）
5. 成長への介入は**期待値保存**（分布の形だけ傾ける）。恒久シフト禁止（R7の教訓）
6. save は additive field＋読み込み時デフォルト補完（旧セーブ互換）。調整ノブは config.tuning のみ

---

## H1: ストーリーライン（連続ニュース・ライバル・引退ロード）【表示層のみ・エンジン非干渉】

新モジュール `src/game/storylines.mjs`（ヘッドレス純関数群）＋ ui のニュースタブ/選手モーダル拡張。

### H1-1 レース追跡（シーズン中・オンデマンド計算・永続なし)
- `titleRaces(state)`: 当季 careerStats から打率/HR/打点/盗塁/ERA/勝利/S/K の各リーグ上位3
  （規定換算は消化試合比例）。首位と2位の差が僅差(config閾値)なら「激戦」フラグ
- `rookieRace(state)`: 当季新人（debut年=当年）のWAR近似上位（観測ベース: wOBA×PA / FIP×IP）
- `recordPaces(state)`: leagueRecords（既存 awards.mjs）と当季ペース比較。シーズン記録の
  105%超ペース＋消化50%以上で「記録ペース」ニュース
- ニュースタブに「今週の見どころ」節: weeklyDigest（既存）へ statements を合流

### H1-2 ライバル・因縁（transactionLog 新設）
- `state.transactionLog` 新設（additive・デフォルト[]）: advanceYear で off の
  fa/trades/pickups/draftLog.picks を**コンパクト行**（year, kind, playerId(s), from, to, round?）で追記
- `rivalriesOf(state, playerId)`: 同年同round指名 / トレード相手 / FA・戦力外の旧所属
- 対戦時ニュース: 日次進行時、当日カードに「因縁」該当選手がいて活躍(notable)したら
  見出しを差し替え（「古巣に牙をむく」等）。news.mjs の headline 生成に hook を追加
- 決定論: 表示文言の選択は hashSeed(masterSeed,'story',year,day,playerId) の rng

### H1-3 引退ロード
- シーズン開幕時: age>=config閾値(37) かつ 通算マイルストーン持ちの選手を「引退ロード候補」
  としてニュース（「今季が集大成か」）。※引退判定そのものは触らない（roster.mjs 不変）
- 引退確定時（off.retirees）: 功労者（通算PA/IP/受賞数が config 閾値超）は
  ダイジェストに「引退セレモニー」節: 通算成績・受賞歴・二つ名・在籍球団を1枚のカードで表示
- 自チーム功労者の引退は個別ニュース化

### config: `tuning.storylines`（閾値一式）。テスト: 決定論（同一シードで同一ニュース列）・
transactionLog の replay 一致・引退カードが集計値と一致

---

## H2: プレイヤー参加型ドラフト会議

### 設計方針
- advanceYear のオフ処理を2段階に分割: **stage1**（引退→淘汰→FA→トレード→窓→pool生成→AI指名計算）
  → プレイヤー球団の指名番で**中断**し `state.awaitingDraft` を返す → UI（`src/ui/draft.mjs`
  ドラフト会議室）→ `submitDraftPick(state, prospectId)` → 解決（競合はくじ・負けたら再指名要求）
  → 全round完了で **stage2**（育成獲得→拾い上げ→契約更改→加齢…）を続行
- 介入は `marketInterventions` に `{phase:'draft', yearIndex, round, prospectId}` を積む。
  **load-replay は非対話**: runDraft がログを参照して同一結果を再構築（bidFA と同型）
- ドラフト中の save: awaitingDraft 状態も save 可（stage・積んだ介入を保存。pool は
  シードから決定論再生成なので保存不要）
- `cfg.game.interactiveDraft`（default true）。false なら従来の全自動

### スカウトレポート（真値は絶対に見せない）
`draftScoutView(state, prospect)`: 自球団 profile での evaluateProspect（ノイズ込み）を
- 総合等級 S/A/B/C/D（poolの分位点で相対化）
- ツール別 5段階（打撃/パワー/走力/守備/肩 or 球速/制球/スタミナ/球種）= obsTool 値の離散化
- 伸びしろ見立て: (peakAge−age) ベース3段階＋スカウトノイズ（「大器」「並」「完成品」）
- 経歴タグ（高卒/大卒/社会人）・世代内評判（全球団平均評価の分位＝「目玉」「隠し玉」）
に変換。ドラフト前週にニュース「今年の目玉」（世代トップ数名を報道）

### テスト: 介入ログからの replay 一致・非対話モード後方互換（既存テストが全autoで通る）・
競合くじ敗退→再指名の状態遷移・70人枠等の不変量維持

---

## H3: 性格タグ＋観測ベース評判ラベル

### H3-1 性格（真値側・小さな効果）
- `p.personality` 新設: 8種（練習熱心/ムラっ気/お調子者/寡黙/闘志/クール/マイペース/リーダー）
- 付与: 独立シード `makeRng(hashSeed(id,'personality'))`（生成ストリーム不変・全選手、既存
  セーブは load 時に同式で補完＝決定論だから後付け可能）
- 効果（config `tuning.personality`・すべて小さく、**効果はオフシーズン処理限定**）:
  - ムラっ気: aging の drift SD ×1.25 ／ 練習熱心: H4方針の効き×1.3 ／
    お調子者: breakout 上方確率+20%・下方+20%（分散だけ増）／ 寡黙系: 変化なし 等
  - 期待値を動かす効果は入れない（インフレ禁止）。1年目シム非干渉
- 表示: 選手モーダル・スカウトレポート（H2）・ニュース文体フレーバー

### H3-2 評判ラベル（観測から湧く・表示層のみ）
- awards.mjs の二つ名を拡張: 「メディア評」節を新設
  - 勝負師/劇場型: 通算 Clutch・WPA・RISP成績の観測が閾値超（真値には該当能力なし＝
    セイバー的に正しい「物語と実力のズレ」がそのままコンテンツ）
  - ブレーキ（併殺多+RISP低）/ ガラスの体（故障日数）/ 鉄人（連続試合）/ 火消し・敗戦処理 等
- 閾値は `tuning.awards.reputation`。UI: 選手モーダルのヘッダ付近にタグ表示

### テスト: 性格分布の決定論・多年ドリフト帯不変（gm 分散変更の影響確認）・ラベルが集計値と整合

---

## H4: 育成方針・キャンプ（期待値保存の間接介入）

- `state.trainingPolicies` ログ新設: `{yearIndex, playerId, policy}`。
  policy = `batting|defense|speed|convert:<POS>|rest|balanced(default)`
- UI: ストーブリーグに「秋季キャンプ」節。自チーム選手に方針設定＋**特別指導枠**（config K=3人、
  効果2倍）。AI球団は teamEvalProfile 由来の癖で決定論的に自動設定（リーグ対称性＝較正保護）
- エンジン: `applyAging(players, cfg, {seed, policies})`:
  - 方針は**軸別の成長係数配分を傾けるだけ**: 対象軸グループの curveDelta成長分に (1+δ)、
    非対象グループに (1−δ·w)。w は「グループ間の期待成長量が相殺される」よう軸数と grow で
    正規化（**個体レベルで期待値総和を保存**）。δ=`tuning.training.tiltStrength`(0.15)
  - convert: 対象POSの positionProf 成長へ振替（primaryPos変更はしない。実出場は既存の
    positionProf ベース選抜が自然に追随）
  - rest: drift SD を下げ decline を僅かに緩める代わり成長も減（怪我ハザードへ小さい低減を
    injury.mjs 側 config で接続可・任意）
- フィードバック: オフのダイジェストに「キャンプの成果」節（特別指導選手の観測等級の前後差＋
  ニュース文。結果は乱数次第＝お祈り）
- **ゲート必須**: test/game_multiyear（多年ERA/SLG帯）と calibrate が無調整で PASS すること。
  傾き実装は R7 の失敗（youthDebt 導入経緯）を必ず読んでから着手

### テスト: 期待値保存（大標本で方針別の平均総成長が同等）・ログreplay一致・AI球団の方針決定論

---

## H5: 経営レイヤー（段階導入 A→B→C）

### H5-A 年俸予算（意思決定の重み）
- `team.finance` 新設: `{budget, payroll}`。budget は生成時に球団プロファイルから決定論付与
  （財力差 config 帯）＋毎年見直し（H5-Cまでは固定帯）
- 既存 `runContractRenewal` の salary を実弾化: FA入札は「salary提示が下限を超えかつ予算内」
  が成立条件に追加。トレードは salary 差が config 許容内。予算超過球団は更改時に高salary
  非プロテクト選手を放出候補へ（戦力外ルートに合流）
- プレイヤーUI: ストーブに payroll バー＋各操作の費用表示。AIも同制約（対称）
- ゲート: 市場成立件数（FA/トレード/拾い上げ）が現状帯から激減しないこと（realismにWATCH追加）

### H5-B オーナー目標・信任
- 開幕時（yearIndex>=1）: オーナー目標1〜2件を決定論生成。**teamWindowState と整合**
  （contending: Aクラス/優勝、rebuilding: 若手PA/育成昇格、neutral: 勝率.480+等。
  payroll超過中なら「圧縮」目標）＋優先度。テンプレは config
- 期末評価 → `state.ownerTrust`（0-100）を加減。閾値割れで**解任イベント**:
  最下位圏の他球団からのオファー提示（受諾で playerTeamId 移籍＝失敗の許容・再起）or 辞退で
  ゲーム継続不可…ではなく「留任嘆願（trust小回復・1回限り）」も用意。`cfg.game.allowFiring`
  で無効化可（サンドボックス派向け）
- 個別メッセージUI: ニュースタブに「フロントからの手紙」節（H1の枠を再利用）

### H5-C ファン・収入の閉ループ
- `team.finance.fanInterest`（0-1）: 毎オフ「勝率分位への緩やかな回帰＋イベント修正値
  （優勝/日本一+、スター獲得+、人気選手放出−。翌年へ指数減衰）」= OOTP実挙動パターン
- 選手人気: 観測（通算成績・受賞・二つ名・在籍年数）から導出（表示兼 fanInterest 入力）
- 収入 = 市場規模(球団固有)×fanInterest → 翌年 budget へ。人気選手の放出はファンが怒る
  （編成判断に「強さ vs 人気」の葛藤）
- ゲート: 多年で budget が発散/枯渇しない（有界性テスト）・優勝球団と最下位球団の budget 比が
  config 帯内（戦力集中の暴走防止）

---

## 委任メモ（sonnet への切り出し方）
- 1柱=1エージェント=1コミット。本 spec の該当節＋fun_design_evidence.md §4該当柱＋
  CLAUDE.md を読ませ、ゲート（npm test/calibrate/realism/verify/smoke）を自走させる
- H2 の stage分割と H5-B の解任フローだけは設計判断が濃い→実装前に差分設計を親でレビュー
- UI 文言・ニューステンプレ・閾値の初期値は sonnet の裁量でよい（config に置くこと）

# CLAUDE.md — saber-yakyuu-j

架空選手プロ野球チーム育成シミュレーションゲーム（セイバーメトリクス完全準拠 / 12球団2リーグ / 一球ごとシミュレーション / Web+Capacitor 想定）。

## 正典・目的関数（必ず最初に読む）
- **`thyroxin/requirements/req_2.md`** — 三原則（開発の最上位目的関数）:
  ①セイバー指標の網羅（一球・一プレー粒度で副産物として算出） ②現状のセパ両リーグ近似（完全架空・起用/采配の妥当性・WAR-6根絶） ③やきゅつく的な楽しさ
- **`thyroxin/requirements/req_1.md`** — 設計思想（三層構造・EV/LA打球モデル・能力別加齢・市場非効率を仕込む等）
- **`thyroxin/progress.md`** — 自走開発ジャーナル（新しいものが上）。**作業前に必ず読む**
- **`thyroxin/specs/phase{A..G}_spec.md`** — 各フェーズの実装仕様（G=UI再ゾーニング。着手前に `f4_review_fixes_spec.md` が前提）

## 状態: フェーズA〜D完成（三原則すべて達成）
- **A**: 12球団2リーグ交流戦/CS/日本シリーズ・起用AI(観測成績＋スカウトノイズ)・監督采配(犠打/敬遠/盗塁/代打代走守備固め/レバレッジ継投/連投制限/中6日)・WAR-6根絶
- **B**: 一球ごとカウント状態機械・全セイバー指標(xwOBA/Barrel/SIERA/xFIP/RE24/WPA/LI/Clutch/UZR成分/O-Swing/CSW等)
- **C**: ゲームシェル(自チーム選択/シーズンプレイ/采配介入/観戦)・多年キャリア(加齢/成長/故障/ブレイク/引退)・市場(ドラフト/FA/トレード/戦力外拾い上げ/球団AI評価の球団差)・演出(表彰/ニュース/記録/二つ名)
- **D**: 打球モデル仕上げ(HR分布安定化)・パークファクター・時代トレンド/王朝均衡・レバレッジ駆動継投
- **残**: D5=全国対戦(BaaS)・Capacitor化(iOS/Android)＝プラットフォーム展開（後から乗せる）

## コマンド
```bash
npm test              # node --test（281テスト）。構造・不変量・決定論を検証
npm run verify        # build.mjs + verify-identity.mjs（Node↔ブラウザ同一性=決定論）
npm run smoke         # build.mjs + smoke-ui.mjs（UI/ゲームシェルのヘッドレス描画検証）
npm run calibrate     # 12seed平均でNPB目標帯とPASS/FAIL機械判定（53指標）
npm run realism       # リアリズム恒常ゲート（打球イベント単位の現実不変量＋NPB公開値との帯比較。
                      #   GATE=修正済みの穴の再発防止 / WATCH=audit既知の未修正穴の観測。修正したらGATE昇格）
npm run build         # dist/pennant.html（全モジュールをインライン化した自己完結HTML）
```
**変更後は必ず `npm test` → `npm run calibrate` を通す**（コミット条件）。シム挙動（打球・走塁・守備・采配）に触れた場合は `npm run realism` も通すこと。

## アーキテクチャ
```
src/
  engine.mjs            エンジンの公開API集約（UIがグローバル参照する窓口）
  config.mjs            全較正ノブ(tuning)＋NPB目標帯(CALIBRATION_TARGETS)。★調整はここだけ
  rng.mjs              階層シードRNG(決定論・順序非依存)
  generate.mjs          架空選手/球団/リーグ生成(リーグ攻撃力均衡化・監督プロファイル)
  model/               player/statline/positions/battedball(球場)/util の型定義
  sim/                 シミュレーション本体
    plateAppearance.mjs  一球カウント状態機械(K/BB/HBPが創発)
    battedBall*.mjs      EV/LA/方向生成→球場ジオメトリ→HR/安打/アウト
    game.mjs            9回状態機械・ベンチ/采配/継投・記録
    manager.mjs         監督ポリシー(采配判断・人間差し替えフック)
    usage.mjs           日次スタメンAI・起用見直し・疲労管理(観測成績ベース)
    season.mjs          日程v2・シーズン実行・順位表・context 2パス
    postseason.mjs       CS→日本シリーズ
    metrics/war/leagueConstants/context/fielding … 指標算出(生カウントから創発)
  game/                ゲーム層(ヘッドレスAPI・UI非依存)
    index.mjs           newGame/advanceDay/advanceTo/advanceYear/save/load
    season_runtime.mjs   日次分割駆動(season.mjsを分割実行)
    aging/breakout/injury/roster/market/transactions/awards/news
  ui.mjs               ブラウザUI(成績ビュー＋ゲームシェル)。document使用
tools/                 build/verify-identity/smoke-ui/calibrate
test/                 node --test（31ファイル）
dist/pennant.html      配布物(自己完結HTML・build生成物)
```

## 鉄則（req_1/req_2の設計原則）
1. **決定論**: 乱数は階層シードrng経由のみ。`Date.now`/`Math.random` 禁止。同一シード=同一結果（`npm run verify`が門番）
2. **config集約**: 調整可能な定数は `src/config.mjs` の `tuning` のみ。マジックナンバーをコードに散らさない
3. **三層構造**: 真値(trueAbility)/観測成績(statline)/球団評価(スカウトノイズ)。シーズン中の起用AI・球団AI・UIは真値を直接見ない（UIは「コーチの見立て」=スカウト等級で表示）
4. **指標は後付けしない**: 一球・一プレーの副産物として生カウントから湧かせる（2パス集計でリーグ定数導出）
5. **市場の非効率を仕込む**: 球団AIをわざと現実的に間違わせる（守備/位置を過小評価）→宝拾い・復活が湧く
6. **エンジンとUIの分離**: ゲーム層は `src/game/`(ヘッドレス・テスト可能)。UIは表示に徹する
7. **1年目シム不変**: 加齢/時代トレンド等の多年要素は2年目以降のみ作用。較正53指標が動いたら副作用バグ
8. **生イベント非永続**(§17): 集計値のみ保存。生打球/一球ログは当該シーズンのみ
9. 采配・起用の判断は `manager.mjs`/`usage.mjs` に集約（フェーズCで人間采配に差し替えるフック）
10. 日本語コメント・req_1のセクション番号(§)参照スタイル・ESM(.mjs)

## 自走開発の運用（ultracode/automode）
- 三原則に従い自律継続。各作業は progress.md 更新＋git コミット（ローカルのみ・push しない）
- 大きな作業は Workflow で「実装→敵対的検証→修正→最終ゲート」構造。較正を壊さないことを毎回確認
- git はローカル自走の安全網（baseline acd7a55）。破壊的操作(大量削除/push/外部公開)はしない

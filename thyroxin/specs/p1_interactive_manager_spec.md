# P1仕様 — 試合中の人間采配（介入観戦）

> 根拠: thyroxin/research/fun_theory_research_20260720.md 統合診断P1（自律性・即時フィードバック・
> 失敗の自己帰属＝面白さの本丸。鉄則9「人間采配に差し替えるフック」の完成形）。
> **この仕様は実装担当モデル（Sonnet想定）がこの文書だけで作業を完遂できるよう書く。**
> 迷ったら本仕様の「決定」に従うこと。

## 0. 全体ルール（厳守）

1. **決定論**: 介入は「介入ログ」に積み、試合はシード＋ログから常に再シミュレートで再現する
   （H2参加型ドラフトの「プール毎回再生成replay」と同型）。`Date.now`/`Math.random` 禁止。
2. **headless不変**: `cfg.game.interactiveManager` を新設し**既定 false**。テスト/較正/realism/前史/
   AI球団は従来と byte 同一。`ui.mjs` の `uiConfig()` だけが true を渡す（interactiveDraft/allowFiring/
   dynamicLineup と同じ「headless既定OFF・UIのみON」第5例目）。
3. **介入点は既存フックのみ**: 判断ロジックの新設をしない。`manager.mjs` の既存判断
   （代打 `choosePinchHitter` / 継投 `chooseReliever`）の**呼び出し地点**に人間差し替えを挟むだけ。
   確率系（盗塁・バント）はP1の対象外（v2候補・チャット頻度が高すぎるため）。
4. **シム結果の不変性**: 介入ゼロ（全おまかせ）の試合は従来の全自動と **bit 同一**であること。
   これをテストで固定する。
5. 変更対象: `src/sim/game.mjs`（フック配線のみ・最小）・`src/game/index.mjs`（介入ログ運搬）・
   `src/ui.mjs` / `src/ui/watch.mjs`（UI）・`src/config.mjs`（フラグ）・`tools/smoke-ui.mjs`（検証追加）・
   `test/`（新テスト1ファイル）。engine の較正ノブ（tuning）は触らない。

## 1. データモデル

```js
// GameState（src/game/index.mjs）に additive:
state.gameInterventions = []; // [{ year, day, seq, kind: 'ph'|'relief', choice }]
//   year/day: 対象試合の座標（自チーム戦のみ）。seq: その試合内で「介入可能点」が訪れた通し番号。
//   choice: kind='ph'   → { pick: pid | null }（null=代打を出さない。おまかせはログに積まない）
//           kind='relief'→ { pick: pid | null }（null=続投）
```

- **「おまかせ」はログに積まない**＝ログ不在の介入点はAI（従来ロジック）が判断する。
  よってログ空＝完全従来挙動（ルール4の機械的保証）。
- save(): `gameInterventions` をそのまま保存（additive）。load(): 無ければ `[]`。

## 2. シム側フック（src/sim/game.mjs）

`simulateGame(homeInit, awayInit, cfg, rng, statFor, park, ?, opts)` の `opts` に additive:

```js
opts.managerIntervention = {
  teamId,            // 人間が采配する球団（自チーム）
  log,               // 上記ログのうち当該試合ぶん（seq昇順）
  onDecision(point), // ログに無い介入点に到達したときに呼ばれる。
                     // point = { seq, kind, situ, candidates }。
                     // 戻り値: choice（{pick}）… ただし P1 では**UIは同期選択できない**ため、
                     // 'PAUSE' センチネルを返すと simulateGame は例外 InterventionPause を投げて中断する。
};
```

実装方法（最小差分・2箇所）:
- **代打**: 現在 `choosePinchHitter(ctx, cfg)` を呼んでいる地点（grep で特定）で、
  攻撃側が `teamId` かつ `interactiveManager` 有効なら:
  1. `seq` をインクリメント（試合内カウンタ。介入可能点に到達するたび+1＝ログ照合キー）
  2. ログに `seq` があれば choice.pick を採用（`null`=出さない・pid=その選手。
     pid が候補外/出場不可なら**無効=AI判断へフォールバック**（決定論のため黙って続行））
  3. 無ければ `onDecision({seq, kind:'ph', situ, candidates})` → 'PAUSE' なら中断
  - `candidates` は AI が検討するベンチ候補一覧（choosePinchHitter 内部の候補集合を関数分離して共有）。
    situ は { inning, half, outs, bases(占有bool3), scoreDiff, batterId, onDeckId? } 程度の表示用要約。
- **継投**: `chooseReliever(...)` の呼び出し地点で同様に。candidates=可用ブルペン
  （bullpenAvailable の結果）。choice.pick=null は続投、pid は交代先。
- ⚠️ **乱数消費を変えない**: ログ採用/AI判断のどちらでも、その後に消費される乱数列は
  「選ばれた行動」にのみ依存する（既存コードの構造上、判断関数は乱数を消費しない/消費が
  行動に含まれることを確認して配線する）。判断が「AIと同じ選択」を返した場合、
  試合結果は全自動と bit 一致すること（テストで固定）。

介入可能点の**間引き**: 全打席で止まるとテンポが死ぬ（研究レポート: テンポ=生命線）。
- 代打: AI が「代打を検討する状況」（choosePinchHitter が非null候補を持つ場面）のみ
- 継投: 投手交代検討が発火する場面（現行 chooseReliever 呼び出し条件）のみ
つまり「AIなら判断していた場面」だけで止まる＝追加の判定ロジックを発明しない。

## 3. ゲーム層の再シミュレート再開（src/game/index.mjs）

観戦モードの試合開始は現在 `advanceTo(gs,'nextPlayerGame')` 経由（試合を丸ごとシムして record を返す）。
P1 では自チーム戦に限り:

```js
export function playInteractiveGame(state) {
  // 1) 当該試合の gameInterventions を抽出して opts.managerIntervention を組む
  // 2) simulateGame を実行。InterventionPause が投げられたら
  //    { paused: true, decision: point } を返す（state は一切書き換えない＝試合未確定）
  // 3) 最後まで走れば従来どおり試合結果を state へ確定（既存の試合確定処理を再利用）し
  //    { record } を返す
}
export function submitGameDecision(state, { year, day, seq, kind, choice }) {
  state.gameInterventions.push({ year, day, seq, kind, choice }); // 追記のみ
}
```

- **再開＝ログを1件増やして `playInteractiveGame` を最初から呼び直す**（決定論なので
  同じ経過を高速に辿り、次の未ログ介入点 or 試合終了まで進む）。プールreplayと同型。
- 途中でユーザーが観戦をやめた場合: 以後の介入点は全部AI（ログ不在=おまかせ）で完走して確定する。
- 非自チーム戦・ダイジェスト/スキップ選択時は従来経路（介入なし）。

## 4. UI（src/ui.mjs / src/ui/watch.mjs）

- 観戦開始オーバーレイ（観戦/ダイジェスト/スキップ）に「⚡介入観戦」を追加
  （既存3ボタンの文言は変えない＝smoke規約）。介入観戦を選ぶと `playInteractiveGame` 経路。
- `paused` が返ったら watch 画面に**采配モーダル**を表示:
  - ヘッダ: 「{inning}回{表/裏} {アウト}死 走者{一二三}　監督、指示を」
  - kind='ph': 打席の選手（成績付き）＋ベンチ候補一覧（当日成績/対左右）＋「そのまま打たせる」
  - kind='relief': 現投手（球数/失点）＋可用ブルペン一覧（役割タグ付き）＋「続投」
  - 「以後おまかせ」ボタン: 以降この試合は決定を求めない（UIローカルフラグ・ログには積まない）
  - 選択→ `submitGameDecision` → `playInteractiveGame` 再実行 → 観戦再生位置は
    **前回の停止点付近まで自動早送り**（events 配列は再シム結果で全置換されるため、
    停止時点の inning/half/打席数から idx を再計算して合わせる）
- 采配モーダル中の選択肢はクリックのみ（キー操作不要）。決定は取り消し不可
  （ログ＝歴史。やり直しはリセマラになるため提供しない）。

## 5. テスト（test/game_p1_interactive.test.mjs 新設）

1. **全おまかせ=従来と bit 同一**: interactiveManager:true でログ空のまま完走した試合が、
   フラグ false の従来シムと record（スコア・全playerSeasons集計）一致
2. **決定論**: 同じログで2回 `playInteractiveGame` → record が bit 一致
3. **中断→再開**: onDecision が PAUSE を返す設定で1回中断→ submitGameDecision（AIと異なる代打を
   選択）→ 再開で完走。選んだ選手が実際に打席に立つ（box の batters に現れる）
4. **無効choiceのフォールバック**: 存在しないpidを積んでもクラッシュせずAI判断で完走
5. save/load: gameInterventions が保存・復元される（additive・旧セーブは[]）

## 6. smoke（tools/smoke-ui.mjs）

観戦フローに追加: 「⚡介入観戦」ボタンで開始→采配モーダルが出たら先頭候補を選択（または
「そのまま」）→試合が完走してリザルトに到達、例外なし。モーダルが一度も出ない試合も正常
（介入点が無い試合はありうる）＝モーダル有無どちらでも通るアサーションにする。

## 7. 検証ゲート（コミット条件）

`npm test` → `npm run build` → `node tools/smoke-ui.mjs` → `npm run verify` → `npm run calibrate`。
フラグ既定OFFなので calibrate/realism は不変のはず＝**1指標でも動いたら配線ミス**（乱数消費が
変わっている）。即修正すること。

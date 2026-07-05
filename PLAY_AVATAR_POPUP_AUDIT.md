# プレイ時アイコンポップアップ追加メモ

## 追加内容

カードが場に出されたタイミングで、出したプレイヤーのアイコンを卓上にポップアップ表示する演出を追加しました。

- 場札の近くに、出した人のアイコンを吹き出し風に表示
- `〇〇 が出した！` の短いラベルを表示
- ポップ、拡大、フェードアウトのアニメーション付き
- PC / スマホ横向き / スマホ縦向きでサイズを自動調整
- 低高さスマホではラベルを非表示にしてカード視認性を優先
- `prefers-reduced-motion` ではアニメーションを抑制

## 実装概要

対象ファイル：`public/index.html`

追加した主な要素：

- `#playAvatarLayer`
- `.playAvatarPop`
- `.playAvatarFace`
- `.playAvatarTail`
- `.playAvatarLabel`
- `detectPlayedCardAnimation()`
- `showPlayedAvatar()`
- `avatarInnerHtml()`

## 判定方法

`renderTrick()` 内で現在の `state.trick` のカードID列を前回のID列と比較し、枚数が増えた場合に最後に追加されたカードを「直近で出されたカード」とみなして演出を出します。

これにより、サーバー側のルール処理には手を入れず、UI演出だけを安全に追加しています。

## 確認

- `server.js` 構文チェック OK
- `public/index.html` 内 JavaScript 構文チェック OK

- 2026-07-05: 出札時の吹き出し演出を改善。表示後すぐ消える挙動を廃止し、トリック中は場に残るよう変更。トリック解決で場札が流れるタイミングに合わせて exit アニメーションで消えるよう調整。

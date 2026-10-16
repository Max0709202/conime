# Postman による API 検証環境

本書 連携02。検収条件「Postman から基本 API の正常系・主要なエラー系を確認できること」をそのまま確認できる構成。

| ファイル | 内容 |
|---|---|
| `CONIME_Phase1.postman_collection.json` | コレクション（フォルダ 00〜07） |
| `local.postman_environment.json` | local 環境（`supabase start` の既定値） |
| `dev.postman_environment.json` | dev 環境（`<project-ref>` と anon key を置き換えて使う） |

## フォルダ構成

| フォルダ | 正常系 | 主なエラー系 |
|---|---|---|
| 00 Health | 活死確認 200 | — |
| 01 Auth | サインアップ・ログイン・トークン更新・ログアウト | 誤パスワード 400、登録済みメール 422、トークンなしで /me 401 |
| 02 Questions | 質問定義 200、ETag 一致で 304 | — |
| 03 Consent | 同意文書取得、同意登録 201、同意状況取得 | 存在しない文書 ID 400 |
| 04 Diagnosis | 送信 202、同キー再送 202（同一 ID）、状態・結果取得 | 未同意 403、必須未回答・選択数超過・文字数超過 400、旧版 409、二重送信 409、キー再利用 422 |
| 05 Character | 取得・名前変更・画像状態取得 | 診断前 404、文字数超過 400、キャラID変更の試行が無視される |
| 06 Mock APIs | 第2段階 API 26本の応答形式 | X-Mock-Scenario による 409・429・500・503（ほか 401 TOKEN_EXPIRED・空一覧） |
| 07 Security | — | 他人の submission_id 参照 404、anon key のみで会員 API 401 |

## 使い方

1. Postman でコレクションと環境ファイルをインポートし、環境を選ぶ（dev は `base_url`・`auth_url`・`anon_key` を設定）
2. コレクションの「Run」で上から順に実行する。「登録 → 同意 → 診断送信 → 結果取得」を通しで確認できる
3. 実行ごとに新しいユーザー（`postman-<実行ID>-a@conime.test` / `-b@`）を作るため、何度実行しても同じ結果になる

- 各リクエストに正常・異常を判定するテストスクリプトを付与している。あわせて、応答が `openapi/openapi.yaml` の定義と一致することを JSON Schema で検証する
- ログイン時のトークンは環境変数（`access_token_a` 等）へ自動保存する
- 「生成状態の取得」は completed になるまで同じリクエストを繰り返す（最大40回・1.5秒間隔）
- ユーザーA は全ての同意あり、ユーザーB は AI 送信同意なし（未同意 403・診断前 404・他人の参照 404 の確認用）

## コマンドラインでの実行（CI と同じ）

```bash
npx newman@6.2.1 run postman/CONIME_Phase1.postman_collection.json -e postman/local.postman_environment.json
npx newman@6.2.1 run postman/CONIME_Phase1.postman_collection.json -e postman/dev.postman_environment.json \
  --env-var base_url=https://<project-ref>.supabase.co/functions/v1/api/v1 \
  --env-var auth_url=https://<project-ref>.supabase.co/auth/v1 \
  --env-var anon_key=<dev の anon key>
```

dev 環境で実行すると検証用のユーザーが2人ずつ作られる（`postman-*@conime.test`）。不要になったら Studio の Authentication から削除する。

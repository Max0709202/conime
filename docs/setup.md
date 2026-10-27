# 環境構築手順書

本書 連携01「`supabase start` 一つで DB・認証・API・初期データがそろう」状態を作る手順と、dev（検証）環境の構築・反映手順。

| 環境 | 用途 | 第1段階 |
|---|---|---|
| local | 開発・自動テスト（Supabase CLI + Docker） | 実動作 |
| dev（検証） | Unity 連携・Postman・貴社確認。東京リージョン、モック有効 | 実動作 |
| prod（本番） | 外部β検証・公開。別プロジェクト、モック無効 | 対象外（P2-10） |

## 1. 必要なもの

| ツール | 版の目安 | 用途 |
|---|---|---|
| Docker Desktop | 最新 | Supabase のローカル環境 |
| Supabase CLI | 2.x | `supabase start` / `db reset` / `functions serve` / `test db` |
| Deno | 2.x | Edge Functions の型チェック・テスト |
| Node.js | 20 以上 | Newman（Postman）・Prism（ローカルモック）を `npx` で実行 |

## 2. local 環境

### 2.1 起動

```bash
git clone <リポジトリ URL> conime-backend && cd conime-backend
cp .env.example .env            # (1) 環境変数（値は local 用のままでよい）
supabase start                  # (2) DB・Auth・Storage・Studio を起動
supabase db reset               # (3) マイグレーションと初期データ（seed.sql）を投入
supabase functions serve --env-file .env   # (4) API（api / worker）を起動（このターミナルは開いたまま）
```

`supabase start` の最後に表示される値を使う。

| 表示 | 用途 |
|---|---|
| API URL（`http://127.0.0.1:54321`） | アプリ API：`http://127.0.0.1:54321/functions/v1/api/v1`、認証：`http://127.0.0.1:54321/auth/v1` |
| anon key | アプリ・Postman の `apikey`（公開前提のキー） |
| service_role key | Edge Functions 内部のみ。アプリ・Postman には使わない |
| Studio URL（`http://127.0.0.1:54323`） | テーブル・データの確認、運営作業（質問セット・同意文書・ギルドの登録） |

アクセストークンの署名は Supabase CLI 2.x の local 既定では ES256（非対称鍵）で、API は JWKS で自動的に検証する。`.env` の `JWT_SECRET` は HS256 で署名するプロジェクト用（local の値は CLI の既定値のままでよい）。

### 2.2 テスト

```bash
supabase test db                                   # (5) pgTAP：RLS（本人・他人・未ログイン）・制約・同意・診断
deno test --allow-env --allow-read --allow-net supabase/functions   # 契約テスト・入力検証の単体テスト（DB 不要）
npx newman@6.2.1 run postman/CONIME_Phase1.postman_collection.json \
  -e postman/local.postman_environment.json        # (5) API テスト（functions serve の起動中に実行）
```

### 2.3 初期データ（seed.sql）

| データ | 内容 |
|---|---|
| 質問セット v1 | Q1〜Q20（本書 API06。質問文・制約は仮置き：U-06） |
| 同意文書（仮） | terms / privacy / ai_transfer の v1（文言は貴社支給で差し替え：U-03・U-21） |
| マスタ（仮） | 作品5件・タグ10件・作品キャラ3件（作品リスト支給前の仮データ：U-05） |
| ギルド | 5ギルド（各ギルドにトークルーム） |
| 検証アカウント | 下表。パスワードは共通で `conime-dev-2026` |

| メールアドレス | 状態 | 用途 |
|---|---|---|
| `pre-diagnosis@conime.test` | 同意済み・診断前 | 診断送信・診断前の 404 の確認 |
| `diagnosed@conime.test` | 診断済み（キャラ「ルミナ」 C-7K3M9Q2X） | 結果画面・マイキャラ詳細 |
| `guild-member@conime.test` | 診断済み・ギルド「ファンタジー好きの酒場」に所属 | ギルド・トークルーム（第2段階） |

診断済みアカウントのキャラ画像は、初回に `GET /me/character/image` を呼んだ時点で worker が生成する（Storage は seed で投入できないため）。

### 2.4 ローカルモック（ネット接続なしで開発する場合）

```bash
npx @stoplight/prism-cli@5.12.0 mock openapi/openapi.yaml   # http://127.0.0.1:4010
```

openapi.yaml の応答例を返す。Unity エディタの `ApiBaseUrl` を `http://127.0.0.1:4010` にすると、サーバーなしで画面を開発できる。

## 3. dev（検証）環境の構築

### 3.1 Supabase プロジェクト

1. 貴社名義の Supabase 組織に、dev 用プロジェクトを **東京（ap-northeast-1）** で作成する（U-19：有料プランを推奨。無料プランは一定期間アクセスがないと一時停止される）
2. Authentication → Providers → Email：Email 有効、**Confirm email を無効**（dev は検証効率のため。本番での有効化は U-02）、パスワード8文字以上
3. Authentication → Sessions：JWT expiry 3600 秒、Refresh token rotation 有効
4. Project Settings → API で、Project URL・anon key を控える。アクセストークンを HS256（従来の JWT Secret）で署名しているプロジェクトでは JWT Secret も控える（JWT Signing Keys の非対称鍵なら不要。API が JWKS で検証する）

### 3.2 初回反映（手元から）

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push                       # migrations を適用
psql "<dev の接続文字列>" -f supabase/seed.sql     # 質問セット v1・同意文書（仮）・検証データ（初回のみ）

# Edge Functions の Secrets（.env.example の項目。SUPABASE_* は自動で設定される）
supabase secrets set MOCK_MODE=true MOCK_GENERATION_DELAY_SECONDS=5 RATE_LIMIT_PER_MINUTE=60 \
  JWT_SECRET=<dev の JWT Secret（HS256 の場合のみ）> WORKER_SECRET=<十分に長いランダム文字列>
supabase functions deploy api --no-verify-jwt
supabase functions deploy worker --no-verify-jwt
```

### 3.3 定期ジョブ（pg_cron）が worker を起動できるようにする

migrations で pg_cron の定期ジョブ（毎分：停滞ジョブの failed 化・再投入、期限切れ冪等キーの削除、退会者データの物理削除、worker の起動）を登録している。
worker の起動に必要な URL と共有シークレットを Vault に登録する（SQL エディタで実行）。

```sql
select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/worker', 'worker_url');
select vault.create_secret('<WORKER_SECRET と同じ値>', 'worker_secret');
```

未登録でも、api が診断送信・再試行の直後に worker を起動するため動作する（定期ジョブは取りこぼしの回収用）。

### 3.4 以降の反映（GitHub Actions）

main へのマージで [deploy-dev.yml](../.github/workflows/deploy-dev.yml) が `supabase db push` と `supabase functions deploy` を実行する。リポジトリの Secrets に次を登録する。

| Secret | 内容 |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | Supabase のアクセストークン（Account → Access Tokens） |
| `SUPABASE_DEV_PROJECT_REF` | dev プロジェクトの Reference ID |
| `SUPABASE_DEV_DB_PASSWORD` | dev プロジェクトの DB パスワード |

### 3.5 Unity 担当へ共有するもの（連携05）

- プロジェクト URL と anon key のみ（**service_role key・JWT Secret・WORKER_SECRET は共有しない**）
- 状態別の検証アカウント（2.3 の表）
- API 仕様：`https://<project-ref>.supabase.co/functions/v1/api/v1/docs`（Redoc。MOCK_MODE=true の環境のみ公開）
- Postman の dev 環境ファイル（[postman/dev.postman_environment.json](../postman/dev.postman_environment.json) の `<project-ref>` と anon key を置き換えたもの）

## 4. 動作確認（検収条件「DB および基本 API が動作すること」）

dev 環境で次が完了することを確認する。Postman コレクションを上から順に実行すると同じ流れを自動で確認できる。

| 順 | 操作 | 期待結果 |
|---|---|---|
| 1 | `GET /question-sets/current` | 200。20問の質問定義 |
| 2 | `POST /auth/v1/signup` | 200。アクセストークン・リフレッシュトークン |
| 3 | `GET /consent-documents/current` → `POST /me/consents` | 201。`ai_transfer_granted: true` |
| 4 | `POST /diagnoses`（Idempotency-Key 付き） | 202。`submission_id`・`status: received` |
| 5 | `GET /diagnoses/{submission_id}` を `poll_after_seconds` ごと | 約5秒後に `completed` |
| 6 | `GET /me/diagnosis-result` | 200。プロフィール・キャラ・画像 URL（署名付き） |

## 5. 運用メモ

| 作業 | 方法 |
|---|---|
| 質問セットの版上げ | Studio で新しい版を draft で登録 → 旧版を deprecated、新版を published に変更（published は同時に1件。旧版は30日間受付：U-22） |
| 同意文書の改訂 | 新しい版を登録し is_current を切り替える。再同意が必要なら requires_reconsent = true |
| 調整値の変更 | `app_settings` を更新（定員・所属上限・履歴上限・配点・待機上限など。デプロイ不要） |
| 生成ジョブの確認 | `generation_jobs` の status / attempts / error_code。worker のログは Edge Functions のログ |
| ログ | api はリクエストごとに request_id・user_id・処理時間・エラーコードを1行の JSON で出力（回答本文・メッセージ本文は出さない） |

## 6. うまくいかないとき

| 症状 | 確認 |
|---|---|
| 会員 API がすべて 401 UNAUTHENTICATED | HS256 のプロジェクトは `JWT_SECRET` が JWT Secret と一致しているか。非対称鍵（ES256 等）のプロジェクトは Edge Function から `/auth/v1/.well-known/jwks.json` に到達できるか |
| 診断が received のまま進まない | `WORKER_SECRET` が api / worker で同じか、worker がデプロイされているか。3分を超えると failed（GENERATION_TIMEOUT）になる |
| 画像の URL が開けない（local） | `.env` の `PUBLIC_SUPABASE_URL` が `http://127.0.0.1:54321` か（実機から開く場合は PC の IP アドレス） |
| `/docs` が 404 | `MOCK_MODE=true` の環境のみ公開している |
| `/docs` が空・`/openapi.yaml` が 500 | `supabase/functions/api/openapi.yaml`（同梱用コピー）が存在するか。openapi.yaml を変更したら `cp openapi/openapi.yaml supabase/functions/api/openapi.yaml` |

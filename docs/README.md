# 第1段階の納品物と検収条件

本書（CONIME MVP サーバーサイド設計書 CONIME-BE-SPEC-001 v1.0）引継05 の納品物12点と、本リポジトリ内の該当ファイルの対応表。

## 納品物

| No. | 納品物 | 形式（本書 引継05） | 該当ファイル |
|---|---|---|---|
| 1 | バックエンド設計資料 | 本書 | 本書（CONIME-BE-SPEC-001 v1.0 PDF・別添） |
| 2 | システム構成図 | 本書 基盤01 | 本書 基盤01（P.9）。構成要素と実装の対応は下表「構成要素と実装」 |
| 3 | データベース設計書・ER 図 | 本書 データ01〜08 ＋ マイグレーションから生成した全列定義書 | 本書 データ01〜08、[database.md](database.md)（全列定義書） |
| 4 | データベースマイグレーション | supabase/migrations/*.sql・seed.sql | [supabase/migrations/](../supabase/migrations/)、[supabase/seed.sql](../supabase/seed.sql) |
| 5 | 認証・権限管理の基盤 | Auth 設定・RLS・同意管理・pgTAP テスト | [supabase/config.toml](../supabase/config.toml)（Auth 設定）、[0800_rls_policies.sql](../supabase/migrations/20261013000800_rls_policies.sql)（RLS）、[0900_api_functions.sql](../supabase/migrations/20261013000900_api_functions.sql)（同意判定）、[supabase/tests/](../supabase/tests/)（pgTAP） |
| 6 | API 仕様書（OpenAPI） | openapi/openapi.yaml（OpenAPI 3.1）・閲覧用ページ | [openapi/openapi.yaml](../openapi/openapi.yaml)、dev 環境の `GET /functions/v1/api/v1/docs`（Redoc） |
| 7 | Postman コレクション | コレクション＋環境ファイル（local / dev） | [postman/CONIME_Phase1.postman_collection.json](../postman/CONIME_Phase1.postman_collection.json)、[local](../postman/local.postman_environment.json) / [dev](../postman/dev.postman_environment.json) |
| 8 | 開発・検証環境 | local 環境一式・dev 環境（Supabase） | local：`supabase start` 一式（[config.toml](../supabase/config.toml)・[.env.example](../.env.example)）、dev：[setup.md](setup.md) の手順で構築し [deploy-dev.yml](../.github/workflows/deploy-dev.yml) で反映 |
| 9 | 環境構築手順書 | Markdown（docs/） | [setup.md](setup.md) |
| 10 | Unity 側との連携手順書 | Markdown ＋ C# 参考実装 | [unity-integration.md](unity-integration.md)、[unity/](unity/) |
| 11 | 未確定事項・引継ぎ資料 | 本書 引継02〜04 | 本書 引継02〜04、[open-items.md](open-items.md)（U-01〜U-22 と仮置きの実装箇所）、[phase2-handover.md](phase2-handover.md)（P2-1〜P2-10） |
| 12 | ソースコード一式 | GitHub リポジトリ（貴社の組織配下を推奨） | 本リポジトリ |

## 構成要素と実装（本書 基盤01・基盤02）

| 構成要素 | 実装 |
|---|---|
| Supabase Auth | [supabase/config.toml](../supabase/config.toml) `[auth]`（メール＋パスワード、トークン1時間、リフレッシュトークンは使い捨て、パスワード8文字以上） |
| Edge Function：api | [supabase/functions/api/](../supabase/functions/api/)（Hono。入力検証は Zod、同意確認・冪等性・モック応答） |
| Edge Function：worker | [supabase/functions/worker/](../supabase/functions/worker/)（生成ジョブの実行・再試行。第1段階は MockProvider） |
| PostgreSQL | [supabase/migrations/](../supabase/migrations/)（33テーブル・全て RLS・業務ルールを制約で担保・pg_cron の定期ジョブ） |
| Storage（非公開） | `character-images`・`message-images` バケット（[1000_storage_scheduler.sql](../supabase/migrations/20261013001000_storage_scheduler.sql)）。アプリには署名付き URL（1時間）のみ |
| 生成 AI の抽象化 | [supabase/functions/_shared/ai/provider.ts](../supabase/functions/_shared/ai/provider.ts)（AiProvider）、[mock_provider.ts](../supabase/functions/_shared/ai/mock_provider.ts)（MockProvider） |
| Realtime | 第2段階（P2-5）。config.toml で有効化済み |
| CI | [.github/workflows/ci.yml](../.github/workflows/ci.yml)（型チェック・pgTAP・Newman）、[deploy-dev.yml](../.github/workflows/deploy-dev.yml)（main へのマージで dev へ反映） |

## 検収条件と確認方法

| 検収条件 | 確認方法 | 補助資料 |
|---|---|---|
| 記載した納品物が提出されていること | 上表「納品物」と照合 | 本ファイル |
| ローカルまたは検証環境で DB および基本 API が動作すること | dev 環境で「質問取得 → 登録 → 同意 → 送信 → 状態 → 結果」が完了する | [setup.md](setup.md)「動作確認」 |
| Postman から基本 API の正常系・主要なエラー系を確認できること | Postman コレクションを dev 環境で一括実行し、全テストが成功する | [postman/README.md](../postman/README.md) |
| フロントエンドエンジニアが API 連携を開始できる資料が用意されていること | 連携05 の一式（dev 環境の URL・anon key・検証アカウント、openapi.yaml と Redoc、Postman、連携手順書と C# 参考実装）を Unity 担当にお渡しし、接続確認ができる | [unity-integration.md](unity-integration.md) |

## 数値の対応（本書との整合）

| 項目 | 本書 | 本リポジトリ |
|---|---|---|
| テーブル数 | 33（データ05） | `supabase/tests/00_schema.test.sql` で33件・全テーブル RLS 有効を検証 |
| アプリ API | 39本（実動作13・モック26）（API03・API04） | openapi.yaml の `x-conime-stage: live / mock`。`supabase/functions/api/contract_test.ts` でルーターと一致を検証 |
| Supabase Auth の認証 API | 4本（API03） | openapi.yaml タグ `Auth`（signup / token?grant_type=password / token?grant_type=refresh_token / logout） |
| Postman のフォルダ | 00 Health〜07 Security（連携02） | コレクションのフォルダ構成が同じ |
| エラーコード | 18種（API02） | openapi.yaml `ErrorCode`、[errors.ts](../supabase/functions/_shared/errors.ts) |
| X-Mock-Scenario | 10種（API09） | openapi.yaml `MockScenario`、[app.ts](../supabase/functions/api/app.ts)・[mocks.ts](../supabase/functions/api/routes/mocks.ts)・[mock_provider.ts](../supabase/functions/_shared/ai/mock_provider.ts) |
| 確認事項 | U-01〜U-22（引継02） | [open-items.md](open-items.md) |
| 第2段階の作業パッケージ | P2-1〜P2-10（引継03・引継04） | [phase2-handover.md](phase2-handover.md) |

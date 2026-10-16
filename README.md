# conime-backend

CONIME MVP サーバーサイド **第1段階（設計・基盤構築）** のソースコード一式。
設計の正は「CONIME MVP サーバーサイド設計書（CONIME-BE-SPEC-001 v1.0）」（以下、本書）で、本リポジトリはその第2章〜第4章を実装したもの。

- 基盤：Supabase（PostgreSQL・Auth・Storage・Edge Functions）、東京リージョン
- Unity アプリが呼ぶのは `/auth/v1/*`（Supabase Auth）と `/functions/v1/api/v1/*`（アプリ API）の2種類だけ
- アプリ API は 39 本（**実動作 13 本・モック 26 本**）。契約は [openapi/openapi.yaml](openapi/openapi.yaml) が正
- データベースは **33 テーブル・全テーブル RLS 有効**。業務ルールは DB の制約・権限で担保する

## リポジトリ構成（本書 連携01）

```
conime-backend/
├─ supabase/
│  ├─ config.toml        # ローカル環境・Auth 設定
│  ├─ migrations/        # テーブル・RLS・関数（番号順に適用）
│  ├─ seed.sql           # 質問セット v1・同意文書（仮）・検証データ
│  ├─ functions/
│  │  ├─ api/            # アプリ API（Hono ルーター）
│  │  ├─ worker/         # 生成ジョブの実行
│  │  └─ _shared/        # 認証・検証・エラー・AiProvider・モック
│  └─ tests/             # pgTAP（RLS・制約のテスト）
├─ openapi/openapi.yaml  # API 仕様（正）
├─ postman/              # コレクション・環境（local / dev）
├─ docs/                 # 環境構築手順書・Unity 連携手順書
└─ .github/workflows/    # CI（型・DB・API テスト、デプロイ）
```

## はじめかた（local）

詳細は [docs/setup.md](docs/setup.md)。

```bash
cp .env.example .env
supabase start                                   # DB・Auth・Storage・Studio を起動
supabase db reset                                # マイグレーションと初期データを投入
supabase functions serve --env-file .env         # API（api / worker）を起動
supabase test db                                 # RLS・制約のテスト（pgTAP）
npx newman@6.2.1 run postman/CONIME_Phase1.postman_collection.json \
  -e postman/local.postman_environment.json      # API テスト（正常系・主要なエラー系）
```

## ドキュメント

| 資料 | ファイル |
|---|---|
| 納品物一覧・検収条件の確認方法 | [docs/README.md](docs/README.md) |
| 環境構築手順書（local / dev） | [docs/setup.md](docs/setup.md) |
| Unity 側との連携手順書 | [docs/unity-integration.md](docs/unity-integration.md)（C# 参考実装：[docs/unity/](docs/unity/)） |
| データベース定義書（全列定義） | [docs/database.md](docs/database.md) |
| API 仕様書（OpenAPI 3.1） | [openapi/openapi.yaml](openapi/openapi.yaml)（dev 環境では `GET /docs` で閲覧） |
| Postman コレクション | [postman/](postman/) |
| 未確定事項・確認依頼（U-01〜U-22） | [docs/open-items.md](docs/open-items.md) |
| 第2段階への引継ぎ資料 | [docs/phase2-handover.md](docs/phase2-handover.md) |

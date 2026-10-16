# 未確定事項・確認依頼（U-01〜U-22）

本書 引継02 の確認事項22件。段階が「1」の10件は第1段階の完了前にご回答をお願いしたい。
ご回答がない場合は仮置きで実装しており、下表「仮置きの実装箇所」の設定値または軽微な修正で変更できる。
仕様書の「確認事項別紙」と統合して管理する形も可能。回答状況は打合せごとに更新する。

| ID | 確認事項 | サーバー側の仮置き（提案） | 確認先 | 段階 | 仮置きの実装箇所（変更方法） | 回答 |
|---|---|---|---|---|---|---|
| U-01 | 仕様書第4章（P.45 開発スコープ・スコープ外）が受領 PDF に含まれていない | ご依頼文の作業範囲を基準に設計 | 貴社 | 1 | 本書 概要2・本リポジトリ全体 | 未 |
| U-02 | Sign in with Apple の要否、本番のメール確認、パスワード再設定画面の有無 | メール＋パスワードのみ。本番はメール確認あり | 貴社・Unity | 1 | `supabase/config.toml`（`[auth.email] enable_confirmations`・`[auth.external.apple]`）。dev はダッシュボードの Auth 設定 | 未 |
| U-03 | AI 送信同意の文言・表示位置・同意しない場合の扱い・撤回時の送信済みデータ | 文言は貴社支給。撤回後は新規送信停止、生成済みは保持 | 貴社 | 1 | 文言：`consent_documents`（seed.sql は仮文書）。撤回後の停止：`private.valid_consent_id`（`POST /diagnoses`・retry・ナビゲーターが 403） | 未 |
| U-04 | 生成 AI（テキスト・画像）の提供元・契約名義・費用負担・API キー | 提供元を抽象化して実装。第2段階着手までに決定 | 貴社 | 2 | `supabase/functions/_shared/ai/provider.ts`（AiProvider。`AI_PROVIDER` で切替。第1段階は MockProvider） | 未 |
| U-05 | 作品リスト・キャラ群・ジャンル群・世界観群の形式と件数、タグ付与者 | CSV（作品名・読み・別名・ジャンル・世界観） | 貴社 | 2 | `works` / `anime_characters` / `tags` / `work_tags`（seed.sql は仮データ5件） | 未 |
| U-06 | 自由記述の文字数上限、必須の欄数 | API06 の仮値 | 貴社 | 1 | `questions.constraints`（`field_count`・`required_field_count`・`max_length`）。seed.sql の質問セット v1 | 未 |
| U-07 | キャラIDの採番形式、キャラ名の入力制限 | C- ＋英数字8文字、名前1〜20文字 | 貴社 | 1 | 採番：`private.generate_public_code()`・`characters.public_code` の CHECK。名前：`app_settings` `character.name_max_length` と `characters.name` の CHECK | 未 |
| U-08 | 生成の待機上限、SC-03・SC-04 の表示順、部分完了時の画面 | 上限3分。部分完了は各結果の status で返す | 貴社・Unity | 1 | `app_settings` `generation.timeout_seconds`（180）。部分完了：`GET /me/diagnosis-result` の各 `status` | 未 |
| U-09 | 推薦の件数・相性%の表示形式・ギルド/アニメの配点・再計算タイミング | 各最大3件。診断完了時と毎日1回 | 貴社 | 2 | `app_settings` `recommendation.max_items`・`matching.weights`。モック応答は openapi.yaml | 未 |
| U-10 | グッとの対象アクション、ポイント・EXP の式、必要 EXP | 対象はメッセージから開始。値は設定表 | 貴社 | 2 | `goodtos.target_type`（CHECK に追加）、`app_settings` `growth.goodto_exp`・`growth.goodto_points`、`level_thresholds`（仮値） | 未 |
| U-11 | 一度に複数レベル上がった場合の画像更新と演出 | 最終到達の進化段階の画像のみ生成 | 貴社 | 2 | 第2段階 P2-6（`generation_jobs` job_type = evolution_image、`characters.image_stage`） | 未 |
| U-12 | 履歴の保存上限（ギルド・DM・ナビゲーター） | 件数または日数で設定表に保持 | 貴社 | 2 | `app_settings` `history.guild_message_limit`・`history.dm_message_limit`・`history.navigator_message_limit` | 未 |
| U-13 | 画像の形式・容量上限、ナビゲーターへの画像送信の採否 | JPEG / PNG・5MB。ナビゲーター画像は対象外 | 貴社 | 2 | Storage バケットの `allowed_mime_types`・`file_size_limit`（`20261013001000_storage_scheduler.sql`）、`POST /uploads/message-images` の検証 | 未 |
| U-14 | DM の開始条件、ブロック時の非表示・制限範囲 | 会員なら開始可。ブロックで相互に DM・推薦から除外 | 貴社 | 2 | `private.is_blocked`（相互判定）、`private.can_access_conversation`、公開ビュー `public_profiles` / `public_characters` | 未 |
| U-15 | アプリ内通知の種類 | グッと受領・レベルアップ・お知らせ・DM 受信 | 貴社 | 2 | `notifications.type` の CHECK（goodto_received / level_up / guild_announcement / dm_received / system） | 未 |
| U-16 | 所属数の上限、初期ギルドの内容、発言者ロールの種類（C-2） | 上限なし（設定で変更可）。member / leader / staff | 貴社 | 1 | `app_settings` `guild.max_memberships`（null = 上限なし）、`guild.default_capacity`、`guild_members.role` の CHECK、seed.sql の5ギルド | 未 |
| U-17 | 退会後のデータ保持期間と過去の発言の扱い | 30日後に物理削除。発言は「退会したユーザー」 | 貴社 | 2 | `app_settings` `withdrawal.purge_after_days`、`private.purge_withdrawn_users()`（pg_cron）、`messages.sender_id` の `on delete set null` | 未 |
| U-18 | ナビゲーターの利用上限・回答範囲・履歴件数 | 1人1日30回。使い方とアニメの話題 | 貴社 | 2 | `app_settings` `navigator.daily_limit`・`history.navigator_message_limit` | 未 |
| U-19 | Supabase の組織・プロジェクトの名義、プラン、請求先 | 貴社名義・有料プラン。担当を開発メンバーに招待 | 貴社 | 1 | [setup.md](setup.md) 3.1 | 未 |
| U-20 | プッシュ通知（OS の通知）の要否 | MVP はアプリ内通知のみ | 貴社 | 2 | `notifications`（アプリ内通知）。プッシュは対象外 | 未 |
| U-21 | 利用規約・プライバシーポリシーの文書 | 貴社支給。dev は仮の文書で検証 | 貴社 | 1 | `consent_documents`（seed.sql は仮文書。新しい版を登録して is_current を切替） | 未 |
| U-22 | 端末保存中の回答の質問セットが古くなった場合 | 旧版を30日間 deprecated として受付 | 貴社・Unity | 1 | `app_settings` `diagnosis.deprecated_grace_days`（30）、`private.question_set_accepting()` | 未 |

## 第1段階で仮置きした値（設定表 app_settings）

デプロイなしで変更できる（Studio または SQL で `app_settings.value` を更新）。

| key | 仮値 | 関連 |
|---|---|---|
| `diagnosis.poll_after_seconds` | 3 | 生成状態の取得間隔 |
| `diagnosis.deprecated_grace_days` | 30 | U-22 |
| `generation.max_retries` | 3 | 自動再試行の最大回数（本書 引継01） |
| `generation.timeout_seconds` | 180 | U-08 |
| `character.name_max_length` | 20 | U-07 |
| `guild.default_capacity` | 100 | G-1 |
| `guild.max_memberships` | null（上限なし） | U-16 |
| `history.guild_message_limit` / `history.dm_message_limit` / `history.navigator_message_limit` | 1000 / 1000 / 200 | U-12 |
| `navigator.daily_limit` | 30 | U-18 |
| `recommendation.max_items` | 3 | U-09 |
| `matching.weights` | works 40・characters 20・enjoyment 15・genre_world 15・visual 10 | U-09（非公開設定） |
| `growth.max_level` | 100 | L-2 |
| `growth.goodto_exp` / `growth.goodto_points` | 10 / 1 | U-10 |
| `idempotency.ttl_hours` | 24 | API01 |
| `withdrawal.purge_after_days` | 30 | U-17 |

このほか、利用制限（1ユーザー60回/分・API01）は Edge Functions の環境変数 `RATE_LIMIT_PER_MINUTE`、生成モックの完了までの秒数は `MOCK_GENERATION_DELAY_SECONDS` で変更する。

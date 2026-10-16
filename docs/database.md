# データベース定義書（全列定義）

CONIME MVP サーバーサイド設計書（CONIME-BE-SPEC-001 v1.0）データ05〜08 の全列定義。
`supabase/migrations/*.sql` を適用したスキーマから生成した（33テーブル・全テーブル RLS 有効）。
テーブルの論理名・段階は設計書 データ05、主要テーブルの説明はデータ07・08、ER 図はデータ01〜04 を参照。

- 段階「1」＝第1段階でロジックまで実装、「1 / 2」＝第1段階でテーブル・RLS、第2段階でロジックを実装
- 権限：anon / authenticated に付与しているテーブル権限。【会員】の書き込みは列単位の権限と RLS ポリシーで制限する
- 書き込み関数は PostgREST に公開しない `private` スキーマに置く（`supabase/migrations/20261013000900_api_functions.sql`）

## テーブル一覧

| No. | 区分 | テーブル | 説明 | 段階 |
|---|---|---|---|---|
| 1 | アカウント・同意 | [profiles](#profiles) | ユーザー。auth.users 作成時にトリガーで自動作成 | 1 |
| 2 | アカウント・同意 | [consent_documents](#consent_documents) | 同意文書。文言変更時は新しい版を登録する | 1 |
| 3 | アカウント・同意 | [user_consents](#user_consents) | 同意履歴。追記のみ（更新・削除不可） | 1 |
| 4 | アカウント・同意 | [account_deletion_requests](#account_deletion_requests) | 退会受付（AC-3）。実処理は第2段階 | 1 / 2 |
| 5 | 診断 | [question_sets](#question_sets) | 質問セット。published は同時に1件。版上げ後の旧版は deprecated として猶予期間のみ受付（U-22） | 1 |
| 6 | 診断 | [questions](#questions) | 質問。版をまたいで同じ意味なら同じ code。constraints = min_select / max_select / field_count / required_field_count / max_length | 1 |
| 7 | 診断 | [question_options](#question_options) | 選択肢。attributes にキャラ要素 | 1 |
| 8 | 診断 | [diagnosis_submissions](#diagnosis_submissions) | 診断送信。1ユーザー1回（user_id UNIQUE）。送信時点で有効だった AI 送信同意を ai_consent_id に記録 | 1 |
| 9 | 診断 | [diagnosis_answers](#diagnosis_answers) | 診断回答。回答は加工せず保存（選択式は option_codes、自由記述は texts） | 1 |
| 10 | 診断 | [answer_entities](#answer_entities) | 自由記述の正規化結果（作品・キャラ・タグのリストID）。元の回答は変更しない。ロジックは第2段階（P2-2） | 1 / 2 |
| 11 | マスタ | [works](#works) | 作品リスト。Q1・Q3・Q12 の照合先 | 1 / 2 |
| 12 | マスタ | [anime_characters](#anime_characters) | 作品キャラ | 1 / 2 |
| 13 | マスタ | [tags](#tags) | タグ（ジャンル・世界観・テンポ・楽しみ方 等） | 1 / 2 |
| 14 | マスタ | [work_tags](#work_tags) | 作品タグ | 1 / 2 |
| 15 | キャラクター・生成・成長 | [ai_profiles](#ai_profiles) | 生成プロフィール（仕様書 概要7「プロフィール反映」の保存先） | 1 |
| 16 | キャラクター・生成・成長 | [characters](#characters) | マイキャラ。1ユーザー1体。アプリから更新できるのは name のみ（Q-4・L-1・L-5） | 1 |
| 17 | キャラクター・生成・成長 | [generation_jobs](#generation_jobs) | 生成ジョブ。失敗時は最大3回自動再試行（app_settings generation.max_retries）し、以降は手動再試行 | 1 |
| 18 | キャラクター・生成・成長 | [exp_events](#exp_events) | 成長台帳。characters.exp_total / goodto_points / level の根拠と再計算用（第2段階 P2-6） | 1 / 2 |
| 19 | キャラクター・生成・成長 | [level_thresholds](#level_thresholds) | 各レベルに必要な累計 EXP（仮値・U-10）。is_evolution = 5の倍数（L-3） | 1 / 2 |
| 20 | キャラクター・生成・成長 | [goodtos](#goodtos) | グッと。対象アクションは target_type の追加で拡張（U-10） | 1 / 2 |
| 21 | ギルド・メッセージ | [guilds](#guilds) | ギルド。運営のみ作成（GE-1 は対象外）。定員の既定値は app_settings guild.default_capacity | 1 / 2 |
| 22 | ギルド・メッセージ | [guild_tags](#guild_tags) | ギルドタグ | 1 / 2 |
| 23 | ギルド・メッセージ | [guild_members](#guild_members) | ギルド所属。参加は参加関数内で行ロックし定員・所属上限を守る（第2段階 P2-4） | 1 / 2 |
| 24 | ギルド・メッセージ | [guild_announcements](#guild_announcements) | ギルドのお知らせ（G-4） | 1 / 2 |
| 25 | ギルド・メッセージ | [conversations](#conversations) | 会話。kind = guild（トークルーム）/ dm / navigator | 1 / 2 |
| 26 | ギルド・メッセージ | [conversation_members](#conversation_members) | 会話の参加者 | 1 / 2 |
| 27 | ギルド・メッセージ | [messages](#messages) | メッセージ。論理削除は deleted_at。履歴上限は app_settings history.*_limit（U-12） | 1 / 2 |
| 28 | 推薦・通知・安心安全・共通 | [recommendations](#recommendations) | 推薦結果。最新の計算結果のみ保持し、アプリは相性%と一致項目をそのまま表示（M-3） | 1 / 2 |
| 29 | 推薦・通知・安心安全・共通 | [notifications](#notifications) | アプリ内通知。事象発生時に保存し read_at で既読（NT-1・U-15） | 1 / 2 |
| 30 | 推薦・通知・安心安全・共通 | [reports](#reports) | 通報（S-1） | 1 / 2 |
| 31 | 推薦・通知・安心安全・共通 | [blocks](#blocks) | ブロック。DM・推薦・メッセージ表示の除外判定に使用（RLS 関数 private.is_blocked） | 1 / 2 |
| 32 | 推薦・通知・安心安全・共通 | [app_settings](#app_settings) | デプロイなしで変える調整値（定員・所属上限・履歴上限・配点 等） | 1 |
| 33 | 推薦・通知・安心安全・共通 | [idempotency_keys](#idempotency_keys) | 作成系 POST の応答を24時間保持し、再送時は同じ応答を返す（API01） | 1 |

## アカウント・同意

### profiles

ユーザー。auth.users 作成時にトリガーで自動作成

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `user_id` | uuid | 不可 |  | ユーザーID（auth.users.id） |
| 2 | `display_name` | text | 可 |  | 表示名（1〜30文字） |
| 3 | `role` | text | 不可 | `'user'::text` | user / admin（運営。判定は Auth の app_metadata.role） |
| 4 | `status` | text | 不可 | `'active'::text` | active / withdrawn（退会済み） |
| 5 | `withdrawn_at` | timestamp with time zone | 可 |  | 退会受付日時。30日後に物理削除（U-17） |
| 6 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |
| 7 | `updated_at` | timestamp with time zone | 不可 | `now()` | 更新日時（トリガーで自動更新） |

制約

- CHECK：`CHECK (((status = 'withdrawn'::text) = (withdrawn_at IS NOT NULL)))`
- CHECK：`CHECK (((display_name IS NULL) OR ((char_length(display_name) >= 1) AND (char_length(display_name) <= 30))))`
- CHECK：`CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text])))`
- CHECK：`CHECK ((status = ANY (ARRAY['active'::text, 'withdrawn'::text])))`
- FK：`FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (user_id)`

権限

- authenticated：SELECT
- authenticated：UPDATE（display_name）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `profiles_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |
| `profiles_update_own` | UPDATE | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid)) / WITH CHECK (user_id = ( SELECT auth.uid() AS uid))` |

### consent_documents

同意文書。文言変更時は新しい版を登録する

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 同意文書ID |
| 2 | `doc_type` | text | 不可 |  | terms（利用規約）/ privacy（プライバシーポリシー）/ ai_transfer（外部 AI 送信・AC-2） |
| 3 | `version` | integer | 不可 |  | 版（種類ごとに1から） |
| 4 | `title` | text | 不可 |  | 表題 |
| 5 | `body` | text | 不可 |  | 本文（貴社支給・U-03 / U-21） |
| 6 | `is_current` | boolean | 不可 | `false` | 最新の有効版（種類ごとに1件） |
| 7 | `requires_reconsent` | boolean | 不可 | `false` | true の版では旧版への同意を無効とし再同意を求める |
| 8 | `published_at` | timestamp with time zone | 不可 | `now()` | 公開日時 |
| 9 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- CHECK：`CHECK ((doc_type = ANY (ARRAY['terms'::text, 'privacy'::text, 'ai_transfer'::text])))`
- CHECK：`CHECK ((version >= 1))`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (doc_type, version)`

インデックス

- `consent_documents_one_current`：`btree (doc_type) WHERE is_current`

権限

- anon：SELECT
- authenticated：DELETE, INSERT, SELECT, UPDATE
- authenticated：INSERT（body, created_at, doc_type, id, is_current, published_at, requires_reconsent, title, version）
- authenticated：UPDATE（body, created_at, doc_type, id, is_current, published_at, requires_reconsent, title, version）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `consent_documents_admin` | ALL | authenticated | `USING ( SELECT private.is_admin() AS is_admin) / WITH CHECK ( SELECT private.is_admin() AS is_admin)` |
| `consent_documents_select` | SELECT | anon,authenticated | `USING (is_current OR ( SELECT private.is_admin() AS is_admin))` |

### user_consents

同意履歴。追記のみ（更新・削除不可）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 同意記録ID（diagnosis_submissions.ai_consent_id の参照先） |
| 2 | `user_id` | uuid | 不可 |  | ユーザーID |
| 3 | `document_id` | uuid | 不可 |  | 同意文書ID（記録時点の最新の有効版） |
| 4 | `decision` | text | 不可 |  | granted（同意）/ revoked（撤回） |
| 5 | `decided_at` | timestamp with time zone | 不可 | `clock_timestamp()` | 記録日時 |
| 6 | `app_version` | text | 可 |  | アプリの版（証跡） |

制約

- CHECK：`CHECK (((app_version IS NULL) OR (char_length(app_version) <= 32)))`
- CHECK：`CHECK ((decision = ANY (ARRAY['granted'::text, 'revoked'::text])))`
- FK：`FOREIGN KEY (document_id) REFERENCES consent_documents(id)`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`

インデックス

- `user_consents_document`：`btree (document_id)`
- `user_consents_user_decided`：`btree (user_id, decided_at DESC)`

権限

- authenticated：SELECT
- authenticated：INSERT（app_version, decision, document_id, user_id）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `user_consents_insert_own` | INSERT | authenticated | `WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1    FROM consent_documents d   WHERE ((d.id = user_consents.document_id) AND d.is_current))))` |
| `user_consents_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

### account_deletion_requests

退会受付（AC-3）。実処理は第2段階

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 退会受付ID |
| 2 | `user_id` | uuid | 可 |  | ユーザーID（物理削除後は null） |
| 3 | `status` | text | 不可 | `'requested'::text` | requested / processing / completed |
| 4 | `requested_at` | timestamp with time zone | 不可 | `now()` | 受付日時 |
| 5 | `completed_at` | timestamp with time zone | 可 |  | 物理削除の完了日時 |

制約

- CHECK：`CHECK (((status = 'completed'::text) = (completed_at IS NOT NULL)))`
- CHECK：`CHECK ((status = ANY (ARRAY['requested'::text, 'processing'::text, 'completed'::text])))`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE SET NULL`
- PK：`PRIMARY KEY (id)`

インデックス

- `account_deletion_requests_user`：`btree (user_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `account_deletion_requests_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

## 診断

### question_sets

質問セット。published は同時に1件。版上げ後の旧版は deprecated として猶予期間のみ受付（U-22）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 質問セットID |
| 2 | `version` | integer | 不可 |  | 版（API の question_set_version） |
| 3 | `status` | text | 不可 | `'draft'::text` | draft / published / deprecated / archived |
| 4 | `published_at` | timestamp with time zone | 可 |  | 公開日時 |
| 5 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |
| 6 | `updated_at` | timestamp with time zone | 不可 | `now()` | 更新日時（トリガーで自動更新） |

制約

- CHECK：`CHECK (((status = 'draft'::text) OR (published_at IS NOT NULL)))`
- CHECK：`CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'deprecated'::text, 'archived'::text])))`
- CHECK：`CHECK ((version >= 1))`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (version)`

インデックス

- `question_sets_one_published`：`btree ((true)) WHERE (status = 'published'::text)`

権限

- anon：SELECT
- authenticated：DELETE, INSERT, SELECT, UPDATE
- authenticated：INSERT（created_at, id, published_at, status, updated_at, version）
- authenticated：UPDATE（created_at, id, published_at, status, updated_at, version）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `question_sets_admin` | ALL | authenticated | `USING ( SELECT private.is_admin() AS is_admin) / WITH CHECK ( SELECT private.is_admin() AS is_admin)` |
| `question_sets_select` | SELECT | anon,authenticated | `USING ((status = 'published'::text) OR ( SELECT private.is_admin() AS is_admin))` |

### questions

質問。版をまたいで同じ意味なら同じ code。constraints = min_select / max_select / field_count / required_field_count / max_length

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 質問ID |
| 2 | `question_set_id` | uuid | 不可 |  | 所属する質問セット |
| 3 | `code` | text | 不可 |  | Q1〜Q20。版をまたいで同じ意味なら同じ code |
| 4 | `sort_order` | integer | 不可 |  | 出題順（問番号表示） |
| 5 | `title` | text | 不可 |  | 問題文 |
| 6 | `answer_type` | text | 不可 |  | single_choice / multi_choice / free_fields / free_multi |
| 7 | `is_required` | boolean | 不可 | `true` | 必須か |
| 8 | `constraints` | jsonb | 不可 | `'{}'::jsonb` | min_select・max_select・field_count・required_field_count・max_length |
| 9 | `usages` | text[] | 不可 | `'{}'::text[]` | character_base / character_adjust / match_score / profile_display（Q-6） |
| 10 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- CHECK：`CHECK ((answer_type = ANY (ARRAY['single_choice'::text, 'multi_choice'::text, 'free_fields'::text, 'free_multi'::text])))`
- CHECK：`CHECK ((code ~ '^Q[0-9]{1,3}$'::text))`
- CHECK：`CHECK ((jsonb_typeof(constraints) = 'object'::text))`
- CHECK：`CHECK ((sort_order >= 1))`
- CHECK：`CHECK ((usages <@ ARRAY['character_base'::text, 'character_adjust'::text, 'match_score'::text, 'profile_display'::text]))`
- FK：`FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (question_set_id, code)`
- UNIQUE：`UNIQUE (question_set_id, sort_order)`

権限

- anon：SELECT
- authenticated：DELETE, INSERT, SELECT, UPDATE
- authenticated：INSERT（answer_type, code, constraints, created_at, id, is_required, question_set_id, sort_order, title, usages）
- authenticated：UPDATE（answer_type, code, constraints, created_at, id, is_required, question_set_id, sort_order, title, usages）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `questions_admin` | ALL | authenticated | `USING ( SELECT private.is_admin() AS is_admin) / WITH CHECK ( SELECT private.is_admin() AS is_admin)` |
| `questions_select` | SELECT | anon,authenticated | `USING ((EXISTS ( SELECT 1    FROM question_sets s   WHERE ((s.id = questions.question_set_id) AND (s.status = 'published'::text)))) OR ( SELECT private.is_admin() AS is_admin))` |

### question_options

選択肢。attributes にキャラ要素

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 選択肢ID |
| 2 | `question_id` | uuid | 不可 |  | 質問ID |
| 3 | `code` | text | 不可 |  | 選択肢コード（A〜） |
| 4 | `label` | text | 不可 |  | 表示文言 |
| 5 | `sort_order` | integer | 不可 |  | 表示順 |
| 6 | `attributes` | jsonb | 不可 | `'{}'::jsonb` | キャラ要素（テーマカラー・エフェクト・雰囲気 等） |

制約

- CHECK：`CHECK ((jsonb_typeof(attributes) = 'object'::text))`
- CHECK：`CHECK ((code ~ '^[A-Z]{1,2}$'::text))`
- CHECK：`CHECK ((sort_order >= 1))`
- FK：`FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (question_id, code)`

権限

- anon：SELECT
- authenticated：DELETE, INSERT, SELECT, UPDATE
- authenticated：INSERT（attributes, code, id, label, question_id, sort_order）
- authenticated：UPDATE（attributes, code, id, label, question_id, sort_order）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `question_options_admin` | ALL | authenticated | `USING ( SELECT private.is_admin() AS is_admin) / WITH CHECK ( SELECT private.is_admin() AS is_admin)` |
| `question_options_select` | SELECT | anon,authenticated | `USING ((EXISTS ( SELECT 1    FROM (questions q      JOIN question_sets s ON ((s.id = q.question_set_id)))   WHERE ((q.id = question_options.question_id) AND (s.status = 'published'::text)))) OR ( SELECT private.is_admin() AS is_admin))` |

### diagnosis_submissions

診断送信。1ユーザー1回（user_id UNIQUE）。送信時点で有効だった AI 送信同意を ai_consent_id に記録

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 送信ID（API の submission_id） |
| 2 | `user_id` | uuid | 不可 |  | ユーザーID（1ユーザー1回） |
| 3 | `question_set_id` | uuid | 不可 |  | 回答した質問セットの版 |
| 4 | `ai_consent_id` | uuid | 不可 |  | 送信時点で有効だった AI 送信同意（証跡） |
| 5 | `status` | text | 不可 | `'received'::text` | received / processing / completed / failed（生成状態） |
| 6 | `idempotency_key` | text | 不可 |  | アプリが付与した冪等キー |
| 7 | `submitted_at` | timestamp with time zone | 不可 | `now()` | 受付日時 |
| 8 | `completed_at` | timestamp with time zone | 可 |  | 生成完了日時 |
| 9 | `error_code` | text | 可 |  | 失敗時の理由コード（GENERATION_FAILED / GENERATION_TIMEOUT） |
| 10 | `updated_at` | timestamp with time zone | 不可 | `now()` | 更新日時（トリガーで自動更新） |

制約

- CHECK：`CHECK (((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255)))`
- CHECK：`CHECK ((status = ANY (ARRAY['received'::text, 'processing'::text, 'completed'::text, 'failed'::text])))`
- FK：`FOREIGN KEY (ai_consent_id) REFERENCES user_consents(id)`
- FK：`FOREIGN KEY (question_set_id) REFERENCES question_sets(id)`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (user_id)`

インデックス

- `diagnosis_submissions_ai_consent`：`btree (ai_consent_id)`
- `diagnosis_submissions_question_set`：`btree (question_set_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `diagnosis_submissions_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

### diagnosis_answers

診断回答。回答は加工せず保存（選択式は option_codes、自由記述は texts）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `submission_id` | uuid | 不可 |  | 送信ID |
| 3 | `user_id` | uuid | 不可 |  | 相性計算・RLS 用に非正規化 |
| 4 | `question_id` | uuid | 不可 |  | 質問ID |
| 5 | `option_codes` | text[] | 不可 | `'{}'::text[]` | 選択式の回答（例：{A,C,D}） |
| 6 | `texts` | text[] | 不可 | `'{}'::text[]` | 自由記述。加工せず保存 |
| 7 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- FK：`FOREIGN KEY (question_id) REFERENCES questions(id)`
- FK：`FOREIGN KEY (submission_id) REFERENCES diagnosis_submissions(id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (submission_id, question_id)`

インデックス

- `diagnosis_answers_question`：`btree (question_id)`
- `diagnosis_answers_user`：`btree (user_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `diagnosis_answers_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

### answer_entities

自由記述の正規化結果（作品・キャラ・タグのリストID）。元の回答は変更しない。ロジックは第2段階（P2-2）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `answer_id` | uuid | 不可 |  | 回答ID |
| 3 | `user_id` | uuid | 不可 |  | ユーザーID |
| 4 | `entity_type` | text | 不可 |  | work / anime_character / tag |
| 5 | `entity_id` | uuid | 不可 |  | works / anime_characters / tags の ID（論理参照） |
| 6 | `source_text` | text | 不可 |  | 照合元の自由記述 |
| 7 | `confidence` | numeric(4,3) | 可 |  | 照合の確からしさ（0〜1） |
| 8 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- CHECK：`CHECK (((confidence >= (0)::numeric) AND (confidence <= (1)::numeric)))`
- CHECK：`CHECK ((entity_type = ANY (ARRAY['work'::text, 'anime_character'::text, 'tag'::text])))`
- FK：`FOREIGN KEY (answer_id) REFERENCES diagnosis_answers(id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`

インデックス

- `answer_entities_answer`：`btree (answer_id)`
- `answer_entities_entity`：`btree (entity_type, entity_id)`
- `answer_entities_user`：`btree (user_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `answer_entities_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

## マスタ

### works

作品リスト。Q1・Q3・Q12 の照合先

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `title` | text | 不可 |  | 作品名 |
| 3 | `title_kana` | text | 可 |  | 読み |
| 4 | `aliases` | text[] | 不可 | `'{}'::text[]` | 別名 |
| 5 | `is_active` | boolean | 不可 | `true` | 照合・推薦の対象か |
| 6 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |
| 7 | `updated_at` | timestamp with time zone | 不可 | `now()` | 更新日時（トリガーで自動更新） |

制約

- PK：`PRIMARY KEY (id)`

インデックス

- `works_title_trgm`：`gin (title extensions.gin_trgm_ops)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `works_select` | SELECT | authenticated | `USING (is_active OR ( SELECT private.is_admin() AS is_admin))` |

### anime_characters

作品キャラ

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `work_id` | uuid | 不可 |  | 作品ID |
| 3 | `name` | text | 不可 |  | キャラ名 |
| 4 | `aliases` | text[] | 不可 | `'{}'::text[]` | 別名 |
| 5 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- FK：`FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`

インデックス

- `anime_characters_name_trgm`：`gin (name extensions.gin_trgm_ops)`
- `anime_characters_work`：`btree (work_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `anime_characters_select` | SELECT | authenticated | `USING true` |

### tags

タグ（ジャンル・世界観・テンポ・楽しみ方 等）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `tag_type` | text | 不可 |  | genre / world / pace / enjoyment / action_mood / role_mood / development |
| 3 | `code` | text | 不可 |  | タグコード |
| 4 | `label` | text | 不可 |  | 表示名 |

制約

- CHECK：`CHECK ((tag_type = ANY (ARRAY['genre'::text, 'world'::text, 'pace'::text, 'enjoyment'::text, 'action_mood'::text, 'role_mood'::text, 'development'::text])))`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (tag_type, code)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `tags_select` | SELECT | authenticated | `USING true` |

### work_tags

作品タグ

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `work_id` | uuid | 不可 |  | 作品ID |
| 2 | `tag_id` | uuid | 不可 |  | タグID |

制約

- FK：`FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (work_id, tag_id)`

インデックス

- `work_tags_tag`：`btree (tag_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `work_tags_select` | SELECT | authenticated | `USING true` |

## キャラクター・生成・成長

### ai_profiles

生成プロフィール（仕様書 概要7「プロフィール反映」の保存先）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `user_id` | uuid | 不可 |  | ユーザーID |
| 2 | `submission_id` | uuid | 不可 |  | 生成元の診断送信 |
| 3 | `personality` | text | 可 |  | 性格 |
| 4 | `strengths` | text[] | 不可 | `'{}'::text[]` | 得意 |
| 5 | `weaknesses` | text[] | 不可 | `'{}'::text[]` | 苦手 |
| 6 | `profile_items` | jsonb | 不可 | `'[]'::jsonb` | プロフィール項目 [{key,label,values}] |
| 7 | `ai_comments` | jsonb | 不可 | `'[]'::jsonb` | AI コメント |
| 8 | `generated_at` | timestamp with time zone | 不可 | `now()` | 生成日時 |

制約

- CHECK：`CHECK ((jsonb_typeof(ai_comments) = 'array'::text))`
- CHECK：`CHECK ((jsonb_typeof(profile_items) = 'array'::text))`
- FK：`FOREIGN KEY (submission_id) REFERENCES diagnosis_submissions(id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (user_id)`

インデックス

- `ai_profiles_submission`：`btree (submission_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `ai_profiles_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

### characters

マイキャラ。1ユーザー1体。アプリから更新できるのは name のみ（Q-4・L-1・L-5）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 内部ID |
| 2 | `user_id` | uuid | 不可 |  | ユーザーID（1ユーザー1体） |
| 3 | `public_code` | text | 不可 | `private.generate_public_code()` | 画面表示用キャラID（C- ＋ 英数字8文字・変更不可・U-07） |
| 4 | `name` | text | 可 |  | ユーザーが命名・変更（初回は NULL・1〜20文字） |
| 5 | `species` | text | 可 |  | 種族（Q-3） |
| 6 | `class` | text | 可 |  | クラス |
| 7 | `attribute` | text | 可 |  | 属性 |
| 8 | `rarity` | text | 可 |  | レア度 |
| 9 | `status_items` | jsonb | 不可 | `'{}'::jsonb` | 性格・得意・苦手・スキル・ステータス等（項目は増減する） |
| 10 | `title` | text | 可 |  | 称号（Q-7） |
| 11 | `level` | smallint | 不可 | `1` | レベル 1〜100。アプリから更新不可 |
| 12 | `exp_total` | integer | 不可 | `0` | 累計 EXP。アプリから更新不可 |
| 13 | `goodto_points` | integer | 不可 | `0` | グッとポイント。アプリから更新不可 |
| 14 | `image_path` | text | 可 |  | 現在画像の Storage パス（character-images バケット） |
| 15 | `image_status` | text | 不可 | `'none'::text` | none / generating / ready / failed（設計04） |
| 16 | `image_stage` | smallint | 不可 | `0` | 現在画像の進化段階（0 = 初期、5 = Lv.5 …）。進化履歴は保持しない（L-3） |
| 17 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |
| 18 | `updated_at` | timestamp with time zone | 不可 | `now()` | 更新日時（トリガーで自動更新） |

制約

- CHECK：`CHECK ((exp_total >= 0))`
- CHECK：`CHECK ((goodto_points >= 0))`
- CHECK：`CHECK (((image_stage >= 0) AND (((image_stage)::integer % 5) = 0)))`
- CHECK：`CHECK ((image_status = ANY (ARRAY['none'::text, 'generating'::text, 'ready'::text, 'failed'::text])))`
- CHECK：`CHECK (((level >= 1) AND (level <= 100)))`
- CHECK：`CHECK (((name IS NULL) OR ((char_length(name) >= 1) AND (char_length(name) <= 20))))`
- CHECK：`CHECK ((public_code ~ '^C-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$'::text))`
- CHECK：`CHECK ((jsonb_typeof(status_items) = 'object'::text))`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (public_code)`
- UNIQUE：`UNIQUE (user_id)`

権限

- authenticated：SELECT
- authenticated：UPDATE（name）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `characters_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |
| `characters_update_own` | UPDATE | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid)) / WITH CHECK (user_id = ( SELECT auth.uid() AS uid))` |

### generation_jobs

生成ジョブ。失敗時は最大3回自動再試行（app_settings generation.max_retries）し、以降は手動再試行

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `user_id` | uuid | 不可 |  | ユーザーID |
| 3 | `job_type` | text | 不可 |  | diagnosis / character_image / evolution_image / recommendation |
| 4 | `status` | text | 不可 | `'queued'::text` | queued / running / succeeded / failed |
| 5 | `dedupe_key` | text | 不可 |  | 重複生成の防止キー（UNIQUE） |
| 6 | `attempts` | smallint | 不可 | `0` | 試行回数 |
| 7 | `payload` | jsonb | 不可 | `'{}'::jsonb` | 入力（submission_id 等） |
| 8 | `result` | jsonb | 可 |  | 生成結果 |
| 9 | `error_code` | text | 可 |  | 失敗理由 |
| 10 | `run_after` | timestamp with time zone | 不可 | `now()` | 実行可能になる日時（再試行の待機） |
| 11 | `started_at` | timestamp with time zone | 可 |  | 最後に実行を開始した日時 |
| 12 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |
| 13 | `updated_at` | timestamp with time zone | 不可 | `now()` | 更新日時（トリガーで自動更新） |

制約

- CHECK：`CHECK ((attempts >= 0))`
- CHECK：`CHECK ((job_type = ANY (ARRAY['diagnosis'::text, 'character_image'::text, 'evolution_image'::text, 'recommendation'::text])))`
- CHECK：`CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text])))`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (dedupe_key)`

インデックス

- `generation_jobs_status_run_after`：`btree (status, run_after)`
- `generation_jobs_user`：`btree (user_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `generation_jobs_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

### exp_events

成長台帳。characters.exp_total / goodto_points / level の根拠と再計算用（第2段階 P2-6）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `user_id` | uuid | 不可 |  | ユーザーID |
| 3 | `source_type` | text | 不可 |  | goodto_received / goodto_given / admin_adjust |
| 4 | `source_id` | uuid | 可 |  | 発生元（goodtos 等への論理参照） |
| 5 | `exp_delta` | integer | 不可 | `0` | EXP の増減 |
| 6 | `points_delta` | integer | 不可 | `0` | グッとポイントの増減 |
| 7 | `level_after` | smallint | 不可 |  | 反映後のレベル |
| 8 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- CHECK：`CHECK (((level_after >= 1) AND (level_after <= 100)))`
- CHECK：`CHECK ((source_type = ANY (ARRAY['goodto_received'::text, 'goodto_given'::text, 'admin_adjust'::text])))`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`

インデックス

- `exp_events_source_once`：`btree (user_id, source_type, source_id) WHERE (source_id IS NOT NULL)`
- `exp_events_user_created`：`btree (user_id, created_at DESC)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `exp_events_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

### level_thresholds

各レベルに必要な累計 EXP（仮値・U-10）。is_evolution = 5の倍数（L-3）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `level` | smallint | 不可 |  | レベル（1〜100） |
| 2 | `required_exp_total` | integer | 不可 |  | 到達に必要な累計 EXP |
| 3 | `is_evolution` | boolean | 不可 |  | 画像を更新するレベル（5の倍数） |

制約

- CHECK：`CHECK ((is_evolution = (((level)::integer % 5) = 0)))`
- CHECK：`CHECK (((level >= 1) AND (level <= 100)))`
- CHECK：`CHECK ((required_exp_total >= 0))`
- PK：`PRIMARY KEY (level)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `level_thresholds_select` | SELECT | authenticated | `USING true` |

### goodtos

グッと。対象アクションは target_type の追加で拡張（U-10）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `giver_id` | uuid | 不可 |  | 贈り主 |
| 3 | `receiver_id` | uuid | 不可 |  | 受取人（対象の発言者） |
| 4 | `target_type` | text | 不可 |  | 対象の種類（message。拡張可能） |
| 5 | `target_id` | uuid | 不可 |  | 対象ID（論理参照） |
| 6 | `points` | integer | 不可 | `1` | 付与ポイント |
| 7 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- CHECK：`CHECK ((giver_id <> receiver_id))`
- CHECK：`CHECK ((points > 0))`
- CHECK：`CHECK ((target_type = 'message'::text))`
- FK：`FOREIGN KEY (giver_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (receiver_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (giver_id, target_type, target_id)`

インデックス

- `goodtos_receiver_created`：`btree (receiver_id, created_at DESC)`
- `goodtos_target`：`btree (target_type, target_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `goodtos_select_party` | SELECT | authenticated | `USING ((giver_id = ( SELECT auth.uid() AS uid)) OR (receiver_id = ( SELECT auth.uid() AS uid)))` |

## ギルド・メッセージ

### guilds

ギルド。運営のみ作成（GE-1 は対象外）。定員の既定値は app_settings guild.default_capacity

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `name` | text | 不可 |  | ギルド名（部分一致検索の対象） |
| 3 | `description` | text | 可 |  | 説明 |
| 4 | `capacity` | integer | 不可 | `100` | 定員（既定100） |
| 5 | `member_count` | integer | 不可 | `0` | 所属人数 |
| 6 | `status` | text | 不可 | `'published'::text` | published / hidden |
| 7 | `leader_info` | text | 可 |  | リーダー情報（表示用） |
| 8 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |
| 9 | `updated_at` | timestamp with time zone | 不可 | `now()` | 更新日時（トリガーで自動更新） |

制約

- CHECK：`CHECK ((capacity > 0))`
- CHECK：`CHECK ((member_count <= capacity))`
- CHECK：`CHECK (((description IS NULL) OR (char_length(description) <= 1000)))`
- CHECK：`CHECK ((member_count >= 0))`
- CHECK：`CHECK (((char_length(name) >= 1) AND (char_length(name) <= 50)))`
- CHECK：`CHECK ((status = ANY (ARRAY['published'::text, 'hidden'::text])))`
- PK：`PRIMARY KEY (id)`

インデックス

- `guilds_name_trgm`：`gin (name extensions.gin_trgm_ops)`

権限

- authenticated：DELETE, INSERT, SELECT, UPDATE
- authenticated：INSERT（capacity, created_at, description, id, leader_info, member_count, name, status, updated_at）
- authenticated：UPDATE（capacity, created_at, description, id, leader_info, member_count, name, status, updated_at）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `guilds_admin` | ALL | authenticated | `USING ( SELECT private.is_admin() AS is_admin) / WITH CHECK ( SELECT private.is_admin() AS is_admin)` |
| `guilds_select` | SELECT | authenticated | `USING ((status = 'published'::text) OR ( SELECT private.is_admin() AS is_admin))` |

### guild_tags

ギルドタグ

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `guild_id` | uuid | 不可 |  | ギルドID |
| 2 | `tag_id` | uuid | 不可 |  | タグID |

制約

- FK：`FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (guild_id, tag_id)`

インデックス

- `guild_tags_tag`：`btree (tag_id)`

権限

- authenticated：DELETE, INSERT, SELECT, UPDATE
- authenticated：INSERT（guild_id, tag_id）
- authenticated：UPDATE（guild_id, tag_id）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `guild_tags_admin` | ALL | authenticated | `USING ( SELECT private.is_admin() AS is_admin) / WITH CHECK ( SELECT private.is_admin() AS is_admin)` |
| `guild_tags_select` | SELECT | authenticated | `USING (EXISTS ( SELECT 1    FROM guilds g   WHERE ((g.id = guild_tags.guild_id) AND ((g.status = 'published'::text) OR ( SELECT private.is_admin() AS is_admin)))))` |

### guild_members

ギルド所属。参加は参加関数内で行ロックし定員・所属上限を守る（第2段階 P2-4）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `guild_id` | uuid | 不可 |  | ギルドID |
| 2 | `user_id` | uuid | 不可 |  | ユーザーID |
| 3 | `role` | text | 不可 | `'member'::text` | member / leader / staff（発言者情報・C-2） |
| 4 | `joined_at` | timestamp with time zone | 不可 | `now()` | 参加日時 |

制約

- CHECK：`CHECK ((role = ANY (ARRAY['member'::text, 'leader'::text, 'staff'::text])))`
- FK：`FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (guild_id, user_id)`

インデックス

- `guild_members_user`：`btree (user_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `guild_members_select` | SELECT | authenticated | `USING ((user_id = ( SELECT auth.uid() AS uid)) OR private.is_guild_member(guild_id))` |

### guild_announcements

ギルドのお知らせ（G-4）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `guild_id` | uuid | 不可 |  | ギルドID |
| 3 | `title` | text | 不可 |  | 表題 |
| 4 | `body` | text | 不可 |  | 本文 |
| 5 | `published_at` | timestamp with time zone | 不可 | `now()` | 公開日時 |
| 6 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- FK：`FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`

インデックス

- `guild_announcements_guild_published`：`btree (guild_id, published_at DESC)`

権限

- authenticated：DELETE, INSERT, SELECT, UPDATE
- authenticated：INSERT（body, created_at, guild_id, id, published_at, title）
- authenticated：UPDATE（body, created_at, guild_id, id, published_at, title）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `guild_announcements_admin` | ALL | authenticated | `USING ( SELECT private.is_admin() AS is_admin) / WITH CHECK ( SELECT private.is_admin() AS is_admin)` |
| `guild_announcements_select` | SELECT | authenticated | `USING (EXISTS ( SELECT 1    FROM guilds g   WHERE ((g.id = guild_announcements.guild_id) AND ((g.status = 'published'::text) OR ( SELECT private.is_admin() AS is_admin)))))` |

### conversations

会話。kind = guild（トークルーム）/ dm / navigator

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `kind` | text | 不可 |  | guild / dm / navigator |
| 3 | `guild_id` | uuid | 可 |  | トークルームのギルド（kind = guild） |
| 4 | `dm_key` | text | 可 |  | DM の2者のキー（kind = dm） |
| 5 | `owner_id` | uuid | 可 |  | ナビゲーター履歴の所有者（kind = navigator） |
| 6 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- CHECK：`CHECK ((((kind = 'guild'::text) AND (guild_id IS NOT NULL) AND (dm_key IS NULL) AND (owner_id IS NULL)) OR ((kind = 'dm'::text) AND (dm_key IS NOT NULL) AND (guild_id IS NULL) AND (owner_id IS NULL)) OR ((kind = 'navigator'::text) AND (owner_id IS NOT NULL) AND (guild_id IS NULL) AND (dm_key IS NULL))))`
- CHECK：`CHECK ((kind = ANY (ARRAY['guild'::text, 'dm'::text, 'navigator'::text])))`
- FK：`FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (owner_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (dm_key)`
- UNIQUE：`UNIQUE (guild_id)`

インデックス

- `conversations_one_navigator`：`btree (owner_id) WHERE (kind = 'navigator'::text)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `conversations_select` | SELECT | authenticated | `USING private.can_access_conversation(id)` |

### conversation_members

会話の参加者

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `conversation_id` | uuid | 不可 |  | 会話ID |
| 2 | `user_id` | uuid | 不可 |  | ユーザーID |
| 3 | `last_read_at` | timestamp with time zone | 可 |  | 最後に既読にした日時（未読判定） |
| 4 | `joined_at` | timestamp with time zone | 不可 | `now()` | 参加日時 |

制約

- FK：`FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (conversation_id, user_id)`

インデックス

- `conversation_members_user`：`btree (user_id)`

権限

- authenticated：SELECT
- authenticated：UPDATE（last_read_at）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `conversation_members_select` | SELECT | authenticated | `USING private.can_access_conversation(conversation_id)` |
| `conversation_members_update_own` | UPDATE | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid)) / WITH CHECK (user_id = ( SELECT auth.uid() AS uid))` |

### messages

メッセージ。論理削除は deleted_at。履歴上限は app_settings history.*_limit（U-12）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `conversation_id` | uuid | 不可 |  | 会話ID |
| 3 | `sender_type` | text | 不可 |  | user / navigator / system |
| 4 | `sender_id` | uuid | 可 |  | 発言者（退会後は null＝「退会したユーザー」） |
| 5 | `body` | text | 可 |  | 本文（2000文字以内） |
| 6 | `image_path` | text | 可 |  | 画像の Storage パス（message-images バケット） |
| 7 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |
| 8 | `deleted_at` | timestamp with time zone | 可 |  | 論理削除日時 |

制約

- CHECK：`CHECK (((body IS NULL) OR (char_length(body) <= 2000)))`
- CHECK：`CHECK (((sender_type = 'user'::text) OR (sender_id IS NULL)))`
- CHECK：`CHECK (((body IS NOT NULL) OR (image_path IS NOT NULL)))`
- CHECK：`CHECK ((sender_type = ANY (ARRAY['user'::text, 'navigator'::text, 'system'::text])))`
- FK：`FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (sender_id) REFERENCES profiles(user_id) ON DELETE SET NULL`
- PK：`PRIMARY KEY (id)`

インデックス

- `messages_conversation_created`：`btree (conversation_id, created_at DESC)`
- `messages_sender`：`btree (sender_id)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `messages_select` | SELECT | authenticated | `USING ((deleted_at IS NULL) AND private.can_access_conversation(conversation_id) AND ((sender_id IS NULL) OR (NOT private.is_blocked(( SELECT auth.uid() AS uid), sender_id))))` |

## 推薦・通知・安心安全・共通

### recommendations

推薦結果。最新の計算結果のみ保持し、アプリは相性%と一致項目をそのまま表示（M-3）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `user_id` | uuid | 不可 |  | ユーザーID |
| 3 | `kind` | text | 不可 |  | user / guild / work |
| 4 | `target_id` | uuid | 不可 |  | 推薦対象（profiles / guilds / works への論理参照） |
| 5 | `rank` | smallint | 不可 |  | 順位 |
| 6 | `score` | numeric(5,2) | 可 |  | 相性%（0〜100） |
| 7 | `matched_items` | jsonb | 不可 | `'[]'::jsonb` | 一致した項目（アプリはそのまま表示） |
| 8 | `reason` | text | 可 |  | 推薦理由（AI） |
| 9 | `generated_at` | timestamp with time zone | 不可 | `now()` | 計算日時 |

制約

- CHECK：`CHECK ((kind = ANY (ARRAY['user'::text, 'guild'::text, 'work'::text])))`
- CHECK：`CHECK ((jsonb_typeof(matched_items) = 'array'::text))`
- CHECK：`CHECK ((rank >= 1))`
- CHECK：`CHECK (((score >= (0)::numeric) AND (score <= (100)::numeric)))`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`
- UNIQUE：`UNIQUE (user_id, kind, rank)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `recommendations_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

### notifications

アプリ内通知。事象発生時に保存し read_at で既読（NT-1・U-15）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `user_id` | uuid | 不可 |  | ユーザーID |
| 3 | `type` | text | 不可 |  | goodto_received / level_up / guild_announcement / dm_received / system（U-15） |
| 4 | `title` | text | 不可 |  | 表題 |
| 5 | `body` | text | 可 |  | 本文 |
| 6 | `link` | text | 可 |  | アプリ内の遷移先 |
| 7 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |
| 8 | `read_at` | timestamp with time zone | 可 |  | 閲覧日時（null = 未読） |

制約

- CHECK：`CHECK ((type = ANY (ARRAY['goodto_received'::text, 'level_up'::text, 'guild_announcement'::text, 'dm_received'::text, 'system'::text])))`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`

インデックス

- `notifications_user_created`：`btree (user_id, created_at DESC)`
- `notifications_user_unread`：`btree (user_id) WHERE (read_at IS NULL)`

権限

- authenticated：SELECT
- authenticated：UPDATE（read_at）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `notifications_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |
| `notifications_update_own` | UPDATE | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid)) / WITH CHECK (user_id = ( SELECT auth.uid() AS uid))` |

### reports

通報（S-1）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | 不可 | `gen_random_uuid()` | 主キー |
| 2 | `reporter_id` | uuid | 不可 |  | 通報者 |
| 3 | `target_type` | text | 不可 |  | message / character_image / navigator_reply / user |
| 4 | `target_id` | uuid | 不可 |  | 通報対象ID（論理参照） |
| 5 | `reason_code` | text | 不可 |  | spam / harassment / inappropriate / impersonation / other |
| 6 | `detail` | text | 可 |  | 詳細（1000文字以内） |
| 7 | `status` | text | 不可 | `'open'::text` | open / reviewing / resolved / dismissed |
| 8 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- CHECK：`CHECK (((detail IS NULL) OR (char_length(detail) <= 1000)))`
- CHECK：`CHECK ((reason_code = ANY (ARRAY['spam'::text, 'harassment'::text, 'inappropriate'::text, 'impersonation'::text, 'other'::text])))`
- CHECK：`CHECK ((status = ANY (ARRAY['open'::text, 'reviewing'::text, 'resolved'::text, 'dismissed'::text])))`
- CHECK：`CHECK ((target_type = ANY (ARRAY['message'::text, 'character_image'::text, 'navigator_reply'::text, 'user'::text])))`
- FK：`FOREIGN KEY (reporter_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (id)`

インデックス

- `reports_reporter`：`btree (reporter_id)`
- `reports_status_created`：`btree (status, created_at)`

権限

- authenticated：SELECT
- authenticated：INSERT（detail, reason_code, reporter_id, target_id, target_type）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `reports_insert_own` | INSERT | authenticated | `WITH CHECK (reporter_id = ( SELECT auth.uid() AS uid))` |
| `reports_select_own` | SELECT | authenticated | `USING ((reporter_id = ( SELECT auth.uid() AS uid)) OR ( SELECT private.is_admin() AS is_admin))` |

### blocks

ブロック。DM・推薦・メッセージ表示の除外判定に使用（RLS 関数 private.is_blocked）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `blocker_id` | uuid | 不可 |  | ブロックしたユーザー |
| 2 | `blocked_id` | uuid | 不可 |  | ブロックされたユーザー |
| 3 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |

制約

- CHECK：`CHECK ((blocker_id <> blocked_id))`
- FK：`FOREIGN KEY (blocked_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- FK：`FOREIGN KEY (blocker_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (blocker_id, blocked_id)`

インデックス

- `blocks_blocked`：`btree (blocked_id)`

権限

- authenticated：DELETE, SELECT
- authenticated：INSERT（blocked_id, blocker_id）

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `blocks_delete_own` | DELETE | authenticated | `USING (blocker_id = ( SELECT auth.uid() AS uid))` |
| `blocks_insert_own` | INSERT | authenticated | `WITH CHECK (blocker_id = ( SELECT auth.uid() AS uid))` |
| `blocks_select_own` | SELECT | authenticated | `USING (blocker_id = ( SELECT auth.uid() AS uid))` |

### app_settings

デプロイなしで変える調整値（定員・所属上限・履歴上限・配点 等）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `key` | text | 不可 |  | 設定キー（例：guild.default_capacity） |
| 2 | `value` | jsonb | 不可 |  | 設定値（jsonb） |
| 3 | `description` | text | 可 |  | 説明 |
| 4 | `updated_at` | timestamp with time zone | 不可 | `now()` | 更新日時（トリガーで自動更新） |

制約

- CHECK：`CHECK ((key ~ '^[a-z_]+(\.[a-z_*]+)+$'::text))`
- PK：`PRIMARY KEY (key)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `app_settings_select_public` | SELECT | authenticated | `USING (split_part(key, '.'::text, 1) = ANY (ARRAY['diagnosis'::text, 'character'::text, 'guild'::text, 'history'::text, 'navigator'::text, 'growth'::text, 'recommendation'::text]))` |

### idempotency_keys

作成系 POST の応答を24時間保持し、再送時は同じ応答を返す（API01）

| # | 列 | 型 | NULL | 既定値 | 説明 |
|---|---|---|---|---|---|
| 1 | `user_id` | uuid | 不可 |  | ユーザーID |
| 2 | `key` | text | 不可 |  | Idempotency-Key（UUID） |
| 3 | `endpoint` | text | 不可 |  | 対象の操作（例：POST /diagnoses） |
| 4 | `request_hash` | text | 不可 |  | 要求内容の SHA-256（同じキーで内容が異なれば 422） |
| 5 | `status_code` | smallint | 不可 |  | 保存した応答の HTTP ステータス |
| 6 | `response` | jsonb | 不可 |  | 保存した応答本文 |
| 7 | `created_at` | timestamp with time zone | 不可 | `now()` | 作成日時 |
| 8 | `expires_at` | timestamp with time zone | 不可 | `(now() + '24:00:00'::interval)` | 有効期限（24時間） |

制約

- CHECK：`CHECK (((char_length(key) >= 1) AND (char_length(key) <= 255)))`
- FK：`FOREIGN KEY (user_id) REFERENCES profiles(user_id) ON DELETE CASCADE`
- PK：`PRIMARY KEY (user_id, key)`

インデックス

- `idempotency_keys_expires`：`btree (expires_at)`

権限

- authenticated：SELECT

RLS ポリシー

| ポリシー | 操作 | ロール | 条件 |
|---|---|---|---|
| `idempotency_keys_select_own` | SELECT | authenticated | `USING (user_id = ( SELECT auth.uid() AS uid))` |

## 公開ビュー（他ユーザーの公開情報・認証03）

### public_characters

authenticated のみ参照可。退会者・ブロック関係のユーザーを除外する。

```sql
SELECT c.user_id,
    c.public_code,
    c.name,
    c.species,
    c.class,
    c.attribute,
    c.rarity,
    c.title,
    c.level,
    c.image_status,
    c.image_stage
   FROM (characters c
     JOIN profiles p ON ((p.user_id = c.user_id)))
  WHERE ((p.status = 'active'::text) AND (( SELECT auth.uid() AS uid) IS NOT NULL) AND (NOT private.is_blocked(( SELECT auth.uid() AS uid), c.user_id)));
```

### public_profiles

authenticated のみ参照可。退会者・ブロック関係のユーザーを除外する。

```sql
SELECT user_id,
    display_name
   FROM profiles p
  WHERE ((status = 'active'::text) AND (( SELECT auth.uid() AS uid) IS NOT NULL) AND (NOT private.is_blocked(( SELECT auth.uid() AS uid), user_id)));
```

## private スキーマの関数

| 関数 | SECURITY DEFINER | 実行できるロール |
|---|---|---|
| `private.can_access_conversation(p_conversation_id uuid)` | ○ | anon, authenticated |
| `private.characters_immutable_columns()` |  | service_role のみ |
| `private.claim_generation_jobs(p_limit integer)` | ○ | service_role のみ |
| `private.complete_diagnosis_job(p_job_id uuid, p_result jsonb, p_image_path text, p_image_status text)` | ○ | service_role のみ |
| `private.complete_image_job(p_job_id uuid, p_image_path text, p_image_status text)` | ○ | service_role のみ |
| `private.consent_status()` | ○ | authenticated |
| `private.create_diagnosis_submission(p_question_set_id uuid, p_answers jsonb, p_idempotency_key text, p_job_payload jsonb)` | ○ | authenticated |
| `private.diagnosis_precheck(p_question_set_id uuid, p_idempotency_key text)` | ○ | authenticated |
| `private.expire_stale_generation()` | ○ | authenticated |
| `private.fail_generation_job(p_job_id uuid, p_error_code text, p_retry_delay_seconds integer, p_retryable boolean)` | ○ | service_role のみ |
| `private.generate_public_code()` |  | service_role のみ |
| `private.handle_new_user()` | ○ | service_role のみ |
| `private.idempotency_lookup(p_key text, p_endpoint text, p_request_hash text)` | ○ | authenticated |
| `private.idempotency_save(p_key text, p_endpoint text, p_request_hash text, p_status_code integer, p_response jsonb)` | ○ | authenticated |
| `private.is_admin()` |  | anon, authenticated |
| `private.is_blocked(p_a uuid, p_b uuid)` | ○ | anon, authenticated |
| `private.is_guild_member(p_guild_id uuid)` | ○ | anon, authenticated |
| `private.kick_worker()` | ○ | service_role のみ |
| `private.purge_allowed()` |  | service_role のみ |
| `private.purge_withdrawn_users()` | ○ | service_role のみ |
| `private.question_set_accepting(p_question_set_id uuid)` | ○ | service_role のみ |
| `private.question_set_definition(p_question_set_id uuid)` | ○ | service_role のみ |
| `private.retry_diagnosis(p_submission_id uuid, p_job_payload jsonb)` | ○ | authenticated |
| `private.run_maintenance()` | ○ | service_role のみ |
| `private.set_updated_at()` |  | service_role のみ |
| `private.setting_int(p_key text, p_default integer)` | ○ | service_role のみ |
| `private.submission_json(s diagnosis_submissions)` |  | service_role のみ |
| `private.user_consents_append_only()` |  | service_role のみ |
| `private.valid_consent_id(p_user_id uuid, p_doc_type text)` | ○ | authenticated |

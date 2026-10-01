# Anime master CSV templates (A-06)

The client supplies the anime master. The backend does **not** scrape or copy external databases. Fill these UTF-8 CSV files (header row required; Excel: save as "CSV UTF-8").

| File | Columns | Notes |
|------|---------|-------|
| `anime_works.csv` | `external_code`, `title`, `title_kana`, `summary`, `start_year`, `status` | `external_code` is your stable ID (never reuse it). `summary` (≤ 200 characters) is given to the AI as recommendation material; no spoilers. `status`: `active` / `inactive` |
| `work_aliases.csv` | `work_external_code`, `alias` | Abbreviations, nicknames, English titles. Title and kana are added as aliases automatically |
| `anime_characters.csv` | `external_code`, `work_external_code`, `name`, `name_kana`, `status` | |
| `character_aliases.csv` | `character_external_code`, `alias` | Nicknames (e.g. “〇〇くん”) |
| `tags.csv` | `kind`, `code`, `name` | `kind`: `genre`, `world_setting`, `guild_topic`. Keep the genre codes used by Q15 (`action`, `sports`, `school`, `mystery`, `romance`, `sf`) or change the Q15 option mapping together with them |
| `tag_aliases.csv` | `tag_kind`, `tag_code`, `alias` | Words users type for a genre or world setting (e.g. 異世界, いせかい) |
| `work_tags.csv` | `work_external_code`, `tag_kind`, `tag_code` | Genres and world settings of each work (used by anime and guild scoring) |

Validate and import (idempotent upsert by `external_code`; IDs stay stable across imports):

```bash
deno run -A scripts/import-anime-master.ts --dir <dir> --out /tmp/master.sql   # validate + preview
CONIME_DB_URL=... deno run -A scripts/import-anime-master.ts --dir <dir> --apply
```

Matching is exact after normalization (NFKC, case and width folding, katakana → hiragana, punctuation and spaces removed). Values that do not match an alias are sent to AI with at most 15 similar candidates, and AI may only pick one of those IDs. More aliases therefore means fewer AI calls and better accuracy.

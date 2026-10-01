-- Staging overrides (apply after migrations): psql "$STAGING_DB_URL" -f supabase/settings/staging.sql
update app.app_settings set value = '5' where key = 'ai.budget.daily_usd';
update app.app_settings set value = '"low"' where key = 'ai.image.quality';

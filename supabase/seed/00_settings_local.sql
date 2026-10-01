-- Local/test environment settings (applied with the local seed only).
-- Staging and production use supabase/settings/<env>.sql (see docs/DEPLOYMENT.md).
update app.app_settings set value = '0' where key = 'ai.budget.daily_usd';           -- mock provider only
update app.app_settings set value = '"low"' where key = 'ai.image.quality';
-- Local only: allow repeated Postman/newman runs (default 5 per hour per user)
update app.app_settings set value = jsonb_set(value, '{diagnosis_submit,limit}', '100') where key = 'rate_limits';

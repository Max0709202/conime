-- Production overrides (apply after migrations; values require client approval).
update app.app_settings set value = '30' where key = 'ai.budget.daily_usd';
update app.app_settings set value = '"medium"' where key = 'ai.image.quality';

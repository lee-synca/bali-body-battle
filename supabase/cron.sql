-- Bali Body Battle: hourly notification check.
-- Run this AFTER the notify function is deployed.
-- Replace YOUR-PROJECT-REF and YOUR-CRON-SECRET before running.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'bbb-hourly',
  '1 * * * *',  -- one minute past every hour; the function works out Melbourne time itself
  $$
  select net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/notify',
    headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR-CRON-SECRET"}'::jsonb,
    body    := '{"type":"tick"}'::jsonb
  );
  $$
);

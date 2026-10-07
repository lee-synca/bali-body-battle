# Sets up push notifications on Supabase. Run from this folder in PowerShell:  .\deploy-push.ps1 -ProjectRef abcdefghijklmnop
param([Parameter(Mandatory=$true)][string]$ProjectRef)
$v = Get-Content .secrets\vapid.json | ConvertFrom-Json
$cron = (Get-Content .secrets\cron-secret.txt -Raw).Trim()
npx --yes supabase@latest login
npx --yes supabase@latest secrets set --project-ref $ProjectRef "VAPID_PUBLIC_KEY=$($v.publicKey)" "VAPID_PRIVATE_KEY=$($v.privateKey)" "CRON_SECRET=$cron" "VAPID_SUBJECT=https://lee-synca.github.io/bali-body-battle/"
npx --yes supabase@latest functions deploy notify --project-ref $ProjectRef --no-verify-jwt
(Get-Content supabase\cron.sql -Raw).Replace('YOUR-PROJECT-REF', $ProjectRef).Replace('YOUR-CRON-SECRET', $cron) | Set-Content -Encoding utf8 .secrets\cron-ready.sql
Write-Host "Done. Last step: open .secrets\cron-ready.sql, copy it into Supabase SQL Editor and press Run."

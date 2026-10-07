# Sets up Bali Body Battle push notifications on Supabase.
# Easiest way to run it: double-click setup-notifications.bat in this folder.
param([string]$ProjectRef = 'dhtzjuoxzwlxvrzuxvsk')
Set-Location $PSScriptRoot
$v = Get-Content .secrets\vapid.json | ConvertFrom-Json
$cron = (Get-Content .secrets\cron-secret.txt -Raw).Trim()

function Step($text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Fail($text) { Write-Host ""; Write-Host $text -ForegroundColor Red; Write-Host "Take a screenshot of this window for Claude."; exit 1 }

Step "Step 1 of 4: log in to Supabase. Press Enter if asked, then approve in your browser."
npx --yes supabase@latest login
if ($LASTEXITCODE -ne 0) { Fail "Supabase login didn't finish." }

Step "Step 2 of 4: saving the notification keys in Supabase..."
npx --yes supabase@latest secrets set --project-ref $ProjectRef "VAPID_PUBLIC_KEY=$($v.publicKey)" "VAPID_PRIVATE_KEY=$($v.privateKey)" "CRON_SECRET=$cron" "VAPID_SUBJECT=https://lee-synca.github.io/bali-body-battle/"
if ($LASTEXITCODE -ne 0) { Fail "Couldn't save the keys." }

Step "Step 3 of 4: uploading the notification sender..."
npx --yes supabase@latest functions deploy notify --project-ref $ProjectRef --no-verify-jwt --use-api
if ($LASTEXITCODE -ne 0) { Fail "Couldn't upload the notification sender." }

Step "Step 4 of 4: the weekly schedule."
$sql = (Get-Content supabase\cron.sql -Raw).Replace('YOUR-PROJECT-REF', $ProjectRef).Replace('YOUR-CRON-SECRET', $cron)
Set-Clipboard -Value $sql
Start-Process "https://supabase.com/dashboard/project/$ProjectRef/sql/new"
Write-Host "The schedule is copied to your clipboard and Supabase's SQL Editor is opening in your browser."
Write-Host "In the editor: click inside it, press Ctrl+V to paste, then click the green Run button."
Write-Host ""
Write-Host "All done! Tell Claude once you've pressed Run." -ForegroundColor Green

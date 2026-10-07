# Bali Body Battle

Family weight-loss competition for the Bali Christmas trip. Week 0 weigh-in Sunday 11 Oct 2026, final weigh-in Sunday 20 Dec 2026, results revealed 7pm Melbourne time every Sunday.

- **App:** static web app hosted on GitHub Pages (`index.html`, `app.js`, `styles.css`, `sw.js`)
- **Database and logins:** Supabase (free tier)
- **Push notifications:** Supabase Edge Function `notify` plus an hourly scheduled job
- `demo.html` is the click-through demo with example players. It doesn't touch the database.

## Privacy
Weights are stored in the `weighins` table, and row-level security only lets each person read their own rows. Everyone else's results reach the app only as percentages, through the `leaderboard()` function, and only after the 7pm reveal.

## One-time setup

### 1. Supabase project
1. Sign up at supabase.com and create a project named `bali-body-battle`. Pick the Sydney region and save the database password somewhere safe.
2. **SQL Editor → New query:** paste in all of `supabase/schema.sql` and press **Run**.
3. **Authentication → Sign In / Providers → Email:** turn **off** "Confirm email". Family can then join straight away without confirmation emails, which Supabase's free email service limits heavily.
4. **Project Settings → API:** copy the **Project URL** and the **anon / publishable key** into `config.js`.

### 2. GitHub Pages
Push this folder to `lee-synca/bali-body-battle`, then go to **Settings → Pages → Deploy from branch → main / root**.
The app will be at `https://lee-synca.github.io/bali-body-battle/`.

Finally, add that URL in Supabase under **Authentication → URL Configuration → Site URL**.

### 3. Push notifications
In PowerShell, in this folder:
```
.\deploy-push.ps1 -ProjectRef YOUR-PROJECT-REF
```
The script:
- logs you into Supabase in the browser
- stores the notification keys as Supabase secrets
- deploys the `notify` function
- writes `.secrets\cron-ready.sql`

To finish, paste `.secrets\cron-ready.sql` into the SQL Editor and press Run.

`.secrets/` holds private keys. It's git-ignored, so never commit it.

## Running the battle
- **Invite:** send `https://lee-synca.github.io/bali-body-battle/#BALI-2026`
- **Forgotten password:** Supabase → Authentication → Users → the person → Send password recovery, or delete their user so they can re-join.
- **Wrong weight entered by someone:** Table Editor → `weighins`.
- **Remove a player:** Table Editor → `players` → delete the row. Their weigh-ins go with it.

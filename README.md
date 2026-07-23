# Store Ops Dashboard

Store Master data (editable) + a foundation for Sales / Bills / Payroll /
Expenses upload-and-process modules.

Stack: **Next.js** (frontend, hosted free on Vercel) + **Supabase** (free
database + auth). Everything below is free-tier.

---

## 1. Create your Supabase project (database + login)

1. Go to https://supabase.com → sign in with GitHub → **New project**
2. Pick any name/region, set a database password (save it somewhere), wait ~2 min for it to spin up
3. In the left sidebar: **SQL Editor** → **New query** → paste the entire contents of
   `supabase/schema.sql` from this repo → **Run**
   - This creates the `stores` table and the security rules (only logged-in
     team members can read/write).
4. Left sidebar: **Project Settings → API** → copy:
   - `Project URL`
   - `anon public` key
   (you'll need these in step 3 below)

### Import your existing store data
1. Left sidebar: **Table Editor → stores → Insert → Import data from CSV**
2. Upload `supabase/store_master_import.csv` (already included in this repo —
   it's your uploaded store sheet, cleaned and mapped to the right columns)
3. Confirm the column mapping matches, then import. All 115 stores load in one shot.

### Add your team members (login accounts)
1. Left sidebar: **Authentication → Users → Add user**
2. Enter each team member's email + a temporary password, repeat for each person
3. They can change their password after first login (or you can build a
   "forgot password" flow later — ask me when you're ready)

---

## 2. Push this project to GitHub

```bash
cd store-dashboard
git init
git add .
git commit -m "Initial store ops dashboard"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

(Create the empty repo on GitHub first at https://github.com/new — don't
initialize it with a README, so the push above doesn't conflict.)

---

## 3. Deploy to Vercel (free)

1. Go to https://vercel.com → sign in with GitHub → **Add New → Project**
2. Import the GitHub repo you just pushed
3. Before deploying, expand **Environment Variables** and add:
   - `NEXT_PUBLIC_SUPABASE_URL` = (Project URL from step 1)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = (anon public key from step 1)
4. Click **Deploy**. In ~1 minute you'll have a live URL like
   `your-project.vercel.app`

From now on: every time new code is pushed to the `main` branch on GitHub,
Vercel automatically redeploys. That's the "connected to Claude" part —
once Claude Code is pushing commits for you, your live site updates itself.

---

## 4. Run it locally while developing (optional but recommended)

```bash
cd store-dashboard
npm install
cp .env.local.example .env.local
# edit .env.local and paste in your Supabase URL + anon key
npm run dev
```

Visit http://localhost:3000 — sign in with a team member account you
created in step 1.

---

## 5. Hand this off to Claude Code for ongoing changes

1. Install Claude Code (desktop app)
2. Open this project folder in it
3. Just describe changes in plain English, e.g.:
   - "Add a Sales upload page that lets me pick a file and matches rows to
     stores by Epay ID"
   - "Add a column for store phone number to the master table"
4. Claude Code edits the files, commits, and pushes — Vercel redeploys
   automatically within a minute or two

---

## What's built so far

- ✅ Team login (Supabase Auth)
- ✅ Store Master: full table view, search, filter by market, add/edit/delete
- ✅ Your 115 stores ready to import via CSV
- ⏳ Sales / Bills / Payroll / Expenses upload + processing — placeholders
  in the sidebar, waiting on sample file formats to build the matching and
  calculation logic

## Project structure

```
app/
  login/page.js       — sign-in screen
  stores/page.js       — the Store Master dashboard (main screen)
  layout.js, page.js   — app shell / redirect
lib/
  supabaseClient.js    — Supabase connection helper
supabase/
  schema.sql            — run once in Supabase SQL Editor
  store_master_import.csv — your store data, ready to import
```

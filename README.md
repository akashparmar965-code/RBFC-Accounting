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
- ✅ JV Entry (`/jv-entry`): a single upload screen with an Entry Type
  picker — Sales Journal Entry, VIP Bills (Device + Service combined),
  VIP Device Expense only, VIP Service Expense only —
  a JV Date, drag-and-drop upload, an on-page Preview, and CSV/XLSX
  export either combined ("All-in-One") or split by company
  ("Company-wise"), all matched against live Store Master data
- ✅ Bills (`/bills`): a dedicated, no-picker-needed VIP upload — device
  and service lines always come back combined, one file per company
- ✅ Checklist (`/checklist`): your monthly reconciliation & recurring-task
  tracker, per company — click a month cell to mark it done, add or delete
  items freely
- ⏳ Payroll / Expenses upload + processing — placeholders in the
  sidebar, waiting on sample file formats to build the matching and
  calculation logic

### How JV Entry works — Sales

1. Upload the raw sales detail export (.xlsx)
2. It's parsed entirely in your browser (nothing uploaded to a server)
3. Rows are grouped by store, excluding voided transactions
4. Each store's totals split into three buckets by vendor:
   - **Device** — everything except accessory distributors and ePay
   - **Accessories** — Ondigo, C2 Wireless, VoiceComm
   - **Bill Payment-Epay** — ePay
5. Tax is broken out as separate rows per bucket
6. Stores are matched to your live Store Master by "Elevate Name" to get
   the QBO Class and Company grouping
7. Download as one combined file ("All-in-One") or one file per company
   ("Company-wise"), in CSV or XLSX

If a new accessory vendor gets added later, update the list in
`lib/salesProcessor.js` (`ACCESSORIES_VENDORS`) — or just ask Claude Code
to add it.

### How JV Entry works — VIP Device / Service Expense

1. Pick "VIP Bills (Device + Service)" as the Entry Type to get both in
   one file, or "VIP Device Expense" / "VIP Service Expense" to get just
   one — then upload the raw VIP export (.xlsx) — only the **Bill** sheet
   is used; Payment and Credit Note sheets are ignored for now
2. It's parsed entirely in your browser (nothing uploaded to a server)
3. Line items are grouped per invoice (by Door Number + Invoice Number).
   A line counts as a **device** sale when its Memo is just the invoice
   number restated (VIP does this for straight device orders); anything
   else (e.g. "Managed Services Fees…") is a **service** line
4. Device lines use Expense Account "All Devices"; service lines use
   "Other Services VIP" and keep their original memo text
5. Door Number is matched to your live Store Master's "VIP Website No."
   to get the QBO Class and Company grouping
6. Each row keeps its own invoice's transaction date from the file (the
   JV Date field only applies to Sales Journal Entry)
7. Download as one combined file ("All-in-One") or one file per company
   ("Company-wise"), in CSV or XLSX, ready to import into QuickBooks as
   bills

## Project structure

```
app/
  login/page.js        — sign-in screen
  stores/page.js        — the Store Master dashboard (main screen)
  jv-entry/page.js      — JV Entry: Sales / VIP Device / VIP Service uploads
  sales/page.js, bills/page.js — redirect to /jv-entry (old links)
  layout.js, page.js    — app shell / redirect
components/
  Sidebar.js             — shared nav
lib/
  supabaseClient.js      — Supabase connection helper
  salesProcessor.js      — Sales Journal Entry parsing/export logic
  billsProcessor.js      — VIP Device/Service Expense parsing/export logic
supabase/
  schema.sql            — run once in Supabase SQL Editor
  store_master_import.csv — your store data, ready to import
```

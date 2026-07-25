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
- ✅ Your 115 stores ready to import via CSV
- ✅ Sales (`/sales`): upload the raw sales export, get back QBO-ready
  journal CSVs/XLSX split by company — a JV Date, drag-and-drop upload,
  per-company selection with an on-page Preview, matched against live
  Store Master data
- ✅ Bills (`/bills`): two sub-tabs —
  **VIP** (device + service lines always come back combined, one file per
  company) and **Epay** (splits each invoice into an Income upload and a
  Purchase upload, one pair of files per company)
- ✅ Checklist (`/checklist`): your monthly reconciliation & recurring-task
  tracker, per company — click a month cell to mark it done, add or delete
  items freely
- ✅ Mapping Master (`/mappings`): three tabs — **Store Master** (full
  table view, search, filter by market/company, add/edit/delete — the
  same UI that used to be its own sidebar item), **VIP** (Product Mapping
  classifies VIP line items by their Products text; Door Mapping covers
  VIP Door Numbers not yet in Store Master), and **Epay** (Epay Account
  Mapping covers Epay Account Numbers not yet in Store Master)
- ✅ Payroll (`/payroll`): type in company-wise payroll per pay period
  (persisted, keyed by date), upload the Employee Timesheet, allocate to
  stores weighted by hours worked, and generate a per-company Journal
  Entry (Journal Date/Account/Debit/Credit/Class/Memo) — same
  select/preview/download UX as Bills
- ⏳ Expenses upload + processing — placeholder in the sidebar, waiting
  on sample file formats to build the matching and calculation logic

### How Sales works

1. Upload the raw sales detail export (.xlsx)
2. It's parsed entirely in your browser (nothing uploaded to a server)
3. Rows are grouped by store, excluding voided transactions
4. Each store's totals split into three buckets by vendor:
   - **Device** — everything except accessory distributors and ePay
   - **Accessories** — Ondigo, C2 Wireless, VoiceComm
   - **Bill Payment-Epay** — ePay
5. Tax is broken out as separate rows per bucket
6. Stores are matched to your live Store Master by "Elevate Name" to get
   the QBO Class and Company grouping; every row is stamped with the JV
   Date you set
7. Check/uncheck companies, Preview selected, then download per company
   (CSV or XLSX) or all companies zipped together

If a new accessory vendor gets added later, update the list in
`lib/salesProcessor.js` (`ACCESSORIES_VENDORS`) — or just ask Claude Code
to add it.

### How Bills works — VIP

1. On the Bills page, stay on the **VIP** tab (the default) and upload the
   raw VIP export (.xlsx) — only the **Bill** sheet is used; Payment and
   Credit Note sheets are ignored for now
2. It's parsed entirely in your browser (nothing uploaded to a server)
3. Line items are grouped per invoice (by Door Number + Invoice Number)
   and classified by their **Products** text — not Memo, which is often
   generic (e.g. just the invoice number restated) or inconsistent.
   Whichever prefix a line's Products starts with (case-insensitive) in
   **Product Mapping** (`/mappings`) determines its Expense Account; a
   line matching no prefix is excluded and shown as an error so you can
   add the new product instead of it being guessed at
4. Lines combine into one row per invoice per matched Expense Account
   (e.g. six different phone models on one invoice still post as one
   "All Devices" line), keeping their original Memo text unless the
   mapping rule overrides it
5. Door Number is matched to your live Store Master's "VIP Website No.";
   if it's not there, **Door Mapping** (`/mappings`) is checked as a
   fallback before the line is flagged as unmatched
6. Each row keeps its own invoice's transaction date from the file
7. Check/uncheck companies, Preview selected, then download per company
   (XLSX/CSV) or all companies zipped together, ready to import into
   QuickBooks as bills

### How Bills works — Epay

1. On the Bills page, switch to the **Epay** tab and upload the raw Epay
   invoices export (.csv or .xlsx) — columns: Store Name, Account Number,
   Invoice Date, Invoice Number, Credit Amount, Debit Amount
2. It's parsed entirely in your browser (nothing uploaded to a server)
3. Each row becomes an **Income** row (if Credit Amount > 0) or a
   **Purchase** row (if Debit Amount > 0) — Income rows post as "Rebate"
   sales to customer "PAYSPOT INC SALES"; Purchase rows post as
   "Bill Payment-Epay" bills from vendor "PAYSPOT INC"
4. Account Number is matched to your live Store Master's "Epay" field to
   get the same QBO Class used by VIP; if it's not there, **Epay Account
   Mapping** (`/mappings`) is checked as a fallback before the row is
   flagged as unmatched
5. Download as one combined file ("All-in-One") or one Income + one
   Purchase file per company ("Company-wise"), in CSV or XLSX

## Project structure

```
app/
  login/page.js        — sign-in screen
  sales/page.js          — Sales Journal Entry upload
  bills/page.js          — Bills: VIP and Epay sub-tabs
  checklist/page.js      — Accounting Checklist
  mappings/page.js       — Mapping Master: Store Master / VIP / Epay tabs
  jv-entry/page.js, stores/page.js — redirect to /sales, /mappings (old links)
  layout.js, page.js    — app shell / redirect
components/
  Sidebar.js             — shared nav
  StoreMasterPanel.js    — Store Master table/search/filter/add/edit/delete UI
lib/
  supabaseClient.js      — Supabase connection helper
  salesProcessor.js      — Sales Journal Entry parsing/export logic
  billsProcessor.js      — VIP Device/Service Expense parsing/export logic
  epayProcessor.js       — Epay Income/Purchase parsing/export logic
  fileNaming.js           — shared export filename builder
supabase/
  schema.sql            — run once in Supabase SQL Editor
  store_master_import.csv — your store data, ready to import
```

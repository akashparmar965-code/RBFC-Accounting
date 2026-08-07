// Content for the SOP (Standard Operating Procedure) page. Kept as data,
// separate from the page's layout, so it can be updated without touching
// JSX. Every fact here describes behavior that actually exists in the
// corresponding page/processor module — this is documentation of what the
// app does, not aspirational/planned behavior.

export const SHARED_CONCEPTS = [
  {
    term: "Store Master",
    body:
      "The master list of every store, on Mapping Master's \"Store Master\" tab. Every upload page matches raw store names from a source file against Store Master's Elevate Name. A store that can't be matched is excluded from that run's output and flagged on-screen — never guessed. If you see a warning banner listing unmatched store names, that's real money not making it into a Journal Entry until it's fixed.",
  },
  {
    term: "Class = QBO Class",
    body:
      "Every Journal Entry line's \"Class\" column is Store Master's \"QB Class Name\" field (e.g. \"AK - 12th-7524\"), not the plain store name (\"AK - 12th\"). This is the code QuickBooks Online actually uses to track P&L by location — if a store's QB Class Name is wrong or missing in Store Master, every JE for that store will post with the wrong Class.",
  },
  {
    term: "Company",
    body:
      "Store Master's \"Company\" field (e.g. \"RBFC YOUNGSTOWN LLC\") is the legal entity each store's books belong to. Every JE-generating page groups its output by Company and gives you one downloadable file per company — because each company is a separate set of books in QuickBooks and gets imported separately.",
  },
  {
    term: "Store Name Mapping (typo/rename fallback)",
    body:
      "Source systems don't always spell a store's name exactly the way Store Master does (renames, casing, typos — e.g. a store renamed from \"EP - Butler\" to \"WP - Butler\"). Mapping Master's \"Store Mapping\" tab is a fallback list of raw name → correct Elevate Name. Any upload that hits an unmatched store name pushes it there as a suggested chip, so you can fix the mapping once and re-upload rather than losing that store's data every month.",
  },
  {
    term: "\"Upload to QuickBooks\"",
    body:
      "Every finished file downloads with the exact columns QuickBooks Online's Journal Entry (or Bank Deposit, for AR Deposits) import expects — Date/Account/Debit/Credit/Class, sometimes plus Memo. Always check the per-company Dr = Cr balance shown in the page's preview before importing. If a company's total is out of balance, do not import it — that means something upstream (a missing store, an unmapped account) needs fixing first.",
  },
];

export const SOP_SECTIONS = [
  {
    key: "sales",
    title: "Sales",
    route: "/sales",
    summary: "Turns the monthly sales export into Device / Accessories / Bill Payment-Epay + tax income lines, one file per company.",
    source: [
      "Download the \"Bookkeeping Sale Details\" export for the full month (file name pattern: Bookkeeping_Sale_Details_MMDDYYYY-MMDDYYYY.xlsx).",
      "Set the \"Month\" field on the page to the month you're closing — the file's own declared date range must fall entirely inside that month, or the upload is rejected. This catches an accidentally-wrong file before it corrupts a month's numbers.",
    ],
    processing: [
      "Each row's Store is matched to Store Master's Elevate Name (with the Store Mapping fallback).",
      "Rows are classified and summed by vendor into Device, Accessories, and Bill Payment-Epay buckets, plus tax.",
      "Rows are grouped by Company, matching Store Master.",
    ],
    finalize: [
      "Set the JV Date (this page is the only one with a manual JV Date stamp — every line in the output uses this single date, not each transaction's own date).",
      "Review the per-company totals, then download each company's file (or all companies as a zip) and import into that company's QuickBooks.",
    ],
    watchFor: [
      "A store that doesn't match Store Master won't have its sales counted anywhere — check the unmatched-store warning every run.",
      "The JV Date is typed once and applied to the whole month's entry — double check it before generating.",
    ],
  },
  {
    key: "deposits",
    title: "AR Deposits",
    route: "/deposits",
    summary: "Turns the daily/monthly X-Report tender totals into one deposit line per store per tender type, ready for a Bank Deposit import.",
    source: [
      "Download the \"X-Report\" export covering the period (file name pattern: X-Report_MMDDYYYY-MMDDYYYY.xlsx). It has one sheet per store, each with a \"Tendered Amounts\" table listing that store's Cash/Check/Credit Card/Debit Card/Gift Card/Store Account (and sometimes Acima/Financing/Likewise) totals.",
    ],
    processing: [
      "Each store sheet's tender-type amounts (the \"Sub Net\" column) are pulled out automatically.",
      "A tender type with a $0 amount that day/period is dropped — it isn't a real deposit.",
      "Each remaining line is matched to Store Master (for Class and Company) and to Mapping Master's \"AR Deposits\" tender-type mapping (for Deposit To Account and Payment Method).",
      "Received From / From Account / Memo are pulled from Mapping Master's AR Deposits > Defaults — not typed per run.",
    ],
    finalize: [
      "Set the Deposit Date, upload the X-Report, and review the per-company preview (grouped exactly like the other JE pages — one table per company).",
      "Download each company's file and import as a Bank Deposit in that company's QuickBooks.",
    ],
    watchFor: [
      "A tender type with no row yet on Mapping Master's AR Deposits tab still posts, but with a blank Deposit To Account/Payment Method (shown as a space) — add it there so it posts to a real account instead.",
      "\"Comapny\" is spelled that way on purpose in the raw/all-data export — it matches the exact column header the QuickBooks import template expects, not a typo to fix.",
    ],
  },
  {
    key: "bills-vip",
    title: "Bills — VIP",
    route: "/bills",
    summary: "Turns a VIP invoice export into per-invoice, per-expense-account bill lines, one file per company.",
    source: ["Download the VIP export and use its \"Bill\" sheet (the VIP tab only reads that sheet)."],
    processing: [
      "Each line is classified by its Products text — not Memo, which is often too generic or inconsistent to classify by. The Products text is prefix-matched (case-insensitive) against Mapping Master's Product Mapping list.",
      "A line whose Products text matches no known prefix is excluded and flagged — never guessed at.",
      "Door Number is matched to Store Master's \"VIP Website No.\" field, falling back to Mapping Master's Door Mapping.",
      "Matching lines are combined per invoice per Expense Account.",
    ],
    finalize: [
      "Each invoice keeps its own original date (there's no manual date override on this tab, unlike Sales).",
      "Review and download per company, then import as Bills in that company's QuickBooks.",
    ],
    watchFor: [
      "A Products text with no Product Mapping entry is silently excluded from the totals — check the flagged list every run and add new product lines to Product Mapping as VIP introduces them.",
      "A Door Number not in Store Master or Door Mapping is excluded the same way — add it to Door Mapping.",
    ],
  },
  {
    key: "bills-epay",
    title: "Bills — Epay",
    route: "/bills",
    summary: "Splits an Epay invoices export into Income (rebates) and Purchase (bill payment fees) lines, one pair per company.",
    source: ["Download the Epay invoices export."],
    processing: [
      "A row with Credit Amount > 0 becomes an Income line (a \"Rebate\" sale to PAYSPOT INC SALES).",
      "A row with Debit Amount > 0 becomes a Purchase line (a \"Bill Payment-Epay\" bill from PAYSPOT INC).",
      "Account Number is matched to Store Master's \"Epay\" field, falling back to Mapping Master's Epay Account Mapping.",
    ],
    finalize: [
      "Review and download the Income and Purchase files per company, then import into that company's QuickBooks (Income as a Sales Receipt/Invoice, Purchase as a Bill, matching however your QuickBooks workflow already handles these two Epay transaction types).",
    ],
    watchFor: [
      "An Account Number not in Store Master's Epay field or Epay Account Mapping is excluded — add it to Epay Account Mapping.",
    ],
  },
  {
    key: "payroll-main",
    title: "Payroll — Main",
    route: "/payroll",
    summary: "Allocates company-level payroll totals to stores by hours worked, then builds the payroll JE.",
    source: [
      "Company-wise payroll numbers are typed in by hand per pay period (or auto-filled by uploading each company's own \"Custom Report\" export — the page matches by header label text, not column position, and guesses which company a file belongs to from its file name).",
      "An Employee Timesheet export for the same pay period (file name pattern: Employee_time_Sheet-Payroll_MMDDYYYY-MMDDYYYY.xlsx).",
    ],
    processing: [
      "The timesheet's \"Total Working Time Decimal\" is summed per store (matched to Store Master, with the Store Mapping fallback) to get each store's hours for the period.",
      "Each payroll field is allocated to a store in proportion to that store's share of its company's total hours.",
      "Final per-store figures are derived from the allocated amounts (Regular Pay, Bonus, Overtime Pay, Additional Earnings, Payroll Taxes-Employer, Reimbursement to Employees, Payroll Tax Liabilities, and a balancing Payroll Liabilities figure) — these formulas were confirmed directly with the business, not guessed.",
    ],
    finalize: [
      "The JE debits Regular Pay/Overtime/Bonus/Additional Earnings/Payroll Taxes-Employer/Reimbursement per store, and credits Payroll Liabilities/Payroll Tax Liabilities.",
      "Review the Entered-vs-Dr/Cr check on the preview (a cent or two of rounding drift between what you typed and what got allocated is expected and fine), then download per company and import into QuickBooks.",
    ],
    watchFor: [
      "If the Employee Timesheet's own declared date range doesn't match the selected Pay Period Date, the upload is rejected outright — this is a real protection against applying last month's hours to this month's payroll.",
      "A store with zero hours that period gets zero allocation, not a guessed share.",
    ],
  },
  {
    key: "payroll-arcade",
    title: "Payroll — Arcade & Subcontractor",
    route: "/payroll",
    summary: "Same store-hours allocation as main Payroll, but for the Arcade and Subcontractor fields, with a different JE shape.",
    source: ["Its own pay period date, its own persisted grid (Arcade/Subcontractor numbers), and its own Employee Timesheet upload — independent of the main Payroll tab's data."],
    processing: ["Same store-hours-weighted allocation logic as main Payroll, applied to just the Arcade/Subcontractor fields."],
    finalize: [
      "One debit line per store per nonzero field (Class = store), plus one credit line per company per field named \"<Field> Payable\" (no Class) — sized to exactly match the sum of that field's debit lines, so it's always balanced regardless of rounding.",
      "Download per company and import into QuickBooks.",
    ],
    watchFor: [
      "This sub-tab does not currently check the timesheet's date range against the pay period the way the main Payroll tab does — double-check the uploaded timesheet is for the right period yourself.",
    ],
  },
  {
    key: "inventory-change",
    title: "Change in Inventory",
    route: "/inventory",
    summary: "Compares Opening vs Closing inventory value per store and posts the difference.",
    source: [
      "Two separate exports: Opening Inventory and Closing Inventory (each a snapshot of on-hand inventory value by store, taken on different dates — not one combined file).",
    ],
    processing: [
      "Each file's \"Total Cost\" is summed by Store (matched to Store Master, with the Store Mapping fallback).",
      "Every Store Master row gets a result — Opening Stock, Closing Stock, and Change in Inventory (Opening − Closing) — even if a store has $0 in both files. Nothing is skipped just because a store didn't move.",
    ],
    finalize: [
      "Set the JE Date, review the Opening/Closing/Change preview per store, then Generate.",
      "Inventory decreased (change > 0) → Dr Change in Inventory / Cr Inventory. Inventory increased (change < 0) → reversed.",
      "Download per company and import into QuickBooks.",
    ],
    watchFor: [
      "A store missing from one of the two files is treated as $0 for that side, not excluded — check the unmatched-store warning if a raw store name in either file doesn't match Store Master at all.",
    ],
  },
  {
    key: "devices-lost",
    title: "Devices Lost",
    route: "/inventory",
    summary: "Turns the Inventory Aging (LOST bin) report into a monthly device write-off entry per store — second tab on the Change in Inventory page.",
    source: [
      "The \"Inventory Aging\" export (file name pattern: Inventory_Aging_MMDDYYYY.xlsx — the date in the name is the report's as-of date). Every row in this export is already a device sitting in the \"LOST\" bin.",
    ],
    processing: [
      "Each row's \"Age in Store\" (days) is subtracted from the report's as-of date to get that device's entry date — the date it actually became Lost.",
      "Only rows whose entry date falls in the selected Entry Month count. Amounts (Cost × Qty) are summed by store for that month.",
      "A store with no loss that month produces no line at all — unlike Change in Inventory's sibling tab, a $0 loss isn't posted.",
    ],
    finalize: [
      "Two JV pairs per store with a loss: (1) Dr Inventory / Cr Change in Inventory, (2) Dr Devices Lost / Cr Inventory.",
      "Download per company and import into QuickBooks.",
    ],
    watchFor: [
      "Set the Report Date and Entry Month correctly — the whole calculation depends on both. The Report Date auto-fills from the file name but is editable if it's ever wrong.",
    ],
  },
  {
    key: "stock-transfer",
    title: "Stock Transfer",
    route: "/store-transfer",
    summary: "Posts device transfers between stores — Devices Transfer Out/In per store, plus inter-company Stock Transfer balance lines.",
    source: ["The \"Store Transfer Receiving Details\" export — one row per transferred item, with From store, To store, and Ext Cost."],
    processing: [
      "Both From and To are matched to Store Master (with the Store Mapping fallback). \"Company Warehouse\" is recognized as a real, non-billable counterpart specific to this page. A row is dropped entirely — not half-posted — unless both sides match.",
      "Rows are grouped by sending store (one Cr Devices Transfer Out line for the store's whole total) and by receiving store (one Dr Devices Transfer In line for the store's whole total).",
      "Within each of those groups, same-company destinations/sources combine into one plain \"Stock Transfer\" line; a different company gets its own \"Stock Transfer: <Company>\" line — this is what carries the real inter-company balance.",
    ],
    finalize: [
      "Every line posts to the store's own company's JE — so a company's file contains both its stores' outgoing and incoming transfer entries.",
      "Download per company and import into QuickBooks.",
    ],
    watchFor: [
      "The 3 account names (Devices Transfer Out/In, Stock Transfer) are editable on Mapping Master's Stock Transfer tab — don't hardcode them elsewhere.",
      "A row where either From or To doesn't match Store Master is dropped, not partially posted — check the unmatched-store warning.",
    ],
  },
  {
    key: "inventory-flow",
    title: "Inventory Flow",
    route: "/inventory-flow",
    summary: "An audit tool, not a Journal Entry — traces every device serial to find what's missing, in transit, or unexplained.",
    source: [
      "All 7 uploads are required for a run: Opening Inventory, Closing Inventory, Purchase Order Receiving, Store Transfer Shipment, Store Transfer Receiving, Sales, and Vendor Return (RMA).",
    ],
    processing: [
      "Every serial's full timeline across all 6 data-carrying files is assembled, then classified: Missing, In Transit, Store Mismatch, Sold Anomalies, Unexplained New, or Vendor Returns.",
      "A device shipped back to the vendor (RMA) is never counted as Missing — it has a known, final disposition.",
      "Cost/value analytics roll each category up into dollar totals, plus Opening/Closing inventory value and monthly transfer/purchase/return flow value.",
    ],
    finalize: [
      "There's nothing to import into QuickBooks from this page — it's for investigating discrepancies (a device that should be somewhere but isn't) before or alongside the other entries above, and for spotting patterns (which stores are losing devices, how much is moving between which stores).",
    ],
    watchFor: [
      "The Sales-side device-identification rule (a Sales line only counts as the device's own line when its Category column is non-blank) was reverse-engineered from real data, not confirmed line-by-line with the business — worth a second look if Sold/Sold-Anomaly counts ever look off.",
    ],
  },
  {
    key: "manual-jv-main",
    title: "Manual JV — Main",
    route: "/manual-jv",
    summary: "Freeform JV lines, split equally across whichever stores were active (had hours) that period.",
    source: ["An Employee Timesheet upload for the period, used only to determine which stores were active — not for hours-weighting."],
    processing: [
      "Any store with nonzero hours that period counts as active. A typed line's amount is divided evenly across however many stores were active system-wide — a flat equal split, explicitly not hours-weighted like Payroll.",
      "A line with \"split per store\" checked explodes into one row per active store (Class = store); unchecked, it collapses into one row per company scaled by that company's share of active stores.",
    ],
    finalize: ["Download per company and import into QuickBooks."],
    watchFor: ["This is a flat per-store split, not proportional to hours — don't confuse it with how main Payroll allocates."],
  },
  {
    key: "manual-jv-company-split",
    title: "Manual JV — Company Split",
    route: "/manual-jv",
    summary: "Freeform JV lines split equally across one chosen company's own Active stores — no timesheet involved.",
    source: ["No file upload — lines are (Account Name, Company, Debit, Credit) typed directly."],
    processing: [
      "A line's amount is divided evenly across that company's Active-status stores in Store Master (not \"active this period\" like the Main tab — literally Store Master's Active/Closed status).",
      "Any store except the last one (in Store Master's own row order) gets the plain fair share; the last store absorbs whatever rounding remainder is left, so the company's JE always reconciles exactly.",
      "A company referenced with zero Active stores is skipped and surfaced as a warning, never guessed.",
    ],
    finalize: ["Download per company and import into QuickBooks."],
    watchFor: ["A store's Active/Closed status in Store Master directly controls whether it gets a share here — keep that status current."],
  },
];

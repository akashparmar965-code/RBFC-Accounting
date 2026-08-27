"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabaseClient";
import Sidebar from "@/components/Sidebar";
import StoreMasterPanel from "@/components/StoreMasterPanel";
import {
  loadPendingMappings,
  removePendingDoor,
  removePendingAccount,
  removePendingProductsMatching,
  removePendingStoreName,
  removePendingTenderType,
  removePendingOndigoAddress,
  removePendingCreditNoteProductsMatching,
  clearPendingList,
} from "@/lib/pendingMappings";

const emptyProductDraft = { product_prefix: "", match_type: "starts_with", expense_account: "", expense_memo: "", notes: "" };
const MATCH_TYPE_OPTIONS = [
  { value: "starts_with", label: "Starts with" },
  { value: "contains", label: "Contains" },
  { value: "exact", label: "Fully matching" },
];
const emptyDoorDraft = { door_number: "", company_name: "", qbo_class: "", notes: "" };
const emptyAccountDraft = { account_number: "", company_name: "", qbo_class: "", notes: "" };
const emptyStoreNameDraft = { raw_name: "", elevate_name: "", notes: "" };
const emptyDepositAccountDraft = { tender_type: "", deposit_to_account: "", payment_method: "", notes: "" };
const emptyOndigoAddressDraft = { street_address: "", company_name: "", qbo_class: "", notes: "" };
const emptyCreditNoteDraft = {
  product_prefix: "",
  match_type: "starts_with",
  expense_account: "",
  expense_memo: "",
  notes: "",
  ignore: false,
};
const emptyChartOfAccountDraft = { account_name: "", category: "Expense", notes: "" };
const ACCOUNT_CATEGORY_OPTIONS = [
  "Revenue",
  "Cost of Goods Sold",
  "Expense",
  "Current Assets",
  "Non Current Assets",
  "Current Liabilities",
  "Non Current Liabilities",
  "Equity",
];

const STOCK_TRANSFER_ACCOUNT_LABELS = {
  devices_transfer_out: "Devices Transfer Out",
  devices_transfer_in: "Devices Transfer In",
  stock_transfer: "Stock Transfer",
};
const STOCK_TRANSFER_ACCOUNT_HINTS = {
  devices_transfer_out: "Credited on the sending store's books for its whole outgoing total.",
  devices_transfer_in: "Debited on the receiving store's books for its whole incoming total.",
  stock_transfer: 'Inter-company balance line — a different destination/source company appends ": <Company>" to this name automatically.',
};

const DEPOSIT_DEFAULT_LABELS = {
  received_from: "Received From",
  from_account: "From Account",
  memo: "Memo",
};

const ONDIGO_DEFAULT_LABELS = {
  vendor: "Vendor",
  expense_account: "Expense Account",
};

export default function MappingsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [session, setSession] = useState(undefined);
  const [activeTab, setActiveTab] = useState("store");
  const [productRows, setProductRows] = useState([]);
  const [doorRows, setDoorRows] = useState([]);
  const [accountRows, setAccountRows] = useState([]);
  const [storeNameRows, setStoreNameRows] = useState([]);
  const [stockTransferAccountRows, setStockTransferAccountRows] = useState([]);
  const [depositAccountRows, setDepositAccountRows] = useState([]);
  const [depositDefaultRows, setDepositDefaultRows] = useState([]);
  const [ondigoAddressRows, setOndigoAddressRows] = useState([]);
  const [ondigoDefaultRows, setOndigoDefaultRows] = useState([]);
  const [creditNoteRows, setCreditNoteRows] = useState([]);
  const [chartOfAccountRows, setChartOfAccountRows] = useState([]);
  const [elevateNameOptions, setElevateNameOptions] = useState([]); // [{ value, label }]
  const [companyOptions, setCompanyOptions] = useState([]);
  const [qboClassOptions, setQboClassOptions] = useState([]); // Store Master's elevate_name_new_qbo_class, distinct + sorted
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [productDraft, setProductDraft] = useState(emptyProductDraft);
  const [doorDraft, setDoorDraft] = useState(emptyDoorDraft);
  const [accountDraft, setAccountDraft] = useState(emptyAccountDraft);
  const [storeNameDraft, setStoreNameDraft] = useState(emptyStoreNameDraft);
  const [depositAccountDraft, setDepositAccountDraft] = useState(emptyDepositAccountDraft);
  const [ondigoAddressDraft, setOndigoAddressDraft] = useState(emptyOndigoAddressDraft);
  const [creditNoteDraft, setCreditNoteDraft] = useState(emptyCreditNoteDraft);
  const [chartOfAccountDraft, setChartOfAccountDraft] = useState(emptyChartOfAccountDraft);
  const [confirmDelete, setConfirmDelete] = useState(null); // { table, id }
  const [pendingDoors, setPendingDoors] = useState([]);
  const [pendingProducts, setPendingProducts] = useState([]);
  const [pendingAccounts, setPendingAccounts] = useState([]);
  const [pendingStoreNames, setPendingStoreNames] = useState([]);
  const [pendingTenderTypes, setPendingTenderTypes] = useState([]);
  const [pendingOndigoAddresses, setPendingOndigoAddresses] = useState([]);
  const [pendingCreditNoteProducts, setPendingCreditNoteProducts] = useState([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) router.push("/login");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
      if (!sess) router.push("/login");
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase, router]);

  useEffect(() => {
    const pending = loadPendingMappings();
    setPendingDoors(pending.unmatchedDoors);
    setPendingProducts(pending.unmappedProducts);
    setPendingAccounts(pending.unmatchedAccounts);
    setPendingStoreNames(pending.unmatchedStoreNames);
    setPendingTenderTypes(pending.unmatchedTenderTypes);
    setPendingOndigoAddresses(pending.unmatchedOndigoAddresses);
    setPendingCreditNoteProducts(pending.unmappedCreditNoteProducts);
  }, []);

  // Other pages link here with ?tab=<key> (e.g. Bills' "Add them in Door
  // Mapping" banner) so the right tab is already open instead of always
  // landing on Store Master. Read via window.location directly rather than
  // next/navigation's useSearchParams, which would force this whole page
  // into a Suspense boundary just for this — this page is already
  // client-only (auth-gated, redirects via useRouter), so a plain
  // client-side read is simpler and has the same effect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    const validTabs = ["store", "vip", "epay", "storemap", "stocktransfer", "ardeposits", "ondigo", "creditnote"];
    if (tab && validTabs.includes(tab)) setActiveTab(tab);
  }, []);

  // Once the target tab's content has actually rendered, scroll to a
  // #section-id from the link (e.g. #door-mapping, since Door Mapping is
  // the 2nd section on the VIP tab, below Product Mapping).
  useEffect(() => {
    if (loading) return;
    const hash = window.location.hash.replace("#", "");
    if (!hash) return;
    const el = document.getElementById(hash);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loading, activeTab]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    const [
      productRes,
      doorRes,
      accountRes,
      checklistRes,
      storeNameRes,
      storesRes,
      stockTransferAccountRes,
      depositAccountRes,
      depositDefaultRes,
      ondigoAddressRes,
      ondigoDefaultRes,
      creditNoteRes,
      chartOfAccountsRes,
    ] = await Promise.all([
      supabase.from("product_mappings").select("*").order("product_prefix", { ascending: true }),
      supabase.from("door_mappings").select("*").order("door_number", { ascending: true }),
      supabase.from("epay_account_mappings").select("*").order("account_number", { ascending: true }),
      supabase.from("checklist_items").select("company"),
      supabase.from("store_name_mappings").select("*").order("raw_name", { ascending: true }),
      supabase
        .from("stores")
        .select("elevate_name, company_name, elevate_name_new_qbo_class")
        .order("elevate_name", { ascending: true }),
      supabase.from("stock_transfer_account_names").select("*").order("key", { ascending: true }),
      supabase.from("deposit_account_mappings").select("*").order("tender_type", { ascending: true }),
      supabase.from("deposit_defaults").select("*").order("key", { ascending: true }),
      supabase.from("ondigo_address_mappings").select("*").order("street_address", { ascending: true }),
      supabase.from("ondigo_defaults").select("*").order("key", { ascending: true }),
      supabase.from("credit_note_mappings").select("*").order("product_prefix", { ascending: true }),
      supabase.from("chart_of_accounts").select("*").order("category", { ascending: true }).order("account_name", { ascending: true }),
    ]);
    if (productRes.error) setError(productRes.error.message);
    else setProductRows(productRes.data || []);
    if (doorRes.error) setError(doorRes.error.message);
    else setDoorRows(doorRes.data || []);
    if (accountRes.error) setError(accountRes.error.message);
    else setAccountRows(accountRes.data || []);
    if (storeNameRes.error) setError(storeNameRes.error.message);
    else setStoreNameRows(storeNameRes.data || []);
    if (stockTransferAccountRes.error) setError(stockTransferAccountRes.error.message);
    else setStockTransferAccountRows(stockTransferAccountRes.data || []);
    if (depositAccountRes.error) setError(depositAccountRes.error.message);
    else setDepositAccountRows(depositAccountRes.data || []);
    if (depositDefaultRes.error) setError(depositDefaultRes.error.message);
    else setDepositDefaultRows(depositDefaultRes.data || []);
    if (ondigoAddressRes.error) setError(ondigoAddressRes.error.message);
    else setOndigoAddressRows(ondigoAddressRes.data || []);
    if (ondigoDefaultRes.error) setError(ondigoDefaultRes.error.message);
    else setOndigoDefaultRows(ondigoDefaultRes.data || []);
    if (creditNoteRes.error) setError(creditNoteRes.error.message);
    else setCreditNoteRows(creditNoteRes.data || []);
    if (chartOfAccountsRes.error) setError(chartOfAccountsRes.error.message);
    else setChartOfAccountRows(chartOfAccountsRes.data || []);
    if (!checklistRes.error) {
      setCompanyOptions(Array.from(new Set((checklistRes.data || []).map((r) => r.company))).sort());
    }
    if (!storesRes.error) {
      const seen = new Set();
      const options = [];
      for (const s of storesRes.data || []) {
        if (!s.elevate_name || seen.has(s.elevate_name)) continue;
        seen.add(s.elevate_name);
        options.push({ value: s.elevate_name, label: `${s.elevate_name} (${s.company_name || "—"})` });
      }
      setElevateNameOptions(options);
      setQboClassOptions(
        Array.from(
          new Set((storesRes.data || []).map((s) => s.elevate_name_new_qbo_class).filter(Boolean))
        ).sort()
      );
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    if (session) loadAll();
  }, [session, loadAll]);

  async function updateProductField(id, field, value) {
    setProductRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("product_mappings")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function updateDoorField(id, field, value) {
    setDoorRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("door_mappings")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function updateCreditNoteField(id, field, value) {
    setCreditNoteRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    // "ignore" is a boolean -- `value || null` would wrongly turn `false` into null, so only
    // apply that empty-string-to-null coercion to the text fields.
    const dbValue = field === "ignore" ? value : value || null;
    const { error } = await supabase
      .from("credit_note_mappings")
      .update({ [field]: dbValue })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function addProductRow() {
    if (!productDraft.product_prefix.trim() || !productDraft.expense_account.trim()) {
      setError("Product Prefix and Expense Account are required.");
      return;
    }
    const { data, error } = await supabase
      .from("product_mappings")
      .insert([
        {
          product_prefix: productDraft.product_prefix.trim(),
          match_type: productDraft.match_type || "starts_with",
          expense_account: productDraft.expense_account.trim(),
          expense_memo: productDraft.expense_memo.trim() || null,
          notes: productDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setProductRows((prev) => [...prev, ...(data || [])]);
    const addedPrefix = productDraft.product_prefix.trim();
    const addedMatchType = productDraft.match_type || "starts_with";
    setProductDraft(emptyProductDraft);
    removePendingProductsMatching(addedPrefix, addedMatchType);
    setPendingProducts((prev) =>
      prev.filter((p) => {
        const productLower = p.product.toLowerCase();
        const prefixLower = addedPrefix.toLowerCase();
        if (addedMatchType === "exact") return productLower !== prefixLower;
        if (addedMatchType === "contains") return !productLower.includes(prefixLower);
        return !productLower.startsWith(prefixLower);
      })
    );
  }

  async function addCreditNoteRow() {
    if (!creditNoteDraft.product_prefix.trim()) {
      setError("Memo Prefix is required.");
      return;
    }
    if (!creditNoteDraft.ignore && !creditNoteDraft.expense_account.trim()) {
      setError("Expense Account is required unless Ignore is checked.");
      return;
    }
    const { data, error } = await supabase
      .from("credit_note_mappings")
      .insert([
        {
          product_prefix: creditNoteDraft.product_prefix.trim(),
          match_type: creditNoteDraft.match_type || "starts_with",
          expense_account: creditNoteDraft.expense_account.trim() || null,
          expense_memo: creditNoteDraft.expense_memo.trim() || null,
          notes: creditNoteDraft.notes.trim() || null,
          ignore: creditNoteDraft.ignore,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setCreditNoteRows((prev) => [...prev, ...(data || [])]);
    const addedPrefix = creditNoteDraft.product_prefix.trim();
    const addedMatchType = creditNoteDraft.match_type || "starts_with";
    setCreditNoteDraft(emptyCreditNoteDraft);
    removePendingCreditNoteProductsMatching(addedPrefix, addedMatchType);
    setPendingCreditNoteProducts((prev) =>
      prev.filter((p) => {
        const productLower = p.product.toLowerCase();
        const prefixLower = addedPrefix.toLowerCase();
        if (addedMatchType === "exact") return productLower !== prefixLower;
        if (addedMatchType === "contains") return !productLower.includes(prefixLower);
        return !productLower.startsWith(prefixLower);
      })
    );
  }

  async function updateChartOfAccountField(id, field, value) {
    setChartOfAccountRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("chart_of_accounts")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function addChartOfAccountRow() {
    if (!chartOfAccountDraft.account_name.trim()) {
      setError("Account Name is required.");
      return;
    }
    const { data, error } = await supabase
      .from("chart_of_accounts")
      .insert([
        {
          account_name: chartOfAccountDraft.account_name.trim(),
          category: chartOfAccountDraft.category,
          notes: chartOfAccountDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setChartOfAccountRows((prev) => [...prev, ...(data || [])]);
    setChartOfAccountDraft(emptyChartOfAccountDraft);
  }

  async function addDoorRow() {
    if (!doorDraft.door_number.trim() || !doorDraft.company_name.trim() || !doorDraft.qbo_class.trim()) {
      setError("Door Number, Company Name, and QBO Class are required.");
      return;
    }
    const { data, error } = await supabase
      .from("door_mappings")
      .insert([
        {
          door_number: doorDraft.door_number.trim(),
          company_name: doorDraft.company_name.trim(),
          qbo_class: doorDraft.qbo_class.trim(),
          notes: doorDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setDoorRows((prev) => [...prev, ...(data || [])]);
    const addedDoor = doorDraft.door_number.trim();
    setDoorDraft(emptyDoorDraft);
    removePendingDoor(addedDoor);
    setPendingDoors((prev) => prev.filter((d) => d !== addedDoor));
  }

  async function updateAccountField(id, field, value) {
    setAccountRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("epay_account_mappings")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function addAccountRow() {
    if (!accountDraft.account_number.trim() || !accountDraft.company_name.trim() || !accountDraft.qbo_class.trim()) {
      setError("Account Number, Company Name, and QBO Class are required.");
      return;
    }
    const { data, error } = await supabase
      .from("epay_account_mappings")
      .insert([
        {
          account_number: accountDraft.account_number.trim(),
          company_name: accountDraft.company_name.trim(),
          qbo_class: accountDraft.qbo_class.trim(),
          notes: accountDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setAccountRows((prev) => [...prev, ...(data || [])]);
    const addedAccount = accountDraft.account_number.trim();
    setAccountDraft(emptyAccountDraft);
    removePendingAccount(addedAccount);
    setPendingAccounts((prev) => prev.filter((a) => a !== addedAccount));
  }

  async function updateStoreNameField(id, field, value) {
    setStoreNameRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("store_name_mappings")
      .update({ [field]: value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function updateStockTransferAccountField(id, field, value) {
    setStockTransferAccountRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("stock_transfer_account_names")
      .update({ [field]: field === "account_name" ? value.trim() : value || null })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function updateDepositAccountField(id, field, value) {
    setDepositAccountRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("deposit_account_mappings")
      .update({ [field]: value })
      .eq("id", id);
    if (error) setError(error.message);
  }

  async function addDepositAccountRow() {
    if (!depositAccountDraft.tender_type.trim()) {
      setError("Tender Type is required.");
      return;
    }
    const { data, error } = await supabase
      .from("deposit_account_mappings")
      .insert([
        {
          tender_type: depositAccountDraft.tender_type.trim(),
          deposit_to_account: depositAccountDraft.deposit_to_account.trim(),
          payment_method: depositAccountDraft.payment_method.trim(),
          notes: depositAccountDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setDepositAccountRows((prev) => [...prev, ...(data || [])]);
    const addedTenderType = depositAccountDraft.tender_type.trim();
    setDepositAccountDraft(emptyDepositAccountDraft);
    removePendingTenderType(addedTenderType);
    setPendingTenderTypes((prev) => prev.filter((t) => t !== addedTenderType));
  }

  function useTenderTypeSuggestion(tenderType) {
    setDepositAccountDraft((d) => ({ ...d, tender_type: tenderType }));
  }

  function dismissPendingTenderType(tenderType) {
    removePendingTenderType(tenderType);
    setPendingTenderTypes((prev) => prev.filter((t) => t !== tenderType));
  }

  async function updateDepositDefaultField(id, value) {
    setDepositDefaultRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
    const { error } = await supabase.from("deposit_defaults").update({ value }).eq("id", id);
    if (error) setError(error.message);
  }

  async function updateOndigoAddressField(id, field, value) {
    setOndigoAddressRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    const { error } = await supabase
      .from("ondigo_address_mappings")
      .update({ [field]: value })
      .eq("id", id);
    if (error) setError(error.message);
  }

  // Pending chips hold the full mailing address from the file (e.g. "228
  // Brownsville Rd, PITTSBURGH, PA, 15210, US"); the mapping table only
  // stores the street portion actually used for matching. Compare on that
  // street prefix, not an exact string, when deciding which chips a newly
  // added mapping resolves.
  function streetPrefixOf(fullAddress) {
    const idx = fullAddress.indexOf(",");
    const street = idx === -1 ? fullAddress : fullAddress.slice(0, idx);
    return street.trim().toLowerCase();
  }

  /** Same as streetPrefixOf but preserves original casing — for prefilling an editable field, not for comparison. */
  function rawStreetPrefixOf(fullAddress) {
    const idx = fullAddress.indexOf(",");
    const street = idx === -1 ? fullAddress : fullAddress.slice(0, idx);
    return street.trim();
  }

  async function addOndigoAddressRow() {
    if (!ondigoAddressDraft.street_address.trim() || !ondigoAddressDraft.company_name.trim() || !ondigoAddressDraft.qbo_class.trim()) {
      setError("Street Address, Company Name, and QBO Class are required.");
      return;
    }
    const { data, error } = await supabase
      .from("ondigo_address_mappings")
      .insert([
        {
          street_address: ondigoAddressDraft.street_address.trim(),
          company_name: ondigoAddressDraft.company_name.trim(),
          qbo_class: ondigoAddressDraft.qbo_class.trim(),
          notes: ondigoAddressDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setOndigoAddressRows((prev) => [...prev, ...(data || [])]);
    const addedStreet = streetPrefixOf(ondigoAddressDraft.street_address.trim());
    setOndigoAddressDraft(emptyOndigoAddressDraft);
    const resolved = pendingOndigoAddresses.filter((full) => streetPrefixOf(full) === addedStreet);
    for (const full of resolved) removePendingOndigoAddress(full);
    setPendingOndigoAddresses((prev) => prev.filter((a) => streetPrefixOf(a) !== addedStreet));
  }

  function useOndigoAddressSuggestion(address) {
    // Pending addresses are the full mailing address from the file; only the
    // street portion (before the first comma) is what actually gets matched.
    setOndigoAddressDraft((d) => ({ ...d, street_address: rawStreetPrefixOf(address) }));
  }

  function dismissPendingOndigoAddress(address) {
    removePendingOndigoAddress(address);
    setPendingOndigoAddresses((prev) => prev.filter((a) => a !== address));
  }

  async function updateOndigoDefaultField(id, value) {
    setOndigoDefaultRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
    const { error } = await supabase.from("ondigo_defaults").update({ value }).eq("id", id);
    if (error) setError(error.message);
  }

  async function addStoreNameRow() {
    if (!storeNameDraft.raw_name.trim() || !storeNameDraft.elevate_name.trim()) {
      setError("Raw Store Name and Elevate Name are required.");
      return;
    }
    const { data, error } = await supabase
      .from("store_name_mappings")
      .insert([
        {
          raw_name: storeNameDraft.raw_name.trim(),
          elevate_name: storeNameDraft.elevate_name.trim(),
          notes: storeNameDraft.notes.trim() || null,
        },
      ])
      .select();
    if (error) {
      setError(error.message);
      return;
    }
    setStoreNameRows((prev) => [...prev, ...(data || [])]);
    const addedRaw = storeNameDraft.raw_name.trim();
    setStoreNameDraft(emptyStoreNameDraft);
    removePendingStoreName(addedRaw);
    setPendingStoreNames((prev) => prev.filter((s) => s !== addedRaw));
  }

  function useStoreNameSuggestion(rawName) {
    setStoreNameDraft((d) => ({ ...d, raw_name: rawName }));
  }

  function dismissPendingStoreName(rawName) {
    removePendingStoreName(rawName);
    setPendingStoreNames((prev) => prev.filter((s) => s !== rawName));
  }

  function useAccountSuggestion(accountNumber) {
    setAccountDraft((d) => ({ ...d, account_number: accountNumber }));
  }

  function dismissPendingAccount(accountNumber) {
    removePendingAccount(accountNumber);
    setPendingAccounts((prev) => prev.filter((a) => a !== accountNumber));
  }

  function useDoorSuggestion(doorNumber) {
    setDoorDraft((d) => ({ ...d, door_number: doorNumber }));
  }

  function dismissPendingDoor(doorNumber) {
    removePendingDoor(doorNumber);
    setPendingDoors((prev) => prev.filter((d) => d !== doorNumber));
  }

  function useProductSuggestion(product) {
    setProductDraft((d) => ({ ...d, product_prefix: product }));
  }

  function dismissPendingProduct(item) {
    removePendingProductsMatching(item.product);
    setPendingProducts((prev) => prev.filter((p) => p !== item));
  }

  function useCreditNoteSuggestion(product) {
    setCreditNoteDraft((d) => ({ ...d, product_prefix: product }));
  }

  function dismissPendingCreditNoteProduct(item) {
    removePendingCreditNoteProductsMatching(item.product);
    setPendingCreditNoteProducts((prev) => prev.filter((p) => p !== item));
  }

  /** "Clear all" for one "From your last upload" row — empties just that list, not the other pending tables. */
  function clearAllPending(fieldName, setter) {
    clearPendingList(fieldName);
    setter([]);
  }

  async function handleDelete() {
    if (!confirmDelete) return;
    const { table, id } = confirmDelete;
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) setError(error.message);
    if (table === "product_mappings") setProductRows((prev) => prev.filter((r) => r.id !== id));
    else if (table === "door_mappings") setDoorRows((prev) => prev.filter((r) => r.id !== id));
    else if (table === "epay_account_mappings") setAccountRows((prev) => prev.filter((r) => r.id !== id));
    else if (table === "deposit_account_mappings") setDepositAccountRows((prev) => prev.filter((r) => r.id !== id));
    else if (table === "ondigo_address_mappings") setOndigoAddressRows((prev) => prev.filter((r) => r.id !== id));
    else if (table === "credit_note_mappings") setCreditNoteRows((prev) => prev.filter((r) => r.id !== id));
    else if (table === "chart_of_accounts") setChartOfAccountRows((prev) => prev.filter((r) => r.id !== id));
    else setStoreNameRows((prev) => prev.filter((r) => r.id !== id));
    setConfirmDelete(null);
  }

  if (session === undefined) {
    return <div style={styles.loadingScreen}>Loading…</div>;
  }
  if (!session) return null;

  return (
    <div style={styles.shell}>
      <Sidebar userEmail={session.user.email} />

      <main style={styles.main}>
        <div style={styles.topRow}>
          <div>
            <h1 style={styles.h1}>Mapping Master</h1>
            <p style={styles.pageSub}>
              Store Master plus the lookup tables Bills and Sales use instead of hardcoded lists in
              code — all editable here
            </p>
          </div>
        </div>

        <div style={styles.tabRow}>
          <button
            style={activeTab === "store" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("store")}
          >
            Store Master
          </button>
          <button
            style={activeTab === "vip" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("vip")}
          >
            VIP
          </button>
          <button
            style={activeTab === "epay" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("epay")}
          >
            Epay
          </button>
          <button
            style={activeTab === "storemap" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("storemap")}
          >
            Store Mapping
          </button>
          <button
            style={activeTab === "stocktransfer" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("stocktransfer")}
          >
            Stock Transfer
          </button>
          <button
            style={activeTab === "ardeposits" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("ardeposits")}
          >
            AR Deposits
          </button>
          <button
            style={activeTab === "ondigo" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("ondigo")}
          >
            Ondigo
          </button>
          <button
            style={activeTab === "creditnote" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("creditnote")}
          >
            Credit Note
          </button>
          <button
            style={activeTab === "accounts" ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab("accounts")}
          >
            Accounts
          </button>
        </div>

        {activeTab !== "store" && error && <div style={styles.errorBanner}>{error}</div>}

        {activeTab === "store" ? (
          <StoreMasterPanel />
        ) : loading ? (
          <div style={styles.emptyState}>Loading…</div>
        ) : activeTab === "vip" ? (
          <>
            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Product Mapping</div>
              <div style={styles.sectionSub}>
                A VIP Bill line is classified by its <strong>Products</strong> text (not Memo, which is
                often generic or inconsistent) — the first rule it matches (case-insensitive, per each
                rule&apos;s own Match Type: Starts with / Contains / Fully matching) determines the Expense
                Account. A line matching no rule is skipped and flagged.
              </div>

              {pendingProducts.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  <button
                    style={styles.clearAllBtn}
                    onClick={() => clearAllPending("unmappedProducts", setPendingProducts)}
                  >
                    Clear all
                  </button>
                  {pendingProducts.map((p, i) => (
                    <span key={i} style={styles.chip}>
                      <button
                        style={styles.chipMain}
                        title={`Door ${p.doorNumber} · ${p.invoiceNo}`}
                        onClick={() => useProductSuggestion(p.product)}
                      >
                        {p.product}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingProduct(p)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Product Prefix</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Match Type</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Expense Account</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Expense Memo (override)</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {productRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.product_prefix}
                            onBlur={(e) => updateProductField(r.id, "product_prefix", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.match_type || "starts_with"}
                            onChange={(e) => updateProductField(r.id, "match_type", e.target.value)}
                          >
                            {MATCH_TYPE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.expense_account}
                            onBlur={(e) => updateProductField(r.id, "expense_account", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            placeholder="(uses raw memo text)"
                            defaultValue={r.expense_memo || ""}
                            onBlur={(e) => updateProductField(r.id, "expense_memo", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateProductField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "product_mappings" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "product_mappings", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Vantedge Program Membership Fees"
                          value={productDraft.product_prefix}
                          onChange={(e) => setProductDraft((d) => ({ ...d, product_prefix: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={productDraft.match_type}
                          onChange={(e) => setProductDraft((d) => ({ ...d, match_type: e.target.value }))}
                        >
                          {MATCH_TYPE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Other Services VIP"
                          value={productDraft.expense_account}
                          onChange={(e) => setProductDraft((d) => ({ ...d, expense_account: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={productDraft.expense_memo}
                          onChange={(e) => setProductDraft((d) => ({ ...d, expense_memo: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={productDraft.notes}
                          onChange={(e) => setProductDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addProductRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div style={styles.sectionCard} id="door-mapping">
              <div style={styles.sectionTitle}>Door Mapping</div>
              <div style={styles.sectionSub}>
                A fallback for VIP Door Numbers that aren't in Store Master yet — lets a bill still match a
                Company and QBO Class without adding a full store record.
              </div>

              {pendingDoors.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  <button style={styles.clearAllBtn} onClick={() => clearAllPending("unmatchedDoors", setPendingDoors)}>
                    Clear all
                  </button>
                  {pendingDoors.map((d) => (
                    <span key={d} style={styles.chip}>
                      <button style={styles.chipMain} onClick={() => useDoorSuggestion(d)}>
                        {d}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingDoor(d)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Door Number</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Company Name</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>QBO Class</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {doorRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.door_number}
                            onBlur={(e) => updateDoorField(r.id, "door_number", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.company_name}
                            onChange={(e) => updateDoorField(r.id, "company_name", e.target.value)}
                          >
                            <option value="">— Select —</option>
                            {companyOptions.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            {r.company_name && !companyOptions.includes(r.company_name) && (
                              <option value={r.company_name}>{r.company_name}</option>
                            )}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.qbo_class}
                            onChange={(e) => updateDoorField(r.id, "qbo_class", e.target.value)}
                          >
                            <option value="">— Select —</option>
                            {qboClassOptions.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            {r.qbo_class && !qboClassOptions.includes(r.qbo_class) && (
                              <option value={r.qbo_class}>{r.qbo_class}</option>
                            )}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateDoorField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "door_mappings" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "door_mappings", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. 7483262"
                          value={doorDraft.door_number}
                          onChange={(e) => setDoorDraft((d) => ({ ...d, door_number: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={doorDraft.company_name}
                          onChange={(e) => setDoorDraft((d) => ({ ...d, company_name: e.target.value }))}
                        >
                          <option value="">— Select —</option>
                          {companyOptions.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={doorDraft.qbo_class}
                          onChange={(e) => setDoorDraft((d) => ({ ...d, qbo_class: e.target.value }))}
                        >
                          <option value="">— Select —</option>
                          {qboClassOptions.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={doorDraft.notes}
                          onChange={(e) => setDoorDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addDoorRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : activeTab === "epay" ? (
          <>
            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Epay Account Mapping</div>
              <div style={styles.sectionSub}>
                A fallback for Epay Account Numbers that aren't in Store Master's "Epay" field yet — lets
                an Epay invoice still match a Company and QBO Class without adding a full store record.
              </div>

              {pendingAccounts.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  <button
                    style={styles.clearAllBtn}
                    onClick={() => clearAllPending("unmatchedAccounts", setPendingAccounts)}
                  >
                    Clear all
                  </button>
                  {pendingAccounts.map((a) => (
                    <span key={a} style={styles.chip}>
                      <button style={styles.chipMain} onClick={() => useAccountSuggestion(a)}>
                        {a}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingAccount(a)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Account Number</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Company Name</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>QBO Class</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {accountRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.account_number}
                            onBlur={(e) => updateAccountField(r.id, "account_number", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.company_name}
                            onChange={(e) => updateAccountField(r.id, "company_name", e.target.value)}
                          >
                            <option value="">— Select —</option>
                            {companyOptions.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            {r.company_name && !companyOptions.includes(r.company_name) && (
                              <option value={r.company_name}>{r.company_name}</option>
                            )}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.qbo_class}
                            onChange={(e) => updateAccountField(r.id, "qbo_class", e.target.value)}
                          >
                            <option value="">— Select —</option>
                            {qboClassOptions.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            {r.qbo_class && !qboClassOptions.includes(r.qbo_class) && (
                              <option value={r.qbo_class}>{r.qbo_class}</option>
                            )}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateAccountField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "epay_account_mappings" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "epay_account_mappings", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. 502329"
                          value={accountDraft.account_number}
                          onChange={(e) => setAccountDraft((d) => ({ ...d, account_number: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={accountDraft.company_name}
                          onChange={(e) => setAccountDraft((d) => ({ ...d, company_name: e.target.value }))}
                        >
                          <option value="">— Select —</option>
                          {companyOptions.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={accountDraft.qbo_class}
                          onChange={(e) => setAccountDraft((d) => ({ ...d, qbo_class: e.target.value }))}
                        >
                          <option value="">— Select —</option>
                          {qboClassOptions.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={accountDraft.notes}
                          onChange={(e) => setAccountDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addAccountRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : activeTab === "storemap" ? (
          <>
            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Store Mapping</div>
              <div style={styles.sectionSub}>
                A fallback for raw store names (from Payroll's Employee Timesheet, Change in Inventory's
                Opening/Closing uploads, or Stock Transfer's From/To columns) that don't exactly match a
                store's Elevate Name in Store Master — renames, typos, or casing drift. Map the raw name
                to the correct Elevate Name and re-upload to pick it up.
              </div>

              {pendingStoreNames.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  <button
                    style={styles.clearAllBtn}
                    onClick={() => clearAllPending("unmatchedStoreNames", setPendingStoreNames)}
                  >
                    Clear all
                  </button>
                  {pendingStoreNames.map((s) => (
                    <span key={s} style={styles.chip}>
                      <button style={styles.chipMain} onClick={() => useStoreNameSuggestion(s)}>
                        {s}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingStoreName(s)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Raw Store Name</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Elevate Name</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {storeNameRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.raw_name}
                            onBlur={(e) => updateStoreNameField(r.id, "raw_name", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.elevate_name}
                            onChange={(e) => updateStoreNameField(r.id, "elevate_name", e.target.value)}
                          >
                            <option value="">— Select —</option>
                            {elevateNameOptions.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                            {r.elevate_name && !elevateNameOptions.some((o) => o.value === r.elevate_name) && (
                              <option value={r.elevate_name}>{r.elevate_name}</option>
                            )}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateStoreNameField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "store_name_mappings" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "store_name_mappings", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. EP - Butler"
                          value={storeNameDraft.raw_name}
                          onChange={(e) => setStoreNameDraft((d) => ({ ...d, raw_name: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={storeNameDraft.elevate_name}
                          onChange={(e) => setStoreNameDraft((d) => ({ ...d, elevate_name: e.target.value }))}
                        >
                          <option value="">— Select —</option>
                          {elevateNameOptions.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={storeNameDraft.notes}
                          onChange={(e) => setStoreNameDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addStoreNameRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : activeTab === "stocktransfer" ? (
          <>
            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Stock Transfer</div>
              <div style={styles.sectionSub}>
                The account names Stock Transfer's Journal Entry uses — edit here instead of in code.
                "Stock Transfer" is the base name only: a different destination/source company gets its
                own line named "<em>this name</em>: &lt;Company&gt;" automatically, so you don't set that
                per company.
              </div>

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Line</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Account Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockTransferAccountRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <div style={{ fontWeight: 600 }}>{STOCK_TRANSFER_ACCOUNT_LABELS[r.key] || r.key}</div>
                          <div style={styles.sectionSub}>{STOCK_TRANSFER_ACCOUNT_HINTS[r.key] || ""}</div>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.account_name}
                            onBlur={(e) => updateStockTransferAccountField(r.id, "account_name", e.target.value)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : activeTab === "ardeposits" ? (
          <>
            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>AR Deposits — Defaults</div>
              <div style={styles.sectionSub}>
                Applied to every line on the AR Deposits page (still editable there per-run, but this is
                the default it loads with).
              </div>

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Field</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {depositDefaultRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <div style={{ fontWeight: 600 }}>{DEPOSIT_DEFAULT_LABELS[r.key] || r.key}</div>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.value}
                            onBlur={(e) => updateDepositDefaultField(r.id, e.target.value)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>AR Deposits — Deposit Account Mapping</div>
              <div style={styles.sectionSub}>
                Maps each X-Report Tender Type to a Deposit To Account and Payment Method for AR Deposits.
                A tender type with no row here still posts (Deposit To Account/Payment Method left blank),
                but is flagged on the AR Deposits page so you know to add it.
              </div>

              {pendingTenderTypes.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  <button
                    style={styles.clearAllBtn}
                    onClick={() => clearAllPending("unmatchedTenderTypes", setPendingTenderTypes)}
                  >
                    Clear all
                  </button>
                  {pendingTenderTypes.map((t) => (
                    <span key={t} style={styles.chip}>
                      <button style={styles.chipMain} onClick={() => useTenderTypeSuggestion(t)}>
                        {t}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingTenderType(t)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Tender Type</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Deposit To Account</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Payment Method</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {depositAccountRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.tender_type}
                            onBlur={(e) => updateDepositAccountField(r.id, "tender_type", e.target.value.trim())}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.deposit_to_account}
                            onBlur={(e) => updateDepositAccountField(r.id, "deposit_to_account", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.payment_method}
                            onBlur={(e) => updateDepositAccountField(r.id, "payment_method", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateDepositAccountField(r.id, "notes", e.target.value || null)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "deposit_account_mappings" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "deposit_account_mappings", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Zelle"
                          value={depositAccountDraft.tender_type}
                          onChange={(e) => setDepositAccountDraft((d) => ({ ...d, tender_type: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Cash in Hand"
                          value={depositAccountDraft.deposit_to_account}
                          onChange={(e) => setDepositAccountDraft((d) => ({ ...d, deposit_to_account: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Bank"
                          value={depositAccountDraft.payment_method}
                          onChange={(e) => setDepositAccountDraft((d) => ({ ...d, payment_method: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={depositAccountDraft.notes}
                          onChange={(e) => setDepositAccountDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addDepositAccountRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : activeTab === "ondigo" ? (
          <>
            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Ondigo — Defaults</div>
              <div style={styles.sectionSub}>
                Every Ondigo bill line posts to this Vendor and Expense Account — there's no per-invoice
                classification like VIP's Product Mapping, since the Ondigo export has no line-item detail to
                classify.
              </div>

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Field</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ondigoDefaultRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <div style={{ fontWeight: 600 }}>{ONDIGO_DEFAULT_LABELS[r.key] || r.key}</div>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.value}
                            onBlur={(e) => updateOndigoDefaultField(r.id, e.target.value)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Ondigo Address Mapping</div>
              <div style={styles.sectionSub}>
                A fallback for Ondigo Store/Location addresses that don't exactly match any store's VIP Address in
                Store Master (spelling drift like "Rd" vs "Road", a store missing that field, etc.) — same role as
                Door Mapping plays for VIP. Only the street portion (before the first comma) is compared; enter
                just that here, not the full city/state/zip address from the file.
              </div>

              {pendingOndigoAddresses.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  <button
                    style={styles.clearAllBtn}
                    onClick={() => clearAllPending("unmatchedOndigoAddresses", setPendingOndigoAddresses)}
                  >
                    Clear all
                  </button>
                  {pendingOndigoAddresses.map((a) => (
                    <span key={a} style={styles.chip}>
                      <button style={styles.chipMain} title={a} onClick={() => useOndigoAddressSuggestion(a)}>
                        {a}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingOndigoAddress(a)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Street Address</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Company Name</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>QBO Class</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ondigoAddressRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.street_address}
                            onBlur={(e) => updateOndigoAddressField(r.id, "street_address", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.company_name}
                            onChange={(e) => updateOndigoAddressField(r.id, "company_name", e.target.value)}
                          >
                            <option value="">— Select —</option>
                            {companyOptions.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            {r.company_name && !companyOptions.includes(r.company_name) && (
                              <option value={r.company_name}>{r.company_name}</option>
                            )}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.qbo_class}
                            onChange={(e) => updateOndigoAddressField(r.id, "qbo_class", e.target.value)}
                          >
                            <option value="">— Select —</option>
                            {qboClassOptions.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                            {r.qbo_class && !qboClassOptions.includes(r.qbo_class) && (
                              <option value={r.qbo_class}>{r.qbo_class}</option>
                            )}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateOndigoAddressField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "ondigo_address_mappings" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "ondigo_address_mappings", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. 228 Brownsville Rd"
                          value={ondigoAddressDraft.street_address}
                          onChange={(e) => setOndigoAddressDraft((d) => ({ ...d, street_address: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={ondigoAddressDraft.company_name}
                          onChange={(e) => setOndigoAddressDraft((d) => ({ ...d, company_name: e.target.value }))}
                        >
                          <option value="">— Select —</option>
                          {companyOptions.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={ondigoAddressDraft.qbo_class}
                          onChange={(e) => setOndigoAddressDraft((d) => ({ ...d, qbo_class: e.target.value }))}
                        >
                          <option value="">— Select —</option>
                          {qboClassOptions.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={ondigoAddressDraft.notes}
                          onChange={(e) => setOndigoAddressDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addOndigoAddressRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : activeTab === "creditnote" ? (
          <>
            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Credit Note Mapping</div>
              <div style={styles.sectionSub}>
                A VIP Credit Note line is classified by its <strong>Memo</strong> text (not Products —
                Memo is the same for every line of a given credit memo, so the whole credit memo posts as
                one line; e.g. &quot;Weekly Incentive Credit - February 1st 2026&quot;, &quot;Xfinity
                Activation Bounty $25 3/01/2026 - 3/31/2026&quot;, &quot;transfer commission withhold
                earned on 4/16/26 due to OC New Age 4/1/26&quot;). Matched against this separate table
                (not Product Mapping — Credit Note's Memo vocabulary has nothing to do with Bills'
                device/accessory SKUs). The first rule it matches (case-insensitive, per each rule&apos;s
                own Match Type: Starts with / Contains / Fully matching) determines the Expense Account. A
                line matching no rule is skipped and flagged. Check <strong>Ignore</strong> on a rule
                (e.g. &quot;Weekly Incentive Credit&quot;) to drop every credit memo matching it from file
                generation entirely — no Expense Account needed, and it won&apos;t show up as unmapped
                either.
              </div>

              {pendingCreditNoteProducts.length > 0 && (
                <div style={styles.pendingRow}>
                  <span style={styles.pendingLabel}>From your last upload:</span>
                  <button
                    style={styles.clearAllBtn}
                    onClick={() => clearAllPending("unmappedCreditNoteProducts", setPendingCreditNoteProducts)}
                  >
                    Clear all
                  </button>
                  {pendingCreditNoteProducts.map((p, i) => (
                    <span key={i} style={styles.chip}>
                      <button
                        style={styles.chipMain}
                        title={`Door ${p.doorNumber} · ${p.invoiceNo}`}
                        onClick={() => useCreditNoteSuggestion(p.product)}
                      >
                        {p.product}
                      </button>
                      <button style={styles.chipDismiss} onClick={() => dismissPendingCreditNoteProduct(p)}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Memo Prefix</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Match Type</th>
                      <th style={styles.th}>Ignore</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Expense Account</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Expense Memo (override)</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditNoteRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.product_prefix}
                            onBlur={(e) => updateCreditNoteField(r.id, "product_prefix", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.match_type || "starts_with"}
                            onChange={(e) => updateCreditNoteField(r.id, "match_type", e.target.value)}
                          >
                            {MATCH_TYPE_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ ...styles.td, textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={!!r.ignore}
                            onChange={(e) => updateCreditNoteField(r.id, "ignore", e.target.checked)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            placeholder={r.ignore ? "(not needed — Ignore is checked)" : ""}
                            defaultValue={r.expense_account || ""}
                            onBlur={(e) => updateCreditNoteField(r.id, "expense_account", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            placeholder="(uses raw memo text)"
                            defaultValue={r.expense_memo || ""}
                            onBlur={(e) => updateCreditNoteField(r.id, "expense_memo", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateCreditNoteField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "credit_note_mappings" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "credit_note_mappings", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Weekly Incentive Credit"
                          value={creditNoteDraft.product_prefix}
                          onChange={(e) => setCreditNoteDraft((d) => ({ ...d, product_prefix: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={creditNoteDraft.match_type}
                          onChange={(e) => setCreditNoteDraft((d) => ({ ...d, match_type: e.target.value }))}
                        >
                          {MATCH_TYPE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ ...styles.td, textAlign: "center" }}>
                        <input
                          type="checkbox"
                          checked={creditNoteDraft.ignore}
                          onChange={(e) => setCreditNoteDraft((d) => ({ ...d, ignore: e.target.checked }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder={creditNoteDraft.ignore ? "(not needed — Ignore is checked)" : "e.g. Dealer Incentives"}
                          value={creditNoteDraft.expense_account}
                          onChange={(e) => setCreditNoteDraft((d) => ({ ...d, expense_account: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={creditNoteDraft.expense_memo}
                          onChange={(e) => setCreditNoteDraft((d) => ({ ...d, expense_memo: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={creditNoteDraft.notes}
                          onChange={(e) => setCreditNoteDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addCreditNoteRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        ) : (
          <>
            <div style={styles.sectionCard}>
              <div style={styles.sectionTitle}>Chart of Accounts</div>
              <div style={styles.sectionSub}>
                The master list of Income/Expense/Balance-Sheet accounts used for JE generation across the
                app — currently wired into Manual JV&apos;s Account Name dropdown. Each account belongs to
                one Category, shown as an optgroup wherever the dropdown is used.
              </div>

              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={{ ...styles.th, textAlign: "left" }}>Account Name</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Category</th>
                      <th style={{ ...styles.th, textAlign: "left" }}>Notes</th>
                      <th style={styles.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {chartOfAccountRows.map((r) => (
                      <tr key={r.id} style={styles.tr}>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.account_name}
                            onBlur={(e) => updateChartOfAccountField(r.id, "account_name", e.target.value)}
                          />
                        </td>
                        <td style={styles.td}>
                          <select
                            style={styles.cellInput}
                            value={r.category}
                            onChange={(e) => updateChartOfAccountField(r.id, "category", e.target.value)}
                          >
                            {ACCOUNT_CATEGORY_OPTIONS.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input
                            style={styles.cellInput}
                            defaultValue={r.notes || ""}
                            onBlur={(e) => updateChartOfAccountField(r.id, "notes", e.target.value)}
                          />
                        </td>
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {confirmDelete?.table === "chart_of_accounts" && confirmDelete.id === r.id ? (
                            <>
                              <button style={{ ...styles.linkBtn, color: "var(--danger)" }} onClick={handleDelete}>
                                Confirm
                              </button>
                              <button style={styles.linkBtn} onClick={() => setConfirmDelete(null)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              style={{ ...styles.linkBtn, color: "var(--danger)" }}
                              onClick={() => setConfirmDelete({ table: "chart_of_accounts", id: r.id })}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="e.g. Marketing"
                          value={chartOfAccountDraft.account_name}
                          onChange={(e) => setChartOfAccountDraft((d) => ({ ...d, account_name: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          style={styles.cellInput}
                          value={chartOfAccountDraft.category}
                          onChange={(e) => setChartOfAccountDraft((d) => ({ ...d, category: e.target.value }))}
                        >
                          {ACCOUNT_CATEGORY_OPTIONS.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={styles.td}>
                        <input
                          style={styles.cellInput}
                          placeholder="(optional)"
                          value={chartOfAccountDraft.notes}
                          onChange={(e) => setChartOfAccountDraft((d) => ({ ...d, notes: e.target.value }))}
                        />
                      </td>
                      <td style={styles.td}>
                        <button style={styles.addBtn} onClick={addChartOfAccountRow}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

const styles = {
  loadingScreen: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--ink-soft)",
  },
  shell: { display: "flex", minHeight: "100vh" },
  main: { flex: 1, padding: "36px 44px", maxWidth: 1300 },
  topRow: { marginBottom: 20 },
  h1: { fontFamily: "var(--font-display)", fontSize: 26, margin: 0 },
  tabRow: { display: "flex", gap: 8, marginBottom: 20 },
  tab: {
    background: "transparent",
    color: "var(--ink-soft)",
    border: "1px solid var(--line)",
    borderRadius: 7,
    padding: "8px 18px",
    fontSize: 13,
    fontWeight: 600,
  },
  tabActive: {
    background: "var(--ledger)",
    color: "#fff",
    border: "1px solid var(--ledger)",
    borderRadius: 7,
    padding: "8px 18px",
    fontSize: 13,
    fontWeight: 600,
  },
  pageSub: { fontSize: 13, color: "var(--ink-soft)", margin: "4px 0 0", maxWidth: 720 },
  errorBanner: {
    background: "var(--danger-bg)",
    color: "var(--danger)",
    padding: "10px 14px",
    borderRadius: 6,
    fontSize: 13,
    marginBottom: 16,
  },
  emptyState: { padding: "48px 16px", textAlign: "center", color: "var(--ink-soft)", fontSize: 13 },
  sectionCard: {
    background: "var(--panel)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    marginBottom: 20,
    padding: 18,
  },
  sectionTitle: { fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 15, marginBottom: 6 },
  sectionSub: { fontSize: 12.5, color: "var(--ink-soft)", marginBottom: 14, lineHeight: 1.5 },
  pendingRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
    padding: "10px 12px",
    background: "var(--warn-bg)",
    borderRadius: 8,
  },
  pendingLabel: { fontSize: 11.5, fontWeight: 700, color: "var(--warn-text)", marginRight: 2 },
  clearAllBtn: {
    background: "none",
    border: "none",
    color: "var(--warn-text)",
    fontSize: 11.5,
    fontWeight: 700,
    textDecoration: "underline",
    padding: 0,
    cursor: "pointer",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    background: "var(--field)",
    border: "1px solid var(--line)",
    borderRadius: 6,
    overflow: "hidden",
  },
  chipMain: {
    background: "transparent",
    border: "none",
    color: "var(--ink)",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    padding: "5px 8px",
    maxWidth: 220,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  chipDismiss: {
    background: "transparent",
    border: "none",
    borderLeft: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontSize: 12,
    padding: "5px 8px",
  },
  tableWrap: { overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12.5 },
  th: {
    textAlign: "center",
    padding: "8px 10px",
    borderBottom: "1px solid var(--line)",
    color: "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 10.5,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
  },
  tr: { borderBottom: "1px solid var(--line)" },
  td: { padding: "6px 8px" },
  cellInput: {
    width: "100%",
    minWidth: 140,
    padding: "6px 8px",
    borderRadius: 5,
    border: "1px solid var(--line)",
    fontSize: 12.5,
    fontFamily: "var(--font-mono)",
  },
  linkBtn: {
    background: "none",
    border: "none",
    color: "var(--ledger)",
    fontSize: 12,
    fontWeight: 600,
    marginRight: 12,
    padding: 0,
    fontFamily: "var(--font-body)",
  },
  addBtn: {
    background: "transparent",
    color: "var(--ledger)",
    border: "1px solid var(--ledger)",
    borderRadius: 5,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: "nowrap",
  },
};

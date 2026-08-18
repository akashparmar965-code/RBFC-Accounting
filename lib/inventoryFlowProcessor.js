import * as XLSX from "xlsx";

// Columns that only ever hold numbers on a grand-total line. Every other
// column (Store, Bin, Product ID, From/To, Serial, ...) is blank on such a
// line, which is what distinguishes it from a real data row.
const NUMERIC_ONLY_COLUMNS = ["Qty", "Cost", "Ext Cost", "Total Cost"];

/**
 * True for the trailing grand-total line these exports append: every label
 * column blank, only Qty/Total Cost filled with the file's own totals.
 * Left in, it double-counts the whole file's value (it literally equals the
 * sum of every row above it) — real, hit on a live run.
 */
function isTotalsRow(row) {
  let sawValue = false;
  for (const key of Object.keys(row)) {
    const v = row[key];
    const blank = v == null || String(v).trim() === "";
    if (blank) continue;
    if (!NUMERIC_ONLY_COLUMNS.includes(key)) return false; // a real identifying value -> real row
    sawValue = true;
  }
  return sawValue; // all-blank rows aren't totals rows, they're just empty
}

function dropTotalsRows(rows) {
  return rows.filter((r) => !isTotalsRow(r));
}

/** Parse an Opening/Closing "Inventory Quantity by Date" snapshot export (xlsx). */
export function parseInventorySnapshotWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return dropTotalsRows(XLSX.utils.sheet_to_json(sheet, { defval: null }));
}

/**
 * Parse a Store Transfer Shipment/Receiving or Purchase Order Receiving
 * export (xlsx) — all 3 share the same core columns (Reference #, Date,
 * Document #, From, To, Product ID, Products Desc, Serial #, Qty, Cost,
 * Ext Cost, Status, Created By); Purchase Order Receiving has a couple of
 * extra trailing columns (DealerCodeFrom/To, PO #), harmlessly ignored.
 */
export function parseTransferWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return dropTotalsRows(XLSX.utils.sheet_to_json(sheet, { defval: null }));
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function cleanSerial(v) {
  return v != null ? String(v).trim() : "";
}

/** Like toNumber, but returns null (not 0) when the source cell is genuinely blank — so "unknown cost" is never confused with "cost of $0". */
function costOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function sumBy(rows, fn) {
  return round2(rows.reduce((sum, row) => sum + (toNumber(fn(row)) || 0), 0));
}

// Preference order for "which event's cost do we trust for this serial" —
// Opening Inventory and Purchase Order Receiving carry the most reliable
// cost basis; a Sale's Ext Cost is trusted last since it's cost-of-goods
// on the transaction, not necessarily the same figure as inventory cost.
const COST_PRIORITY = ["OPEN", "PO_IN", "XFER_IN", "CLOSE", "XFER_OUT", "VENDOR_RETURN", "SOLD", "RETURNED"];

function bestKnownCost(events) {
  for (const type of COST_PRIORITY) {
    const e = events.find((ev) => ev.type === type && ev.cost != null);
    if (e) return e.cost;
  }
  return 0;
}

/**
 * Build the full serial-level reconciliation report for one month from
 * the 6 uploaded files. Only serialized rows (devices) participate in
 * per-serial tracking — accessories have no unique identity to trace and
 * are only reflected in the aggregate `flowByRoute` totals.
 *
 * Rules (confirmed with the user before building):
 *   - "Sold" = net of Sale minus Return/Exchange-return for that serial
 *     this period. An Exchange is one negative-qty line for the returned
 *     serial + one positive-qty line for the new serial — treated as a
 *     Return event + a separate Sale event, not one combined event.
 *   - A Sales row only counts as the device's own line (not a plan/
 *     service line that happens to carry the same phone's serial for
 *     reference — confirmed this happens in real data: a phone's serial
 *     is stamped on every line of its transaction) when `Category` is
 *     non-blank; every plan/service line sampled had a blank Category,
 *     while the device's own line did not.
 *   - "In Transit" = shipped (Store Transfer Shipment) but not yet
 *     confirmed received (Store Transfer Receiving) this period — its
 *     own status, never counted as Missing.
 *   - "Missing" = known to exist this month (Opening, Purchase Order
 *     Receiving, or a completed transfer-in) but not sold, not found in
 *     Closing Inventory, and not explained by an outstanding shipment.
 *   - Scope is per-store: a serial found in Closing at a different store
 *     than expected (Opening store, or transfer/purchase destination) is
 *     flagged as a store mismatch, independent of whether it's missing.
 *   - A serial with no Opening/Purchase/Transfer-in record this month at
 *     all, but that shows up in Sales or Closing anyway, is flagged as
 *     "unexplained new" — informational, most likely a purchase/intake
 *     source outside these 6 files, not necessarily a problem.
 *   - "Vendor Return" (RMA Shipment) = shipped back to the vendor this
 *     month. Has a known, final disposition — never counted as Missing,
 *     even though (like Missing) it won't appear in Sales or Closing.
 *
 * @returns {{
 *   missing: Array<{serial, productDesc, lastKnownStore, events, cost}>,
 *   inTransit: Array<{serial, productDesc, from, to, shippedDate, cost}>,
 *   storeMismatch: Array<{serial, productDesc, expectedStore, foundStore, cost}>,
 *   unexplainedNew: Array<{serial, productDesc, note, store, cost}>,
 *   soldAnomalies: Array<{serial, productDesc, store, note, cost}>,
 *   vendorReturns: Array<{serial, productDesc, store, vendor, date, cost}>,
 *   flowByRoute: Array<{from, to, kind, serialCount, lineCount, totalExtCost}>,
 *   stats: Object,
 * }}
 */
export function buildInventoryFlowReport({
  openingRows = [],
  closingRows = [],
  poReceivingRows = [],
  shipmentRows = [],
  receivingRows = [],
  rmaRows = [],
  salesRows = [],
}) {
  const serials = new Map(); // serial -> { productDesc, events: [] }

  function ensure(serial, desc) {
    if (!serials.has(serial)) serials.set(serial, { productDesc: desc || "", events: [] });
    const rec = serials.get(serial);
    if (!rec.productDesc && desc) rec.productDesc = desc;
    return rec;
  }

  for (const row of openingRows) {
    const serial = cleanSerial(row["Serial 1"]);
    if (!serial) continue;
    ensure(serial, row["Product Desc Full"]).events.push({
      type: "OPEN",
      store: row["Store"],
      cost: costOrNull(row["Total Cost"]),
    });
  }
  for (const row of closingRows) {
    const serial = cleanSerial(row["Serial 1"]);
    if (!serial) continue;
    ensure(serial, row["Product Desc Full"]).events.push({
      type: "CLOSE",
      store: row["Store"],
      cost: costOrNull(row["Total Cost"]),
    });
  }
  for (const row of poReceivingRows) {
    const serial = cleanSerial(row["Serial #"]);
    if (!serial) continue;
    ensure(serial, row["Products Desc"]).events.push({
      type: "PO_IN",
      from: row["From"],
      to: row["To"],
      date: row["Date"],
      cost: costOrNull(row["Ext Cost"]),
    });
  }
  for (const row of shipmentRows) {
    const serial = cleanSerial(row["Serial #"]);
    if (!serial) continue;
    ensure(serial, row["Products Desc"]).events.push({
      type: "XFER_OUT",
      from: row["From"],
      to: row["To"],
      date: row["Date"],
      cost: costOrNull(row["Ext Cost"]),
    });
  }
  for (const row of receivingRows) {
    const serial = cleanSerial(row["Serial #"]);
    if (!serial) continue;
    ensure(serial, row["Products Desc"]).events.push({
      type: "XFER_IN",
      from: row["From"],
      to: row["To"],
      date: row["Date"],
      cost: costOrNull(row["Ext Cost"]),
    });
  }
  for (const row of rmaRows) {
    const serial = cleanSerial(row["Serial #"]);
    if (!serial) continue;
    ensure(serial, row["Products Desc"]).events.push({
      type: "VENDOR_RETURN",
      store: row["From"],
      vendor: row["To"],
      date: row["Date"],
      cost: costOrNull(row["Ext Cost"]),
    });
  }
  for (const row of salesRows) {
    if (row["Voided"]) continue;
    const serial = cleanSerial(row["Serial 1"]);
    if (!serial) continue;
    const category = row["Category"] != null ? String(row["Category"]).trim() : "";
    if (!category) continue; // plan/service line just referencing the device's serial, not the device's own line
    const transType = row["Trans Type"];
    const qty = toNumber(row["Qty"]);
    const store = row["Store"];
    const date = row["Trans Date Time"];
    const cost = costOrNull(row["Ext Cost"]);
    if (transType === "Sale") {
      ensure(serial, row["Product Desc"]).events.push({ type: "SOLD", store, date, cost });
    } else if (transType === "Return") {
      ensure(serial, row["Product Desc"]).events.push({ type: "RETURNED", store, date, cost });
    } else if (transType === "Exchange") {
      ensure(serial, row["Product Desc"]).events.push({ type: qty < 0 ? "RETURNED" : "SOLD", store, date, cost });
    }
  }

  const missing = [];
  const inTransit = [];
  const storeMismatch = [];
  const unexplainedNew = [];
  const soldAnomalies = [];
  const vendorReturns = [];

  for (const [serial, rec] of serials.entries()) {
    const events = rec.events;
    const openEvent = events.find((e) => e.type === "OPEN");
    const closeEvent = events.find((e) => e.type === "CLOSE");
    const soldCount = events.filter((e) => e.type === "SOLD").length;
    const returnedCount = events.filter((e) => e.type === "RETURNED").length;
    const netSold = soldCount - returnedCount;
    const xferOuts = events.filter((e) => e.type === "XFER_OUT");
    const xferIns = events.filter((e) => e.type === "XFER_IN");
    const poIns = events.filter((e) => e.type === "PO_IN");

    let expectedStore = openEvent ? openEvent.store : null;
    if (xferIns.length > 0) expectedStore = xferIns[xferIns.length - 1].to;
    else if (poIns.length > 0) expectedStore = poIns[poIns.length - 1].to;

    const hadKnownOrigin = !!openEvent || poIns.length > 0 || xferIns.length > 0;
    const cost = bestKnownCost(events);

    if (netSold > 0) {
      if (closeEvent) {
        soldAnomalies.push({
          serial,
          productDesc: rec.productDesc,
          store: closeEvent.store,
          note: "Sold this period but still appears in Closing Inventory",
          cost,
        });
      }
      if (!hadKnownOrigin) {
        unexplainedNew.push({
          serial,
          productDesc: rec.productDesc,
          note: "Sold with no Opening/Purchase/Transfer-in record this month",
          cost,
        });
      }
      continue;
    }

    if (closeEvent) {
      if (expectedStore && closeEvent.store !== expectedStore) {
        storeMismatch.push({
          serial,
          productDesc: rec.productDesc,
          expectedStore,
          foundStore: closeEvent.store,
          cost,
        });
      }
      if (!hadKnownOrigin) {
        unexplainedNew.push({
          serial,
          productDesc: rec.productDesc,
          store: closeEvent.store,
          note: "Found in Closing Inventory with no Opening/Purchase/Transfer-in record this month",
          cost,
        });
      }
      continue;
    }

    // Not sold, not in Closing. A vendor return is a known, final
    // disposition — resolved, never counted as Missing.
    const vendorReturnEvents = events.filter((e) => e.type === "VENDOR_RETURN");
    if (vendorReturnEvents.length > 0) {
      const lastReturn = vendorReturnEvents[vendorReturnEvents.length - 1];
      vendorReturns.push({
        serial,
        productDesc: rec.productDesc,
        store: lastReturn.store,
        vendor: lastReturn.vendor,
        date: lastReturn.date,
        cost,
      });
      continue;
    }

    if (xferOuts.length > xferIns.length) {
      const lastOut = xferOuts[xferOuts.length - 1];
      inTransit.push({
        serial,
        productDesc: rec.productDesc,
        from: lastOut.from,
        to: lastOut.to,
        shippedDate: lastOut.date,
        cost,
      });
      continue;
    }

    if (hadKnownOrigin) {
      missing.push({
        serial,
        productDesc: rec.productDesc,
        lastKnownStore: expectedStore,
        events: events.map((e) => ({ type: e.type, store: e.store || e.to || e.from || null, date: e.date || null })),
        cost,
      });
    }
  }

  function aggregateRoute(rows, kind) {
    const byRoute = new Map();
    for (const row of rows) {
      const from = row["From"] || "";
      const to = row["To"] || "";
      const key = `${kind}|${from}|${to}`;
      if (!byRoute.has(key)) byRoute.set(key, { from, to, kind, serialCount: 0, lineCount: 0, totalExtCost: 0 });
      const r = byRoute.get(key);
      r.lineCount += 1;
      if (cleanSerial(row["Serial #"])) r.serialCount += 1;
      r.totalExtCost = round2(r.totalExtCost + toNumber(row["Ext Cost"]));
    }
    return Array.from(byRoute.values());
  }

  const flowByRoute = [
    ...aggregateRoute(shipmentRows, "Store Transfer"),
    ...aggregateRoute(poReceivingRows, "Purchase Order"),
    ...aggregateRoute(rmaRows, "Vendor Return"),
  ];

  const stats = {
    totalSerialsTracked: serials.size,
    totalMissing: missing.length,
    totalInTransit: inTransit.length,
    totalStoreMismatch: storeMismatch.length,
    totalUnexplainedNew: unexplainedNew.length,
    totalSoldAnomalies: soldAnomalies.length,
    totalVendorReturns: vendorReturns.length,

    // Cost/value analytics — dollar exposure behind each flagged category,
    // plus the two snapshot totals and the raw flow volume (all serialized
    // + non-serialized rows, not just tracked serials).
    totalMissingValue: sumBy(missing, (r) => r.cost),
    totalInTransitValue: sumBy(inTransit, (r) => r.cost),
    totalStoreMismatchValue: sumBy(storeMismatch, (r) => r.cost),
    totalUnexplainedNewValue: sumBy(unexplainedNew, (r) => r.cost),
    totalSoldAnomaliesValue: sumBy(soldAnomalies, (r) => r.cost),
    totalVendorReturnsValue: sumBy(vendorReturns, (r) => r.cost),

    totalOpeningValue: sumBy(openingRows, (r) => r["Total Cost"]),
    totalClosingValue: sumBy(closingRows, (r) => r["Total Cost"]),
    totalPurchaseInValue: sumBy(poReceivingRows, (r) => r["Ext Cost"]),
    totalTransferOutValue: sumBy(shipmentRows, (r) => r["Ext Cost"]),
    totalTransferInValue: sumBy(receivingRows, (r) => r["Ext Cost"]),
    totalVendorReturnOutValue: sumBy(rmaRows, (r) => r["Ext Cost"]),
  };

  return { missing, inTransit, storeMismatch, unexplainedNew, soldAnomalies, vendorReturns, flowByRoute, stats };
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Build a CSV string from an array of flat row objects, columns = the given header list (keys into each row). */
export function rowsToCsvGeneric(rows, columns) {
  const header = columns.join(",");
  const lines = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(","));
  return [header, ...lines].join("\n");
}

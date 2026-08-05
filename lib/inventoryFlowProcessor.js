import * as XLSX from "xlsx";

/** Parse an Opening/Closing "Inventory Quantity by Date" snapshot export (xlsx). */
export function parseInventorySnapshotWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
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
  return XLSX.utils.sheet_to_json(sheet, { defval: null });
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
 *
 * @returns {{
 *   missing: Array<{serial, productDesc, lastKnownStore, events}>,
 *   inTransit: Array<{serial, productDesc, from, to, shippedDate}>,
 *   storeMismatch: Array<{serial, productDesc, expectedStore, foundStore}>,
 *   unexplainedNew: Array<{serial, productDesc, note, store}>,
 *   soldAnomalies: Array<{serial, productDesc, store, note}>,
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
    ensure(serial, row["Product Desc Full"]).events.push({ type: "OPEN", store: row["Store"] });
  }
  for (const row of closingRows) {
    const serial = cleanSerial(row["Serial 1"]);
    if (!serial) continue;
    ensure(serial, row["Product Desc Full"]).events.push({ type: "CLOSE", store: row["Store"] });
  }
  for (const row of poReceivingRows) {
    const serial = cleanSerial(row["Serial #"]);
    if (!serial) continue;
    ensure(serial, row["Products Desc"]).events.push({
      type: "PO_IN",
      from: row["From"],
      to: row["To"],
      date: row["Date"],
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
    if (transType === "Sale") {
      ensure(serial, row["Product Desc"]).events.push({ type: "SOLD", store, date });
    } else if (transType === "Return") {
      ensure(serial, row["Product Desc"]).events.push({ type: "RETURNED", store, date });
    } else if (transType === "Exchange") {
      ensure(serial, row["Product Desc"]).events.push({ type: qty < 0 ? "RETURNED" : "SOLD", store, date });
    }
  }

  const missing = [];
  const inTransit = [];
  const storeMismatch = [];
  const unexplainedNew = [];
  const soldAnomalies = [];

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

    if (netSold > 0) {
      if (closeEvent) {
        soldAnomalies.push({
          serial,
          productDesc: rec.productDesc,
          store: closeEvent.store,
          note: "Sold this period but still appears in Closing Inventory",
        });
      }
      if (!hadKnownOrigin) {
        unexplainedNew.push({
          serial,
          productDesc: rec.productDesc,
          note: "Sold with no Opening/Purchase/Transfer-in record this month",
        });
      }
      continue;
    }

    if (closeEvent) {
      if (expectedStore && closeEvent.store !== expectedStore) {
        storeMismatch.push({ serial, productDesc: rec.productDesc, expectedStore, foundStore: closeEvent.store });
      }
      if (!hadKnownOrigin) {
        unexplainedNew.push({
          serial,
          productDesc: rec.productDesc,
          store: closeEvent.store,
          note: "Found in Closing Inventory with no Opening/Purchase/Transfer-in record this month",
        });
      }
      continue;
    }

    // Not sold, not in Closing.
    if (xferOuts.length > xferIns.length) {
      const lastOut = xferOuts[xferOuts.length - 1];
      inTransit.push({ serial, productDesc: rec.productDesc, from: lastOut.from, to: lastOut.to, shippedDate: lastOut.date });
      continue;
    }

    if (hadKnownOrigin) {
      missing.push({
        serial,
        productDesc: rec.productDesc,
        lastKnownStore: expectedStore,
        events: events.map((e) => ({ type: e.type, store: e.store || e.to || e.from || null, date: e.date || null })),
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

  const flowByRoute = [...aggregateRoute(shipmentRows, "Store Transfer"), ...aggregateRoute(poReceivingRows, "Purchase Order")];

  const stats = {
    totalSerialsTracked: serials.size,
    totalMissing: missing.length,
    totalInTransit: inTransit.length,
    totalStoreMismatch: storeMismatch.length,
    totalUnexplainedNew: unexplainedNew.length,
    totalSoldAnomalies: soldAnomalies.length,
  };

  return { missing, inTransit, storeMismatch, unexplainedNew, soldAnomalies, flowByRoute, stats };
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

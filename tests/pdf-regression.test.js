"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const renderer = require("../pdf/pdf-export.js");
const integration = require("../pdf/pdf-integration.js");

const projectRoot = path.resolve(__dirname, "..");
const assets = {
  regularFontBytes: new Uint8Array(fs.readFileSync(path.join(projectRoot, "pdf/fonts/NotoSans-Regular.ttf"))),
  boldFontBytes: new Uint8Array(fs.readFileSync(path.join(projectRoot, "pdf/fonts/NotoSans-Bold.ttf"))),
  logoDataUrl: `data:image/png;base64,${fs.readFileSync(path.join(projectRoot, "VSTD LOGO 3.0.png")).toString("base64")}`
};

function input(value, unit) {
  return { value: String(value == null ? "" : value), dataset: { unit: unit || "" } };
}

function row(values, displayedAmount) {
  const cells = [
    {},
    { querySelector: () => input(values.description, values.unit) },
    { querySelector: () => input(values.quantity) },
    { querySelector: () => input(values.rate) },
    { textContent: displayedAmount == null ? "" : String(displayedAmount) },
    {}
  ];
  return { cells };
}

function formDocument(values, rows) {
  const elements = Object.fromEntries(Object.entries(values).map(([id, value]) => [
    id,
    { value: String(value == null ? "" : value), textContent: String(value == null ? "" : value) }
  ]));
  return {
    getElementById(id) { return elements[id] || null; },
    querySelectorAll(selector) { return selector === "#tbl tbody tr" ? rows : []; }
  };
}

function ledgerDocument(type, count) {
  const headers = ["No", "Date", type === "purchase-order" ? "Supplier" : "Customer", "Total", "Actions"]
    .map((textContent) => ({ textContent }));
  const rows = Array.from({ length: count }, (_, index) => ({
    cells: [
      { textContent: `${type === "purchase-order" ? "PO" : "Q"}-${index + 1}` },
      { textContent: "08-10-2026" },
      { textContent: `Test Party ${index + 1}` },
      { textContent: type === "purchase-order" ? `${index + 1}.00` : `₹ ${(index + 1) * 100}.00` },
      { textContent: "Open Delete" }
    ]
  }));
  const table = {
    querySelectorAll(selector) {
      if (selector === "thead th") return headers;
      if (selector === "tbody tr") return rows;
      return [];
    }
  };
  return {
    getElementById(id) {
      if (id === "ledgerTable") return table;
      if (id === "ledgerPrintFilters") return { textContent: "Filters: Date: 08-10-2026" };
      return null;
    }
  };
}

function assertPdf(result, filenamePart, minimumPages) {
  assert(result.bytes.length > 50000, "PDF should contain embedded fonts and document content");
  assert.strictEqual(Buffer.from(result.bytes.subarray(0, 5)).toString("ascii"), "%PDF-");
  assert(result.filename.includes(filenamePart), `Expected filename to contain ${filenamePart}`);
  assert(result.doc.getNumberOfPages() >= minimumPages, `Expected at least ${minimumPages} PDF page(s)`);
}

async function run() {
  assert.strictEqual(integration.shouldUseGeneratedPdf({ standalone: true }), true, "iOS standalone must use generated PDF");
  assert.strictEqual(integration.shouldUseGeneratedPdf({ standalone: false }), false, "iOS Safari must retain native print");
  assert.strictEqual(integration.shouldUseGeneratedPdf({}), false, "Android and Windows must retain native print");
  assert.strictEqual(integration._test.isShareCancellation({ name: "AbortError" }), true);
  assert.strictEqual(integration._test.isShareCancellation({ name: "NotAllowedError" }), false);

  globalThis.resolveCurrentFolio = () => ({
    name: "Test Supplier",
    phone: "9000000000",
    altPhone: "9111111111",
    address: "123 Test Street",
    gstin: "33ABCDE1234F1Z5"
  });
  const poRows = Array.from({ length: 55 }, (_, index) => row({
    description: `Long production test product ${index + 1} ${"description ".repeat(5)}`,
    quantity: index + 0.5,
    unit: "kg"
  }));
  const poDoc = formDocument({
    qno: "PO-TEST-101",
    date: "2026-10-08",
    client: "Fallback supplier",
    phone: "",
    reqBy: "Test Employee",
    shipVia: "TN 00 TEST",
    shipTerms: "Delivery test only",
    grand: "1512.50"
  }, poRows);
  const poModel = renderer.buildPurchaseOrderPdfModel(poDoc);
  assert.strictEqual(poModel.items.length, 55);
  assert.strictEqual(poModel.totals.totalQuantity, 1512.5, "PO must use the displayed application total");
  assert.strictEqual(poModel.party.name, "Test Supplier", "Reopened PO folio details must be retained");
  const poPdf = await renderer.generateBusinessPdf(poModel, assets);
  assertPdf(poPdf, "PO-TEST-101", 2);

  globalThis.resolveCurrentFolio = () => null;
  const quoteRows = Array.from({ length: 55 }, (_, index) => row({
    description: `Long quotation test product ${index + 1} ${"description ".repeat(5)}`,
    quantity: 2,
    rate: index + 100,
    unit: "nos"
  }, (index + 100) * 2));
  const quoteDoc = formDocument({
    qno: "Q-TEST-202",
    date: "2026-10-08",
    client: "Test Customer",
    phone: "9222222222",
    pkg: "250.00",
    disc: "125.00",
    gst: "18",
    cgst: "1143.45",
    sgst: "1143.45",
    grand: "15002.90"
  }, quoteRows);
  const quoteModel = renderer.buildQuotationPdfModel(quoteDoc);
  assert.strictEqual(quoteModel.items.length, 55);
  assert.strictEqual(quoteModel.totals.packaging, 250);
  assert.strictEqual(quoteModel.totals.discount, 125);
  assert.strictEqual(quoteModel.totals.cgst, 1143.45, "Quotation must preserve displayed CGST");
  assert.strictEqual(quoteModel.totals.sgst, 1143.45, "Quotation must preserve displayed SGST");
  assert.strictEqual(quoteModel.totals.grandTotal, 15002.9, "Quotation must preserve displayed grand total");
  const quotePdf = await renderer.generateBusinessPdf(quoteModel, assets);
  assertPdf(quotePdf, "Q-TEST-202", 2);
  assert(renderer.currency(1).startsWith("₹"), "Rupee glyph must remain Unicode U+20B9");

  const zeroQuote = renderer.buildQuotationPdfModel(formDocument({
    qno: "Q-DRAFT",
    date: "2026-10-08",
    client: "",
    phone: "",
    pkg: "0",
    disc: "0",
    gst: "0",
    cgst: "0",
    sgst: "0",
    grand: "200"
  }, [row({ description: "Draft item", quantity: 2, rate: 100 }, 200)]));
  assert.strictEqual(zeroQuote.totals.packaging, 0);
  assert.strictEqual(zeroQuote.totals.discount, 0);
  assertPdf(await renderer.generateBusinessPdf(zeroQuote, assets), "Q-DRAFT", 1);

  for (const type of ["purchase-order", "quotation"]) {
    const ledgerModel = renderer.buildLedgerPdfModel(type, ledgerDocument(type, 65));
    assert.strictEqual(ledgerModel.columns.length, 4, "Ledger Actions column must not enter PDF");
    assert.strictEqual(ledgerModel.rows.length, 65);
    assert(ledgerModel.rows.every((entry) => entry.length === 4));
    assertPdf(await renderer.generateLedgerPdf(ledgerModel, assets), "History", 2);
  }

  const sw = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  assert(sw.includes('gst-quote-v11'));
  for (const assetPath of [
    "pdf/pdf-integration.js",
    "pdf/pdf-export.js",
    "pdf/vendor/jspdf-4.2.1.umd.min.js",
    "pdf/vendor/jspdf-autotable-5.0.8.min.js",
    "pdf/fonts/NotoSans-Regular.ttf",
    "pdf/fonts/NotoSans-Bold.ttf",
    "VSTD LOGO 3.0.png"
  ]) {
    assert(sw.includes(assetPath), `${assetPath} must be pre-cached for offline PDF generation`);
  }

  const integrationSource = fs.readFileSync(path.join(projectRoot, "pdf/pdf-integration.js"), "utf8");
  assert(!/firebase|localStorage|indexedDB/i.test(integrationSource), "PDF integration must not write persistence or Firebase");
  console.log("PDF regression tests passed: routing, document parity, long tables, ledgers, rupee, and offline assets.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

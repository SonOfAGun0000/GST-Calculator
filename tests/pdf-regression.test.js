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

function encodeNotoAscii(value) {
  return Array.from(value).map((character) => {
    const code = character.codePointAt(0);
    assert(code >= 32 && code <= 126, `Test helper only supports printable ASCII: ${character}`);
    return (code - 29).toString(16).padStart(4, "0");
  }).join("");
}

function pageCommands(result) {
  return result.doc.internal.pages.slice(1).map((page) => page.join("\n"));
}

function assertBlackText(result, value) {
  const encoded = `<${encodeNotoAscii(value)}> Tj`;
  const commands = result.doc.internal.pages.slice(1).flat();
  const index = commands.findIndex((command) => command.includes(encoded));
  assert(index >= 0, `Expected actual PDF content for: ${value}`);
  const precedingCommands = commands.slice(Math.max(0, index - 12), index);
  const colorScope = [commands[index], ...precedingCommands];
  assert(colorScope.some((command) => command.includes("0.067 g")), `${value} must be emitted as #111111 text`);
}

function assertDecorations(result) {
  const pages = pageCommands(result);
  assert(pages.some((page) => page.includes("/I0 Do")), "Existing logo must be emitted into the PDF");
  pages.forEach((page, index) => {
    const pageLabel = `<${encodeNotoAscii(`Page ${index + 1} of ${pages.length}`)}> Tj`;
    assert(page.includes(pageLabel), `Page ${index + 1} must contain its page-number footer`);
    assert(page.includes(`<${encodeNotoAscii("Questions? Contact")}`.slice(0, -1)), `Page ${index + 1} must contain the contact footer`);
  });
}

function assertHighContrastContent(result) {
  const commands = pageCommands(result).join("\n");
  assert(!commands.includes("0.094 0.129 0.169 rg"), "Legacy light body text color must not appear in emitted PDF content");
}

async function run() {
  assert.strictEqual(integration.shouldUseGeneratedPdf({ standalone: true }), true, "iOS standalone must use generated PDF");
  assert.strictEqual(integration.shouldUseGeneratedPdf({ standalone: false }), true, "iPhone Safari must use generated PDF");
  assert.strictEqual(integration.shouldUseGeneratedPdf({}), true, "Android and Windows must use generated PDF");
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
  assertBlackText(poPdf, "PO-TEST-101");
  assertBlackText(poPdf, "Test Supplier");
  assertHighContrastContent(poPdf);
  assertDecorations(poPdf);

  globalThis.resolveCurrentFolio = () => null;
  const draftPoModel = renderer.buildPurchaseOrderPdfModel(formDocument({
    qno: "PO-DRAFT",
    date: "2026-10-08",
    client: "Draft Supplier",
    phone: "",
    reqBy: "",
    shipVia: "",
    shipTerms: "",
    grand: "2.00"
  }, [row({ description: "Draft PO item", quantity: 2, unit: "nos" })]));
  const draftPoPdf = await renderer.generateBusinessPdf(draftPoModel, assets);
  assertPdf(draftPoPdf, "PO-DRAFT", 1);
  assertBlackText(draftPoPdf, "Draft Supplier");
  assertBlackText(draftPoPdf, "Draft PO item");
  assertHighContrastContent(draftPoPdf);

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
  assertBlackText(quotePdf, "Q-TEST-202");
  assertBlackText(quotePdf, "Test Customer");
  assertHighContrastContent(quotePdf);
  assertDecorations(quotePdf);
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
  const zeroQuotePdf = await renderer.generateBusinessPdf(zeroQuote, assets);
  assertPdf(zeroQuotePdf, "Q-DRAFT", 1);
  assertBlackText(zeroQuotePdf, "Draft item");
  assertBlackText(zeroQuotePdf, "2.00");
  assertHighContrastContent(zeroQuotePdf);

  for (const type of ["purchase-order", "quotation"]) {
    const ledgerModel = renderer.buildLedgerPdfModel(type, ledgerDocument(type, 65));
    assert.strictEqual(ledgerModel.columns.length, 4, "Ledger Actions column must not enter PDF");
    assert.strictEqual(ledgerModel.rows.length, 65);
    assert(ledgerModel.rows.every((entry) => entry.length === 4));
    const ledgerPdf = await renderer.generateLedgerPdf(ledgerModel, assets);
    assertPdf(ledgerPdf, "History", 2);
    assertBlackText(ledgerPdf, "Test Party 1");
    assertHighContrastContent(ledgerPdf);
    assertDecorations(ledgerPdf);
  }

  const sw = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");
  assert(sw.includes('gst-quote-v14'));
  for (const assetPath of [
    "autocomplete-positioning.js",
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
  assert(integrationSource.includes("navigator.share(payload)"), "Share must be invoked with the app-controlled File payload");
  assert(!/share\(\s*\{[^}]*\b(?:url|text)\s*:/s.test(integrationSource), "Share must not send blob or application URLs");
  assert(integrationSource.includes('anchor.target = "_blank"'), "Open PDF must use a separate native browser viewer");
  assert(!/iframe|Preview PDF|Download PDF|Browser Print|pdfPreview/i.test(integrationSource), "Compact dialog must not retain preview, download, print, or iframe code");
  assert(integrationSource.includes(">Share PDF</button>"));
  assert(integrationSource.includes(">Open PDF</button>"));
  console.log("PDF regression tests passed: six exports, universal routing, dark content, compact share/open dialog, and offline assets.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

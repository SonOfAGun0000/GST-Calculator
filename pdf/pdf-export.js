(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./vendor/jspdf-4.2.1.umd.min.js"),
      require("./vendor/jspdf-autotable-5.0.8.min.js")
    );
  } else {
    root.VstdPdfRenderer = factory(root.jspdf, { autoTable: root.autoTable });
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (jspdfModule, autoTableModule) {
  "use strict";

  const jsPDF = jspdfModule && jspdfModule.jsPDF;
  const autoTable = autoTableModule && autoTableModule.autoTable;
  const PAGE_WIDTH = 210;
  const PAGE_HEIGHT = 297;
  const MARGIN = 14;
  const BRAND = [153, 27, 43];

  const DEFAULT_BUSINESS = Object.freeze({
    name: "VSTD COMPANY",
    address: "11/33 Thadagam Rd, Edayarpalayam, Coimbatore - 641025",
    contactName: "Kasi Anandan",
    contactPhone: "+91 98946 99090"
  });

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatDate(value) {
    const raw = text(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : raw;
  }

  function indian(value) {
    return number(value).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function currency(value) {
    return `₹ ${indian(value)}`;
  }

  function sanitizeFilenamePart(value, fallback) {
    const cleaned = text(value)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
    return cleaned || fallback;
  }

  function buildFilename(model) {
    const type = model.documentType === "purchase-order" ? "PO" : "Quotation";
    const documentNumber = sanitizeFilenamePart(model.documentNumber, "Draft");
    const date = sanitizeFilenamePart(formatDate(model.date), "Undated");
    return `VSTD-${type}-${documentNumber}-${date}.pdf`;
  }

  function getElementValue(documentRoot, id) {
    const element = documentRoot && documentRoot.getElementById(id);
    return text(element && ("value" in element ? element.value : element.textContent));
  }

  function currentParty(documentRoot) {
    let folio = null;
    try {
      if (typeof globalThis.resolveCurrentFolio === "function") {
        folio = globalThis.resolveCurrentFolio();
      }
    } catch (_) {
      folio = null;
    }
    return {
      name: text(folio && folio.name) || getElementValue(documentRoot, "client"),
      phone: text(folio && folio.phone) || getElementValue(documentRoot, "phone"),
      alternatePhone: text(folio && folio.altPhone),
      address: text(folio && folio.address),
      gstin: text(folio && folio.gstin)
    };
  }

  function tableRows(documentRoot) {
    if (!documentRoot) return [];
    return Array.from(documentRoot.querySelectorAll("#tbl tbody tr"));
  }

  function buildPurchaseOrderPdfModel(documentRoot) {
    const items = tableRows(documentRoot).map((row) => {
      const productInput = row.cells && row.cells[1] && row.cells[1].querySelector("input");
      const quantityInput = row.cells && row.cells[2] && row.cells[2].querySelector("input");
      return {
        description: text(productInput && productInput.value),
        quantity: number(quantityInput && quantityInput.value),
        unit: text(productInput && productInput.dataset && productInput.dataset.unit)
      };
    }).filter((item) => item.description || item.quantity);

    return normalizeModel({
      documentType: "purchase-order",
      documentNumber: getElementValue(documentRoot, "qno"),
      date: getElementValue(documentRoot, "date"),
      party: currentParty(documentRoot),
      shipping: {
        requestedBy: getElementValue(documentRoot, "reqBy"),
        shipVia: getElementValue(documentRoot, "shipVia"),
        shippingTerms: getElementValue(documentRoot, "shipTerms")
      },
      items,
      totals: {
        totalQuantity: number(getElementValue(documentRoot, "grand")) ||
          items.reduce((sum, item) => sum + number(item.quantity), 0)
      },
      business: DEFAULT_BUSINESS
    });
  }

  function buildQuotationPdfModel(documentRoot) {
    const items = tableRows(documentRoot).map((row) => {
      const productInput = row.cells && row.cells[1] && row.cells[1].querySelector("input");
      const quantityInput = row.cells && row.cells[2] && row.cells[2].querySelector("input");
      const rateInput = row.cells && row.cells[3] && row.cells[3].querySelector("input");
      const quantity = number(quantityInput && quantityInput.value);
      const rate = number(rateInput && rateInput.value);
      const displayedAmount = row.cells && row.cells[4] ? number(row.cells[4].textContent) : 0;
      return {
        description: text(productInput && productInput.value),
        quantity,
        unit: text(productInput && productInput.dataset && productInput.dataset.unit),
        rate,
        amount: displayedAmount || quantity * rate
      };
    }).filter((item) => item.description || item.quantity || item.rate);

    const subtotal = items.reduce((sum, item) => sum + number(item.amount), 0);
    const packaging = number(getElementValue(documentRoot, "pkg"));
    const discount = number(getElementValue(documentRoot, "disc"));
    const taxableValue = subtotal + packaging - discount;
    const gstPercent = number(getElementValue(documentRoot, "gst"));
    const displayedCgst = number(getElementValue(documentRoot, "cgst"));
    const displayedSgst = number(getElementValue(documentRoot, "sgst"));
    const displayedGrand = number(getElementValue(documentRoot, "grand"));
    const totalTax = taxableValue * gstPercent / 100;

    return normalizeModel({
      documentType: "quotation",
      documentNumber: getElementValue(documentRoot, "qno"),
      date: getElementValue(documentRoot, "date"),
      party: currentParty(documentRoot),
      shipping: {},
      items,
      totals: {
        subtotal,
        packaging,
        discount,
        taxableValue,
        gstPercent,
        cgst: displayedCgst || totalTax / 2,
        sgst: displayedSgst || totalTax / 2,
        grandTotal: displayedGrand || taxableValue + totalTax
      },
      business: DEFAULT_BUSINESS
    });
  }

  function buildLedgerPdfModel(sourceType, documentRoot) {
    const purchaseOrder = sourceType === "purchase-order";
    const table = documentRoot && documentRoot.getElementById("ledgerTable");
    const headerCells = table ? Array.from(table.querySelectorAll("thead th")) : [];
    const columns = headerCells.slice(0, -1).map((cell) => text(cell.textContent));
    const rows = table ? Array.from(table.querySelectorAll("tbody tr")).map((row) =>
      Array.from(row.cells).slice(0, -1).map((cell) => text(cell.textContent))
    ) : [];
    const filterElement = documentRoot && documentRoot.getElementById("ledgerPrintFilters");
    return {
      sourceType: purchaseOrder ? "purchase-order" : "quotation",
      title: purchaseOrder ? "PURCHASE ORDER HISTORY" : "QUOTATION HISTORY",
      columns,
      rows,
      filters: text(filterElement && filterElement.textContent),
      business: Object.assign({}, DEFAULT_BUSINESS)
    };
  }

  function normalizeModel(input) {
    const model = input || {};
    const documentType = model.documentType === "purchase-order" ? "purchase-order" : "quotation";
    const items = Array.isArray(model.items) ? model.items.map((item) => ({
      description: text(item.description),
      quantity: number(item.quantity),
      unit: text(item.unit),
      rate: number(item.rate),
      amount: number(item.amount || number(item.quantity) * number(item.rate))
    })) : [];
    return {
      documentType,
      documentNumber: text(model.documentNumber),
      date: text(model.date),
      party: {
        name: text(model.party && model.party.name),
        phone: text(model.party && model.party.phone),
        alternatePhone: text(model.party && model.party.alternatePhone),
        address: text(model.party && model.party.address),
        gstin: text(model.party && model.party.gstin)
      },
      shipping: {
        requestedBy: text(model.shipping && model.shipping.requestedBy),
        shipVia: text(model.shipping && model.shipping.shipVia),
        shippingTerms: text(model.shipping && model.shipping.shippingTerms)
      },
      items,
      totals: Object.assign({}, model.totals || {}),
      business: Object.assign({}, DEFAULT_BUSINESS, model.business || {})
    };
  }

  function bytesToBinaryString(bytes) {
    const chunkSize = 0x8000;
    let result = "";
    for (let index = 0; index < bytes.length; index += chunkSize) {
      result += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
    }
    return result;
  }

  function registerFonts(doc, assets) {
    if (!assets || !assets.regularFontBytes || !assets.boldFontBytes) {
      throw new Error("Both local Noto Sans font files are required");
    }
    doc.addFileToVFS("NotoSans-Regular.ttf", bytesToBinaryString(assets.regularFontBytes));
    doc.addFont("NotoSans-Regular.ttf", "NotoSans", "normal");
    doc.addFileToVFS("NotoSans-Bold.ttf", bytesToBinaryString(assets.boldFontBytes));
    doc.addFont("NotoSans-Bold.ttf", "NotoSans", "bold");
  }

  function drawHeader(doc, model, assets) {
    doc.setTextColor(24, 33, 43);
    doc.setFont("NotoSans", "bold");
    doc.setFontSize(19);
    doc.text(model.business.name, MARGIN, 18);
    doc.setFont("NotoSans", "normal");
    doc.setFontSize(8.5);
    doc.text(model.business.address, MARGIN, 24);

    if (assets.logoDataUrl) {
      try {
        doc.addImage(assets.logoDataUrl, "PNG", 174, 8, 22, 22, "VSTDLogo", "FAST");
      } catch (_) {
        // Branding is optional; PDF generation must remain functional.
      }
    }

    doc.setDrawColor.apply(doc, BRAND);
    doc.setLineWidth(0.8);
    doc.line(MARGIN, 29, PAGE_WIDTH - MARGIN, 29);
    doc.setTextColor.apply(doc, BRAND);
    doc.setFont("NotoSans", "bold");
    doc.setFontSize(16);
    doc.text(model.documentType === "purchase-order" ? "PURCHASE ORDER" : "QUOTATION", PAGE_WIDTH / 2, 38, { align: "center" });

    doc.setTextColor(24, 33, 43);
    doc.setFontSize(9);
    doc.text(model.documentType === "purchase-order" ? "PO No" : "Quotation No", MARGIN, 47);
    doc.text("Date", 140, 47);
    doc.setFontSize(11);
    doc.text(model.documentNumber || "Draft", MARGIN, 53);
    doc.text(formatDate(model.date) || "—", 140, 53);
  }

  function drawParty(doc, model, startY) {
    const label = model.documentType === "purchase-order" ? "Supplier" : "Customer";
    const rows = [
      [label, model.party.name],
      ["Address", model.party.address],
      ["Phone", model.party.phone],
      ["Alternate Phone", model.party.alternatePhone],
      ["GSTIN", model.party.gstin]
    ].filter((entry) => entry[1]);

    let y = startY;
    rows.forEach(([field, value]) => {
      doc.setFont("NotoSans", "bold");
      doc.setFontSize(8.5);
      doc.text(`${field}:`, MARGIN, y);
      doc.setFont("NotoSans", "normal");
      const wrapped = doc.splitTextToSize(value, 145);
      doc.text(wrapped, 46, y);
      y += Math.max(5, wrapped.length * 4.2);
    });
    return y + 2;
  }

  function drawShipping(doc, model, startY) {
    const values = [
      ["Order placed by", model.shipping.requestedBy || "—"],
      ["Vehicle No.", model.shipping.shipVia || "—"],
      ["Shipping Terms", model.shipping.shippingTerms || "—"]
    ];
    autoTable(doc, {
      startY,
      head: [values.map((entry) => entry[0])],
      body: [values.map((entry) => entry[1])],
      margin: { left: MARGIN, right: MARGIN },
      theme: "grid",
      styles: { font: "NotoSans", fontSize: 8.5, cellPadding: 2.2, lineColor: BRAND, lineWidth: 0.25 },
      headStyles: { font: "NotoSans", fontStyle: "bold", fillColor: BRAND, textColor: [255, 255, 255] },
      bodyStyles: { font: "NotoSans", fontStyle: "normal", textColor: [24, 33, 43] }
    });
    return doc.lastAutoTable.finalY + 4;
  }

  function drawItems(doc, model, startY) {
    const purchaseOrder = model.documentType === "purchase-order";
    const head = purchaseOrder
      ? [["S.No", "Product", "Qty"]]
      : [["S.No", "Product", "Qty", "Rate", "Amount"]];
    const body = model.items.map((item, index) => {
      const quantity = item.unit ? `${indian(item.quantity)} ${item.unit}` : indian(item.quantity);
      return purchaseOrder
        ? [String(index + 1), item.description, quantity]
        : [String(index + 1), item.description, quantity, currency(item.rate), currency(item.amount)];
    });

    autoTable(doc, {
      startY,
      head,
      body,
      showHead: "everyPage",
      rowPageBreak: "avoid",
      pageBreak: "auto",
      margin: { top: 19, right: MARGIN, bottom: 24, left: MARGIN },
      theme: "grid",
      styles: {
        font: "NotoSans",
        fontStyle: "normal",
        fontSize: 8.3,
        cellPadding: 2.25,
        lineColor: [93, 105, 117],
        lineWidth: 0.15,
        overflow: "linebreak",
        valign: "middle"
      },
      headStyles: { font: "NotoSans", fontStyle: "bold", fillColor: BRAND, textColor: [255, 255, 255], halign: "center" },
      columnStyles: purchaseOrder ? {
        0: { cellWidth: 14, halign: "center" },
        1: { cellWidth: 132 },
        2: { cellWidth: 36, halign: "right" }
      } : {
        0: { cellWidth: 12, halign: "center" },
        1: { cellWidth: 78 },
        2: { cellWidth: 22, halign: "right" },
        3: { cellWidth: 34, halign: "right" },
        4: { cellWidth: 36, halign: "right" }
      }
    });
    return doc.lastAutoTable.finalY;
  }

  function ensureSpace(doc, y, required) {
    if (y + required <= PAGE_HEIGHT - 24) return y;
    doc.addPage("a4", "portrait");
    return 24;
  }

  function drawTotals(doc, model, startY) {
    if (model.documentType === "purchase-order") {
      const y = ensureSpace(doc, startY + 7, 18);
      doc.setFont("NotoSans", "bold");
      doc.setFontSize(12);
      doc.setTextColor.apply(doc, BRAND);
      doc.text(`Total Qty: ${indian(model.totals.totalQuantity)}`, PAGE_WIDTH - MARGIN, y, { align: "right" });
      return;
    }

    const totals = model.totals;
    const lines = [["Subtotal", totals.subtotal]];
    if (number(totals.packaging) > 0) lines.push(["(+) Packaging / Forwarding", totals.packaging]);
    if (number(totals.discount) > 0) lines.push(["(-) Discount", totals.discount]);
    lines.push(["Taxable Value", totals.taxableValue]);
    lines.push([`GST ${number(totals.gstPercent)}%`, number(totals.cgst) + number(totals.sgst)]);
    lines.push([`CGST ${number(totals.gstPercent) / 2}%`, totals.cgst]);
    lines.push([`SGST ${number(totals.gstPercent) / 2}%`, totals.sgst]);
    lines.push(["Grand Total", totals.grandTotal]);

    let y = ensureSpace(doc, startY + 7, lines.length * 6 + 8);
    const left = 99;
    const right = PAGE_WIDTH - MARGIN;
    doc.setDrawColor(180, 187, 195);
    doc.line(left, y - 4, right, y - 4);
    lines.forEach(([label, value], index) => {
      const grand = index === lines.length - 1;
      doc.setFont("NotoSans", grand ? "bold" : "normal");
      doc.setFontSize(grand ? 12 : 9);
      doc.setTextColor.apply(doc, grand ? BRAND : [24, 33, 43]);
      doc.text(label, left, y);
      doc.text(currency(value), right, y, { align: "right" });
      y += grand ? 8 : 5.5;
    });
  }

  function drawPageDecorations(doc, model, assets) {
    const pages = doc.getNumberOfPages();
    for (let page = 1; page <= pages; page += 1) {
      doc.setPage(page);
      if (page > 1) {
        doc.setFont("NotoSans", "bold");
        doc.setFontSize(8.5);
        doc.setTextColor.apply(doc, BRAND);
        doc.text(`${model.business.name} — ${model.documentType === "purchase-order" ? "Purchase Order" : "Quotation"} ${model.documentNumber}`, MARGIN, 10);
      }

      if (assets.logoDataUrl && typeof doc.GState === "function") {
        try {
          doc.saveGraphicsState();
          doc.setGState(new doc.GState({ opacity: 0.035 }));
          doc.addImage(assets.logoDataUrl, "PNG", 75, 111, 60, 60, "VSTDLogo", "FAST");
          doc.restoreGraphicsState();
        } catch (_) {
          try { doc.restoreGraphicsState(); } catch (_) { /* no-op */ }
        }
      }

      doc.setDrawColor(180, 187, 195);
      doc.setLineWidth(0.2);
      doc.line(MARGIN, 279, PAGE_WIDTH - MARGIN, 279);
      doc.setFont("NotoSans", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(55, 65, 81);
      doc.text(
        `Questions? Contact ${model.business.contactName} | ${model.business.contactPhone}`,
        MARGIN,
        285
      );
      doc.text(`Page ${page} of ${pages}`, PAGE_WIDTH - MARGIN, 285, { align: "right" });
    }
  }

  async function generateBusinessPdf(inputModel, assets) {
    if (!jsPDF || !autoTable) throw new Error("Local jsPDF and AutoTable dependencies are unavailable");
    const model = normalizeModel(inputModel);
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true, putOnlyUsedFonts: true });
    registerFonts(doc, assets);
    doc.setProperties({
      title: `${model.documentType === "purchase-order" ? "Purchase Order" : "Quotation"} ${model.documentNumber}`,
      subject: "VSTD business document",
      author: model.business.name,
      creator: "VSTD GST Calculator offline PDF"
    });

    drawHeader(doc, model, assets || {});
    let y = drawParty(doc, model, 61);
    if (model.documentType === "purchase-order") y = drawShipping(doc, model, y);
    const tableEndY = drawItems(doc, model, y);
    drawTotals(doc, model, tableEndY);
    drawPageDecorations(doc, model, assets || {});

    const arrayBuffer = doc.output("arraybuffer");
    const bytes = new Uint8Array(arrayBuffer);
    const blob = new Blob([bytes], { type: "application/pdf" });
    return { model, doc, bytes, blob, filename: buildFilename(model) };
  }

  async function generateLedgerPdf(inputModel, assets) {
    if (!jsPDF || !autoTable) throw new Error("Local jsPDF and AutoTable dependencies are unavailable");
    const model = inputModel || {};
    const purchaseOrder = model.sourceType === "purchase-order";
    const business = Object.assign({}, DEFAULT_BUSINESS, model.business || {});
    const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true, putOnlyUsedFonts: true });
    registerFonts(doc, assets);
    doc.setProperties({
      title: model.title || (purchaseOrder ? "Purchase Order History" : "Quotation History"),
      subject: "VSTD history ledger",
      author: business.name,
      creator: "VSTD GST Calculator offline PDF"
    });

    doc.setTextColor(24, 33, 43);
    doc.setFont("NotoSans", "bold");
    doc.setFontSize(19);
    doc.text(business.name, MARGIN, 18);
    doc.setFont("NotoSans", "normal");
    doc.setFontSize(8.5);
    doc.text(business.address, MARGIN, 24);
    if (assets && assets.logoDataUrl) {
      try { doc.addImage(assets.logoDataUrl, "PNG", 174, 8, 22, 22, "VSTDLogo", "FAST"); } catch (_) { /* optional */ }
    }
    doc.setDrawColor.apply(doc, BRAND);
    doc.setLineWidth(0.8);
    doc.line(MARGIN, 29, PAGE_WIDTH - MARGIN, 29);
    doc.setTextColor.apply(doc, BRAND);
    doc.setFont("NotoSans", "bold");
    doc.setFontSize(15);
    doc.text(model.title || (purchaseOrder ? "PURCHASE ORDER HISTORY" : "QUOTATION HISTORY"), PAGE_WIDTH / 2, 38, { align: "center" });
    let startY = 47;
    if (model.filters) {
      doc.setTextColor(55, 65, 81);
      doc.setFont("NotoSans", "normal");
      doc.setFontSize(8.5);
      const filterLines = doc.splitTextToSize(model.filters, PAGE_WIDTH - MARGIN * 2);
      doc.text(filterLines, MARGIN, startY);
      startY += filterLines.length * 4.2 + 3;
    }

    const columns = Array.isArray(model.columns) && model.columns.length
      ? model.columns
      : ["No", "Date", purchaseOrder ? "Supplier" : "Client", purchaseOrder ? "Total Qty" : "Total"];
    const rows = Array.isArray(model.rows) ? model.rows : [];
    autoTable(doc, {
      startY,
      head: [columns],
      body: rows,
      showHead: "everyPage",
      rowPageBreak: "avoid",
      pageBreak: "auto",
      margin: { top: 19, right: MARGIN, bottom: 24, left: MARGIN },
      theme: "grid",
      styles: { font: "NotoSans", fontStyle: "normal", fontSize: 8.3, cellPadding: 2.4, lineColor: [93, 105, 117], lineWidth: 0.15 },
      headStyles: { font: "NotoSans", fontStyle: "bold", fillColor: BRAND, textColor: [255, 255, 255], halign: "center" },
      columnStyles: {
        0: { cellWidth: 22, halign: "center" },
        1: { cellWidth: 35 },
        2: { cellWidth: 85 },
        3: { cellWidth: 40, halign: "right" }
      }
    });

    drawPageDecorations(doc, {
      documentType: purchaseOrder ? "purchase-order" : "quotation",
      documentNumber: "History",
      business
    }, assets || {});

    const now = new Date();
    const datePart = [String(now.getDate()).padStart(2, "0"), String(now.getMonth() + 1).padStart(2, "0"), now.getFullYear()].join("-");
    const filename = `VSTD-${purchaseOrder ? "PO" : "Quotation"}-History-${datePart}.pdf`;
    const arrayBuffer = doc.output("arraybuffer");
    const bytes = new Uint8Array(arrayBuffer);
    const blob = new Blob([bytes], { type: "application/pdf" });
    return { model, doc, bytes, blob, filename };
  }

  async function loadBrowserAssets(options) {
    const base = typeof options === "string" ? options : options && options.basePath || ".";
    const logoPath = options && typeof options === "object" && options.logoPath
      ? options.logoPath
      : `${base}/VSTD-LOGO.png`;
    const [regularResponse, boldResponse, logoResponse] = await Promise.all([
      fetch(`${base}/fonts/NotoSans-Regular.ttf`),
      fetch(`${base}/fonts/NotoSans-Bold.ttf`),
      fetch(logoPath)
    ]);
    if (!regularResponse.ok || !boldResponse.ok) throw new Error("Local PDF font assets could not be loaded");
    const regularFontBytes = new Uint8Array(await regularResponse.arrayBuffer());
    const boldFontBytes = new Uint8Array(await boldResponse.arrayBuffer());
    let logoDataUrl = "";
    if (logoResponse.ok) {
      const logoBytes = new Uint8Array(await logoResponse.arrayBuffer());
      let binary = "";
      for (let index = 0; index < logoBytes.length; index += 0x8000) {
        binary += String.fromCharCode.apply(null, logoBytes.subarray(index, index + 0x8000));
      }
      logoDataUrl = `data:image/png;base64,${btoa(binary)}`;
    }
    return { regularFontBytes, boldFontBytes, logoDataUrl };
  }

  return {
    DEFAULT_BUSINESS,
    buildPurchaseOrderPdfModel,
    buildQuotationPdfModel,
    buildLedgerPdfModel,
    normalizeModel,
    generateBusinessPdf,
    generateLedgerPdf,
    loadBrowserAssets,
    buildFilename,
    formatDate,
    currency
  };
});

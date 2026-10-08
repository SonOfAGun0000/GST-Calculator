(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root);
  } else {
    root.VstdPdfIntegration = factory(root);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const SCRIPT_PATHS = [
    "pdf/vendor/jspdf-4.2.1.umd.min.js",
    "pdf/vendor/jspdf-autotable-5.0.8.min.js",
    "pdf/pdf-export.js"
  ];

  let enginePromise = null;
  let assetsPromise = null;
  let generationPromise = null;
  let currentFile = null;
  let currentUrl = "";
  let currentKind = "document";
  let modal = null;

  function shouldUseGeneratedPdf() {
    return true;
  }

  function isIosStandalone(navigatorLike) {
    const candidate = navigatorLike || (typeof navigator !== "undefined" ? navigator : null);
    return Boolean(candidate && candidate.standalone === true);
  }

  function loadScript(path) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-vstd-pdf-src="${path}"]`);
      if (existing) {
        if (existing.dataset.loaded === "true") resolve();
        else {
          existing.addEventListener("load", resolve, { once: true });
          existing.addEventListener("error", () => reject(new Error(`Could not load ${path}`)), { once: true });
        }
        return;
      }

      const script = document.createElement("script");
      script.src = path;
      script.dataset.vstdPdfSrc = path;
      script.addEventListener("load", () => {
        script.dataset.loaded = "true";
        resolve();
      }, { once: true });
      script.addEventListener("error", () => reject(new Error(`Could not load ${path}`)), { once: true });
      document.head.appendChild(script);
    });
  }

  function loadEngine() {
    if (!enginePromise) {
      enginePromise = SCRIPT_PATHS.reduce(
        (chain, path) => chain.then(() => loadScript(path)),
        Promise.resolve()
      ).then(() => {
        if (!root.VstdPdfRenderer) throw new Error("The local PDF renderer did not initialize");
        return root.VstdPdfRenderer;
      }).catch((error) => {
        enginePromise = null;
        throw error;
      });
    }
    return enginePromise;
  }

  async function loadAssets(renderer) {
    if (!assetsPromise) {
      assetsPromise = renderer.loadBrowserAssets({
        basePath: "pdf",
        logoPath: "VSTD LOGO 3.0.png"
      }).catch((error) => {
        assetsPromise = null;
        throw error;
      });
    }
    return assetsPromise;
  }

  function revokeCurrentUrl() {
    if (modal && modal.previewFrame) modal.previewFrame.removeAttribute("src");
    if (currentUrl) {
      URL.revokeObjectURL(currentUrl);
      currentUrl = "";
    }
  }

  function clearCurrentPdf() {
    revokeCurrentUrl();
    currentFile = null;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} bytes`;
    return `${(bytes / 1024).toFixed(bytes >= 1024 * 1024 ? 0 : 1)} KB`;
  }

  function isShareCancellation(error) {
    return Boolean(error && error.name === "AbortError");
  }

  function ensureModal() {
    if (modal) return modal;

    const overlay = document.createElement("div");
    overlay.className = "pdfReadyOverlay";
    overlay.hidden = true;
    overlay.innerHTML = [
      '<section class="pdfReadyDialog" role="dialog" aria-modal="true" aria-labelledby="pdfReadyTitle">',
      '  <button type="button" class="pdfReadyClose" aria-label="Close PDF dialog">&times;</button>',
      '  <h2 id="pdfReadyTitle">Preparing PDF</h2>',
      '  <p class="pdfReadyStatus" role="status" aria-live="polite">Generating locally&hellip;</p>',
      '  <p class="pdfReadyFile" hidden></p>',
      '  <div class="pdfReadyActions">',
      '    <button type="button" class="pdfShareButton" disabled>Share PDF</button>',
      '    <button type="button" class="pdfDownloadButton" disabled>Download PDF</button>',
      '    <button type="button" class="pdfPreviewButton" disabled>Preview PDF</button>',
      '    <button type="button" class="pdfPrintButton">Browser Print</button>',
      '    <button type="button" class="pdfDoneButton">Close</button>',
      '  </div>',
      '  <p class="pdfReadyHint">The PDF stays on this device until you choose where to share or save it.</p>',
      '  <div class="pdfPreviewPanel" hidden>',
      '    <div class="pdfPreviewHeader"><strong>PDF Preview</strong><button type="button" class="pdfPreviewBack">Close Preview</button></div>',
      '    <iframe class="pdfPreviewFrame" title="Generated PDF preview"></iframe>',
      '    <p>Preview uses the browser PDF viewer. For a clean attachment, use Share PDF above.</p>',
      '  </div>',
      '</section>'
    ].join("");
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector(".pdfReadyDialog");
    const closeButton = overlay.querySelector(".pdfReadyClose");
    const shareButton = overlay.querySelector(".pdfShareButton");
    const downloadButton = overlay.querySelector(".pdfDownloadButton");
    const previewButton = overlay.querySelector(".pdfPreviewButton");
    const printButton = overlay.querySelector(".pdfPrintButton");
    const doneButton = overlay.querySelector(".pdfDoneButton");
    const previewPanel = overlay.querySelector(".pdfPreviewPanel");
    const previewFrame = overlay.querySelector(".pdfPreviewFrame");
    const previewBack = overlay.querySelector(".pdfPreviewBack");

    function close() {
      previewPanel.hidden = true;
      previewFrame.removeAttribute("src");
      overlay.hidden = true;
      document.body.classList.remove("pdf-dialog-open");
    }

    closeButton.addEventListener("click", close);
    doneButton.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    dialog.addEventListener("click", (event) => event.stopPropagation());
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !overlay.hidden) close();
    });

    shareButton.addEventListener("click", function () {
      if (!currentFile) return;
      const payload = { files: [currentFile], title: currentFile.name };
      let supported = false;
      try {
        supported = typeof navigator.share === "function" &&
          typeof navigator.canShare === "function" &&
          navigator.canShare(payload);
      } catch (_) {
        supported = false;
      }

      if (!supported) {
        setModalState("ready", "File sharing is unavailable here. Use Download PDF or Preview PDF instead.");
        return;
      }

      let shareResult;
      try {
        // Called directly in this tap handler so iOS retains user activation.
        shareResult = navigator.share(payload);
      } catch (error) {
        handleShareError(error);
        return;
      }
      Promise.resolve(shareResult).then(
        () => setModalState("ready", "Share sheet completed."),
        handleShareError
      );
    });

    downloadButton.addEventListener("click", function () {
      if (!currentFile) return;
      if (!currentUrl) currentUrl = URL.createObjectURL(currentFile);
      const anchor = document.createElement("a");
      anchor.href = currentUrl;
      anchor.download = currentFile.name;
      anchor.hidden = true;
      document.body.appendChild(anchor);
      anchor.click();
      window.setTimeout(() => anchor.remove(), 0);
      setModalState("ready", isIosStandalone()
        ? "Download requested. On iPhone, use Share PDF → Save to Files when a direct download is not offered."
        : "Download requested. Check your browser downloads; completion cannot be confirmed by the app.");
    });

    previewButton.addEventListener("click", function () {
      if (!currentFile) return;
      if (!currentUrl) currentUrl = URL.createObjectURL(currentFile);
      previewFrame.src = currentUrl;
      previewPanel.hidden = false;
      previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      setModalState("ready", "Preview opened below. Share PDF sends the actual file without an application or blob URL payload.");
    });

    previewBack.addEventListener("click", function () {
      previewPanel.hidden = true;
      previewFrame.removeAttribute("src");
      previewButton.focus();
    });

    printButton.addEventListener("click", function () {
      previewPanel.hidden = true;
      previewFrame.removeAttribute("src");
      overlay.hidden = true;
      document.body.classList.remove("pdf-dialog-open");
      document.body.classList.toggle("print-ledger", currentKind === "ledger");
      window.print();
    });

    modal = {
      overlay,
      closeButton,
      shareButton,
      downloadButton,
      previewButton,
      printButton,
      previewPanel,
      previewFrame
    };
    return modal;
  }

  function handleShareError(error) {
    if (isShareCancellation(error)) {
      setModalState("ready", "Sharing cancelled. Your PDF is still ready.");
      return;
    }
    const message = error && error.message ? error.message : "The share sheet could not be opened.";
    setModalState("ready", `${message} Use Download PDF or Preview PDF instead.`);
  }

  function setModalState(state, message) {
    const view = ensureModal();
    const title = view.overlay.querySelector("#pdfReadyTitle");
    const status = view.overlay.querySelector(".pdfReadyStatus");
    const fileInfo = view.overlay.querySelector(".pdfReadyFile");
    const ready = state === "ready" && Boolean(currentFile);
    const error = state === "error";

    title.textContent = error ? "PDF could not be generated" : ready ? "PDF Ready" : "Preparing PDF";
    status.textContent = message || (ready ? "Your PDF was generated locally." : "Generating locally…");
    fileInfo.hidden = !ready;
    fileInfo.textContent = ready ? `${currentFile.name} · ${formatBytes(currentFile.size)}` : "";
    view.shareButton.disabled = !ready;
    view.downloadButton.disabled = !ready;
    view.previewButton.disabled = !ready;
    if (!ready) {
      view.previewPanel.hidden = true;
      view.previewFrame.removeAttribute("src");
    }
  }

  function showModal() {
    const view = ensureModal();
    view.overlay.hidden = false;
    document.body.classList.add("pdf-dialog-open");
    view.closeButton.focus();
  }

  async function generate(kind, sourceType) {
    if (generationPromise) {
      showModal();
      setModalState("generating", "PDF generation is already in progress…");
      return generationPromise;
    }

    clearCurrentPdf();
    currentKind = kind;
    showModal();
    setModalState("generating", "Generating locally…");

    generationPromise = (async () => {
      const renderer = await loadEngine();
      const assets = await loadAssets(renderer);
      const model = kind === "ledger"
        ? renderer.buildLedgerPdfModel(sourceType, document)
        : sourceType === "purchase-order"
          ? renderer.buildPurchaseOrderPdfModel(document)
          : renderer.buildQuotationPdfModel(document);
      const result = kind === "ledger"
        ? await renderer.generateLedgerPdf(model, assets)
        : await renderer.generateBusinessPdf(model, assets);
      currentFile = new File([result.blob], result.filename, {
        type: "application/pdf",
        lastModified: Date.now()
      });
      setModalState("ready", "Your PDF was generated locally and is ready to share, download, or preview.");
      return result;
    })().catch((error) => {
      console.error("PDF generation failed:", error);
      clearCurrentPdf();
      setModalState("error", error && error.message
        ? error.message
        : "PDF generation failed. Your form has not been changed.");
      return null;
    }).finally(() => {
      generationPromise = null;
    });

    return generationPromise;
  }

  function generateCurrentDocument(sourceType) {
    return generate("document", sourceType);
  }

  function generateCurrentLedger(sourceType) {
    return generate("ledger", sourceType);
  }

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", revokeCurrentUrl);
  }

  return {
    shouldUseGeneratedPdf,
    isIosStandalone,
    generateCurrentDocument,
    generateCurrentLedger,
    _test: { formatBytes, isShareCancellation }
  };
});

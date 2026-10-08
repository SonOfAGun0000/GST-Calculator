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
  let modal = null;

  function shouldUseGeneratedPdf(navigatorLike) {
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
      '    <button type="button" class="pdfOpenButton" disabled>Open / Save PDF</button>',
      '  </div>',
      '  <p class="pdfReadyHint">The PDF stays on this device until you choose where to share or save it.</p>',
      '</section>'
    ].join("");
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector(".pdfReadyDialog");
    const closeButton = overlay.querySelector(".pdfReadyClose");
    const shareButton = overlay.querySelector(".pdfShareButton");
    const openButton = overlay.querySelector(".pdfOpenButton");

    function close() {
      overlay.hidden = true;
      document.body.classList.remove("pdf-dialog-open");
    }

    closeButton.addEventListener("click", close);
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
        setModalState("ready", "File sharing is unavailable here. Use Open / Save PDF instead.");
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

    openButton.addEventListener("click", function () {
      if (!currentFile) return;
      if (!currentUrl) currentUrl = URL.createObjectURL(currentFile);
      const anchor = document.createElement("a");
      anchor.href = currentUrl;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      anchor.download = currentFile.name;
      anchor.click();
      setModalState("ready", "PDF opened. Use the iPhone share controls to save or send it.");
    });

    modal = { overlay, closeButton, shareButton, openButton };
    return modal;
  }

  function handleShareError(error) {
    if (isShareCancellation(error)) {
      setModalState("ready", "Sharing cancelled. Your PDF is still ready.");
      return;
    }
    const message = error && error.message ? error.message : "The share sheet could not be opened.";
    setModalState("ready", `${message} Use Open / Save PDF instead.`);
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
    view.openButton.disabled = !ready;
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
      setModalState("ready", "Your PDF was generated locally and is ready to share or open.");
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
    generateCurrentDocument,
    generateCurrentLedger,
    _test: { formatBytes, isShareCancellation }
  };
});

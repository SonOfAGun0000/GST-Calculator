const defaultProducts=["Sugar","Groundnut Oil","Rice","Oil","Toor Dhall","Channa Flour"];
const productCatalog = loadProductCatalog();
const products = (() => {
  const names = productCatalog.map(r => r.name).filter(Boolean);
  return names.length ? [...new Set(names)] : defaultProducts;
})();
const folioAllowedTypes = new Set(["customer", "both"]);
const STORE_KEY = "gst_quotes_history";
const LOCAL_LAST_QNO_KEY = "gst_last_qno";
const CLOUD_ROOT = "companyData";
const CLOUD_QUOTES = `${CLOUD_ROOT}/quotes`;
const CLOUD_LAST_QNO = `${CLOUD_ROOT}/meta/lastQno`;
let cloudSyncStarted = false;
let holdCurrentQno = false;
let selectedFolio = null;
const AUTOCOMPLETE_LIMIT = 8;
const autocompleteState = {
  container: null,
  list: null,
  input: null
};

document.addEventListener("DOMContentLoaded", function(){
    setTodayDate();
    generateNextQuoteNo();
    ensureFirstRow();
    setupProductDatalist();
    setupFolioAutocomplete();
  });

function normalizeHistory(list){
  if(!Array.isArray(list)) return [];
  return list
    .filter(r => r && typeof r === "object" && Number(r.qno) > 0)
    .map(r => ({
      ...r,
      qno: Number(r.qno),
      client: String(r.client || ""),
      date: toISODateString(r.date || "") || "",
      pkg: Number(r.pkg) || 0,
      disc: Number(r.disc) || 0,
      gst: Number(r.gst) || 0,
      items: Array.isArray(r.items) ? r.items : []
    }))
    .sort((a,b) => a.qno - b.qno);
}

function safeItems(record){
  if(!Array.isArray(record?.items)) return [];
  return record.items.filter(i => i && typeof i === "object");
}

function getLocalHistory(){
  try{
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return normalizeHistory(parsed);
  }catch{
    return [];
  }
}

function setLocalHistory(data){
  const normalized = normalizeHistory(data);
  localStorage.setItem(STORE_KEY, JSON.stringify(normalized));
  updateLocalHighWater(maxQnoFromList(normalized));
}

function maxQnoFromList(data){
  return data.reduce((m, r) => Math.max(m, Number(r.qno) || 0), 0);
}

function getLocalHighWater(){
  const stored = Number(localStorage.getItem(LOCAL_LAST_QNO_KEY));
  return Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
}

function updateLocalHighWater(...values){
  const current = getLocalHighWater();
  const next = values.reduce((max, value) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > max ? n : max;
  }, current);
  if(next > current){
    localStorage.setItem(LOCAL_LAST_QNO_KEY, String(next));
  }
  return next;
}

function currentHighWater(data = getLocalHistory(), cloudLastQno = 0){
  return updateLocalHighWater(maxQnoFromList(data), cloudLastQno);
}

function nextQnoFromList(data){
  return Math.max(maxQnoFromList(data), getLocalHighWater()) + 1;
}

function refreshNextQno(force = false){
  if(holdCurrentQno && !force) return;
  document.getElementById("qno").value = nextQnoFromList(getLocalHistory());
}

function parseCloudHistory(raw){
  if(Array.isArray(raw)) return normalizeHistory(raw);
  if(!raw || typeof raw !== "object") return [];
  if(Array.isArray(raw.quotes)) return normalizeHistory(raw.quotes);
  if(raw.quotes && typeof raw.quotes === "object"){
    return normalizeHistory(Object.values(raw.quotes));
  }
  return [];
}

function mergeHistory(localHistory, cloudHistory){
  const merged = new Map();
  [...cloudHistory, ...localHistory].forEach(r => {
    if(!r || !Number(r.qno)) return;
    const qno = Number(r.qno);
    const existing = merged.get(qno);
    if(!existing){
      merged.set(qno, { ...r, qno });
      return;
    }
    const existingSaved = Number(existing.savedAt) || 0;
    const candidateSaved = Number(r.savedAt) || 0;
    if(candidateSaved >= existingSaved){
      merged.set(qno, { ...r, qno });
    }
  });
  return [...merged.values()].sort((a,b) => a.qno - b.qno);
}

function toCloudPayload(history){
  const quotes = {};
  history.forEach(r => { quotes[r.qno] = r; });
  return {
    quotes,
    meta: { lastQno: currentHighWater(history) }
  };
}

function toCloudQuotesPayload(history){
  const quotes = {};
  history.forEach(r => { quotes[r.qno] = r; });
  return quotes;
}

// Auto date update
function localISODate(){
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function setTodayDate(){
  document.getElementById("date").value = localISODate();
}

function toISODateString(value){
  if(!value) return "";
  if(/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if(/^\d{2}-\d{2}-\d{4}$/.test(value)){
    const [dd, mm, yyyy] = value.split("-");
    return `${yyyy}-${mm}-${dd}`;
  }
  return "";
}

function loadProductCatalog(){
  try{
    const rawCatalog = JSON.parse(localStorage.getItem("gst_catalog_master") || "[]");
    const normalizedCatalog = Array.isArray(rawCatalog)
      ? rawCatalog
          .filter(x => x && typeof x === "object")
          .map(x => ({
            code: String(x.code || "").trim(),
            name: String(x.name || "").trim(),
            unit: String(x.unit || "").trim(),
            rate: Number(x.rate) || 0,
            gst: Number(x.gst) || 0
          }))
          .filter(x => x.name)
      : [];
    if(normalizedCatalog.length) return normalizedCatalog;
  }catch{}

  try{
    const legacy = JSON.parse(localStorage.getItem("gst_product_master") || "[]");
    const normalizedLegacy = Array.isArray(legacy)
      ? legacy
          .filter(x => x && typeof x === "object")
          .map(x => ({
            code: "",
            name: String(x.name || "").trim(),
            unit: String(x.unit || "").trim(),
            rate: 0,
            gst: Number(x.gst) || 0
          }))
          .filter(x => x.name)
      : [];
    if(normalizedLegacy.length) return normalizedLegacy;
  }catch{}

  return defaultProducts.map(name => ({ code: "", name, unit: "", rate: 0, gst: 0 }));
}

function normalizeKey(value){
  return String(value || "").trim().toLowerCase();
}

function findProductRecord(token){
  const key = normalizeKey(token);
  if(!key) return null;
  return productCatalog.find(p => normalizeKey(p.code) === key)
    || productCatalog.find(p => normalizeKey(p.name) === key)
    || null;
}

function ensureAutocompleteUI(){
  if(autocompleteState.container) return autocompleteState;

  const container = document.createElement("div");
  container.id = "customAutocomplete";
  container.className = "customAutocomplete";
  container.setAttribute("aria-hidden", "true");

  const list = document.createElement("div");
  list.className = "customAutocompleteList";
  container.appendChild(list);

  document.body.appendChild(container);

  autocompleteState.container = container;
  autocompleteState.list = list;

  document.addEventListener("pointerdown", event => {
    if(!autocompleteState.input || !container.classList.contains("open")) return;
    if(container.contains(event.target) || autocompleteState.input.contains(event.target)) return;
    closeAutocomplete();
  });

  window.addEventListener("resize", positionAutocomplete);
  window.addEventListener("scroll", positionAutocomplete, true);
  return autocompleteState;
}

function closeAutocomplete(){
  ensureAutocompleteUI();
  autocompleteState.container.classList.remove("open");
  autocompleteState.container.setAttribute("aria-hidden", "true");
  autocompleteState.list.innerHTML = "";
  autocompleteState.input = null;
}

function closeAutocompleteForInput(input){
  if(autocompleteState.input === input){
    closeAutocomplete();
  }
}

function positionAutocomplete(){
  ensureAutocompleteUI();
  const input = autocompleteState.input;
  if(!input || !document.body.contains(input)){
    closeAutocomplete();
    return;
  }

  const rect = input.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const maxWidth = Math.max(120, viewportWidth - 16);
  const width = Math.min(Math.max(rect.width, 120), maxWidth);
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const spaceBelow = viewportHeight - rect.bottom - 8;
  const spaceAbove = rect.top - 8;
  const openAbove = spaceBelow < 120 && spaceAbove > spaceBelow;
  const menuHeight = openAbove
    ? Math.max(64, spaceAbove - 8)
    : Math.max(64, spaceBelow);

  autocompleteState.container.style.left = `${left}px`;
  autocompleteState.container.style.width = `${width}px`;
  autocompleteState.container.style.maxHeight = `${menuHeight}px`;

  if(openAbove){
    autocompleteState.container.style.top = "auto";
    autocompleteState.container.style.bottom = `${Math.max(8, viewportHeight - rect.top + 4)}px`;
  }else{
    autocompleteState.container.style.bottom = "auto";
    autocompleteState.container.style.top = `${Math.max(8, rect.bottom + 4)}px`;
  }
}

function renderAutocompleteItems(input, items, onSelect){
  ensureAutocompleteUI();

  if(!Array.isArray(items) || items.length === 0){
    closeAutocompleteForInput(input);
    return;
  }

  autocompleteState.input = input;
  autocompleteState.list.innerHTML = "";

  items.slice(0, AUTOCOMPLETE_LIMIT).forEach(item => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "customAutocompleteItem";

    const label = document.createElement("span");
    label.className = "customAutocompleteMain";
    label.textContent = item.label || "";
    button.appendChild(label);

    if(item.meta){
      const meta = document.createElement("span");
      meta.className = "customAutocompleteMeta";
      meta.textContent = item.meta;
      button.appendChild(meta);
    }

    button.addEventListener("click", () => {
      onSelect(item);
      closeAutocomplete();
    });

    autocompleteState.list.appendChild(button);
  });

  autocompleteState.container.classList.add("open");
  autocompleteState.container.setAttribute("aria-hidden", "false");
  positionAutocomplete();
}

function bindAutocomplete(input, getItems, onSelect){
  input.removeAttribute("list");

  const refresh = () => {
    const token = normalizeKey(input.value);
    if(!token){
      closeAutocompleteForInput(input);
      return;
    }
    renderAutocompleteItems(input, getItems(token), onSelect);
  };

  input.addEventListener("focus", refresh);
  input.addEventListener("input", refresh);
  input.addEventListener("keydown", event => {
    if(event.key === "Escape"){
      closeAutocompleteForInput(input);
    }
    if(event.key === "Enter"){
      closeAutocompleteForInput(input);
    }
  });
  input.addEventListener("blur", () => {
    window.setTimeout(() => closeAutocompleteForInput(input), 120);
  });
}

function rankTokenMatch(token, value){
  const index = value.indexOf(token);
  if(index < 0) return Number.POSITIVE_INFINITY;
  return index === 0 ? 0 : index + 1;
}

function getProductSuggestions(token){
  const suggestions = [];
  const seen = new Set();

  productCatalog.forEach(rec => {
    const name = String(rec.name || "").trim();
    const code = String(rec.code || "").trim();
    const nameKey = normalizeKey(name);
    const codeKey = normalizeKey(code);
    const rank = Math.min(
      rankTokenMatch(token, nameKey),
      codeKey ? rankTokenMatch(token, codeKey) : Number.POSITIVE_INFINITY
    );
    if(!Number.isFinite(rank)) return;

    const key = `${codeKey}|${nameKey}`;
    if(seen.has(key)) return;
    seen.add(key);

    const meta = [];
    if(code) meta.push(`Code: ${code}`);
    if(rec.unit) meta.push(`Unit: ${rec.unit}`);
    suggestions.push({
      label: name || code,
      meta: meta.join(" | "),
      rank,
      rec
    });
  });

  defaultProducts.forEach(name => {
    const nameKey = normalizeKey(name);
    const rank = rankTokenMatch(token, nameKey);
    if(!Number.isFinite(rank)) return;
    const key = `|${nameKey}`;
    if(seen.has(key)) return;
    seen.add(key);
    suggestions.push({
      label: name,
      meta: "",
      rank,
      rec: { code: "", name, unit: "", rate: 0, gst: 0 }
    });
  });

  return suggestions.sort((a,b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

function getFolioSuggestions(token){
  const suggestions = [];
  const seen = new Set();

  loadPageFolios().forEach(folio => {
    const name = String(folio.name || "").trim();
    const nameKey = normalizeKey(name);
    const rank = rankTokenMatch(token, nameKey);
    if(!Number.isFinite(rank) || seen.has(nameKey)) return;
    seen.add(nameKey);
    suggestions.push({ label: name, meta: folio.type || "", rank, folio });
  });

  return suggestions.sort((a,b) => a.rank - b.rank || a.label.localeCompare(b.label));
}

function clearProductSelectionState(input){
  if(!input) return;
  input.dataset.unit = "";
  input.dataset.gst = "";
  input.dataset.code = "";
}

function attachProductAutocomplete(input, row){
  if(!input || input.hasAttribute("data-product-autocomplete-bound")) return;
  input.setAttribute("data-product-autocomplete-bound", "1");

  bindAutocomplete(
    input,
    getProductSuggestions,
    item => {
      input.value = item.rec.name || item.label;
      applyProductSelection(input, row, item.rec);
      calc();
    }
  );

  input.addEventListener("input", () => {
    clearProductSelectionState(input);
    applyAutoGSTFromRows();
  });
}

function setupProductDatalist(){
  ensureAutocompleteUI();
  document.querySelectorAll("#tbl .product-field").forEach(input => {
    attachProductAutocomplete(input, input.closest("tr"));
  });
}

function applyProductSelection(input, row, matchedRecord = null){
  if(!input) return null;
  const rec = matchedRecord || findProductRecord(input.value);
  if(!rec) return null;

  input.value = rec.name;
  input.dataset.unit = rec.unit || "";
  input.dataset.gst = String(rec.gst || "");
  input.dataset.code = rec.code || "";

  if(row?.cells?.[3]){
    const rateInput = row.cells[3].querySelector("input");
    if(rateInput && !(Number(rateInput.value) > 0) && rec.rate > 0){
      rateInput.value = rec.rate;
    }
  }

  applyAutoGSTFromRows();
  return rec;
}

function applyAutoGSTFromRows(){
  const gstInputEl = document.getElementById("gst");
  if(!gstInputEl) return;

  const values = [];
  document.querySelectorAll("#tbl tbody tr").forEach(r => {
    const input = r.cells?.[1]?.querySelector("input");
    const rec = findProductRecord(input?.value || "");
    if(rec && rec.gst > 0) values.push(rec.gst);
  });
  if(values.length === 0) return;

  const unique = [...new Set(values)];
  if(unique.length === 1){
    gstInputEl.value = unique[0];
    return;
  }
  if(!(Number(gstInputEl.value) > 0)){
    gstInputEl.value = unique[0];
  }
}

function normalizeFolioRecord(x){
  if(!x || typeof x !== "object") return null;
  const name = String(x.name || "").trim();
  if(!name) return null;
  return {
    name,
    type: String(x.type || "").trim(),
    phone: String(x.phone || "").trim(),
    altPhone: String(x.altPhone || "").trim(),
    address: String(x.address || "").trim(),
    gstin: String(x.gstin || "").trim()
  };
}

function loadPageFolios(){
  try{
    const raw = JSON.parse(localStorage.getItem("gst_folio_master") || "[]");
    if(!Array.isArray(raw)) return [];
    return raw
      .map(normalizeFolioRecord)
      .filter(Boolean)
      .filter(f => folioAllowedTypes.has(normalizeKey(f.type)));
  }catch{
    return [];
  }
}

function findFolioByName(name){
  const key = normalizeKey(name);
  if(!key) return null;
  return loadPageFolios().find(f => normalizeKey(f.name) === key) || null;
}

function setupFolioAutocomplete(){
  const clientInput = document.getElementById("client");
  if(!clientInput || clientInput.hasAttribute("data-folio-autocomplete-bound")) return;
  clientInput.setAttribute("data-folio-autocomplete-bound", "1");

  bindAutocomplete(
    clientInput,
    getFolioSuggestions,
    item => {
      applyFolioSelection(item.folio);
    }
  );

  clientInput.addEventListener("input", () => {
    selectedFolio = null;
  });
}

function applyFolioSelection(forcedFolio = null){
  const clientInput = document.getElementById("client");
  if(!clientInput) return;
  const match = normalizeFolioRecord(forcedFolio) || findFolioByName(clientInput.value);
  selectedFolio = match;
  if(!match) return;

  clientInput.value = match.name;
  const phoneInput = document.getElementById("phone");
  if(phoneInput && match.phone){
    phoneInput.value = match.phone;
  }
}

function resolveCurrentFolio(){
  const clientValue = document.getElementById("client")?.value || "";
  const match = findFolioByName(clientValue);
  return normalizeFolioRecord(match || selectedFolio);
}

function formatDocumentDate(value){
  const iso = toISODateString(value);
  if(!iso) return value || "";
  const [yyyy, mm, dd] = iso.split("-");
  return `${dd}-${mm}-${yyyy}`;
}

function preparePrintMetaValues(){
  document.querySelectorAll(".print-meta-value[data-source]").forEach(span => {
    const source = span.getAttribute("data-source");
    const el = source ? document.getElementById(source) : null;
    let value = el ? String(el.value || "").trim() : "";
    if(source === "date"){
      value = formatDocumentDate(value);
    }
    span.textContent = value;
    span.style.display = value ? "block" : "none";
  });
}

function renderPrintPartyDetails(){
  const box = document.getElementById("printPartyDetails");
  if(!box) return;

  const folio = resolveCurrentFolio();
  const fallbackName = document.getElementById("client")?.value?.trim() || "";
  const fallbackPhone = document.getElementById("phone")?.value?.trim() || "";

  const name = folio?.name || fallbackName;
  const address = folio?.address || "";
  const phone = folio?.phone || fallbackPhone;
  const altPhone = folio?.altPhone || "";
  const gstin = folio?.gstin || "";

  const fields = [
    { label: "Name", value: name },
    { label: "Address", value: address },
    { label: "Phone", value: phone },
    { label: "Alternate Phone", value: altPhone },
    { label: "GSTIN", value: gstin }
  ].filter(x => x.value);

  box.innerHTML = "";
  fields.forEach(x => {
    const line = document.createElement("div");
    line.className = "printPartyLine";

    const label = document.createElement("span");
    label.className = "printPartyLabel";
    label.textContent = `${x.label}: `;

    const value = document.createElement("span");
    value.className = "printPartyValue";
    value.textContent = x.value;

    line.append(label, value);
    box.appendChild(line);
  });
  box.style.display = fields.length ? "block" : "none";
}

function preparePrintTableValues(){
  document.querySelectorAll("#tbl tbody tr").forEach(r => {
    const productInput = r.cells?.[1]?.querySelector("input");
    const qtyInput = r.cells?.[2]?.querySelector("input");
    const rateInput = r.cells?.[3]?.querySelector("input");
    const productPrint = r.cells?.[1]?.querySelector(".print-value");
    const qtyPrint = r.cells?.[2]?.querySelector(".print-value");
    const ratePrint = r.cells?.[3]?.querySelector(".print-value");

    if(productPrint){
      productPrint.textContent = (productInput?.value || "").trim();
    }
    if(qtyPrint){
      const rec = findProductRecord(productInput?.value || "");
      const unit = rec?.unit ? ` ${rec.unit}` : "";
      const qty = (qtyInput?.value || "").trim();
      qtyPrint.textContent = `${qty}${unit}`.trim();
    }
    if(ratePrint){
      ratePrint.textContent = (rateInput?.value || "").trim();
    }
  });
}

//Generate Quote No.
function generateNextQuoteNo(){
  let history = getLocalHistory();
  currentHighWater(history);
  let next = nextQnoFromList(history);
  holdCurrentQno = false;
  document.getElementById("qno").value = next;
}

//Hamburger Menu 
//Open
function toggleMenu(){
  const menu = document.getElementById("sideMenu");
  const overlay = document.getElementById("menuOverlay");
  const trigger = document.getElementById("menuToggle");
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  overlay.classList.add("active");
  document.body.classList.add("menu-open");
  trigger?.setAttribute("aria-expanded", "true");
  window.setTimeout(() => document.getElementById("menuClose")?.focus(), 0);
}
//Close
function closeMenu(){
  const menu = document.getElementById("sideMenu");
  const wasOpen = menu.classList.contains("open");
  menu.classList.remove("open");
  menu.setAttribute("aria-hidden", "true");
  document.getElementById("menuOverlay").classList.remove("active");
  document.body.classList.remove("menu-open");
  const trigger = document.getElementById("menuToggle");
  trigger?.setAttribute("aria-expanded", "false");
  if(wasOpen) trigger?.focus();
}

function triggerPrint(){
  closeMenu();
  closeLedger();
  window.print();
}


//Backup & Import JSON
//Export
function exportData(){
  const data = localStorage.getItem("gst_quotes_history");
  const blob = new Blob([data], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "gst-backup.json";
  a.click();
}

//Import
function importData(){
  const input = document.createElement("input");
  input.type="file";
  input.accept="application/json";

  input.onchange = e => {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = function(){
      try{
        const imported = JSON.parse(reader.result);
        if(!Array.isArray(imported)) throw new Error("Quotation backup must contain a list");
        localStorage.setItem(STORE_KEY, reader.result);
        updateLocalHighWater(maxQnoFromList(normalizeHistory(imported)));
        alert("Data Imported Successfully");
        location.reload();
      }catch(err){
        console.error("Quotation import failed:", err);
        alert("Import failed. Please choose a valid quotation backup file.");
      }
    }
    reader.readAsText(file);
  };

  input.click();
}

//Share APP
function shareApp(){
  if(navigator.share){
    navigator.share({
      title:"GST Rate App by Sathish Sekar",
      url:window.location.href
    });
  } else {
    alert("Copy this link:\n" + window.location.href);
  }
}

//check for updates
function checkUpdates(){
  navigator.serviceWorker.getRegistrations().then(regs=>{
    for(let reg of regs){
      reg.update();
    }
  });
  location.reload();
}

// Generate next quotation number
function nextQuotationNumber(){
  return nextQnoFromList(getLocalHistory());
}

function formatLedgerDate(value){
  const iso = toISODateString(value);
  if(!iso) return value || "";
  const [yyyy, mm, dd] = iso.split("-");
  return `${dd}-${mm}-${yyyy}`;
}

// Save quotation to local storage
async function saveQuotation(){
  let rows=[];
  document.querySelectorAll("#tbl tbody tr").forEach(r=>{
    const productInput = r.cells[1].querySelector("input");
    let name=productInput.value;
    let qty=r.cells[2].querySelector("input").value;
    let rate=r.cells[3].querySelector("input").value;

    if(name && qty>0 && rate>0){
      rows.push({name,qty,rate});
    }
  });

  if(rows.length === 0){
    alert("Add at least one product before saving");
    return;
  }

  let recordBase={
    date:toISODateString(document.getElementById("date").value),
    client:document.getElementById("client").value,
    phone:document.getElementById("phone").value,
    folio: resolveCurrentFolio(),
    pkg:+document.getElementById("pkg").value||0,
    disc:+document.getElementById("disc").value||0,
    gst:+document.getElementById("gst").value||0,
    items:rows,
    savedAt: Date.now()
  };

  let data = getLocalHistory();
  let newQno = nextQnoFromList(data);

  if(window.database && window.ref && window.set && window.runTransaction){
    try{
      const tx = await window.runTransaction(
        window.ref(window.database, CLOUD_LAST_QNO),
        current => Math.max(Number(current) || 0, currentHighWater(data)) + 1
      );
      if(!tx.committed){
        throw new Error("Failed to allocate quotation number");
      }
      newQno = Number(tx.snapshot.val()) || newQno;
      const cloudRecord = { ...recordBase, qno: newQno };
      await window.set(window.ref(window.database, `${CLOUD_QUOTES}/${newQno}`), cloudRecord);
    }catch(err){
      console.error("Cloud save failed, using local-only save:", err);
    }
  }

  const record = { ...recordBase, qno: newQno };
  data = data.filter(r => Number(r.qno) !== newQno);
  data.push(record);
  setLocalHistory(data);
  if(document.getElementById("ledgerModal").style.display === "block"){
    renderLedger();
  }
  document.getElementById("qno").value = newQno;
  holdCurrentQno = true;
  alert(`Successfully saved (Quotation No: ${newQno})`);
}

document.getElementById("qno").addEventListener("change", () => {
  holdCurrentQno = false;
  loadQuotation();
});
// Firebase Save
function syncToCloud(){
  // Deprecated full-overwrite sync; kept as no-op for backward compatibility.
  return;
}


// Load quotation from local storage
function loadQuotation(){

  let data = getLocalHistory();

  const qnoInput = document.getElementById("qno");
  let rec = data.find(x => x.qno == qnoInput.value);
  if(!rec) return;

  document.getElementById("client").value = rec.client;
  document.getElementById("phone").value = rec.phone;
  selectedFolio = normalizeFolioRecord(rec.folio) || findFolioByName(rec.client);
  document.getElementById("date").value = toISODateString(rec.date);
  document.getElementById("pkg").value = rec.pkg;
  document.getElementById("disc").value = rec.disc;
  document.getElementById("gst").value = rec.gst;

  document.querySelector("#tbl tbody").innerHTML="";

  const items = safeItems(rec);
  items.forEach(it=>{
    addRow();
    let r=document.querySelector("#tbl tbody tr:last-child");
    r.cells[1].querySelector("input").value=it.name;
    r.cells[2].querySelector("input").value=it.qty;
    r.cells[3].querySelector("input").value=it.rate;
  });
  if(items.length === 0){
    addRow();
  }

  calc();
}
// Firebase Load
function startCloudSync(){
  if(cloudSyncStarted) return true;
  if(!window.database || !window.ref || !window.onValue || !window.set) return false;
  cloudSyncStarted = true;

  const companyRef = window.ref(window.database, CLOUD_ROOT);
  window.onValue(companyRef, async (snapshot) => {
    try{
      const raw = snapshot.val();
      const cloudHistory = parseCloudHistory(raw);
      const localHistory = getLocalHistory();
      const merged = mergeHistory(localHistory, cloudHistory);

      setLocalHistory(merged);

      const cloudLastQno = Number(raw?.meta?.lastQno) || 0;
      const mergedLastQno = currentHighWater(merged, cloudLastQno);
      const shouldWriteBack =
        cloudHistory.length !== merged.length ||
        Array.isArray(raw) ||
        cloudLastQno < mergedLastQno;

      if(shouldWriteBack){
        await Promise.all([
          window.set(window.ref(window.database, CLOUD_QUOTES), toCloudQuotesPayload(merged)),
          window.set(window.ref(window.database, CLOUD_LAST_QNO), mergedLastQno)
        ]);
      }

      refreshNextQno();
      if(document.getElementById("ledgerModal").style.display === "block"){
        renderLedger();
      }
    }catch(err){
      console.error("Cloud sync merge failed:", err);
      refreshNextQno();
    }
  });
  return true;
}
if(!startCloudSync()){
  window.addEventListener("firebase-ready", startCloudSync, { once: true });
}

// Add new row to the table
function addRow(){
  let tbody=document.querySelector("#tbl tbody");
  let row=tbody.insertRow();
  let sno=tbody.rows.length;

  row.innerHTML=`
  <td>${sno}</td>
  <td>
    <input class="yellow product-field" placeholder="Product name">
    <span class="print-value"></span>
  </td>
  <td><input type="number" inputmode="decimal" step="any" value="" onchange="calc()" class="yellow"><span class="print-value"></span></td>
  <td><input type="number" inputmode="decimal" step="any" value="" onchange="calc()" class="yellow"><span class="print-value"></span></td>
  <td>0</td>
  <td><button class="del-btn" onclick="this.closest('tr').remove();calc()">&times;</button></td>
  `;
  const productInput = row.cells[1].querySelector("input");
  attachProductAutocomplete(productInput, row);
  productInput.addEventListener("change", calc);
  productInput.addEventListener("blur", calc);
}
function ensureFirstRow(){
  const tbody = document.querySelector("#tbl tbody");
  if(tbody.children.length === 0){
    addRow();
  }
}

// GST Buttons
function setGST(val){
  document.getElementById("gst").value = val;
  calc();
}

// Calculate totals
function calc(){
  let subtotal=0;

  document.querySelectorAll("#tbl tbody tr").forEach((r,i)=>{
    r.cells[0].innerText=i+1;

    let q=r.cells[2].children[0].value||0;
    let rate=r.cells[3].children[0].value||0;

    let amt=q*rate;
    r.cells[4].innerText=amt.toFixed(2);

    subtotal+=amt;
  });

  document.getElementById("subtotal").innerText=subtotal.toFixed(2);

  let pkg=+pkgInput();
  let disc=+discInput();
  let gst=+gstInput();

  let taxable=subtotal+pkg-disc;
  let tax=taxable*(gst/100);

  let half=tax/2;

  document.getElementById("cgst").innerText=half.toFixed(2);
  document.getElementById("sgst").innerText=half.toFixed(2);
  document.getElementById("grand").innerText=(taxable+tax).toFixed(2);
}

function pkgInput(){return document.getElementById("pkg").value||0}
function discInput(){return document.getElementById("disc").value||0}
function gstInput(){return document.getElementById("gst").value||0}

["pkg","disc","gst"].forEach(id=>{
  document.getElementById(id).oninput=calc;
});

// Clear form
function clearForm(){
  location.reload();
}

// Format number in Indian style
function indian(n){
  return Number(n).toLocaleString('en-IN',{minimumFractionDigits:2});
}

// Remove empty fields
window.addEventListener("beforeprint", handlePrint);
window.addEventListener("afterprint", restorePrint);

function handlePrint(){
  applyFolioSelection();
  preparePrintMetaValues();
  preparePrintTableValues();
  renderPrintPartyDetails();
  togglePrintField("client", ".clientDiv");
  togglePrintField("phone", ".phoneDiv");
  togglePrintField("pkg", ".pkgDiv");
  togglePrintField("disc", ".discDiv");
}

function restorePrint(){
  document.body.classList.remove("print-ledger");
  const box = document.getElementById("printPartyDetails");
  if(box){
    box.style.display = "";
    box.innerHTML = "";
  }
  document.querySelectorAll(".clientDiv, .phoneDiv, .pkgDiv, .discDiv")
    .forEach(div => div.style.display = "");
}

function togglePrintField(inputId, divClass){
  const value = document.getElementById(inputId)?.value?.trim();
  const div = document.querySelector(divClass);
  if(!value && div){
    div.style.display = "none";
  }
}


// Share quotation via WhatsApp
function shareWhatsApp(){
  function indian(n){
    return Number(n).toLocaleString('en-IN',{minimumFractionDigits:2});
  }

  function formatDate(d){
    if(!d) return "";
    let parts=d.split("-");
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

  let clientName = document.getElementById("client").value || "Customer";
  let dateVal = formatDate(document.getElementById("date").value);

  let msg = `Hi, M/s ${clientName},\n`;
  msg += `Quote: -\n`;
  msg += `Date: ${dateVal}\n\n`;

  let subtotal = 0;

  document.querySelectorAll("#tbl tbody tr").forEach(r=>{

    let name = r.cells[1].querySelector("input").value;
    let qty  = +r.cells[2].querySelector("input").value;
    let rate = +r.cells[3].querySelector("input").value;

    if(name && qty>0 && rate>0){

      let amt = qty*rate;
      subtotal += amt;

      msg += `${name}\n`;
      msg += `     ${indian(rate)} x ${qty} = ${indian(amt)}\n\n`;
    }
  });

  let pkg  = +document.getElementById("pkg").value || 0;
  let disc = +document.getElementById("disc").value || 0;
  let gst  = +document.getElementById("gst").value || 0;

  if(pkg>0)  msg += `(+) Packaging : ${indian(pkg)}\n`;
  if(disc>0) msg += `(-) Discount : ${indian(disc)}\n`;

  let taxable = subtotal + pkg - disc;
  let tax = taxable * gst/100;
  let half = tax/2;

  msg += `Taxable Value = ${indian(taxable)}\n`;
  msg += `(+) GST ${gst}% :\n`;
  msg += `          CGST ${gst/2}% = ${indian(half)}\n`;
  msg += `          SGST ${gst/2}% = ${indian(half)}\n\n`;
  msg += `Grand Total = *${indian(taxable+tax)}*`;

  let phone = document.getElementById("phone").value.replace(/\D/g,'');

if(phone){
  window.open("https://wa.me/91" + phone + "?text=" + encodeURIComponent(msg), "_blank");
}else{
  window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank");
}
}

calc();

// Ledger modal
function openLedger(){
  document.getElementById("ledgerModal").style.display="block";
  document.getElementById("fDate").value = "";
  renderLedger();
}
// Close ledger modal
function closeLedger(){
  document.getElementById("ledgerModal").style.display="none";
}
// Get history from local storage
function getHistory(){
  return getLocalHistory();
}
// Open quotation from ledger
function renderLedger(list=null){

  let data = [...(list || getHistory())].sort((a,b) => Number(b.qno) - Number(a.qno));
  const countEl = document.getElementById("ledgerCount");
  if(countEl){
    countEl.textContent = `Entries: ${data.length}`;
  }

  let tbody=document.querySelector("#ledgerTable tbody");
  tbody.innerHTML="";

  data.forEach(r=>{

    let subtotal=0;
    safeItems(r).forEach(i=> subtotal += (Number(i.qty) || 0) * (Number(i.rate) || 0));

    let taxable=subtotal + r.pkg - r.disc;
    let tax=taxable*r.gst/100;
    let grand=taxable+tax;

    let tr=document.createElement("tr");

    tr.innerHTML=`
      <td>${r.qno}</td>
      <td>${formatLedgerDate(r.date)}</td>
      <td>${r.client}</td>
      <td>${grand.toLocaleString('en-IN')}</td>
      <td>
        <div class="ledger-action-group">
          <button class="open-btn ledger-action-btn" onclick="openFromLedger(${r.qno})">Open</button>
          <button class="history-delete-btn ledger-action-btn" onclick="deleteLedgerEntry(${r.qno})">Delete</button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  });
}

// Delete one saved quotation without changing its issued-number high-water mark.
async function deleteLedgerEntry(qno){
  const target = Number(qno);
  if(!Number.isSafeInteger(target) || target <= 0){
    console.error("Quotation deletion aborted: invalid number", qno);
    alert("Could not delete this quotation because its number is invalid.");
    return;
  }

  const data = getHistory();
  const matches = data.filter(r => Number(r.qno) === target);
  if(matches.length !== 1){
    console.error("Quotation deletion aborted: expected one match", { target, matches: matches.length });
    alert("Could not safely delete this quotation. No records were changed.");
    return;
  }

  const confirmed = confirm(
    `Delete Quotation #${target}?\n\nThis will remove this saved quotation.\nThis action cannot be undone.`
  );
  if(!confirmed) return;

  const remaining = data.filter(r => Number(r.qno) !== target);
  if(data.length - remaining.length !== 1){
    console.error("Quotation deletion aborted: unexpected removal count", { target });
    alert("Could not safely delete this quotation. No records were changed.");
    return;
  }

  const deletingCurrent = Number(document.getElementById("qno")?.value) === target;
  currentHighWater(data);
  setLocalHistory(remaining);
  filterLedger();
  const cloudResult = await syncDeletedEntryToCloud(target);

  if(cloudResult !== true){
    alert("Quotation deleted locally. Cloud deletion could not be confirmed and the record may reappear after synchronization.");
  }
  if(deletingCurrent){
    alert("The deleted quotation was open. The form will now reset to a new quotation.");
    location.reload();
  }
}

async function syncDeletedEntryToCloud(qno){
  if(!window.database || !window.ref || !window.set){
    console.warn("Quotation deleted locally; Firebase is unavailable.");
    return false;
  }
  try{
    const cloudWrite = window.set(window.ref(window.database, `${CLOUD_QUOTES}/${qno}`), null);
    if(navigator.onLine === false){
      cloudWrite.catch(err => console.error("Queued quotation cloud deletion failed:", err));
      console.warn("Quotation cloud deletion queued while offline for this app session.");
      return false;
    }
    const timeout = new Promise(resolve => window.setTimeout(() => resolve(false), 3000));
    const completed = cloudWrite
      .then(() => true)
      .catch(err => {
        console.error("Quotation cloud deletion failed:", err);
        return false;
      });
    if(await Promise.race([completed, timeout]) !== true){
      console.warn("Quotation cloud deletion is still pending.");
      return false;
    }
    return true;
  }catch(err){
    console.error("Quotation cloud deletion failed:", err);
    return false;
  }
}

function updateLedgerPrintFilters(){
  const el = document.getElementById("ledgerPrintFilters");
  if(!el) return;

  const d = document.getElementById("fDate").value;
  const c = document.getElementById("fClient").value.trim();
  const p = document.getElementById("fProduct").value.trim();

  const parts = [];
  if(d) parts.push(`Date: ${formatLedgerDate(d)}`);
  if(c) parts.push(`Customer: ${c}`);
  if(p) parts.push(`Product: ${p}`);

  if(parts.length === 0){
    el.textContent = "";
    el.style.display = "none";
    return;
  }

  el.textContent = `Filters: ${parts.join(" | ")}`;
  el.style.display = "block";
}

// Filter ledger entries
function filterLedger(){

  let d=fDate.value;
  let c=fClient.value.toLowerCase();
  let p=fProduct.value.toLowerCase();

  let data=getHistory().filter(r=>{

    let ok=true;

    if(d && toISODateString(r.date) !== d) ok=false;

    if(c && !r.client.toLowerCase().includes(c)) ok=false;

    if(p){
      let found=safeItems(r).some(i => String(i.name || "").toLowerCase().includes(p));
      if(!found) ok=false;
    }

    return ok;
  });

  renderLedger(data);
}
// Open quotation from ledger
function openFromLedger(no){
  closeLedger();
  document.getElementById("qno").value = no;
  loadQuotation();
}
// Export ledger to PDF
function exportLedgerPDF(){
  closeMenu();
  updateLedgerPrintFilters();
  document.body.classList.add("print-ledger");
  window.print();
}

document.addEventListener("keydown", e => {
  if(e.key === "Escape" && document.getElementById("sideMenu")?.classList.contains("open")){
    e.preventDefault();
    closeMenu();
    return;
  }
  if(!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  if(key === "s"){
    e.preventDefault();
    saveQuotation();
  }else if(key === "c"){
    e.preventDefault();
    clearForm();
  }else if(key === "h"){
    e.preventDefault();
    openLedger();
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}


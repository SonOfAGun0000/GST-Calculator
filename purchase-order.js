const defaultProducts=["Sugar","Groundnut Oil","Rice","Oil","Toor Dhall","Channa Flour"];
const productCatalog = loadProductCatalog();
const products = (() => {
  const names = productCatalog.map(r => r.name).filter(Boolean);
  return names.length ? [...new Set(names)] : defaultProducts;
})();
const folioAllowedTypes = new Set(["supplier", "both"]);
const STORE_KEY = "gst_purchase_orders_history";
const CLOUD_ROOT = "companyData/purchaseOrders";
const CLOUD_QUOTES = `${CLOUD_ROOT}/orders`;
const CLOUD_LAST_QNO = `${CLOUD_ROOT}/meta/lastPono`;
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
  localStorage.setItem(STORE_KEY, JSON.stringify(normalizeHistory(data)));
}

function nextQnoFromList(data){
  const max = data.reduce((m, r) => Math.max(m, Number(r.qno) || 0), 0);
  return max + 1;
}

function refreshNextQno(force = false){
  if(holdCurrentQno && !force) return;
  document.getElementById("qno").value = nextQnoFromList(getLocalHistory());
}

function parseCloudHistory(raw){
  if(Array.isArray(raw)) return normalizeHistory(raw);
  if(!raw || typeof raw !== "object") return [];
  if(Array.isArray(raw.orders)) return normalizeHistory(raw.orders);
  if(raw.orders && typeof raw.orders === "object"){
    return normalizeHistory(Object.values(raw.orders));
  }
  return [];
}

function poSignature(record){
  return JSON.stringify({
    date: toISODateString(record?.date || ""),
    client: String(record?.client || "").trim(),
    phone: String(record?.phone || "").trim(),
    reqBy: String(record?.reqBy || "").trim(),
    shipVia: String(record?.shipVia || "").trim(),
    shipTerms: String(record?.shipTerms || "").trim(),
    items: safeItems(record).map(i => ({
      name: String(i?.name || "").trim(),
      qty: Number(i?.qty) || 0
    }))
  });
}

function mergeHistory(localHistory, cloudHistory){
  const merged = new Map();
  const usedQnos = new Set();

  function reserveQno(qno){
    const n = Number(qno);
    if(n > 0) usedQnos.add(n);
  }

  function nextAvailableQno(){
    let n = 1;
    while(usedQnos.has(n)) n += 1;
    usedQnos.add(n);
    return n;
  }

  cloudHistory.forEach(r => {
    const qno = Number(r?.qno);
    if(!qno) return;
    reserveQno(qno);
    merged.set(qno, { ...r, qno });
  });

  localHistory.forEach(r => {
    const qno = Number(r?.qno);
    if(!qno){
      const assigned = nextAvailableQno();
      merged.set(assigned, { ...r, qno: assigned });
      return;
    }

    reserveQno(qno);
    const existing = merged.get(qno);
    if(!existing){
      merged.set(qno, { ...r, qno });
      return;
    }

    const existingSig = poSignature(existing);
    const incomingSig = poSignature(r);
    const existingSaved = Number(existing.savedAt) || 0;
    const incomingSaved = Number(r.savedAt) || 0;

    if(existingSig === incomingSig){
      if(incomingSaved >= existingSaved){
        merged.set(qno, { ...r, qno });
      }
      return;
    }

    if(incomingSaved >= existingSaved){
      const movedQno = nextAvailableQno();
      merged.set(movedQno, { ...existing, qno: movedQno });
      merged.set(qno, { ...r, qno });
      return;
    }

    const assigned = nextAvailableQno();
    merged.set(assigned, { ...r, qno: assigned });
  });

  return [...merged.values()].sort((a,b) => a.qno - b.qno);
}

function toCloudPayload(history){
  const orders = {};
  history.forEach(r => { orders[r.qno] = r; });
  return {
    orders,
    meta: { lastPono: nextQnoFromList(history) - 1 }
  };
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
  input.dataset.code = rec.code || "";
  return rec;
}

function applyAutoGSTFromRows(){
  return;
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
    const productPrint = r.cells?.[1]?.querySelector(".print-value");
    const qtyPrint = r.cells?.[2]?.querySelector(".print-value");

    if(productPrint){
      productPrint.textContent = (productInput?.value || "").trim();
    }
    if(qtyPrint){
      const rec = findProductRecord(productInput?.value || "");
      const unit = rec?.unit ? ` ${rec.unit}` : "";
      const qty = (qtyInput?.value || "").trim();
      qtyPrint.textContent = `${qty}${unit}`.trim();
    }
  });
}

//Generate Quote No.
function generateNextQuoteNo(){
  let history = getLocalHistory();
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
  const data = localStorage.getItem(STORE_KEY);
  const blob = new Blob([data], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "purchase-order-backup.json";
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
      localStorage.setItem(STORE_KEY, reader.result);
      alert("Data Imported Successfully");
      location.reload();
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
function nextPurchaseOrderNumber(){
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

    if(name && qty>0){
      rows.push({name,qty});
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
    reqBy:document.getElementById("reqBy").value,
    shipVia:document.getElementById("shipVia").value,
    shipTerms:document.getElementById("shipTerms").value,
    items:rows,
    savedAt: Date.now()
  };

  let data = getLocalHistory();
  let newQno = nextQnoFromList(data);

  if(window.database && window.ref && window.set && window.runTransaction){
    try{
      const tx = await window.runTransaction(
        window.ref(window.database, CLOUD_LAST_QNO),
        current => (Number(current) || 0) + 1
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
  alert(`Successfully saved (PO No: ${newQno})`);
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
  document.getElementById("reqBy").value = rec.reqBy || "";
  document.getElementById("shipVia").value = rec.shipVia || "";
  document.getElementById("shipTerms").value = rec.shipTerms || "";
  document.getElementById("date").value = toISODateString(rec.date);

  document.querySelector("#tbl tbody").innerHTML="";

  const items = safeItems(rec);
  items.forEach(it=>{
    addRow();
    let r=document.querySelector("#tbl tbody tr:last-child");
    r.cells[1].querySelector("input").value=it.name;
    r.cells[2].querySelector("input").value=it.qty;
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

      const cloudLastPono = Number(raw?.meta?.lastPono) || 0;
      const mergedLastPono = nextQnoFromList(merged) - 1;
      const shouldWriteBack =
        cloudHistory.length !== merged.length ||
        Array.isArray(raw) ||
        cloudLastPono < mergedLastPono;

      if(shouldWriteBack){
        await window.set(window.ref(window.database, CLOUD_ROOT), toCloudPayload(merged));
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

// Calculate totals
function calc(){
  let totalQty=0;

  document.querySelectorAll("#tbl tbody tr").forEach((r,i)=>{
    r.cells[0].innerText=i+1;
    let q=Number(r.cells[2].children[0].value||0);
    totalQty += q;
  });
  document.getElementById("grand").innerText=totalQty.toFixed(2);
}

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
  togglePrintField("reqBy", ".reqByDiv");
  togglePrintField("shipVia", ".shipViaDiv");
  togglePrintField("shipTerms", ".shipTermsDiv");
}

function restorePrint(){
  document.body.classList.remove("print-ledger");
  const box = document.getElementById("printPartyDetails");
  if(box){
    box.style.display = "";
    box.innerHTML = "";
  }
  document.querySelectorAll(".clientDiv, .phoneDiv, .reqByDiv, .shipViaDiv, .shipTermsDiv")
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
  function formatDate(d){
    if(!d) return "";
    let parts=d.split("-");
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }

  let clientName = document.getElementById("client").value || "Supplier";
  let dateVal = formatDate(document.getElementById("date").value);
  let reqBy = document.getElementById("reqBy").value || "";
  let shipVia = document.getElementById("shipVia").value || "";
  let shipTerms = document.getElementById("shipTerms").value || "";

  let msg = `Hi, M/s ${clientName},\n`;
  msg += `Purchase Order: -\n`;
  msg += `Date: ${dateVal}\n\n`;
  if(reqBy) msg += `Requisitioner: ${reqBy}\n`;
  if(shipVia) msg += `Ship Via: ${shipVia}\n`;
  if(shipTerms) msg += `Shipping Terms: ${shipTerms}\n`;
  if(reqBy || shipVia || shipTerms) msg += `\n`;
  let totalQty = 0;

  document.querySelectorAll("#tbl tbody tr").forEach(r=>{

    let name = r.cells[1].querySelector("input").value;
    let qty  = +r.cells[2].querySelector("input").value;

    if(name && qty>0){
      totalQty += qty;
      msg += `${name}\n`;
      msg += `     Qty: ${qty}\n\n`;
    }
  });
  msg += `Total Qty = *${totalQty.toFixed(2)}*`;

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
    let totalQty=0;
    safeItems(r).forEach(i=> totalQty += (Number(i.qty) || 0));

    let tr=document.createElement("tr");

    tr.innerHTML=`
      <td>${r.qno}</td>
      <td>${formatLedgerDate(r.date)}</td>
      <td>${r.client}</td>
      <td>${totalQty.toLocaleString('en-IN')}</td>
      <td><button class="open-btn" onclick="openFromLedger(${r.qno})">Open</button></td>
    `;

    tbody.appendChild(tr);
  });
}

// Delete Saved Ledger
function deleteLedgerEntry(qno){

  if(!confirm("Delete this entry?")) return;

  let data = getHistory();
  data = data.filter(r => r.qno !== qno);

  setLocalHistory(data);
  syncDeletedEntryToCloud(qno);

  renderLedger();
  refreshNextQno();
}

function syncDeletedEntryToCloud(qno){
  if(!window.database || !window.ref || !window.set) return;
  window.set(window.ref(window.database, `${CLOUD_QUOTES}/${qno}`), null);
}

function updateLedgerPrintFilters(){
  const el = document.getElementById("ledgerPrintFilters");
  if(!el) return;

  const d = document.getElementById("fDate").value;
  const c = document.getElementById("fClient").value.trim();
  const p = document.getElementById("fProduct").value.trim();

  const parts = [];
  if(d) parts.push(`Date: ${formatLedgerDate(d)}`);
  if(c) parts.push(`Supplier: ${c}`);
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



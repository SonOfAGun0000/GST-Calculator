const defaultProducts=["Sugar","Groundnut Oil","Rice","Oil","Toor Dhall","Channa Flour"];
const productCatalog = loadProductCatalog();
const products = (() => {
  const names = productCatalog.map(r => r.name).filter(Boolean);
  return names.length ? [...new Set(names)] : defaultProducts;
})();
const folioAllowedTypes = new Set(["customer", "both"]);
const STORE_KEY = "gst_quotes_history";
const CLOUD_ROOT = "companyData";
const CLOUD_QUOTES = `${CLOUD_ROOT}/quotes`;
const CLOUD_LAST_QNO = `${CLOUD_ROOT}/meta/lastQno`;
let cloudSyncStarted = false;
let holdCurrentQno = false;
let selectedFolio = null;

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
    meta: { lastQno: nextQnoFromList(history) - 1 }
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

function setupProductDatalist(){
  let d = document.getElementById("plist");
  if(!d){
    d = document.createElement("datalist");
    d.id = "plist";
    document.body.appendChild(d);
  }
  d.innerHTML = "";

  const values = new Set();
  productCatalog.forEach(p => {
    if(p.name) values.add(p.name);
    if(p.code) values.add(p.code);
  });
  defaultProducts.forEach(p => values.add(p));

  [...values].sort((a,b) => a.localeCompare(b)).forEach(v => {
    const o = document.createElement("option");
    o.value = v;
    d.appendChild(o);
  });
}

function applyProductSelection(input, row){
  if(!input) return null;
  const rec = findProductRecord(input.value);
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
  if(!clientInput) return;

  let d = document.getElementById("folioList");
  if(!d){
    d = document.createElement("datalist");
    d.id = "folioList";
    document.body.appendChild(d);
  }
  d.innerHTML = "";

  const names = [...new Set(loadPageFolios().map(f => f.name))].sort((a,b) => a.localeCompare(b));
  names.forEach(name => {
    const o = document.createElement("option");
    o.value = name;
    d.appendChild(o);
  });

  clientInput.setAttribute("list", "folioList");
  clientInput.addEventListener("input", () => {
    if(findFolioByName(clientInput.value)){
      applyFolioSelection();
    }
  });
  clientInput.addEventListener("change", applyFolioSelection);
  clientInput.addEventListener("blur", applyFolioSelection);
}

function applyFolioSelection(){
  const clientInput = document.getElementById("client");
  if(!clientInput) return;
  const match = findFolioByName(clientInput.value);
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
  let next = nextQnoFromList(history);
  holdCurrentQno = false;
  document.getElementById("qno").value = next;
}

//Hamburger Menu 
//Open
function toggleMenu(){
  document.getElementById("sideMenu").classList.add("open");
  document.getElementById("menuOverlay").classList.add("active");
}
//Close
function closeMenu(){
  document.getElementById("sideMenu").classList.remove("open");
  document.getElementById("menuOverlay").classList.remove("active");
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
      localStorage.setItem("gst_quotes_history", reader.result);
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
    applyProductSelection(productInput, r);
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
    applyProductSelection(r.cells[1].querySelector("input"), r);
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
      const mergedLastQno = nextQnoFromList(merged) - 1;
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
    <input list="plist" class="yellow product-field" placeholder="Product name">
    <span class="print-value"></span>
  </td>
  <td><input type="number" inputmode="decimal" step="any" value="" onchange="calc()" class="yellow"><span class="print-value"></span></td>
  <td><input type="number" inputmode="decimal" step="any" value="" onchange="calc()" class="yellow"><span class="print-value"></span></td>
  <td>0</td>
  <td><button class="del-btn" onclick="this.closest('tr').remove();calc()">&times;</button></td>
  `;
  const productInput = row.cells[1].querySelector("input");
  productInput.addEventListener("change", () => {
    applyProductSelection(productInput, row);
    calc();
  });
  productInput.addEventListener("input", () => {
    if(findProductRecord(productInput.value)){
      applyProductSelection(productInput, row);
      calc();
    }
  });
  productInput.addEventListener("blur", () => {
    applyProductSelection(productInput, row);
    calc();
  });
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


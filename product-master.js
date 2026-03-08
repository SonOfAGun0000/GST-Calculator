const STORE_KEY = "gst_catalog_master";
const LEGACY_PRODUCT_KEY = "gst_product_master";
const LEGACY_ITEM_KEY = "gst_item_master";

const CLOUD_ROOT = "companyData/catalogMaster";
const CLOUD_CATALOG = `${CLOUD_ROOT}/catalog`;
const LEGACY_CLOUD_PRODUCTS = "companyData/catalogLegacy/products";
const LEGACY_CLOUD_ITEMS = "companyData/catalogLegacy/items";

let cloudSyncStarted = false;
let editingId = null;
let legacyCloudHydrated = false;

document.addEventListener("DOMContentLoaded", () => {
  hydrateLocalCatalogFromLegacy();
  renderCatalog();
  if(!startCloudSync()){
    window.addEventListener("firebase-ready", startCloudSync, { once: true });
  }
});

function normalizeCatalog(list){
  if(!Array.isArray(list)) return [];
  return list
    .filter(r => r && typeof r === "object")
    .map((r, idx) => ({
      id: Number(r.id) || (Date.now() + idx),
      code: String(r.code || "").trim(),
      name: String(r.name || "").trim(),
      unit: String(r.unit || "").trim(),
      rate: Number(r.rate) || 0,
      hsn: String(r.hsn || "").trim(),
      gst: Number(r.gst) || 0,
      updatedAt: Number(r.updatedAt) || 0
    }))
    .filter(r => r.name);
}

function parseArray(raw, key){
  if(Array.isArray(raw)) return raw;
  if(!raw || typeof raw !== "object") return [];
  if(Array.isArray(raw[key])) return raw[key];
  if(raw[key] && typeof raw[key] === "object") return Object.values(raw[key]);
  return Object.values(raw);
}

function normalizeLegacyProducts(list){
  if(!Array.isArray(list)) return [];
  return list
    .filter(r => r && typeof r === "object")
    .map((r, idx) => ({
      id: Number(r.id) || (Date.now() + idx),
      code: String(r.code || "").trim(),
      name: String(r.name || "").trim(),
      unit: String(r.unit || "").trim(),
      rate: Number(r.rate) || 0,
      hsn: String(r.hsn || "").trim(),
      gst: Number(r.gst) || 0,
      updatedAt: Number(r.updatedAt) || 0
    }))
    .filter(r => r.name);
}

function normalizeLegacyItems(list){
  if(!Array.isArray(list)) return [];
  return list
    .filter(r => r && typeof r === "object")
    .map((r, idx) => ({
      id: Number(r.id) || (Date.now() + idx),
      code: String(r.code || "").trim(),
      name: String(r.name || "").trim(),
      unit: String(r.unit || "").trim(),
      rate: Number(r.rate) || 0,
      hsn: String(r.hsn || "").trim(),
      gst: Number(r.gst) || 0,
      updatedAt: Number(r.updatedAt) || 0
    }))
    .filter(r => r.name);
}

function getLocalCatalog(){
  try{
    return normalizeCatalog(JSON.parse(localStorage.getItem(STORE_KEY) || "[]"));
  }catch{
    return [];
  }
}

function syncLegacyLocalViews(list){
  const normalized = normalizeCatalog(list);
  const productView = normalized.map(r => ({
    id: r.id,
    name: r.name,
    unit: r.unit,
    hsn: r.hsn,
    gst: r.gst,
    updatedAt: r.updatedAt
  }));
  const itemView = normalized.map(r => ({
    id: r.id,
    code: r.code,
    name: r.name,
    unit: r.unit,
    rate: r.rate,
    updatedAt: r.updatedAt
  }));
  localStorage.setItem(LEGACY_PRODUCT_KEY, JSON.stringify(productView));
  localStorage.setItem(LEGACY_ITEM_KEY, JSON.stringify(itemView));
}

function setLocalCatalog(list){
  const normalized = normalizeCatalog(list);
  localStorage.setItem(STORE_KEY, JSON.stringify(normalized));
  syncLegacyLocalViews(normalized);
}

function catalogIdentity(rec){
  const code = String(rec.code || "").trim().toLowerCase();
  const name = String(rec.name || "").trim().toLowerCase();
  if(code) return `code:${code}`;
  return `name:${name}`;
}

function mergeTwoCatalog(a, b){
  const aTime = Number(a.updatedAt) || 0;
  const bTime = Number(b.updatedAt) || 0;
  const newer = bTime >= aTime ? b : a;
  const older = newer === b ? a : b;
  return {
    id: Number(newer.id) || Number(older.id) || Date.now(),
    code: newer.code || older.code || "",
    name: newer.name || older.name || "",
    unit: newer.unit || older.unit || "",
    rate: Number(newer.rate) || Number(older.rate) || 0,
    hsn: newer.hsn || older.hsn || "",
    gst: Number(newer.gst) || Number(older.gst) || 0,
    updatedAt: Math.max(aTime, bTime)
  };
}

function ensureUniqueIds(list){
  const used = new Set();
  return list.map((r, idx) => {
    let id = Number(r.id) || 0;
    while(!id || used.has(id)){
      id = Date.now() + idx + used.size + 1;
    }
    used.add(id);
    return { ...r, id };
  });
}

function mergeCatalog(...lists){
  const map = new Map();
  const all = lists.flat().filter(Boolean);
  normalizeCatalog(all).forEach(rec => {
    const key = catalogIdentity(rec);
    if(!key || key === "name:") return;
    const existing = map.get(key);
    map.set(key, existing ? mergeTwoCatalog(existing, rec) : rec);
  });
  const merged = ensureUniqueIds([...map.values()]);
  return merged.sort((a,b) => a.name.localeCompare(b.name));
}

function hydrateLocalCatalogFromLegacy(){
  const existing = getLocalCatalog();
  if(existing.length){
    syncLegacyLocalViews(existing);
    return;
  }

  let legacyProducts = [];
  let legacyItems = [];
  try{
    legacyProducts = normalizeLegacyProducts(JSON.parse(localStorage.getItem(LEGACY_PRODUCT_KEY) || "[]"));
  }catch{}
  try{
    legacyItems = normalizeLegacyItems(JSON.parse(localStorage.getItem(LEGACY_ITEM_KEY) || "[]"));
  }catch{}

  const merged = mergeCatalog(legacyProducts, legacyItems);
  if(merged.length){
    setLocalCatalog(merged);
  }
}

function parseCloudCatalog(raw){
  if(Array.isArray(raw)) return normalizeCatalog(raw);
  if(!raw || typeof raw !== "object") return [];
  if(Array.isArray(raw.catalog)) return normalizeCatalog(raw.catalog);
  if(raw.catalog && typeof raw.catalog === "object"){
    return normalizeCatalog(Object.values(raw.catalog));
  }
  return [];
}

function toCloudPayload(list){
  const catalog = {};
  list.forEach(r => { catalog[r.id] = r; });
  return { catalog };
}

function renderCatalog(){
  const list = getLocalCatalog();
  const tbody = document.querySelector("#pmTable tbody");
  tbody.innerHTML = "";

  list.forEach((r, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${escapeHtml(r.code)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.unit)}</td>
      <td>${r.rate ? Number(r.rate).toFixed(2) : ""}</td>
      <td>${escapeHtml(r.hsn)}</td>
      <td>${r.gst || ""}</td>
      <td><button class="del-btn" onclick="editCatalogRecord(${r.id})">Edit</button></td>
      <td><button class="del-btn" onclick="deleteCatalogRecord(${r.id})">Del</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("pmCount").textContent = `Records: ${list.length}`;
}

function saveCatalogRecord(){
  const name = document.getElementById("pmName").value.trim();
  if(!name){
    alert("Enter product name");
    return;
  }

  const rec = {
    id: editingId || Date.now(),
    code: document.getElementById("pmCode").value.trim(),
    name,
    unit: document.getElementById("pmUnit").value.trim(),
    rate: Number(document.getElementById("pmRate").value) || 0,
    hsn: document.getElementById("pmHsn").value.trim(),
    gst: Number(document.getElementById("pmGst").value) || 0,
    updatedAt: Date.now()
  };

  let list = getLocalCatalog().filter(r => Number(r.id) !== Number(rec.id));
  list.push(rec);
  list = mergeCatalog(list);
  setLocalCatalog(list);
  syncRecordToCloud(rec);
  clearCatalogForm();
  renderCatalog();
}

function editCatalogRecord(id){
  const rec = getLocalCatalog().find(r => Number(r.id) === Number(id));
  if(!rec) return;

  editingId = rec.id;
  document.getElementById("pmCode").value = rec.code;
  document.getElementById("pmName").value = rec.name;
  document.getElementById("pmUnit").value = rec.unit;
  document.getElementById("pmRate").value = rec.rate || "";
  document.getElementById("pmHsn").value = rec.hsn;
  document.getElementById("pmGst").value = rec.gst || "";
}

function deleteCatalogRecord(id){
  if(!confirm("Delete this record?")) return;
  const list = getLocalCatalog().filter(r => Number(r.id) !== Number(id));
  setLocalCatalog(list);
  syncDeleteFromCloud(id);
  renderCatalog();
}

function clearCatalogForm(){
  editingId = null;
  document.getElementById("pmCode").value = "";
  document.getElementById("pmName").value = "";
  document.getElementById("pmUnit").value = "";
  document.getElementById("pmRate").value = "";
  document.getElementById("pmHsn").value = "";
  document.getElementById("pmGst").value = "";
}

function syncRecordToCloud(rec){
  if(!window.database || !window.ref || !window.set) return;

  window.set(window.ref(window.database, `${CLOUD_CATALOG}/${rec.id}`), rec);

  const productLegacy = {
    id: rec.id,
    name: rec.name,
    unit: rec.unit,
    hsn: rec.hsn,
    gst: rec.gst,
    updatedAt: rec.updatedAt
  };
  const itemLegacy = {
    id: rec.id,
    code: rec.code,
    name: rec.name,
    unit: rec.unit,
    rate: rec.rate,
    updatedAt: rec.updatedAt
  };
  window.set(window.ref(window.database, `${LEGACY_CLOUD_PRODUCTS}/${rec.id}`), productLegacy);
  window.set(window.ref(window.database, `${LEGACY_CLOUD_ITEMS}/${rec.id}`), itemLegacy);
}

function syncDeleteFromCloud(id){
  if(!window.database || !window.ref || !window.set) return;
  window.set(window.ref(window.database, `${CLOUD_CATALOG}/${id}`), null);
  window.set(window.ref(window.database, `${LEGACY_CLOUD_PRODUCTS}/${id}`), null);
  window.set(window.ref(window.database, `${LEGACY_CLOUD_ITEMS}/${id}`), null);
}

function startCloudSync(){
  if(cloudSyncStarted) return true;
  if(!window.database || !window.ref || !window.onValue || !window.set) return false;
  cloudSyncStarted = true;

  window.onValue(window.ref(window.database, CLOUD_ROOT), async (snapshot) => {
    try{
      const raw = snapshot.val();
      const cloudCatalog = parseCloudCatalog(raw);
      let merged = mergeCatalog(getLocalCatalog(), cloudCatalog);

      if(!legacyCloudHydrated && window.get){
        legacyCloudHydrated = true;
        try{
          const [legacyProductSnap, legacyItemSnap] = await Promise.all([
            window.get(window.ref(window.database, LEGACY_CLOUD_PRODUCTS)),
            window.get(window.ref(window.database, LEGACY_CLOUD_ITEMS))
          ]);

          const legacyCloudProducts = normalizeLegacyProducts(
            parseArray(legacyProductSnap.val(), "products")
          );
          const legacyCloudItems = normalizeLegacyItems(
            parseArray(legacyItemSnap.val(), "items")
          );
          merged = mergeCatalog(merged, legacyCloudProducts, legacyCloudItems);
        }catch(err){
          console.error("Legacy master cloud hydration failed:", err);
        }
      }

      setLocalCatalog(merged);
      renderCatalog();

      const needWriteBack = !raw || !raw.catalog || cloudCatalog.length !== merged.length;
      if(needWriteBack){
        await window.set(window.ref(window.database, CLOUD_ROOT), toCloudPayload(merged));
      }
    }catch(err){
      console.error("Catalog master sync failed:", err);
    }
  });

  return true;
}

function exportData(){
  const data = localStorage.getItem(STORE_KEY) || "[]";
  const blob = new Blob([data], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "product-item-master-backup.json";
  a.click();
}

function importData(){
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = e => {
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try{
        const imported = normalizeCatalog(JSON.parse(reader.result));
        setLocalCatalog(mergeCatalog(imported));
        renderCatalog();
        alert("Import successful");
      }catch{
        alert("Invalid file");
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function toggleMenu(){
  document.getElementById("sideMenu").classList.add("open");
  document.getElementById("menuOverlay").classList.add("active");
}

function closeMenu(){
  document.getElementById("sideMenu").classList.remove("open");
  document.getElementById("menuOverlay").classList.remove("active");
}

function shareApp(){
  if(navigator.share){
    navigator.share({ title:"VSTD Company", url:window.location.href });
  } else {
    alert("Copy this link:\n" + window.location.href);
  }
}

function checkUpdates(){
  navigator.serviceWorker.getRegistrations().then(regs => {
    regs.forEach(reg => reg.update());
  });
  location.reload();
}

function escapeHtml(value){
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js");
}

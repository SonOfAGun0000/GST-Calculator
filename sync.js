import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
  import { getDatabase, ref, set, onValue, runTransaction, get } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-database.js";

  const firebaseConfig = {
    apiKey: "AIzaSyA4NGdwbvS0JPR3jEpYXYIzlVFs9v3HEKQ",
    authDomain: "gst-quote-by-sathish-sekar.firebaseapp.com",
    databaseURL: "https://gst-quote-by-sathish-sekar-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "gst-quote-by-sathish-sekar",
    storageBucket: "gst-quote-by-sathish-sekar.firebasestorage.app",
    messagingSenderId: "1031085607122",
    appId: "1:1031085607122:web:8b12cf7f19ce834760850b",
    measurementId: "G-BS0VBLHRXB"
  };

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

const CATALOG_LOCAL_KEY = "gst_catalog_master";
const LEGACY_PRODUCT_KEY = "gst_product_master";
const LEGACY_ITEM_KEY = "gst_item_master";
const FOLIO_LOCAL_KEY = "gst_folio_master";
const REMOVED_DC_KEY = "gst_delivery_challans_history";
const REMOVED_DC_CLOUD_ROOT = "companyData/deliveryChallans";
const REMOVED_DC_CLEANUP_FLAG = "gst_removed_dc_cleanup_v1";
const CLOUD_CATALOG_ROOT = "companyData/catalogMaster";
const CLOUD_FOLIO_ROOT = "companyData/folioMaster";

function parseObjectValues(raw, key){
  if(Array.isArray(raw)) return raw;
  if(!raw || typeof raw !== "object") return [];
  if(Array.isArray(raw[key])) return raw[key];
  if(raw[key] && typeof raw[key] === "object") return Object.values(raw[key]);
  return [];
}

function normalizeCatalogList(list){
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
    .filter(r => r.name)
    .sort((a,b) => a.name.localeCompare(b.name));
}

function mergeById(localList, cloudList){
  const map = new Map();
  [...cloudList, ...localList].forEach(r => {
    const id = Number(r.id);
    if(!id) return;
    const existing = map.get(id);
    if(!existing || Number(r.updatedAt) >= Number(existing.updatedAt)){
      map.set(id, { ...r, id });
    }
  });
  return [...map.values()];
}

function saveCatalogToLocal(allCatalog){
  const normalized = normalizeCatalogList(allCatalog);
  localStorage.setItem(CATALOG_LOCAL_KEY, JSON.stringify(normalized));

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

function normalizeType(value){
  const t = String(value || "").trim().toLowerCase();
  if(t === "supplier") return "Supplier";
  if(t === "both") return "Both";
  return "Customer";
}

function normalizeFolios(list){
  if(!Array.isArray(list)) return [];
  return list
    .filter(f => f && typeof f === "object")
    .map((f, idx) => ({
      id: Number(f.id) || (Date.now() + idx),
      name: String(f.name || "").trim(),
      type: normalizeType(f.type),
      phone: String(f.phone || "").trim(),
      altPhone: String(f.altPhone || "").trim(),
      address: String(f.address || "").trim(),
      gstin: String(f.gstin || "").trim(),
      updatedAt: Number(f.updatedAt) || 0
    }))
    .filter(f => f.name)
    .sort((a,b) => a.name.localeCompare(b.name));
}

function startSharedMasterHydration(){
  if(!window.onValue || !window.ref || !window.database) return;

  const catalogRef = window.ref(window.database, CLOUD_CATALOG_ROOT);
  window.onValue(catalogRef, snapshot => {
    try{
      const cloudCatalog = normalizeCatalogList(
        parseObjectValues(snapshot.val(), "catalog")
      );
      if(!cloudCatalog.length) return;

      let localCatalog = [];
      try{
        localCatalog = normalizeCatalogList(
          JSON.parse(localStorage.getItem(CATALOG_LOCAL_KEY) || "[]")
        );
      }catch{}

      saveCatalogToLocal(mergeById(localCatalog, cloudCatalog));
    }catch(err){
      console.error("Shared catalog hydration failed:", err);
    }
  });

  const folioRef = window.ref(window.database, CLOUD_FOLIO_ROOT);
  window.onValue(folioRef, snapshot => {
    try{
      const cloudFolios = normalizeFolios(
        parseObjectValues(snapshot.val(), "folios")
      );
      if(!cloudFolios.length) return;

      let localFolios = [];
      try{
        localFolios = normalizeFolios(
          JSON.parse(localStorage.getItem(FOLIO_LOCAL_KEY) || "[]")
        );
      }catch{}

      localStorage.setItem(
        FOLIO_LOCAL_KEY,
        JSON.stringify(mergeById(localFolios, cloudFolios))
      );
    }catch(err){
      console.error("Shared folio hydration failed:", err);
    }
  });
}

function cleanupRemovedDeliveryChallanData(){
  try{
    localStorage.removeItem(REMOVED_DC_KEY);
  }catch{}

  try{
    if(localStorage.getItem(REMOVED_DC_CLEANUP_FLAG) === "1") return;
    if(!window.set || !window.ref || !window.database) return;
    window
      .set(window.ref(window.database, REMOVED_DC_CLOUD_ROOT), null)
      .then(() => localStorage.setItem(REMOVED_DC_CLEANUP_FLAG, "1"))
      .catch(err => console.error("Delivery challan cloud cleanup failed:", err));
  }catch(err){
    console.error("Delivery challan cleanup failed:", err);
  }
}

// expose globally
window.database = database;
window.ref = ref;
window.set = set;
window.onValue = onValue;
window.runTransaction = runTransaction;
window.get = get;
startSharedMasterHydration();
cleanupRemovedDeliveryChallanData();
window.dispatchEvent(new Event("firebase-ready"));


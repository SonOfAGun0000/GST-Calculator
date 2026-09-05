const STORE_KEY = "gst_folio_master";
const CLOUD_ROOT = "companyData/folioMaster";
const CLOUD_FOLIOS = `${CLOUD_ROOT}/folios`;

let cloudSyncStarted = false;
let editingId = null;

document.addEventListener("DOMContentLoaded", () => {
  renderFolios();
  if(!startCloudSync()){
    window.addEventListener("firebase-ready", startCloudSync, { once: true });
  }
});

function normalizeType(value){
  const raw = String(value || "").trim().toLowerCase();
  if(raw === "supplier") return "Supplier";
  if(raw === "both") return "Both";
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
    .filter(f => f.name);
}

function getLocalFolios(){
  try{
    return normalizeFolios(JSON.parse(localStorage.getItem(STORE_KEY) || "[]"));
  }catch{
    return [];
  }
}

function setLocalFolios(list){
  localStorage.setItem(STORE_KEY, JSON.stringify(normalizeFolios(list)));
}

function parseCloudFolios(raw){
  if(Array.isArray(raw)) return normalizeFolios(raw);
  if(!raw || typeof raw !== "object") return [];
  if(Array.isArray(raw.folios)) return normalizeFolios(raw.folios);
  if(raw.folios && typeof raw.folios === "object"){
    return normalizeFolios(Object.values(raw.folios));
  }
  return [];
}

function mergeFolios(localList, cloudList){
  const map = new Map();
  [...cloudList, ...localList].forEach(f => {
    const id = Number(f.id);
    if(!id) return;
    const existing = map.get(id);
    if(!existing || Number(f.updatedAt) >= Number(existing.updatedAt)){
      map.set(id, { ...f, id });
    }
  });
  return [...map.values()].sort((a,b) => a.name.localeCompare(b.name));
}

function toCloudPayload(list){
  const folios = {};
  list.forEach(f => { folios[f.id] = f; });
  return { folios };
}

function renderFolios(){
  const list = getLocalFolios();
  const tbody = document.querySelector("#foTable tbody");
  tbody.innerHTML = "";

  list.forEach((f, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${escapeHtml(f.name)}</td>
      <td>${escapeHtml(f.type)}</td>
      <td>${escapeHtml(f.phone)}</td>
      <td>${escapeHtml(f.gstin)}</td>
      <td><button class="del-btn" onclick="editFolio(${f.id})">Edit</button></td>
      <td><button class="del-btn" onclick="deleteFolio(${f.id})">Del</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("foCount").textContent = `Folios: ${list.length}`;
}

function saveFolio(){
  const name = document.getElementById("foName").value.trim();
  if(!name){
    alert("Enter name");
    return;
  }

  const rec = {
    id: editingId || Date.now(),
    name,
    type: normalizeType(document.getElementById("foType").value),
    phone: document.getElementById("foPhone").value.trim(),
    altPhone: document.getElementById("foAltPhone").value.trim(),
    address: document.getElementById("foAddress").value.trim(),
    gstin: document.getElementById("foGstin").value.trim(),
    updatedAt: Date.now()
  };

  let list = getLocalFolios().filter(f => Number(f.id) !== Number(rec.id));
  list.push(rec);
  setLocalFolios(list);
  syncRecord(rec);
  clearFolioForm();
  renderFolios();
}

function editFolio(id){
  const rec = getLocalFolios().find(f => Number(f.id) === Number(id));
  if(!rec) return;
  editingId = rec.id;
  document.getElementById("foName").value = rec.name;
  document.getElementById("foType").value = rec.type;
  document.getElementById("foPhone").value = rec.phone;
  document.getElementById("foAltPhone").value = rec.altPhone;
  document.getElementById("foAddress").value = rec.address;
  document.getElementById("foGstin").value = rec.gstin;
}

function deleteFolio(id){
  if(!confirm("Delete this folio?")) return;
  const list = getLocalFolios().filter(f => Number(f.id) !== Number(id));
  setLocalFolios(list);
  if(window.database && window.ref && window.set){
    window.set(window.ref(window.database, `${CLOUD_FOLIOS}/${id}`), null);
  }
  renderFolios();
}

function clearFolioForm(){
  editingId = null;
  document.getElementById("foName").value = "";
  document.getElementById("foType").value = "Customer";
  document.getElementById("foPhone").value = "";
  document.getElementById("foAltPhone").value = "";
  document.getElementById("foAddress").value = "";
  document.getElementById("foGstin").value = "";
}

function syncRecord(rec){
  if(!window.database || !window.ref || !window.set) return;
  window.set(window.ref(window.database, `${CLOUD_FOLIOS}/${rec.id}`), rec);
}

function startCloudSync(){
  if(cloudSyncStarted) return true;
  if(!window.database || !window.ref || !window.onValue || !window.set) return false;
  cloudSyncStarted = true;

  window.onValue(window.ref(window.database, CLOUD_ROOT), async (snapshot) => {
    try{
      const raw = snapshot.val();
      const cloudFolios = parseCloudFolios(raw);
      const localFolios = getLocalFolios();
      const merged = mergeFolios(localFolios, cloudFolios);
      setLocalFolios(merged);
      renderFolios();

      const needWriteBack = !raw || !raw.folios || cloudFolios.length !== merged.length;
      if(needWriteBack){
        await window.set(window.ref(window.database, CLOUD_ROOT), toCloudPayload(merged));
      }
    }catch(err){
      console.error("Folio master sync failed:", err);
    }
  });

  return true;
}

function exportData(){
  const data = localStorage.getItem(STORE_KEY) || "[]";
  const blob = new Blob([data], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "folio-master-backup.json";
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
        setLocalFolios(normalizeFolios(JSON.parse(reader.result)));
        renderFolios();
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
  const menu = document.getElementById("sideMenu");
  const trigger = document.getElementById("menuToggle");
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  document.getElementById("menuOverlay").classList.add("active");
  document.body.classList.add("menu-open");
  trigger?.setAttribute("aria-expanded", "true");
  window.setTimeout(() => document.getElementById("menuClose")?.focus(), 0);
}

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

document.addEventListener("keydown", event => {
  if(event.key === "Escape" && document.getElementById("sideMenu")?.classList.contains("open")){
    event.preventDefault();
    closeMenu();
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./service-worker.js");
}

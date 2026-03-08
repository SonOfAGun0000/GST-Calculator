const STORE_KEY = "gst_item_master";
const CLOUD_ROOT = "companyData/itemMaster";
const CLOUD_ITEMS = `${CLOUD_ROOT}/items`;
let cloudSyncStarted = false;
let editingId = null;

document.addEventListener("DOMContentLoaded", () => {
  renderItems();
  if(!startCloudSync()){
    window.addEventListener("firebase-ready", startCloudSync, { once: true });
  }
});

function normalizeItems(list){
  if(!Array.isArray(list)) return [];
  return list
    .filter(i => i && typeof i === "object" && Number(i.id) > 0)
    .map(i => ({
      id: Number(i.id),
      code: String(i.code || "").trim(),
      name: String(i.name || "").trim(),
      unit: String(i.unit || "").trim(),
      rate: Number(i.rate) || 0,
      updatedAt: Number(i.updatedAt) || 0
    }))
    .filter(i => i.name);
}

function getLocalItems(){
  try{
    return normalizeItems(JSON.parse(localStorage.getItem(STORE_KEY) || "[]"));
  }catch{
    return [];
  }
}

function setLocalItems(list){
  localStorage.setItem(STORE_KEY, JSON.stringify(normalizeItems(list)));
}

function parseCloudItems(raw){
  if(Array.isArray(raw)) return normalizeItems(raw);
  if(!raw || typeof raw !== "object") return [];
  if(Array.isArray(raw.items)) return normalizeItems(raw.items);
  if(raw.items && typeof raw.items === "object"){
    return normalizeItems(Object.values(raw.items));
  }
  return [];
}

function mergeItems(localList, cloudList){
  const merged = new Map();
  [...cloudList, ...localList].forEach(i => {
    const id = Number(i.id);
    if(!id) return;
    const existing = merged.get(id);
    if(!existing || Number(i.updatedAt) >= Number(existing.updatedAt)){
      merged.set(id, { ...i, id });
    }
  });
  return [...merged.values()].sort((a,b) => a.name.localeCompare(b.name));
}

function toCloudPayload(list){
  const items = {};
  list.forEach(i => { items[i.id] = i; });
  return { items };
}

function renderItems(){
  const list = getLocalItems().sort((a,b) => a.name.localeCompare(b.name));
  const tbody = document.querySelector("#imTable tbody");
  tbody.innerHTML = "";

  list.forEach((i, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${idx+1}</td>
      <td>${escapeHtml(i.code)}</td>
      <td>${escapeHtml(i.name)}</td>
      <td>${escapeHtml(i.unit)}</td>
      <td>${i.rate ? i.rate.toFixed(2) : ""}</td>
      <td><button class="del-btn" onclick="editItem(${i.id})">Edit</button></td>
      <td><button class="del-btn" onclick="deleteItem(${i.id})">Del</button></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("imCount").textContent = `Items: ${list.length}`;
}

function saveItem(){
  const name = document.getElementById("imName").value.trim();
  if(!name){
    alert("Enter item name");
    return;
  }

  const rec = {
    id: editingId || Date.now(),
    code: document.getElementById("imCode").value.trim(),
    name,
    unit: document.getElementById("imUnit").value.trim(),
    rate: +document.getElementById("imRate").value || 0,
    updatedAt: Date.now()
  };

  let list = getLocalItems();
  list = list.filter(i => i.id !== rec.id);
  list.push(rec);
  setLocalItems(list);
  syncRecord(rec);
  clearItemForm();
  renderItems();
}

function editItem(id){
  const rec = getLocalItems().find(i => i.id === Number(id));
  if(!rec) return;
  editingId = rec.id;
  document.getElementById("imCode").value = rec.code;
  document.getElementById("imName").value = rec.name;
  document.getElementById("imUnit").value = rec.unit;
  document.getElementById("imRate").value = rec.rate || "";
}

function deleteItem(id){
  if(!confirm("Delete this item?")) return;
  const list = getLocalItems().filter(i => i.id !== Number(id));
  setLocalItems(list);
  if(window.database && window.ref && window.set){
    window.set(window.ref(window.database, `${CLOUD_ITEMS}/${id}`), null);
  }
  renderItems();
}

function clearItemForm(){
  editingId = null;
  document.getElementById("imCode").value = "";
  document.getElementById("imName").value = "";
  document.getElementById("imUnit").value = "";
  document.getElementById("imRate").value = "";
}

function syncRecord(rec){
  if(!window.database || !window.ref || !window.set) return;
  window.set(window.ref(window.database, `${CLOUD_ITEMS}/${rec.id}`), rec);
}

function startCloudSync(){
  if(cloudSyncStarted) return true;
  if(!window.database || !window.ref || !window.onValue || !window.set) return false;
  cloudSyncStarted = true;

  window.onValue(window.ref(window.database, CLOUD_ROOT), async (snapshot) => {
    try{
      const cloudList = parseCloudItems(snapshot.val());
      const localList = getLocalItems();
      const merged = mergeItems(localList, cloudList);
      setLocalItems(merged);
      renderItems();
      if(cloudList.length !== merged.length){
        await window.set(window.ref(window.database, CLOUD_ROOT), toCloudPayload(merged));
      }
    }catch(err){
      console.error("Item master sync failed:", err);
    }
  });
  return true;
}

function exportData(){
  const data = localStorage.getItem(STORE_KEY) || "[]";
  const blob = new Blob([data], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "item-master-backup.json";
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
        setLocalItems(JSON.parse(reader.result));
        renderItems();
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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js');
}

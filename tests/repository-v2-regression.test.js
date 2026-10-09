const fs = require("fs");
const path = require("path");
const assert = require("assert");

const projectRoot = path.resolve(__dirname, "..");
const repository = fs.readFileSync(path.join(projectRoot, "repository-v2.js"), "utf8");
const persistence = fs.readFileSync(path.join(projectRoot, "persistence-v2.js"), "utf8");
const quotation = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
const purchaseOrder = fs.readFileSync(path.join(projectRoot, "purchase-order.js"), "utf8");
const sync = fs.readFileSync(path.join(projectRoot, "sync.js"), "utf8");
const index = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const quotationHtml = fs.readFileSync(path.join(projectRoot, "quotation.html"), "utf8");
const serviceWorker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");

[
  "listHistory",
  "getDocument",
  "findByBusinessNumber",
  "getNextNumberFloor",
  "createBackupSnapshot",
  "inspectBackup"
].forEach(name => assert(repository.includes(name), `Repository API ${name} is missing`));

assert(repository.includes('const BACKUP_VERSION = 2'), "Versioned backup format is missing");
assert(repository.includes('canRestore: false'), "Restore safety lock is missing");
assert(repository.includes('crossDeviceUnique: false'), "Offline numbering must not claim global uniqueness");
assert(!repository.includes("storage.setItem("), "Repository read layer must not write localStorage");
assert(persistence.includes("getNumberHighWater"), "Narrow IndexedDB high-water read API is missing");
assert(persistence.includes('const DB_VERSION = 1'), "Physical IndexedDB version must remain 1");
assert(!quotation.includes("vstdRepositoryV2"), "Quotation live reads must not use the repository yet");
assert(!purchaseOrder.includes("vstdRepositoryV2"), "PO live reads must not use the repository yet");
assert(!sync.includes("vstdRepositoryV2"), "Firebase must not use the repository yet");
assert(!index.includes("repository-v2.js"), "PO page must not activate repository reads yet");
assert(!quotationHtml.includes("repository-v2.js"), "Quotation page must not activate repository reads yet");
assert(serviceWorker.includes('const CACHE_NAME = "gst-quote-v14"'), "Service-worker cache version changed");

console.log("Repository v2 regression checks passed: additive read layer remains inactive and IndexedDB version 1 is retained.");

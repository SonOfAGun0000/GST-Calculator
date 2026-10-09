"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const persistence = fs.readFileSync(path.join(projectRoot, "persistence-v2.js"), "utf8");
const quotation = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
const purchaseOrder = fs.readFileSync(path.join(projectRoot, "purchase-order.js"), "utf8");
const sync = fs.readFileSync(path.join(projectRoot, "sync.js"), "utf8");
const serviceWorker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");

assert(persistence.includes('const DB_VERSION = 1'), "Physical IndexedDB version must remain 1");
assert(persistence.includes('["documents", "outbox", "meta"], "readwrite"'), "Atomic commit must cover all three stores");
assert(persistence.includes("transaction.oncomplete"), "Commit must wait for transaction completion");
assert(persistence.includes("commitDocumentWithOutbox"), "Transactional commit API is missing");
for(const api of [
  "getDocument",
  "listDocuments",
  "findDocumentsByBusinessNumber",
  "listPendingOperations",
  "markOperationAttempt",
  "markOperationComplete",
  "markOperationFailed"
]){
  assert(persistence.includes(api), `Supporting API ${api} is missing`);
}

assert(!quotation.includes("commitDocumentWithOutbox"), "Quotation Save must not use the new persistence API yet");
assert(!purchaseOrder.includes("commitDocumentWithOutbox"), "PO Save must not use the new persistence API yet");
assert(!sync.includes("listPendingOperations"), "Firebase outbox processing must not be activated yet");
assert(serviceWorker.includes('gst-quote-v14'), "Service-worker cache version must remain v14");

console.log("Persistence v2 regression checks passed: version 1 retained, API exposed, and no live Save/cloud integration enabled.");

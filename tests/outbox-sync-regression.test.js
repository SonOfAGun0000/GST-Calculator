const fs = require("fs");
const path = require("path");
const assert = require("assert");

const projectRoot = path.resolve(__dirname, "..");
const consumer = fs.readFileSync(path.join(projectRoot, "outbox-sync.js"), "utf8");
const persistence = fs.readFileSync(path.join(projectRoot, "persistence-v2.js"), "utf8");
const quotation = fs.readFileSync(path.join(projectRoot, "app.js"), "utf8");
const purchaseOrder = fs.readFileSync(path.join(projectRoot, "purchase-order.js"), "utf8");
const sync = fs.readFileSync(path.join(projectRoot, "sync.js"), "utf8");
const index = fs.readFileSync(path.join(projectRoot, "index.html"), "utf8");
const quotationHtml = fs.readFileSync(path.join(projectRoot, "quotation.html"), "utf8");
const serviceWorker = fs.readFileSync(path.join(projectRoot, "service-worker.js"), "utf8");

assert(consumer.includes("createProcessor"), "Opt-in processor factory is missing");
assert(consumer.includes("cloudAdapter.applyOperation"), "Injected cloud adapter contract is missing");
assert(consumer.includes("claimNextPendingOperation"), "Durable claim flow is missing");
assert(consumer.includes("renewOperationLease"), "Lease heartbeat is missing");
assert(consumer.includes("settleClaimedOperation"), "Conditional acknowledgement is missing");
assert(consumer.includes("calculateBackoff"), "Bounded retry calculation is missing");
assert(consumer.includes('identity: "recordId"'), "Stable cloud identity contract is missing");
assert(consumer.includes('idempotency: "operationId"'), "Cloud idempotency contract is missing");
assert(!consumer.includes("firebaseConfig"), "Consumer must not embed a Firebase adapter");
assert(!consumer.includes("companyData/"), "Consumer must not target production Firebase paths");
assert(persistence.includes('const DB_VERSION = 1'), "Physical IndexedDB version must remain 1");
assert(persistence.includes("document: intendedDocument"), "Durable revision snapshot is missing from outbox operations");
assert(!quotation.includes("VstdOutboxSync"), "Quotation Save must not activate the outbox consumer");
assert(!purchaseOrder.includes("VstdOutboxSync"), "PO Save must not activate the outbox consumer");
assert(!sync.includes("VstdOutboxSync"), "Firebase module must not activate the outbox consumer");
assert(!index.includes("outbox-sync.js"), "PO page must not load the consumer");
assert(!quotationHtml.includes("outbox-sync.js"), "Quotation page must not load the consumer");
assert(!serviceWorker.includes("outbox-sync.js"), "Service worker must not cache or execute the consumer");
assert(serviceWorker.includes('const CACHE_NAME = "gst-quote-v14"'), "Service-worker cache version changed");

console.log("Outbox sync regression checks passed: durable consumer is opt-in, adapter-only, and production-inactive.");

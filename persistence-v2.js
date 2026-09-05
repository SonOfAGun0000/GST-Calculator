(function(){
  "use strict";

  const DB_NAME = "vstd-gst-calculator";
  const DB_VERSION = 1;
  const SCHEMA_VERSION = 2;
  const MIGRATION_ID = "legacy-documents-to-v2";
  const MIGRATION_META_KEY = `migration:${MIGRATION_ID}`;
  const SOURCES = [
    {
      localStorageKey: "gst_quotes_history",
      entityType: "quotation",
      recordIdPrefix: "legacy:quotation"
    },
    {
      localStorageKey: "gst_purchase_orders_history",
      entityType: "purchaseOrder",
      recordIdPrefix: "legacy:po"
    }
  ];

  function requestResult(request){
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction){
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    });
  }

  function openDatabase(){
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        const meta = database.createObjectStore("meta", { keyPath: "key" });
        meta.createIndex("updatedAt", "updatedAt", { unique: false });

        const documents = database.createObjectStore("documents", { keyPath: "recordId" });
        documents.createIndex("entityType", "entityType", { unique: false });
        documents.createIndex("businessNumber", "businessNumber", { unique: false });
        documents.createIndex("createdAt", "createdAt", { unique: false });
        documents.createIndex("updatedAt", "updatedAt", { unique: false });

        const outbox = database.createObjectStore("outbox", { keyPath: "operationId" });
        outbox.createIndex("status", "status", { unique: false });
        outbox.createIndex("createdAt", "createdAt", { unique: false });
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another open page"));
    });
  }

  function createDeviceId(){
    if(window.crypto && typeof window.crypto.randomUUID === "function"){
      return window.crypto.randomUUID();
    }
    if(!window.crypto || typeof window.crypto.getRandomValues !== "function"){
      throw new Error("Secure random values are unavailable; deviceId was not created");
    }

    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  function ensureFoundationMeta(database){
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("meta", "readwrite");
      const store = transaction.objectStore("meta");
      const deviceRequest = store.get("deviceId");
      const migrationRequest = store.get(MIGRATION_META_KEY);
      let deviceId;

      deviceRequest.onsuccess = () => {
        try{
          deviceId = deviceRequest.result?.value || createDeviceId();
          store.put({ key: "deviceId", value: deviceId, updatedAt: Date.now() });
          store.put({ key: "schemaVersion", value: SCHEMA_VERSION, updatedAt: Date.now() });
        }catch(error){
          transaction.abort();
        }
      };
      deviceRequest.onerror = () => transaction.abort();
      migrationRequest.onsuccess = () => {
        if(!migrationRequest.result){
          store.put({
            key: MIGRATION_META_KEY,
            migrationId: MIGRATION_ID,
            status: "not-started",
            updatedAt: Date.now()
          });
        }
      };
      migrationRequest.onerror = () => transaction.abort();
      transaction.oncomplete = () => resolve(deviceId);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Could not initialize persistence metadata"));
    });
  }

  async function getMeta(database, key){
    const transaction = database.transaction("meta", "readonly");
    const done = transactionDone(transaction);
    const result = await requestResult(transaction.objectStore("meta").get(key));
    await done;
    return result || null;
  }

  async function putMeta(database, value){
    const transaction = database.transaction("meta", "readwrite");
    transaction.objectStore("meta").put(value);
    await transactionDone(transaction);
  }

  function stableStringify(value){
    if(value === null || typeof value !== "object") return JSON.stringify(value);
    if(Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  async function sha256(value){
    const bytes = new TextEncoder().encode(value);
    if(window.crypto?.subtle){
      const digest = await window.crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    // Deterministic offline fallback for diagnostics and duplicate suffixes only.
    let hash = 2166136261;
    bytes.forEach(byte => {
      hash ^= byte;
      hash = Math.imul(hash, 16777619);
    });
    return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}-${bytes.length}`;
  }

  function readSource(source){
    const raw = localStorage.getItem(source.localStorageKey);
    const preservedRaw = raw === null ? null : raw;
    if(raw === null){
      return { ...source, raw: preservedRaw, records: [] };
    }

    let records;
    try{
      records = JSON.parse(raw);
    }catch(error){
      throw new Error(`${source.localStorageKey} contains invalid JSON: ${error.message}`);
    }
    if(!Array.isArray(records)){
      throw new Error(`${source.localStorageKey} must contain a JSON array`);
    }
    return { ...source, raw: preservedRaw, records };
  }

  async function buildDocuments(source, deviceId){
    const documents = [];
    const issues = [];
    const numberCounts = new Map();

    for(let index = 0; index < source.records.length; index += 1){
      const payload = source.records[index];
      const businessNumber = Number(payload?.qno);
      if(!payload || typeof payload !== "object" || Array.isArray(payload) ||
        !Number.isSafeInteger(businessNumber) || businessNumber <= 0){
        issues.push({ sourceKey: source.localStorageKey, sourceIndex: index, reason: "invalid-qno" });
        continue;
      }

      const occurrence = (numberCounts.get(businessNumber) || 0) + 1;
      numberCounts.set(businessNumber, occurrence);
      const baseRecordId = `${source.recordIdPrefix}:${businessNumber}`;
      let recordId = baseRecordId;
      if(occurrence > 1){
        const contentHash = await sha256(stableStringify(payload));
        recordId = `${baseRecordId}:duplicate:${contentHash.slice(0, 16)}:${occurrence}`;
        issues.push({
          sourceKey: source.localStorageKey,
          sourceIndex: index,
          businessNumber,
          recordId,
          reason: "duplicate-business-number"
        });
      }

      const savedAt = Number(payload.savedAt);
      const timestamp = Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0;
      documents.push({
        recordId,
        entityType: source.entityType,
        businessNumber,
        schemaVersion: SCHEMA_VERSION,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdOnDevice: deviceId,
        source: "legacy-localStorage",
        legacy: {
          originalKey: source.localStorageKey,
          originalQnoField: "qno"
        },
        payload
      });
    }

    return { documents, issues };
  }

  async function copyDocuments(database, documents){
    const transaction = database.transaction("documents", "readwrite");
    const store = transaction.objectStore("documents");
    documents.forEach(document => store.put(document));
    await transactionDone(transaction);
  }

  async function verifyDocuments(database, sourcePlans, sourceSnapshots, highWaterSnapshots){
    const transaction = database.transaction("documents", "readonly");
    const done = transactionDone(transaction);
    const actualDocuments = await requestResult(transaction.objectStore("documents").getAll());
    await done;
    const actualById = new Map(actualDocuments.map(document => [document.recordId, document]));
    const checks = sourcePlans.flatMap(plan => plan.documents.map(intended => {
        const actual = actualById.get(intended.recordId);
        return Boolean(actual) &&
          actual.businessNumber === intended.businessNumber &&
          actual.entityType === intended.entityType &&
          stableStringify(actual.payload) === stableStringify(intended.payload);
      }));

    const sourceUnchanged = sourceSnapshots.every(snapshot =>
      localStorage.getItem(snapshot.localStorageKey) === snapshot.raw
    );
    const highWaterUnchanged = highWaterSnapshots.every(snapshot =>
      localStorage.getItem(snapshot.key) === snapshot.value
    );
    const quotation = sourcePlans.find(plan => plan.entityType === "quotation");
    const purchaseOrder = sourcePlans.find(plan => plan.entityType === "purchaseOrder");
    const invalidIssueCount = sourcePlans.reduce((count, plan) =>
      count + plan.issues.filter(issue => issue.reason === "invalid-qno").length, 0
    );
    const countsMatch = quotation.documents.length === quotation.records.length &&
      purchaseOrder.documents.length === purchaseOrder.records.length;

    return {
      passed: checks.every(Boolean) && sourceUnchanged && highWaterUnchanged && countsMatch && invalidIssueCount === 0,
      documentPayloadsMatch: checks.every(Boolean),
      sourceLocalStorageUnchanged: sourceUnchanged,
      highWaterKeysUnchanged: highWaterUnchanged,
      countsMatch,
      invalidIssueCount
    };
  }

  async function runCopyOnlyMigration(database, deviceId){
    const existingState = await getMeta(database, MIGRATION_META_KEY);
    if(existingState?.status === "complete" && existingState.verificationResult?.passed){
      return existingState;
    }

    const startedAt = existingState?.startedAt || Date.now();
    await putMeta(database, {
      ...existingState,
      key: MIGRATION_META_KEY,
      migrationId: MIGRATION_ID,
      status: "running",
      startedAt,
      completedAt: null,
      lastError: null,
      updatedAt: Date.now()
    });

    try{
      const highWaterSnapshots = ["gst_last_qno", "gst_last_pono"].map(key => ({
        key,
        value: localStorage.getItem(key)
      }));
      const sources = SOURCES.map(readSource);
      const sourceChecksums = {};
      const plans = [];
      for(const source of sources){
        sourceChecksums[source.localStorageKey] = await sha256(source.raw === null ? "<missing>" : source.raw);
        plans.push({ ...source, ...(await buildDocuments(source, deviceId)) });
      }

      for(const plan of plans){
        await copyDocuments(database, plan.documents);
      }

      const verificationResult = await verifyDocuments(database, plans, sources, highWaterSnapshots);
      const quotation = plans.find(plan => plan.entityType === "quotation");
      const purchaseOrder = plans.find(plan => plan.entityType === "purchaseOrder");
      const issues = plans.flatMap(plan => plan.issues);
      const state = {
        key: MIGRATION_META_KEY,
        migrationId: MIGRATION_ID,
        status: verificationResult.passed ? "complete" : "error",
        startedAt,
        completedAt: verificationResult.passed ? Date.now() : null,
        quotationSourceCount: quotation.records.length,
        quotationMigratedCount: quotation.documents.length,
        poSourceCount: purchaseOrder.records.length,
        poMigratedCount: purchaseOrder.documents.length,
        sourceChecksums,
        issues,
        verificationResult,
        lastError: verificationResult.passed ? null : "Copy verification did not pass",
        updatedAt: Date.now()
      };
      await putMeta(database, state);
      if(issues.length){
        console.warn("V2 copy-only migration completed with reported legacy record issues:", issues);
      }
      return state;
    }catch(error){
      const state = {
        ...existingState,
        key: MIGRATION_META_KEY,
        migrationId: MIGRATION_ID,
        status: "error",
        startedAt,
        completedAt: null,
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: Date.now()
      };
      await putMeta(database, state).catch(metaError => {
        console.error("Could not record v2 migration error:", metaError);
      });
      throw error;
    }
  }

  async function initialize(){
    const database = await openDatabase();
    const deviceId = await ensureFoundationMeta(database);
    const migration = await runCopyOnlyMigration(database, deviceId);
    return { ok: migration.status === "complete", databaseName: DB_NAME, databaseVersion: DB_VERSION, schemaVersion: SCHEMA_VERSION, deviceId, migration };
  }

  const ready = initialize().catch(error => {
    console.error("V2 persistence foundation initialization failed; the existing app remains active:", error);
    return {
      ok: false,
      databaseName: DB_NAME,
      databaseVersion: DB_VERSION,
      schemaVersion: SCHEMA_VERSION,
      error: error instanceof Error ? error.message : String(error)
    };
  });

  window.vstdPersistenceV2 = Object.freeze({
    databaseName: DB_NAME,
    databaseVersion: DB_VERSION,
    schemaVersion: SCHEMA_VERSION,
    migrationId: MIGRATION_ID,
    ready,
    getDiagnostics: () => ready
  });
})();

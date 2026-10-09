(function(){
  "use strict";

  const PRODUCTION_DB_NAME = "vstd-gst-calculator";
  const testConfig = window.__VSTD_PERSISTENCE_V2_TEST_CONFIG__;
  const isTestMode = Boolean(testConfig?.enabled);
  if(isTestMode && !String(testConfig.databaseName || "").startsWith("vstd-gst-calculator-test-")){
    throw new Error("Persistence tests require a disposable test database name");
  }

  const DB_NAME = isTestMode ? testConfig.databaseName : PRODUCTION_DB_NAME;
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
  const ENTITY_TYPES = new Set(["quotation", "purchaseOrder"]);
  const storage = isTestMode && testConfig.storage ? testConfig.storage : window.localStorage;
  const testHooks = isTestMode ? (testConfig.hooks || {}) : {};
  let databasePromise = null;

  class PersistenceError extends Error {
    constructor(code, message, options = {}){
      super(message);
      this.name = "PersistenceError";
      this.code = code;
      if(options.cause) this.cause = options.cause;
      if(options.details) this.details = options.details;
    }
  }

  function persistenceError(error, fallbackCode, fallbackMessage, details){
    if(error instanceof PersistenceError) return error;
    const name = error?.name || "";
    let code = fallbackCode;
    if(name === "QuotaExceededError") code = "QUOTA_EXCEEDED";
    if(name === "VersionError") code = "DATABASE_VERSION_MISMATCH";
    return new PersistenceError(
      code,
      error?.message || fallbackMessage,
      { cause: error, details }
    );
  }

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
    if(!window.indexedDB){
      return Promise.reject(new PersistenceError(
        "INDEXEDDB_UNAVAILABLE",
        "IndexedDB is unavailable in this browser context"
      ));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

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

      request.onsuccess = () => {
        if(settled){
          request.result.close();
          return;
        }
        settled = true;
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => {
        if(settled) return;
        settled = true;
        reject(persistenceError(
          request.error,
          "DATABASE_OPEN_FAILED",
          "Could not open the persistence database"
        ));
      };
      request.onblocked = () => {
        if(settled) return;
        settled = true;
        reject(new PersistenceError(
          "DATABASE_BLOCKED",
          "IndexedDB upgrade is blocked by another open page"
        ));
      };
    });
  }

  function getDatabaseConnection(){
    if(!databasePromise) databasePromise = openDatabase();
    return databasePromise;
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
    const raw = storage.getItem(source.localStorageKey);
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
      storage.getItem(snapshot.localStorageKey) === snapshot.raw
    );
    const highWaterUnchanged = highWaterSnapshots.every(snapshot =>
      storage.getItem(snapshot.key) === snapshot.value
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
        value: storage.getItem(key)
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

  function validateEntityType(entityType){
    if(!ENTITY_TYPES.has(entityType)){
      throw new PersistenceError(
        "INVALID_ENTITY_TYPE",
        `Unsupported document entity type: ${entityType}`
      );
    }
    return entityType;
  }

  function validateBusinessNumber(value){
    const number = Number(value);
    if(!Number.isSafeInteger(number) || number <= 0){
      throw new PersistenceError(
        "INVALID_BUSINESS_NUMBER",
        "Business number must be a positive safe integer"
      );
    }
    return number;
  }

  function validateRecordId(value){
    const recordId = String(value || "").trim();
    if(!recordId || recordId.length > 240){
      throw new PersistenceError(
        "INVALID_RECORD_ID",
        "recordId must be a non-empty string no longer than 240 characters"
      );
    }
    return recordId;
  }

  function createRecordId(entityType){
    return `document:${entityType}:${createDeviceId()}`;
  }

  function validatePayload(payload){
    if(!payload || typeof payload !== "object" || Array.isArray(payload)){
      throw new PersistenceError("INVALID_PAYLOAD", "Document payload must be an object");
    }
    return payload;
  }

  function validateTimestamp(value, fallback){
    if(value === undefined || value === null) return fallback;
    const timestamp = Number(value);
    if(!Number.isFinite(timestamp) || timestamp < 0){
      throw new PersistenceError("INVALID_TIMESTAMP", "Timestamp must be a non-negative finite number");
    }
    return timestamp;
  }

  function operationMatches(existing, intended){
    if(!existing) return false;
    return existing.operationId === intended.operationId &&
      existing.recordId === intended.recordId &&
      existing.entityType === intended.entityType &&
      Number(existing.businessNumber) === Number(intended.businessNumber) &&
      existing.operation === intended.operation &&
      Number(existing.revision) === Number(intended.revision) &&
      Number(existing.baseRevision) === Number(intended.baseRevision) &&
      existing.deviceId === intended.deviceId;
  }

  function documentMatchesIntent(existing, intended){
    if(!existing) return false;
    return existing.recordId === intended.recordId &&
      existing.entityType === intended.entityType &&
      Number(existing.businessNumber) === Number(intended.businessNumber) &&
      Number(existing.revision) === Number(intended.revision) &&
      Number(existing.baseRevision) === Number(intended.baseRevision) &&
      Boolean(existing.deleted) === Boolean(intended.deleted) &&
      stableStringify(existing.payload) === stableStringify(intended.payload);
  }

  async function requireReady(){
    if(testHooks.forceIndexedDBUnavailable){
      throw new PersistenceError("INDEXEDDB_UNAVAILABLE", "IndexedDB is unavailable in this browser context");
    }
    if(testHooks.forceMigrationIncomplete){
      throw new PersistenceError("MIGRATION_INCOMPLETE", "The legacy copy migration has not completed successfully");
    }
    if(testHooks.forceVersionMismatch){
      throw new PersistenceError("DATABASE_VERSION_MISMATCH", "The IndexedDB version is incompatible");
    }
    const state = await ready;
    if(!state?.ok){
      const migrationIncomplete = state?.migration && state.migration.status !== "complete";
      throw new PersistenceError(
        migrationIncomplete ? "MIGRATION_INCOMPLETE" : (state?.errorCode || "PERSISTENCE_NOT_READY"),
        migrationIncomplete
          ? "The legacy copy migration has not completed successfully"
          : (state?.error || "IndexedDB persistence is not ready"),
        { details: state }
      );
    }
    return {
      database: await getDatabaseConnection(),
      deviceId: state.deviceId,
      state
    };
  }

  function invokeWriteHook(storeName, value){
    if(typeof testHooks.beforeStoreWrite === "function"){
      testHooks.beforeStoreWrite(storeName, value);
    }
  }

  async function commitDocumentWithOutbox(options = {}){
    const mode = options.mode || (options.expectedRevision === undefined ? "create" : "update");
    if(mode !== "create" && mode !== "update"){
      throw new PersistenceError("INVALID_OPTIONS", "Commit mode must be create or update");
    }

    const entityType = validateEntityType(options.entityType);
    const businessNumber = validateBusinessNumber(options.businessNumber);
    const payload = validatePayload(options.payload);
    const recordId = validateRecordId(options.recordId || createRecordId(entityType));
    const expectedRevision = mode === "update" ? Number(options.expectedRevision) : 0;
    if(mode === "update" && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)){
      throw new PersistenceError(
        "INVALID_REVISION",
        "Updates require a positive expectedRevision"
      );
    }

    const now = Date.now();
    const updatedAt = validateTimestamp(options.updatedAt, now);
    const deleted = Boolean(options.deleted);
    const operation = deleted ? "delete" : "upsert";
    const { database, deviceId } = await requireReady();

    return new Promise((resolve, reject) => {
      let failure = null;
      let outcome = null;
      const transaction = database.transaction(["documents", "outbox", "meta"], "readwrite");
      if(typeof testHooks.onTransactionCreated === "function"){
        testHooks.onTransactionCreated(transaction);
      }
      const documents = transaction.objectStore("documents");
      const outbox = transaction.objectStore("outbox");
      const meta = transaction.objectStore("meta");
      const currentRequest = documents.get(recordId);
      const conflictsRequest = documents.index("businessNumber").getAll(businessNumber);
      const numberMetaKey = `number:${entityType}`;
      const numberRequest = meta.get(numberMetaKey);
      let currentResult;
      let conflictResults;
      let numberResult;
      let completedReads = 0;

      function fail(error){
        if(failure) return;
        failure = error instanceof PersistenceError
          ? error
          : persistenceError(error, "TRANSACTION_ABORTED", "Document transaction failed");
        try{
          transaction.abort();
        }catch{}
      }

      function readFailed(request, category, message){
        if(!failure) failure = persistenceError(request.error, category, message);
      }

      function writeFailed(request, category, message, storeName){
        if(!failure) failure = persistenceError(request.error, category, message, { storeName });
      }

      function stageWrites(document, pendingOperation, highWater, currentNumberMeta){
        try{
          invokeWriteHook("documents", document);
        }catch(error){
          fail(persistenceError(error, "DOCUMENT_WRITE_FAILED", "Could not stage the document write"));
          return;
        }

        let documentWrite;
        try{
          documentWrite = mode === "create" ? documents.add(document) : documents.put(document);
          documentWrite.onerror = () => writeFailed(
            documentWrite,
            "DOCUMENT_WRITE_FAILED",
            "Could not write the document",
            "documents"
          );
        }catch(error){
          fail(persistenceError(error, "DOCUMENT_WRITE_FAILED", "Could not write the document"));
          return;
        }

        try{
          invokeWriteHook("outbox", pendingOperation);
        }catch(error){
          fail(persistenceError(error, "OUTBOX_WRITE_FAILED", "Could not stage the pending operation"));
          return;
        }

        let outboxWrite;
        try{
          outboxWrite = outbox.add(pendingOperation);
          outboxWrite.onerror = () => writeFailed(
            outboxWrite,
            "OUTBOX_WRITE_FAILED",
            "Could not write the pending operation",
            "outbox"
          );
        }catch(error){
          fail(persistenceError(error, "OUTBOX_WRITE_FAILED", "Could not write the pending operation"));
          return;
        }

        const numberMeta = {
          ...(currentNumberMeta || {}),
          key: numberMetaKey,
          value: highWater,
          updatedAt
        };
        try{
          invokeWriteHook("meta", numberMeta);
        }catch(error){
          fail(persistenceError(error, "METADATA_WRITE_FAILED", "Could not stage numbering metadata"));
          return;
        }

        let metaWrite;
        try{
          metaWrite = meta.put(numberMeta);
          metaWrite.onerror = () => writeFailed(
            metaWrite,
            "METADATA_WRITE_FAILED",
            "Could not update numbering metadata",
            "meta"
          );
        }catch(error){
          fail(persistenceError(error, "METADATA_WRITE_FAILED", "Could not update numbering metadata"));
          return;
        }

        try{
          outcome = {
            ok: true,
            committed: true,
            idempotent: false,
            document,
            operation: pendingOperation,
            highWater
          };
          if(typeof testHooks.afterWrites === "function"){
            testHooks.afterWrites(transaction);
          }
        }catch(error){
          fail(persistenceError(
            error,
            "TRANSACTION_ABORTED",
            "Could not stage the atomic document transaction"
          ));
        }
      }

      function prepareCommit(){
        const current = currentResult || null;
        const conflictingDocuments = (conflictResults || []).filter(document =>
          document.recordId !== recordId &&
          document.entityType === entityType
        );
        if(conflictingDocuments.length){
          fail(new PersistenceError(
            "BUSINESS_NUMBER_CONFLICT",
            `${entityType} number ${businessNumber} already belongs to another local record`,
            { details: { recordIds: conflictingDocuments.map(document => document.recordId) } }
          ));
          return;
        }

        let intendedDocument;
        let normalWrite = true;
        let duplicateCode = null;
        if(mode === "create"){
          intendedDocument = {
            recordId,
            entityType,
            businessNumber,
            schemaVersion: SCHEMA_VERSION,
            revision: 1,
            baseRevision: 0,
            createdAt: validateTimestamp(options.createdAt, updatedAt),
            updatedAt,
            createdOnDevice: deviceId,
            updatedOnDevice: deviceId,
            deleted,
            payload
          };
          if(current){
            normalWrite = false;
            duplicateCode = "DUPLICATE_RECORD";
          }
        }else{
          if(!current){
            fail(new PersistenceError("DOCUMENT_NOT_FOUND", `Document ${recordId} does not exist`));
            return;
          }
          if(current.entityType !== entityType){
            fail(new PersistenceError("INVALID_ENTITY_TYPE", "An update cannot change document entity type"));
            return;
          }
          const targetRevision = expectedRevision + 1;
          intendedDocument = {
            ...current,
            recordId,
            entityType,
            businessNumber,
            schemaVersion: SCHEMA_VERSION,
            revision: targetRevision,
            baseRevision: expectedRevision,
            createdAt: Number(current.createdAt) || 0,
            updatedAt,
            createdOnDevice: current.createdOnDevice || deviceId,
            updatedOnDevice: deviceId,
            deleted,
            payload
          };
          if(Number(current.revision) !== expectedRevision){
            normalWrite = false;
            duplicateCode = "STALE_REVISION";
          }
        }

        const operationId = validateRecordId(
          options.operationId || `${recordId}:${intendedDocument.revision}:${operation}`
        );
        const pendingOperation = {
          operationId,
          recordId,
          entityType,
          businessNumber,
          operation,
          revision: intendedDocument.revision,
          baseRevision: intendedDocument.baseRevision,
          deviceId,
          status: "pending",
          attempts: 0,
          createdAt: updatedAt,
          nextAttemptAt: updatedAt,
          lastAttemptAt: null,
          lastError: null
        };

        const operationRequest = outbox.get(operationId);
        operationRequest.onerror = () => {
          readFailed(operationRequest, "OUTBOX_READ_FAILED", "Could not inspect the pending operation");
        };
        operationRequest.onsuccess = () => {
          const existingOperation = operationRequest.result || null;
          if(!normalWrite){
            if(documentMatchesIntent(current, intendedDocument) &&
              operationMatches(existingOperation, pendingOperation)){
              outcome = {
                ok: true,
                committed: false,
                idempotent: true,
                document: current,
                operation: existingOperation,
                highWater: Math.max(Number(numberResult?.value) || 0, businessNumber)
              };
              return;
            }
            fail(new PersistenceError(
              duplicateCode,
              duplicateCode === "DUPLICATE_RECORD"
                ? `Document ${recordId} already exists`
                : `Document ${recordId} has changed since revision ${expectedRevision}`,
              { details: { currentRevision: Number(current?.revision) || 0, expectedRevision } }
            ));
            return;
          }

          if(existingOperation){
            fail(new PersistenceError(
              "OPERATION_CONFLICT",
              `Operation ${operationId} already exists with conflicting content`
            ));
            return;
          }

          const highWater = Math.max(Number(numberResult?.value) || 0, businessNumber);
          stageWrites(intendedDocument, pendingOperation, highWater, numberResult);
        };
      }

      function readCompleted(){
        completedReads += 1;
        if(completedReads === 3 && !failure) prepareCommit();
      }

      currentRequest.onsuccess = () => {
        currentResult = currentRequest.result;
        readCompleted();
      };
      currentRequest.onerror = () => readFailed(
        currentRequest,
        "DOCUMENT_READ_FAILED",
        "Could not inspect the current document"
      );
      conflictsRequest.onsuccess = () => {
        conflictResults = conflictsRequest.result;
        readCompleted();
      };
      conflictsRequest.onerror = () => readFailed(
        conflictsRequest,
        "DOCUMENT_READ_FAILED",
        "Could not inspect documents using this business number"
      );
      numberRequest.onsuccess = () => {
        numberResult = numberRequest.result;
        readCompleted();
      };
      numberRequest.onerror = () => readFailed(
        numberRequest,
        "METADATA_READ_FAILED",
        "Could not inspect numbering metadata"
      );

      transaction.oncomplete = () => {
        if(!outcome){
          reject(new PersistenceError("TRANSACTION_ABORTED", "Transaction completed without a result"));
          return;
        }
        resolve(outcome);
      };
      transaction.onerror = () => {
        if(!failure){
          failure = persistenceError(
            transaction.error,
            "TRANSACTION_ABORTED",
            "Atomic document transaction failed"
          );
        }
      };
      transaction.onabort = () => reject(
        failure || persistenceError(
          transaction.error,
          "TRANSACTION_ABORTED",
          "Atomic document transaction was aborted"
        )
      );
    });
  }

  async function getDocument(recordId){
    const id = validateRecordId(recordId);
    const { database } = await requireReady();
    const transaction = database.transaction("documents", "readonly");
    const done = transactionDone(transaction);
    const result = await requestResult(transaction.objectStore("documents").get(id));
    await done;
    return result || null;
  }

  async function listDocuments(entityType, options = {}){
    validateEntityType(entityType);
    const { database } = await requireReady();
    const transaction = database.transaction("documents", "readonly");
    const done = transactionDone(transaction);
    let results = await requestResult(
      transaction.objectStore("documents").index("entityType").getAll(entityType)
    );
    await done;
    if(!options.includeDeleted) results = results.filter(document => !document.deleted);
    results.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
    if(options.order === "asc") results.reverse();
    const limit = Number(options.limit);
    if(Number.isSafeInteger(limit) && limit >= 0) results = results.slice(0, limit);
    return results;
  }

  async function findDocumentsByBusinessNumber(entityType, businessNumber){
    validateEntityType(entityType);
    const number = validateBusinessNumber(businessNumber);
    const { database } = await requireReady();
    const transaction = database.transaction("documents", "readonly");
    const done = transactionDone(transaction);
    const results = await requestResult(
      transaction.objectStore("documents").index("businessNumber").getAll(number)
    );
    await done;
    return results.filter(document => document.entityType === entityType);
  }

  async function listPendingOperations(options = {}){
    const { database } = await requireReady();
    const transaction = database.transaction("outbox", "readonly");
    const done = transactionDone(transaction);
    let results = await requestResult(transaction.objectStore("outbox").getAll());
    await done;
    const statuses = Array.isArray(options.statuses)
      ? new Set(options.statuses)
      : new Set(["pending", "failed"]);
    results = results.filter(operation => statuses.has(operation.status));
    results.sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
    const limit = Number(options.limit);
    if(Number.isSafeInteger(limit) && limit >= 0) results = results.slice(0, limit);
    return results;
  }

  async function updateOperation(operationId, updater){
    const id = validateRecordId(operationId);
    const { database } = await requireReady();
    return new Promise((resolve, reject) => {
      let failure = null;
      let updatedOperation = null;
      const transaction = database.transaction("outbox", "readwrite");
      const store = transaction.objectStore("outbox");
      const request = store.get(id);
      request.onerror = () => {
        failure = persistenceError(request.error, "OUTBOX_READ_FAILED", "Could not read the outbox operation");
      };
      request.onsuccess = () => {
        if(!request.result){
          failure = new PersistenceError("OPERATION_NOT_FOUND", `Operation ${id} does not exist`);
          transaction.abort();
          return;
        }
        try{
          updatedOperation = updater({ ...request.result });
          store.put(updatedOperation);
        }catch(error){
          failure = persistenceError(error, "OUTBOX_WRITE_FAILED", "Could not update the outbox operation");
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(updatedOperation);
      transaction.onerror = () => {
        if(!failure){
          failure = persistenceError(transaction.error, "OUTBOX_WRITE_FAILED", "Could not update the outbox operation");
        }
      };
      transaction.onabort = () => reject(failure || new PersistenceError(
        "TRANSACTION_ABORTED",
        "Outbox transaction was aborted"
      ));
    });
  }

  function markOperationAttempt(operationId, options = {}){
    const attemptedAt = validateTimestamp(options.attemptedAt, Date.now());
    const nextAttemptAt = validateTimestamp(options.nextAttemptAt, attemptedAt);
    return updateOperation(operationId, operation => ({
      ...operation,
      status: "pending",
      attempts: (Number(operation.attempts) || 0) + 1,
      lastAttemptAt: attemptedAt,
      nextAttemptAt
    }));
  }

  function markOperationComplete(operationId, options = {}){
    const completedAt = validateTimestamp(options.completedAt, Date.now());
    return updateOperation(operationId, operation => ({
      ...operation,
      status: "complete",
      completedAt,
      lastError: null
    }));
  }

  function markOperationFailed(operationId, error, options = {}){
    const failedAt = validateTimestamp(options.failedAt, Date.now());
    const nextAttemptAt = validateTimestamp(options.nextAttemptAt, failedAt);
    return updateOperation(operationId, operation => ({
      ...operation,
      status: "failed",
      failedAt,
      nextAttemptAt,
      lastError: error instanceof Error ? error.message : String(error || "Unknown synchronization error")
    }));
  }

  async function initialize(){
    const database = await getDatabaseConnection();
    const deviceId = await ensureFoundationMeta(database);
    let migration;
    try{
      migration = await runCopyOnlyMigration(database, deviceId);
    }catch(error){
      throw persistenceError(
        error,
        "MIGRATION_INCOMPLETE",
        "The legacy copy migration did not complete"
      );
    }
    return { ok: migration.status === "complete", databaseName: DB_NAME, databaseVersion: DB_VERSION, schemaVersion: SCHEMA_VERSION, deviceId, migration };
  }

  const ready = initialize().catch(error => {
    console.error("V2 persistence foundation initialization failed; the existing app remains active:", error);
    return {
      ok: false,
      databaseName: DB_NAME,
      databaseVersion: DB_VERSION,
      schemaVersion: SCHEMA_VERSION,
      errorCode: error?.code || "PERSISTENCE_INITIALIZATION_FAILED",
      error: error instanceof Error ? error.message : String(error)
    };
  });

  const publicApi = {
    databaseName: DB_NAME,
    databaseVersion: DB_VERSION,
    schemaVersion: SCHEMA_VERSION,
    migrationId: MIGRATION_ID,
    ready,
    getDiagnostics: () => ready,
    commitDocumentWithOutbox,
    getDocument,
    listDocuments,
    findDocumentsByBusinessNumber,
    listPendingOperations,
    markOperationAttempt,
    markOperationComplete,
    markOperationFailed
  };

  if(isTestMode){
    publicApi.closeDisposableDatabase = async () => {
      const database = await databasePromise?.catch(() => null);
      database?.close();
      databasePromise = null;
    };
  }

  window.vstdPersistenceV2 = Object.freeze(publicApi);
})();

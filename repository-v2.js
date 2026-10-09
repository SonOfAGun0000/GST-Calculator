(function(){
  "use strict";

  const BACKUP_FORMAT = "vstd-gst-calculator-backup";
  const BACKUP_VERSION = 2;
  const ENTITY_CONFIG = Object.freeze({
    quotation: Object.freeze({
      localStorageKey: "gst_quotes_history",
      localCounterKey: "gst_last_qno",
      legacyPrefix: "legacy:quotation"
    }),
    purchaseOrder: Object.freeze({
      localStorageKey: "gst_purchase_orders_history",
      localCounterKey: "gst_last_pono",
      legacyPrefix: "legacy:po"
    })
  });
  const testConfig = window.__VSTD_REPOSITORY_V2_TEST_CONFIG__;
  const testMode = Boolean(testConfig?.enabled);

  function repositoryError(code, message, cause){
    const error = new Error(message);
    error.name = "RepositoryError";
    error.code = code;
    if(cause) error.cause = cause;
    return error;
  }

  function validateEntityType(entityType){
    if(!Object.prototype.hasOwnProperty.call(ENTITY_CONFIG, entityType)){
      throw repositoryError("INVALID_ENTITY_TYPE", `Unsupported document entity type: ${entityType}`);
    }
    return entityType;
  }

  function validateBusinessNumber(value){
    const number = Number(value);
    if(!Number.isSafeInteger(number) || number <= 0){
      throw repositoryError("INVALID_BUSINESS_NUMBER", "Business number must be a positive safe integer");
    }
    return number;
  }

  function stableStringify(value){
    if(value === null || typeof value !== "object") return JSON.stringify(value);
    if(Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  function payloadsEqual(left, right){
    return stableStringify(left) === stableStringify(right);
  }

  function projectionHash(value){
    const text = stableStringify(value);
    let hash = 2166136261;
    for(let index = 0; index < text.length; index += 1){
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function issueFromError(error, fallbackCode, source){
    return {
      code: error?.code || fallbackCode,
      source,
      message: error instanceof Error ? error.message : String(error)
    };
  }

  function createRepository(dependencies){
    const persistence = dependencies.persistence;
    const storage = dependencies.storage;

    function readStorageValue(key){
      try{
        return { ok: true, value: storage.getItem(key) };
      }catch(error){
        return {
          ok: false,
          value: null,
          issue: issueFromError(error, "LOCAL_STORAGE_UNAVAILABLE", `localStorage:${key}`)
        };
      }
    }

    function readLegacyRecords(entityType){
      const config = ENTITY_CONFIG[entityType];
      const result = readStorageValue(config.localStorageKey);
      if(!result.ok){
        return { records: [], raw: null, issues: [result.issue], complete: false };
      }
      if(result.value === null){
        return { records: [], raw: null, issues: [], complete: true };
      }
      try{
        const parsed = JSON.parse(result.value);
        if(!Array.isArray(parsed)){
          throw repositoryError("INVALID_LEGACY_STORAGE", `${config.localStorageKey} must contain an array`);
        }
        const records = [];
        const issues = [];
        parsed.forEach((payload, sourceIndex) => {
          const businessNumber = Number(payload?.qno);
          if(!payload || typeof payload !== "object" || Array.isArray(payload) ||
            !Number.isSafeInteger(businessNumber) || businessNumber <= 0){
            issues.push({
              code: "INVALID_LEGACY_RECORD",
              source: `localStorage:${config.localStorageKey}`,
              sourceIndex,
              message: "Legacy record does not contain a valid positive qno"
            });
            return;
          }
          records.push({ payload, businessNumber, sourceIndex });
        });
        return {
          records,
          raw: result.value,
          issues,
          complete: issues.length === 0
        };
      }catch(error){
        return {
          records: [],
          raw: result.value,
          issues: [issueFromError(error, "CORRUPT_LEGACY_STORAGE", `localStorage:${config.localStorageKey}`)],
          complete: false
        };
      }
    }

    async function readIndexedDocuments(entityType){
      try{
        if(!persistence || typeof persistence.listDocuments !== "function"){
          throw repositoryError("INDEXEDDB_UNAVAILABLE", "IndexedDB persistence API is unavailable");
        }
        const records = await persistence.listDocuments(entityType, { includeDeleted: true });
        return { records, issues: [], complete: true };
      }catch(error){
        return {
          records: [],
          issues: [issueFromError(error, "INDEXEDDB_READ_FAILED", "indexedDB:documents")],
          complete: false
        };
      }
    }

    function toDocumentEntry(document, payload, sources, projectionChanged){
      return {
        recordId: document.recordId,
        entityType: document.entityType,
        businessNumber: Number(document.businessNumber),
        schemaVersion: Number(document.schemaVersion) || 2,
        revision: Number(document.revision) || 1,
        baseRevision: Number(document.baseRevision) || 0,
        createdAt: Number(document.createdAt) || 0,
        updatedAt: Number(document.updatedAt) || 0,
        createdOnDevice: document.createdOnDevice || null,
        updatedOnDevice: document.updatedOnDevice || null,
        deleted: Boolean(document.deleted),
        payload,
        metadata: {
          sources,
          migratedLegacy: document.source === "legacy-localStorage",
          projectionChanged: Boolean(projectionChanged),
          persistedPayload: document.payload
        }
      };
    }

    function synthesizeLegacyEntry(entityType, legacy, occurrence, usedIds){
      const config = ENTITY_CONFIG[entityType];
      const baseId = `${config.legacyPrefix}:${legacy.businessNumber}`;
      let recordId = occurrence === 1
        ? baseId
        : `${baseId}:projection:${projectionHash(legacy.payload)}:${occurrence}`;
      let suffix = occurrence;
      while(usedIds.has(recordId)){
        suffix += 1;
        recordId = `${baseId}:projection:${projectionHash(legacy.payload)}:${suffix}`;
      }
      usedIds.add(recordId);
      return {
        recordId,
        entityType,
        businessNumber: legacy.businessNumber,
        schemaVersion: 1,
        revision: 0,
        baseRevision: 0,
        createdAt: Number(legacy.payload.savedAt) || 0,
        updatedAt: Number(legacy.payload.savedAt) || 0,
        createdOnDevice: null,
        updatedOnDevice: null,
        deleted: false,
        payload: legacy.payload,
        metadata: {
          sources: ["localStorage"],
          migratedLegacy: false,
          projectionOnly: true,
          sourceIndex: legacy.sourceIndex
        }
      };
    }

    function mergeCompatibilityView(entityType, legacyRecords, indexedDocuments){
      const usedDocumentIds = new Set();
      const matchedLegacyIndexes = new Set();
      const usedIds = new Set(indexedDocuments.map(document => document.recordId));
      const entries = [];
      const localGroups = new Map();
      const migratedGroups = new Map();

      legacyRecords.forEach(record => {
        const group = localGroups.get(record.businessNumber) || [];
        group.push(record);
        localGroups.set(record.businessNumber, group);
      });
      indexedDocuments.forEach(document => {
        if(document.source !== "legacy-localStorage" || Number(document.revision) !== 1) return;
        const number = Number(document.businessNumber);
        const group = migratedGroups.get(number) || [];
        group.push(document);
        migratedGroups.set(number, group);
      });

      legacyRecords.forEach(legacy => {
        const candidates = (migratedGroups.get(legacy.businessNumber) || [])
          .filter(document => !usedDocumentIds.has(document.recordId));
        let match = candidates.find(document => payloadsEqual(document.payload, legacy.payload));
        const localGroup = localGroups.get(legacy.businessNumber) || [];
        const allMigrated = migratedGroups.get(legacy.businessNumber) || [];
        if(!match && localGroup.length === 1 && allMigrated.length === 1 &&
          !usedDocumentIds.has(allMigrated[0].recordId)){
          match = allMigrated[0];
        }
        if(match){
          usedDocumentIds.add(match.recordId);
          matchedLegacyIndexes.add(legacy.sourceIndex);
          entries.push(toDocumentEntry(
            match,
            legacy.payload,
            ["indexedDB", "localStorage"],
            !payloadsEqual(match.payload, legacy.payload)
          ));
        }
      });

      const localOccurrences = new Map();
      legacyRecords.forEach(legacy => {
        if(matchedLegacyIndexes.has(legacy.sourceIndex)) return;
        const occurrence = (localOccurrences.get(legacy.businessNumber) || 0) + 1;
        localOccurrences.set(legacy.businessNumber, occurrence);
        entries.push(synthesizeLegacyEntry(entityType, legacy, occurrence, usedIds));
      });

      indexedDocuments.forEach(document => {
        if(usedDocumentIds.has(document.recordId)) return;
        entries.push(toDocumentEntry(document, document.payload, ["indexedDB"], false));
      });

      const byNumber = new Map();
      entries.forEach(entry => {
        const group = byNumber.get(entry.businessNumber) || [];
        group.push(entry);
        byNumber.set(entry.businessNumber, group);
      });
      const conflicts = [];
      byNumber.forEach((group, businessNumber) => {
        const distinctIds = [...new Set(group.map(entry => entry.recordId))];
        if(distinctIds.length < 2) return;
        conflicts.push({
          code: "BUSINESS_NUMBER_IDENTITY_CONFLICT",
          entityType,
          businessNumber,
          recordIds: distinctIds
        });
        group.forEach(entry => {
          entry.metadata.businessNumberConflict = true;
        });
      });
      return { entries, conflicts };
    }

    async function listHistory(entityType, options = {}){
      const type = validateEntityType(entityType);
      const [legacy, indexed] = await Promise.all([
        Promise.resolve(readLegacyRecords(type)),
        readIndexedDocuments(type)
      ]);
      const merged = mergeCompatibilityView(type, legacy.records, indexed.records);
      let records = options.includeDeleted
        ? merged.entries
        : merged.entries.filter(entry => !entry.deleted);
      records.sort((left, right) => {
        const result = left.businessNumber - right.businessNumber ||
          left.recordId.localeCompare(right.recordId);
        return options.order === "asc" ? result : -result;
      });
      const limit = Number(options.limit);
      if(Number.isSafeInteger(limit) && limit >= 0) records = records.slice(0, limit);
      return {
        entityType: type,
        records,
        conflicts: merged.conflicts,
        issues: [...legacy.issues, ...indexed.issues],
        complete: legacy.complete && indexed.complete,
        sources: {
          localStorage: legacy.complete,
          indexedDB: indexed.complete
        }
      };
    }

    async function getDocument(recordId, options = {}){
      const id = String(recordId || "").trim();
      if(!id) throw repositoryError("INVALID_RECORD_ID", "recordId is required");
      const entityTypes = options.entityType
        ? [validateEntityType(options.entityType)]
        : Object.keys(ENTITY_CONFIG);
      const results = await Promise.all(entityTypes.map(type => listHistory(type, { includeDeleted: true })));
      for(const result of results){
        const record = result.records.find(entry => entry.recordId === id);
        if(record){
          return {
            record,
            conflicts: result.conflicts.filter(conflict => conflict.recordIds.includes(id)),
            issues: result.issues,
            complete: result.complete
          };
        }
      }
      return {
        record: null,
        conflicts: [],
        issues: results.flatMap(result => result.issues),
        complete: results.every(result => result.complete)
      };
    }

    async function findByBusinessNumber(entityType, businessNumber, options = {}){
      const type = validateEntityType(entityType);
      const number = validateBusinessNumber(businessNumber);
      const history = await listHistory(type, { includeDeleted: Boolean(options.includeDeleted) });
      return {
        entityType: type,
        businessNumber: number,
        records: history.records.filter(record => record.businessNumber === number),
        conflicts: history.conflicts.filter(conflict => conflict.businessNumber === number),
        issues: history.issues,
        complete: history.complete
      };
    }

    function readLocalHighWater(entityType){
      const result = readStorageValue(ENTITY_CONFIG[entityType].localCounterKey);
      if(!result.ok) return { value: 0, issues: [result.issue], complete: false };
      const value = Number(result.value);
      return {
        value: Number.isSafeInteger(value) && value > 0 ? value : 0,
        issues: [],
        complete: true
      };
    }

    async function readIndexedHighWater(entityType){
      try{
        if(!persistence || typeof persistence.getNumberHighWater !== "function"){
          throw repositoryError("INDEXEDDB_UNAVAILABLE", "IndexedDB numbering metadata is unavailable");
        }
        return { value: await persistence.getNumberHighWater(entityType), issues: [], complete: true };
      }catch(error){
        return {
          value: 0,
          issues: [issueFromError(error, "INDEXEDDB_READ_FAILED", "indexedDB:meta")],
          complete: false
        };
      }
    }

    async function getNextNumberFloor(entityType){
      const type = validateEntityType(entityType);
      const [history, local, indexed] = await Promise.all([
        listHistory(type, { includeDeleted: true }),
        Promise.resolve(readLocalHighWater(type)),
        readIndexedHighWater(type)
      ]);
      const documentMaximum = history.records.reduce(
        (maximum, record) => Math.max(maximum, record.businessNumber),
        0
      );
      const highWater = Math.max(local.value, indexed.value, documentMaximum);
      return {
        entityType: type,
        localStorageHighWater: local.value,
        indexedDBHighWater: indexed.value,
        documentMaximum,
        highWater,
        nextNumberFloor: highWater + 1,
        crossDeviceUnique: false,
        issues: [...history.issues, ...local.issues, ...indexed.issues],
        complete: history.complete && local.complete && indexed.complete
      };
    }

    function parseBackup(input, options = {}){
      let value = input;
      if(typeof value === "string"){
        try{
          value = JSON.parse(value);
        }catch(error){
          throw repositoryError("CORRUPT_BACKUP", "Backup is not valid JSON", error);
        }
      }
      if(Array.isArray(value)){
        const entityType = validateEntityType(options.entityType);
        const invalidIndexes = [];
        value.forEach((record, index) => {
          try{
            validateBusinessNumber(record?.qno);
          }catch{
            invalidIndexes.push(index);
          }
        });
        if(invalidIndexes.length){
          throw repositoryError("INVALID_LEGACY_BACKUP", `Legacy backup has invalid records at indexes ${invalidIndexes.join(", ")}`);
        }
        return { format: "legacy-array", version: 1, entityType, records: value };
      }
      if(!value || typeof value !== "object" || value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION){
        throw repositoryError("UNSUPPORTED_BACKUP", "Backup format or version is unsupported");
      }
      if(!Array.isArray(value.documents) || !Array.isArray(value.pendingOperations)){
        throw repositoryError("INVALID_BACKUP", "Version 2 backup must contain documents and pendingOperations arrays");
      }
      const ids = new Set();
      value.documents.forEach((document, index) => {
        if(!document || typeof document !== "object" || !String(document.recordId || "").trim()){
          throw repositoryError("INVALID_BACKUP", `Document ${index} has no recordId`);
        }
        validateEntityType(document.entityType);
        validateBusinessNumber(document.businessNumber);
        if(!Number.isSafeInteger(Number(document.revision)) || Number(document.revision) < 1){
          throw repositoryError("INVALID_BACKUP", `Document ${document.recordId} has an invalid revision`);
        }
        if(ids.has(document.recordId)){
          throw repositoryError("INVALID_BACKUP", `Backup contains duplicate recordId ${document.recordId}`);
        }
        ids.add(document.recordId);
      });
      return value;
    }

    async function inspectBackup(input, options = {}){
      const backup = parseBackup(input, options);
      const conflicts = [];
      if(backup.format === "legacy-array"){
        for(const record of backup.records){
          const current = await findByBusinessNumber(backup.entityType, record.qno, { includeDeleted: true });
          if(current.records.length){
            conflicts.push({
              code: "LEGACY_IMPORT_IDENTITY_AMBIGUOUS",
              entityType: backup.entityType,
              businessNumber: Number(record.qno),
              currentRecordIds: current.records.map(item => item.recordId)
            });
          }
        }
      }else{
        for(const incoming of backup.documents){
          const current = await getDocument(incoming.recordId, { entityType: incoming.entityType });
          if(current.record){
            const incomingRevision = Number(incoming.revision);
            const currentRevision = Number(current.record.revision);
            if(incomingRevision < currentRevision){
              conflicts.push({
                code: "STALE_BACKUP_REVISION",
                recordId: incoming.recordId,
                incomingRevision,
                currentRevision
              });
            }else if(incomingRevision === currentRevision &&
              !payloadsEqual(incoming.payload, current.record.metadata.persistedPayload)){
              conflicts.push({
                code: "EQUAL_REVISION_CONTENT_CONFLICT",
                recordId: incoming.recordId,
                revision: currentRevision
              });
            }
          }
          const sameNumber = await findByBusinessNumber(
            incoming.entityType,
            incoming.businessNumber,
            { includeDeleted: true }
          );
          const otherIds = sameNumber.records
            .map(record => record.recordId)
            .filter(recordId => recordId !== incoming.recordId);
          if(otherIds.length){
            conflicts.push({
              code: "BUSINESS_NUMBER_IDENTITY_CONFLICT",
              entityType: incoming.entityType,
              businessNumber: incoming.businessNumber,
              incomingRecordId: incoming.recordId,
              currentRecordIds: otherIds
            });
          }
        }
      }
      return {
        format: backup.format,
        version: backup.version,
        valid: true,
        conflicts,
        canRestore: false,
        restoreActivated: false
      };
    }

    async function createBackupSnapshot(options = {}){
      const exportedAt = Number(options.exportedAt) || Date.now();
      const issues = [];
      const localStorage = {};
      for(const entityType of Object.keys(ENTITY_CONFIG)){
        const config = ENTITY_CONFIG[entityType];
        const legacy = readLegacyRecords(entityType);
        const counter = readStorageValue(config.localCounterKey);
        localStorage[entityType] = {
          historyKey: config.localStorageKey,
          raw: legacy.raw,
          records: legacy.records.map(record => record.payload),
          counterKey: config.localCounterKey,
          counterRaw: counter.value
        };
        issues.push(...legacy.issues);
        if(!counter.ok) issues.push(counter.issue);
      }

      const documents = [];
      for(const entityType of Object.keys(ENTITY_CONFIG)){
        const result = await readIndexedDocuments(entityType);
        documents.push(...result.records);
        issues.push(...result.issues);
      }

      let pendingOperations = [];
      try{
        if(!persistence || typeof persistence.listPendingOperations !== "function"){
          throw repositoryError("INDEXEDDB_UNAVAILABLE", "IndexedDB outbox is unavailable");
        }
        pendingOperations = await persistence.listPendingOperations({ statuses: ["pending", "failed"] });
      }catch(error){
        issues.push(issueFromError(error, "INDEXEDDB_READ_FAILED", "indexedDB:outbox"));
      }

      const numberHighWater = {};
      for(const entityType of Object.keys(ENTITY_CONFIG)){
        numberHighWater[entityType] = await getNextNumberFloor(entityType);
        issues.push(...numberHighWater[entityType].issues);
      }

      return {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt,
        complete: issues.length === 0,
        restoreActivated: false,
        localStorage,
        documents,
        pendingOperations,
        numberHighWater,
        issues
      };
    }

    return Object.freeze({
      backupFormat: BACKUP_FORMAT,
      backupVersion: BACKUP_VERSION,
      listHistory,
      getDocument,
      findByBusinessNumber,
      getNextNumberFloor,
      createBackupSnapshot,
      inspectBackup
    });
  }

  const productionPersistence = window.vstdPersistenceV2;
  const productionStorage = testMode && testConfig.storage ? testConfig.storage : window.localStorage;
  const repository = createRepository({
    persistence: productionPersistence,
    storage: productionStorage
  });
  if(testMode && !String(productionPersistence?.databaseName || "").startsWith("vstd-gst-calculator-test-")){
    throw new Error("Repository tests require a disposable persistence database name");
  }
  window.vstdRepositoryV2 = Object.freeze(testMode
    ? { ...repository, createTestRepository: dependencies => createRepository(dependencies) }
    : repository);
})();

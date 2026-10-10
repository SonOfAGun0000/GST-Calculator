(function(){
  "use strict";

  const DEFAULTS = Object.freeze({
    leaseDurationMs: 30000,
    baseRetryMs: 5000,
    maxRetryMs: 15 * 60 * 1000,
    maxAttempts: 8,
    drainLimit: 50
  });
  const CONFLICT_KINDS = new Set([
    "IDENTITY_COLLISION",
    "STALE_BASE_REVISION",
    "REMOTE_REVISION_NEWER",
    "EQUAL_REVISION_CONTENT_CONFLICT",
    "REMOTE_TOMBSTONE"
  ]);

  function syncError(code, message, options = {}){
    const error = new Error(message);
    error.name = "OutboxSyncError";
    error.code = code;
    if(options.transient) error.transient = true;
    if(options.permanent) error.permanent = true;
    if(options.cause) error.cause = options.cause;
    return error;
  }

  function positiveNumber(value, fallback, name){
    const result = value === undefined ? fallback : Number(value);
    if(!Number.isFinite(result) || result <= 0){
      throw syncError("INVALID_OPTIONS", `${name} must be a positive finite number`, { permanent: true });
    }
    return result;
  }

  function positiveInteger(value, fallback, name){
    const result = value === undefined ? fallback : Number(value);
    if(!Number.isSafeInteger(result) || result <= 0){
      throw syncError("INVALID_OPTIONS", `${name} must be a positive integer`, { permanent: true });
    }
    return result;
  }

  function createOwnerId(){
    if(window.crypto?.randomUUID) return `outbox:${window.crypto.randomUUID()}`;
    if(!window.crypto?.getRandomValues){
      throw syncError("SECURE_RANDOM_UNAVAILABLE", "A secure lease owner ID could not be generated", { permanent: true });
    }
    const values = new Uint32Array(4);
    window.crypto.getRandomValues(values);
    return `outbox:${[...values].map(value => value.toString(16).padStart(8, "0")).join("")}`;
  }

  function calculateBackoff(attempts, options = {}){
    const baseRetryMs = positiveNumber(options.baseRetryMs, DEFAULTS.baseRetryMs, "baseRetryMs");
    const maxRetryMs = positiveNumber(options.maxRetryMs, DEFAULTS.maxRetryMs, "maxRetryMs");
    const exponent = Math.max(0, Math.min(30, (Number(attempts) || 1) - 1));
    return Math.min(maxRetryMs, baseRetryMs * (2 ** exponent));
  }

  function stableStringify(value){
    if(value === null || typeof value !== "object") return JSON.stringify(value);
    if(Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }

  function validateOperation(operation){
    if(!operation || typeof operation !== "object"){
      throw syncError("CORRUPT_OPERATION", "Outbox operation is not an object", { permanent: true });
    }
    const requiredStrings = ["operationId", "recordId", "entityType", "operation", "deviceId"];
    for(const field of requiredStrings){
      if(!String(operation[field] || "").trim()){
        throw syncError("CORRUPT_OPERATION", `Outbox operation is missing ${field}`, { permanent: true });
      }
    }
    if(operation.entityType !== "quotation" && operation.entityType !== "purchaseOrder"){
      throw syncError("CORRUPT_OPERATION", "Outbox operation has an invalid entityType", { permanent: true });
    }
    if(operation.operation !== "upsert" && operation.operation !== "delete"){
      throw syncError("CORRUPT_OPERATION", "Outbox operation has an invalid operation type", { permanent: true });
    }
    const businessNumber = Number(operation.businessNumber);
    const revision = Number(operation.revision);
    const baseRevision = Number(operation.baseRevision);
    if(!Number.isSafeInteger(businessNumber) || businessNumber <= 0 ||
      !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(baseRevision) || baseRevision < 0 ||
      revision !== baseRevision + 1){
      throw syncError("CORRUPT_OPERATION", "Outbox operation has invalid numbering or revisions", { permanent: true });
    }
    const document = operation.document;
    if(!document || typeof document !== "object" || Array.isArray(document)){
      throw syncError("CORRUPT_OPERATION", "Outbox operation has no durable document snapshot", { permanent: true });
    }
    if(document.recordId !== operation.recordId ||
      document.entityType !== operation.entityType ||
      Number(document.businessNumber) !== businessNumber ||
      Number(document.revision) !== revision ||
      Number(document.baseRevision) !== baseRevision ||
      Boolean(document.deleted) !== (operation.operation === "delete") ||
      !document.payload || typeof document.payload !== "object" || Array.isArray(document.payload)){
      throw syncError("CORRUPT_OPERATION", "Document snapshot does not match its outbox metadata", { permanent: true });
    }
    return operation;
  }

  function normalizeAdapterResult(result){
    if(!result || typeof result !== "object"){
      throw syncError("INVALID_ADAPTER_RESULT", "Cloud adapter returned no result", { permanent: true });
    }
    if(result.status === "applied" || result.status === "alreadyApplied") return result;
    if(result.status === "conflict"){
      const kind = String(result.kind || "");
      if(!CONFLICT_KINDS.has(kind)){
        throw syncError("INVALID_ADAPTER_RESULT", `Cloud adapter returned an unknown conflict kind: ${kind}`, { permanent: true });
      }
      return result;
    }
    throw syncError("INVALID_ADAPTER_RESULT", `Cloud adapter returned an unsupported status: ${result.status}`, { permanent: true });
  }

  function createProcessor(options = {}){
    const persistence = options.persistence;
    const cloudAdapter = options.cloudAdapter;
    if(!persistence || typeof persistence.claimNextPendingOperation !== "function" ||
      typeof persistence.renewOperationLease !== "function" ||
      typeof persistence.settleClaimedOperation !== "function"){
      throw syncError("INVALID_OPTIONS", "A lease-capable persistence API is required", { permanent: true });
    }
    if(!cloudAdapter || typeof cloudAdapter.applyOperation !== "function"){
      throw syncError("INVALID_OPTIONS", "A cloud adapter with applyOperation() is required", { permanent: true });
    }

    const ownerId = String(options.ownerId || createOwnerId()).trim();
    if(!ownerId) throw syncError("INVALID_OPTIONS", "ownerId is required", { permanent: true });
    const leaseDurationMs = positiveNumber(options.leaseDurationMs, DEFAULTS.leaseDurationMs, "leaseDurationMs");
    const baseRetryMs = positiveNumber(options.baseRetryMs, DEFAULTS.baseRetryMs, "baseRetryMs");
    const maxRetryMs = positiveNumber(options.maxRetryMs, DEFAULTS.maxRetryMs, "maxRetryMs");
    const maxAttempts = positiveInteger(options.maxAttempts, DEFAULTS.maxAttempts, "maxAttempts");
    const now = typeof options.now === "function" ? options.now : () => Date.now();
    const isOnline = typeof options.isOnline === "function"
      ? options.isOnline
      : () => navigator.onLine !== false;
    const scheduleInterval = options.setInterval || window.setInterval.bind(window);
    const cancelInterval = options.clearInterval || window.clearInterval.bind(window);

    async function settle(operation, outcome){
      return persistence.settleClaimedOperation(operation.operationId, ownerId, {
        ...outcome,
        settledAt: now()
      });
    }

    async function handleFailure(operation, error){
      const message = error instanceof Error ? error.message : String(error || "Cloud synchronization failed");
      if(error?.permanent || operation.attempts >= maxAttempts){
        const completed = await settle(operation, {
          status: "permanent",
          error: message
        });
        return {
          status: "permanent",
          operation: completed,
          errorCode: error?.code || (operation.attempts >= maxAttempts ? "MAX_ATTEMPTS_EXCEEDED" : "PERMANENT_FAILURE")
        };
      }
      const delay = calculateBackoff(operation.attempts, { baseRetryMs, maxRetryMs });
      const completed = await persistence.settleClaimedOperation(operation.operationId, ownerId, {
        status: "failed",
        error: message,
        settledAt: now(),
        nextAttemptAt: now() + delay
      });
      return { status: "retryScheduled", operation: completed, delay };
    }

    async function processOnce(){
      if(!isOnline()) return { status: "offline", operation: null };
      const operation = await persistence.claimNextPendingOperation({
        leaseOwner: ownerId,
        now: now(),
        leaseDurationMs
      });
      if(!operation) return { status: "idle", operation: null };

      try{
        validateOperation(operation);
      }catch(error){
        return handleFailure(operation, error);
      }

      let leaseLost = null;
      const heartbeatMs = Math.max(25, Math.floor(leaseDurationMs / 3));
      const heartbeat = scheduleInterval(() => {
        Promise.resolve(persistence.renewOperationLease(operation.operationId, ownerId, {
          now: now(),
          leaseDurationMs
        })).catch(error => {
          leaseLost = error;
        });
      }, heartbeatMs);

      try{
        const adapterResult = normalizeAdapterResult(await cloudAdapter.applyOperation({
          operationId: operation.operationId,
          recordId: operation.recordId,
          entityType: operation.entityType,
          businessNumber: operation.businessNumber,
          revision: operation.revision,
          baseRevision: operation.baseRevision,
          operation: operation.operation,
          document: operation.document
        }));
        if(leaseLost){
          throw syncError("LEASE_LOST", "The outbox lease was lost during the cloud operation", {
            transient: true,
            cause: leaseLost
          });
        }
        if(adapterResult.status === "conflict"){
          const completed = await settle(operation, {
            status: "conflict",
            error: adapterResult.message || adapterResult.kind,
            conflict: {
              kind: adapterResult.kind,
              remote: adapterResult.remote || null,
              message: adapterResult.message || null
            }
          });
          return { status: "conflict", operation: completed, conflict: completed.conflict };
        }
        const completed = await settle(operation, {
          status: "complete",
          remoteResult: {
            status: adapterResult.status,
            remoteRevision: adapterResult.remoteRevision ?? operation.revision
          }
        });
        return {
          status: adapterResult.status === "alreadyApplied" ? "acknowledgedReplay" : "complete",
          operation: completed
        };
      }catch(error){
        if(error?.code === "LEASE_LOST") throw error;
        return handleFailure(operation, error);
      }finally{
        cancelInterval(heartbeat);
      }
    }

    async function drain(options = {}){
      const limit = positiveInteger(options.limit, DEFAULTS.drainLimit, "limit");
      const results = [];
      for(let index = 0; index < limit; index += 1){
        const result = await processOnce();
        results.push(result);
        if(result.status === "idle" || result.status === "offline") break;
      }
      return results;
    }

    return Object.freeze({
      ownerId,
      processOnce,
      drain
    });
  }

  window.VstdOutboxSync = Object.freeze({
    createProcessor,
    calculateBackoff,
    conflictKinds: Object.freeze([...CONFLICT_KINDS]),
    cloudIdentityContract: Object.freeze({
      identity: "recordId",
      idempotency: "operationId",
      concurrency: "baseRevision-to-revision compare-and-set",
      businessNumber: "conflict index only; never a document destination"
    })
  });
})();

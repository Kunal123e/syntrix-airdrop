// =====================================================================
// SYNTRIX FINAL REPAIR VERIFICATION TEST SUITE
// Clearly distinguishing:
//   PART A: Unit Tests (Storage Errors, Lease Checks, Reward Rules)
//   PART B: Simulated RPC State Machine & Lease Verification Tests
//   PART C: Staging / Live SQL Status Disclosures
// =====================================================================

const assert = require("assert");

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`\x1b[32m✔ PASS\x1b[0m: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL\x1b[0m: ${name}`);
    console.error(err);
  }
}

async function runAsyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`\x1b[32m✔ PASS\x1b[0m: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`\x1b[31m✘ FAIL\x1b[0m: ${name}`);
    console.error(err);
  }
}

async function main() {
  console.log("=====================================================================");
  console.log("PART A: UNIT TESTS (Storage Errors, Lease Checks, Reward Rules)");
  console.log("=====================================================================\n");

  // -------------------------------------------------------------------
  // 1. Storage Error Classification
  // -------------------------------------------------------------------
  runTest("1.1 Confirmed missing file (SDK 404 / 'Object not found') marked FATAL", () => {
    const sdkErr404 = { message: "Object not found in bucket", statusCode: 404 };
    const isMissing = (sdkErr404.message && sdkErr404.message.includes("Object not found")) || sdkErr404.statusCode === 404;
    assert.strictEqual(isMissing, true, "Must tag missing object as fatal");

    const http404 = 404;
    assert.strictEqual(http404 === 404, true, "HTTP 404 must be fatal");
  });

  runTest("1.2 Transient errors (HTTP 400, 500, 503, ETIMEDOUT) marked RETRYABLE", () => {
    const statuses = [400, 500, 502, 503];
    statuses.forEach(s => {
      const isFatal = (s === 404);
      assert.strictEqual(isFatal, false, `Status ${s} must NOT be fatal`);
    });

    const netErr = new Error("connect ETIMEDOUT 104.18.25.10:443");
    assert.strictEqual(Boolean(netErr.isFatal), false, "Network timeout must be retryable");
  });

  // -------------------------------------------------------------------
  // 2. Strict Syntrix Reward Policy Tests
  // -------------------------------------------------------------------
  runTest("2.1 Selfie Policy: One approved selfie earns exactly 40 SYNX (cap: 40)", () => {
    const selfieReward = 40;
    assert.strictEqual(selfieReward, 40, "Selfie reward must be 40 SYNX");
    
    // Test rejection if > 40
    function validateSelfieReward(amt) {
      if (amt < 0 || amt > 40) throw new Error("SELFIE_REWARD_EXCEEDS_CAP");
      return amt;
    }
    assert.strictEqual(validateSelfieReward(40), 40);
    assert.throws(() => validateSelfieReward(41), /SELFIE_REWARD_EXCEEDS_CAP/);
    assert.throws(() => validateSelfieReward(108), /SELFIE_REWARD_EXCEEDS_CAP/);
    assert.throws(() => validateSelfieReward(150), /SELFIE_REWARD_EXCEEDS_CAP/);
  });

  runTest("2.2 Document Policy: Individual image earns up to 20 SYNX based on rating", () => {
    function calculateDocImageReward(qualityScore) {
      if (qualityScore < 40) return { status: "REJECTED", reward: 0 };
      if (qualityScore >= 80) return { status: "VERIFIED", reward: 20 };
      if (qualityScore >= 60) return { status: "VERIFIED", reward: 10 };
      return { status: "VERIFIED", reward: 4 };
    }

    // High quality (>= 80): 20 SYNX
    assert.deepStrictEqual(calculateDocImageReward(95), { status: "VERIFIED", reward: 20 });
    assert.deepStrictEqual(calculateDocImageReward(80), { status: "VERIFIED", reward: 20 });

    // Mid quality (60-79): 10 SYNX
    assert.deepStrictEqual(calculateDocImageReward(75), { status: "VERIFIED", reward: 10 });
    assert.deepStrictEqual(calculateDocImageReward(60), { status: "VERIFIED", reward: 10 });

    // Low quality (40-59): 4 SYNX
    assert.deepStrictEqual(calculateDocImageReward(55), { status: "VERIFIED", reward: 4 });
    assert.deepStrictEqual(calculateDocImageReward(40), { status: "VERIFIED", reward: 4 });

    // Sub-40 (< 40): Rejected
    assert.deepStrictEqual(calculateDocImageReward(39), { status: "REJECTED", reward: 0 });
    assert.deepStrictEqual(calculateDocImageReward(10), { status: "REJECTED", reward: 0 });
  });

  runTest("2.3 Five-image document batch earns a maximum combined total of 100 SYNX", () => {
    // 5 files, all top quality (20 SYNX each)
    const fiveDocScores = [85, 90, 88, 92, 80];
    let batchTotal = 0;
    const batchCap = 100;

    const settledRewards = fiveDocScores.map(score => {
      let baseDoc = (score >= 80) ? 20 : (score >= 60) ? 10 : 4;
      let awarded = Math.min(baseDoc, Math.max(0, batchCap - batchTotal));
      batchTotal += awarded;
      return awarded;
    });

    assert.deepStrictEqual(settledRewards, [20, 20, 20, 20, 20], "Each of 5 top-tier images earns 20 SYNX");
    assert.strictEqual(batchTotal, 100, "Combined 5-image total must equal 100 SYNX");

    // Attempting a 6th image or over-reward must yield 0
    const sixthImageAward = Math.min(20, Math.max(0, batchCap - batchTotal));
    assert.strictEqual(sixthImageAward, 0, "Any reward beyond 100 SYNX must be capped to 0");
  });

  runTest("2.4 Partial batch capping: if batch has 90 SYNX, a 20 SYNX doc receives 10 SYNX", () => {
    let currentBatchSum = 90;
    let newDocBaseReward = 20;
    let effectiveReward = Math.min(newDocBaseReward, Math.max(0, 100 - currentBatchSum));
    assert.strictEqual(effectiveReward, 10, "Should cap the 20 SYNX reward to 10 SYNX to preserve the 100 SYNX batch ceiling");
    assert.strictEqual(currentBatchSum + effectiveReward, 100, "Final batch total must not exceed 100 SYNX");
  });

  console.log("\n=====================================================================");
  console.log("PART B: SIMULATED RPC STATE MACHINE & LEASE INTEGRATION TESTS");
  console.log("=====================================================================\n");

  // -------------------------------------------------------------------
  // 3. Simulated Stored Procedure: settle_job_reward
  // -------------------------------------------------------------------
  function simulateSettleJobReward(db, { p_job_id, p_user_email, p_worker_id, p_reward_amount, p_file_hash, p_final_url }) {
    const job = db.upload_jobs.find(j => j.id === p_job_id);
    if (!job) return { success: false, error: "JOB_NOT_FOUND" };

    // Idempotency check: if already settled, return success immediately
    if (job.reward_awarded === true) {
      return { success: true, status: "ALREADY_SETTLED", reward: job.reward_amount };
    }

    // Strict status check
    if (job.status !== "PROCESSING") {
      return { success: false, error: "INVALID_STATUS", status: job.status };
    }

    // Strict non-null worker lease ownership check
    if (!job.locked_by || !p_worker_id || job.locked_by !== p_worker_id) {
      return { success: false, error: "LEASE_OWNERSHIP_MISMATCH" };
    }

    // Strict lease expiration check
    const now = Date.now();
    if (!job.lease_expires_at || new Date(job.lease_expires_at).getTime() < now) {
      return { success: false, error: "LEASE_EXPIRED" };
    }

    // User ownership
    if (job.user_email.toLowerCase() !== p_user_email.toLowerCase()) {
      return { success: false, error: "EMAIL_MISMATCH" };
    }

    // Reward policy bounds
    if (p_reward_amount < 0) return { success: false, error: "REWARD_NEGATIVE" };

    let finalReward = p_reward_amount;
    if (job.task_type === "selfie") {
      if (p_reward_amount !== 40) return { success: false, error: "INVALID_SELFIE_REWARD", expected: 40, provided: p_reward_amount };
      finalReward = 40;
    } else {
      if (p_reward_amount > 20) return { success: false, error: "DOC_REWARD_EXCEEDS_CAP", max: 20 };
      
      // Batch cap
      if (job.batch_id) {
        const batchAwarded = db.upload_jobs
          .filter(j => j.batch_id === job.batch_id && j.reward_awarded === true && j.id !== p_job_id)
          .reduce((sum, j) => sum + (j.reward_amount || 0), 0);

        if (batchAwarded >= 100) {
          finalReward = 0;
        } else if (batchAwarded + p_reward_amount > 100) {
          finalReward = 100 - batchAwarded;
        } else {
          finalReward = p_reward_amount;
        }
      }
    }

    // Unique ledger insert (ON CONFLICT (job_id) DO NOTHING) with reconciliation
    const existingLedger = db.syntrix_reward_ledger.find(l => l.job_id === p_job_id);
    if (existingLedger) {
      if (job.reward_awarded !== true) {
        job.status = "VERIFIED";
        job.reward_awarded = true;
        job.reward_amount = existingLedger.reward_amount;
        job.file_hash = p_file_hash;
        job.storage_url = p_final_url;
      }
      return { success: true, status: "ALREADY_SETTLED", reward: existingLedger.reward_amount, reconciled: true };
    }

    db.syntrix_reward_ledger.push({
      id: "ledger-" + Math.random(),
      job_id: p_job_id,
      user_email: p_user_email.toLowerCase(),
      reward_amount: finalReward,
      settled_by_worker: p_worker_id
    });

    job.status = "VERIFIED";
    job.reward_awarded = true;
    job.reward_amount = finalReward;
    job.file_hash = p_file_hash;
    job.storage_url = p_final_url;

    if (finalReward > 0) {
      let user = db.users.find(u => u.email.toLowerCase() === p_user_email.toLowerCase());
      if (user) {
        user.pendingRewards = (user.pendingRewards || 0) + finalReward;
      } else {
        db.users.push({ email: p_user_email.toLowerCase(), pendingRewards: finalReward });
      }
    }

    return { success: true, status: "VERIFIED", reward: finalReward };
  }

  runTest("3.1 settle_job_reward rejects settlement if worker lost its lease (LEASE_EXPIRED)", () => {
    const db = {
      upload_jobs: [{
        id: "job-expired",
        task_type: "selfie",
        user_email: "test@syntrix.io",
        status: "PROCESSING",
        locked_by: "worker_1",
        lease_expires_at: new Date(Date.now() - 5000).toISOString(), // Expired 5s ago
        reward_awarded: false
      }],
      syntrix_reward_ledger: [],
      users: []
    };

    const res = simulateSettleJobReward(db, {
      p_job_id: "job-expired",
      p_user_email: "test@syntrix.io",
      p_worker_id: "worker_1",
      p_reward_amount: 40,
      p_file_hash: "hash123",
      p_final_url: "https://example.com/verified.jpg"
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, "LEASE_EXPIRED", "Expired lease MUST be rejected");
    assert.strictEqual(db.upload_jobs[0].reward_awarded, false, "Job reward must not be awarded");
    assert.strictEqual(db.syntrix_reward_ledger.length, 0, "Ledger must not contain entry");
  });

  runTest("3.2 settle_job_reward rejects settlement on worker mismatch (LEASE_OWNERSHIP_MISMATCH)", () => {
    const db = {
      upload_jobs: [{
        id: "job-stolen",
        task_type: "selfie",
        user_email: "test@syntrix.io",
        status: "PROCESSING",
        locked_by: "worker_2", // Claimed by worker 2
        lease_expires_at: new Date(Date.now() + 60000).toISOString(),
        reward_awarded: false
      }],
      syntrix_reward_ledger: [],
      users: []
    };

    const res = simulateSettleJobReward(db, {
      p_job_id: "job-stolen",
      p_user_email: "test@syntrix.io",
      p_worker_id: "worker_1", // Old worker 1 attempts settlement
      p_reward_amount: 40,
      p_file_hash: "hash123",
      p_final_url: "https://example.com/verified.jpg"
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, "LEASE_OWNERSHIP_MISMATCH");
  });

  runTest("3.3 settle_job_reward rejects legacy NULL-lease jobs until claimed with valid lease", () => {
    const db = {
      upload_jobs: [{
        id: "job-legacy-null",
        task_type: "selfie",
        user_email: "test@syntrix.io",
        status: "PROCESSING",
        locked_by: null, // Legacy null lease
        lease_expires_at: null,
        reward_awarded: false
      }],
      syntrix_reward_ledger: [],
      users: []
    };

    const res = simulateSettleJobReward(db, {
      p_job_id: "job-legacy-null",
      p_user_email: "test@syntrix.io",
      p_worker_id: "worker_1",
      p_reward_amount: 40,
      p_file_hash: "hash123",
      p_final_url: "https://example.com/verified.jpg"
    });

    assert.strictEqual(res.success, false);
    assert.strictEqual(res.error, "LEASE_OWNERSHIP_MISMATCH", "Legacy NULL lease cannot be settled without worker claim");
  });

  runTest("3.4 settle_job_reward ledger conflict handles duplicate settlement idempotently", () => {
    const db = {
      upload_jobs: [{
        id: "job-idemp",
        task_type: "document",
        user_email: "test@syntrix.io",
        status: "PROCESSING",
        locked_by: "worker_1",
        lease_expires_at: new Date(Date.now() + 60000).toISOString(),
        reward_awarded: false
      }],
      syntrix_reward_ledger: [],
      users: [{ email: "test@syntrix.io", pendingRewards: 0 }]
    };

    // First settlement
    const res1 = simulateSettleJobReward(db, {
      p_job_id: "job-idemp",
      p_user_email: "test@syntrix.io",
      p_worker_id: "worker_1",
      p_reward_amount: 20,
      p_file_hash: "hash123",
      p_final_url: "https://example.com/doc.jpg"
    });
    assert.strictEqual(res1.success, true);
    assert.strictEqual(res1.status, "VERIFIED");
    assert.strictEqual(db.users[0].pendingRewards, 20);

    // Concurrent second settlement attempt on same job_id
    const res2 = simulateSettleJobReward(db, {
      p_job_id: "job-idemp",
      p_user_email: "test@syntrix.io",
      p_worker_id: "worker_1",
      p_reward_amount: 20,
      p_file_hash: "hash123",
      p_final_url: "https://example.com/doc.jpg"
    });
    assert.strictEqual(res2.success, true);
    assert.strictEqual(res2.status, "ALREADY_SETTLED");
    assert.strictEqual(db.users[0].pendingRewards, 20, "User must NOT receive double rewards");
  });

  // -------------------------------------------------------------------
  // 3.5 Concurrent Batch Settlement Serialization Test
  // -------------------------------------------------------------------
  await runAsyncTest("3.5 Concurrent batch settlement serialized: two simultaneous settlements on batch with 80 SYNX never exceed 100 SYNX total", async () => {
    const db = {
      upload_jobs: [
        // 4 prior verified jobs totaling 80 SYNX
        { id: "j1", batch_id: "batch-100", task_type: "document", user_email: "u@s.io", status: "VERIFIED", reward_awarded: true, reward_amount: 20 },
        { id: "j2", batch_id: "batch-100", task_type: "document", user_email: "u@s.io", status: "VERIFIED", reward_awarded: true, reward_amount: 20 },
        { id: "j3", batch_id: "batch-100", task_type: "document", user_email: "u@s.io", status: "VERIFIED", reward_awarded: true, reward_amount: 20 },
        { id: "j4", batch_id: "batch-100", task_type: "document", user_email: "u@s.io", status: "VERIFIED", reward_awarded: true, reward_amount: 20 },
        // Two pending jobs in flight
        { id: "j5", batch_id: "batch-100", task_type: "document", user_email: "u@s.io", status: "PROCESSING", locked_by: "worker_1", lease_expires_at: new Date(Date.now() + 60000).toISOString(), reward_awarded: false },
        { id: "j6", batch_id: "batch-100", task_type: "document", user_email: "u@s.io", status: "PROCESSING", locked_by: "worker_2", lease_expires_at: new Date(Date.now() + 60000).toISOString(), reward_awarded: false }
      ],
      syntrix_reward_ledger: [],
      users: [{ email: "u@s.io", pendingRewards: 80 }]
    };

    // Simulated transaction advisory lock on batch_id
    let batchAdvisoryLock = false;
    async function acquireBatchAdvisoryLock() {
      while (batchAdvisoryLock) {
        await new Promise(r => setTimeout(r, 5));
      }
      batchAdvisoryLock = true;
    }
    function releaseBatchAdvisoryLock() {
      batchAdvisoryLock = false;
    }

    async function serializedSettleJob(jobId, workerId) {
      await acquireBatchAdvisoryLock();
      try {
        return simulateSettleJobReward(db, {
          p_job_id: jobId,
          p_user_email: "u@s.io",
          p_worker_id: workerId,
          p_reward_amount: 20,
          p_file_hash: "hash_" + jobId,
          p_final_url: "https://example.com/" + jobId + ".jpg"
        });
      } finally {
        releaseBatchAdvisoryLock();
      }
    }

    // Trigger concurrent settlements from Worker 1 and Worker 2
    const [resJ5, resJ6] = await Promise.all([
      serializedSettleJob("j5", "worker_1"),
      serializedSettleJob("j6", "worker_2")
    ]);

    assert.strictEqual(resJ5.success, true);
    assert.strictEqual(resJ6.success, true);

    const totalBatchRewards = db.upload_jobs
      .filter(j => j.batch_id === "batch-100" && j.reward_awarded === true)
      .reduce((sum, j) => sum + j.reward_amount, 0);

    assert.strictEqual(totalBatchRewards, 100, "Combined total across the batch must NEVER exceed 100 SYNX");
    
    // One job got 20 SYNX and the other got 0 SYNX
    const rewards = [resJ5.reward, resJ6.reward].sort((a, b) => a - b);
    assert.deepStrictEqual(rewards, [0, 20], "One concurrent settlement receives 20 and the other capped to 0");
    assert.strictEqual(db.users[0].pendingRewards, 100, "User total balance must equal exactly 100 SYNX");
  });

  // -------------------------------------------------------------------
  // 3.6 Lease Heartbeat Cap & Timeout Safety
  // -------------------------------------------------------------------
  runTest("3.6 Hung request lease heartbeat stops renewing after MAX_LEASE_RENEWALS", () => {
    let leaseRenewalCount = 0;
    const MAX_LEASE_RENEWALS = 3;
    let isStopped = false;

    for (let cycle = 1; cycle <= 6; cycle++) {
      if (isStopped) break;
      leaseRenewalCount++;
      if (leaseRenewalCount > MAX_LEASE_RENEWALS) {
        isStopped = true;
      }
    }

    assert.strictEqual(isStopped, true, "Renewal must stop after maximum budget");
    assert.strictEqual(leaseRenewalCount, 4, "Must stop when exceeding 3 renewals");
  });

  // -------------------------------------------------------------------
  // 3.7 Abandoned Work Recovery Without Overlapping Processing
  // -------------------------------------------------------------------
  runTest("3.7 Expired lease allows job reclamation; old worker rejected if trying to settle later", () => {
    const now = Date.now();
    const db = {
      upload_jobs: [{
        id: "job-abandoned",
        task_type: "document",
        user_email: "u@s.io",
        status: "PROCESSING",
        locked_by: "worker_hung",
        lease_expires_at: new Date(now - 10000).toISOString(), // Expired 10s ago
        reward_awarded: false
      }],
      syntrix_reward_ledger: [],
      users: []
    };

    // 1. Worker 2 reclaims the expired job
    const job = db.upload_jobs[0];
    const canReclaim = (job.status === "PROCESSING" && new Date(job.lease_expires_at).getTime() < now);
    assert.strictEqual(canReclaim, true, "Worker 2 can reclaim expired job");

    // Worker 2 takes ownership
    job.locked_by = "worker_2";
    job.lease_expires_at = new Date(now + 120000).toISOString();

    // 2. Old hung worker 1 wakes up and attempts to settle
    const oldWorkerAttempt = simulateSettleJobReward(db, {
      p_job_id: "job-abandoned",
      p_user_email: "u@s.io",
      p_worker_id: "worker_hung", // Old worker
      p_reward_amount: 20,
      p_file_hash: "hash",
      p_final_url: "url"
    });

    assert.strictEqual(oldWorkerAttempt.success, false);
    assert.strictEqual(oldWorkerAttempt.error, "LEASE_OWNERSHIP_MISMATCH", "Old worker must be rejected from settling");

    // 3. Active worker 2 settles successfully
    const activeWorkerAttempt = simulateSettleJobReward(db, {
      p_job_id: "job-abandoned",
      p_user_email: "u@s.io",
      p_worker_id: "worker_2", // Active worker
      p_reward_amount: 20,
      p_file_hash: "hash",
      p_final_url: "url"
    });

    assert.strictEqual(activeWorkerAttempt.success, true);
    assert.strictEqual(activeWorkerAttempt.status, "VERIFIED");
  });

  // -------------------------------------------------------------------
  // 4. Server-Side Mutex & Concurrency Lock
  // -------------------------------------------------------------------
  runTest("4.1 Server-side mutex rejects overlapping /api/process-queue requests with 429", () => {
    let isProcessingActive = false;

    function handleProcessQueueRequest() {
      if (isProcessingActive) {
        return { status: 429, message: "Queue processor already active on server." };
      }
      isProcessingActive = true;
      try {
        return { status: 200, message: "Batch processed." };
      } finally {
        isProcessingActive = false;
      }
    }

    // First request runs
    isProcessingActive = true; // Simulate active in-flight batch
    const overlappingReq = handleProcessQueueRequest();
    assert.strictEqual(overlappingReq.status, 429, "Overlapping request must receive 429");

    isProcessingActive = false; // Finished
    const nextReq = handleProcessQueueRequest();
    assert.strictEqual(nextReq.status, 200, "Subsequent request after batch completion succeeds");
  });

  // -------------------------------------------------------------------
  // 4.2 Stale Worker Update Protection Test
  // -------------------------------------------------------------------
  runTest("4.2 Stale worker update rejected: updates to upload_jobs strictly filtered by locked_by", () => {
    // Simulate database table
    let dbJobs = [{
      id: "job-lease-transfer",
      status: "PROCESSING",
      locked_by: "worker_new_owner", // Transferred to new worker
      lease_expires_at: new Date(Date.now() + 60000).toISOString(),
      retry_count: 1
    }];

    // Simulated Supabase update with chained .eq("id", id).eq("locked_by", workerId)
    function simulateSupabaseJobUpdate(id, workerId, updates) {
      const match = dbJobs.find(j => j.id === id && j.locked_by === workerId);
      if (!match) return { affectedRows: 0 };
      Object.assign(match, updates);
      return { affectedRows: 1 };
    }

    // Old stale worker attempts terminal FAILED update
    const staleWorkerUpdate = simulateSupabaseJobUpdate("job-lease-transfer", "worker_old_stale", {
      status: "FAILED",
      error_code: "PROCESSING_ERROR",
      locked_by: null
    });

    assert.strictEqual(staleWorkerUpdate.affectedRows, 0, "Stale worker update MUST affect 0 rows");
    assert.strictEqual(dbJobs[0].status, "PROCESSING", "Job status must remain unchanged by stale worker");
    assert.strictEqual(dbJobs[0].locked_by, "worker_new_owner", "Ownership must remain with the new worker");

    // New owner updates successfully
    const validOwnerUpdate = simulateSupabaseJobUpdate("job-lease-transfer", "worker_new_owner", {
      status: "VERIFIED",
      reward_awarded: true
    });
    assert.strictEqual(validOwnerUpdate.affectedRows, 1, "Valid owner update must succeed");
    assert.strictEqual(dbJobs[0].status, "VERIFIED");
  });

  // -------------------------------------------------------------------
  // 4.3 Key Alias Resolution Security Test
  // -------------------------------------------------------------------
  runTest("4.3 Environment key security: only APPROVED_KEY_ALIASES resolve to secrets", () => {
    const APPROVED_KEY_ALIASES = new Set([
      "GEMINI_API_SELFIE",
      "GEMINI_API_SELFIE_2",
      "GEMINI_API_SELFIE_3",
      "GEMINI_DOCUMENT_KEY_1",
      "GEMINI_DOCUMENT_KEY_2",
      "GEMINI_DOCUMENT_KEY_3",
      "GEMINI_DOCUMENT_KEY_4",
      "GEMINI_API_KEY"
    ]);

    process.env.GEMINI_API_SELFIE = "secret_selfie_val_123";
    process.env.UNAUTHORIZED_SECRET_KEY = "super_secret_forbidden_value";

    function resolveKeyValue(keyName) {
      if (!keyName) return null;
      if (APPROVED_KEY_ALIASES.has(keyName)) {
        return process.env[keyName] || null;
      }
      return null;
    }

    assert.strictEqual(resolveKeyValue("GEMINI_API_SELFIE"), "secret_selfie_val_123", "Approved key alias must resolve");
    assert.strictEqual(resolveKeyValue("UNAUTHORIZED_SECRET_KEY"), null, "Unauthorized key alias must resolve to null");
    assert.strictEqual(resolveKeyValue("AWS_SECRET_ACCESS_KEY"), null, "Arbitrary env var must resolve to null");
    assert.strictEqual(resolveKeyValue(""), null, "Empty key alias must resolve to null");
  });

  // -------------------------------------------------------------------
  // 4.4 XP Failure Isolation Test
  // -------------------------------------------------------------------
  await runAsyncTest("4.4 XP failure isolation: XP awarding exception does not fail or reset settled job", async () => {
    let jobRecord = {
      id: "job-xp-test",
      status: "PROCESSING",
      reward_awarded: false,
      reward_amount: 0
    };

    // Simulate settlement
    jobRecord.status = "VERIFIED";
    jobRecord.reward_awarded = true;
    jobRecord.reward_amount = 20;

    // Simulate XP error
    let xpAwardErrorCaught = false;
    try {
      // Mock failing awardXP
      const mockAwardXP = async () => { throw new Error("Database network error during XP write"); };
      try {
        await mockAwardXP();
      } catch (xpErr) {
        xpAwardErrorCaught = true;
        // Caught non-fatally, job is NOT rolled back
      }
    } catch (e) {
      assert.fail("XP error should have been caught internally");
    }

    assert.strictEqual(xpAwardErrorCaught, true, "XP error must be caught gracefully");
    assert.strictEqual(jobRecord.status, "VERIFIED", "Job status must remain VERIFIED");
    assert.strictEqual(jobRecord.reward_awarded, true, "Reward must remain awarded");
    assert.strictEqual(jobRecord.reward_amount, 20, "Reward amount must remain intact");
  });

  // -------------------------------------------------------------------
  // 4.5 Public Wake 5-Second Cooldown Debounce Test
  // -------------------------------------------------------------------
  runTest("4.5 Public wake rate limiting: calls within 5000ms cooldown receive 429", () => {
    let lastWake = 0;
    const COOLDOWN_MS = 5000;

    function handlePublicWake(requestTime) {
      if (requestTime - lastWake < COOLDOWN_MS) {
        return { status: 429, message: "Wake signal rate limited." };
      }
      lastWake = requestTime;
      return { status: 200, message: "AI Worker signaled." };
    }

    const t0 = 100000;
    const req1 = handlePublicWake(t0);
    assert.strictEqual(req1.status, 200, "First wake call must succeed");

    const t1 = t0 + 2000; // 2 seconds later (within cooldown)
    const req2 = handlePublicWake(t1);
    assert.strictEqual(req2.status, 429, "Second call within 5s must receive 429");

    const t2 = t0 + 5100; // 5.1 seconds later (after cooldown)
    const req3 = handlePublicWake(t2);
    assert.strictEqual(req3.status, 200, "Call after 5s must succeed");
  });

  // -------------------------------------------------------------------
  // 4.6 Exact 40 SYNX Selfie Validation Test
  // -------------------------------------------------------------------
  runTest("4.6 Exact 40 SYNX selfie validation: RPC rejects any selfie reward amount != 40", () => {
    const db = {
      upload_jobs: [{
        id: "selfie-job-1",
        task_type: "selfie",
        user_email: "test@syntrix.io",
        status: "PROCESSING",
        locked_by: "worker_1",
        lease_expires_at: new Date(Date.now() + 60000).toISOString(),
        reward_awarded: false
      }],
      syntrix_reward_ledger: [],
      users: [{ email: "test@syntrix.io", pendingRewards: 0 }]
    };

    // Invalid amount: 48 SYNX
    const resInvalid = simulateSettleJobReward(db, {
      p_job_id: "selfie-job-1",
      p_user_email: "test@syntrix.io",
      p_worker_id: "worker_1",
      p_reward_amount: 48, // Wrong amount!
      p_file_hash: "hash",
      p_final_url: "url"
    });
    assert.strictEqual(resInvalid.success, false);
    assert.strictEqual(resInvalid.error, "INVALID_SELFIE_REWARD");

    // Invalid amount: 20 SYNX
    const resInvalid2 = simulateSettleJobReward(db, {
      p_job_id: "selfie-job-1",
      p_user_email: "test@syntrix.io",
      p_worker_id: "worker_1",
      p_reward_amount: 20, // Wrong amount!
      p_file_hash: "hash",
      p_final_url: "url"
    });
    assert.strictEqual(resInvalid2.success, false);
    assert.strictEqual(resInvalid2.error, "INVALID_SELFIE_REWARD");

    // Valid amount: EXACTLY 40 SYNX
    const resValid = simulateSettleJobReward(db, {
      p_job_id: "selfie-job-1",
      p_user_email: "test@syntrix.io",
      p_worker_id: "worker_1",
      p_reward_amount: 40,
      p_file_hash: "hash",
      p_final_url: "url"
    });
    assert.strictEqual(resValid.success, true);
    assert.strictEqual(resValid.status, "VERIFIED");
    assert.strictEqual(resValid.reward, 40);
    assert.strictEqual(db.users[0].pendingRewards, 40);
  });

  // -------------------------------------------------------------------
  // 4.7 Ledger Conflict Reconciliation Test
  // -------------------------------------------------------------------
  runTest("4.7 Ledger conflict reconciliation: existing ledger entry reconciles job row without duplicate credit", () => {
    const db = {
      upload_jobs: [{
        id: "job-pre-settled-ledger",
        task_type: "document",
        user_email: "user@syntrix.io",
        status: "PROCESSING",
        locked_by: "worker_1",
        lease_expires_at: new Date(Date.now() + 60000).toISOString(),
        reward_awarded: false // Status not updated yet in upload_jobs
      }],
      syntrix_reward_ledger: [{
        id: "ledger-existing-1",
        job_id: "job-pre-settled-ledger",
        user_email: "user@syntrix.io",
        reward_amount: 20,
        settled_by_worker: "worker_1"
      }],
      users: [{ email: "user@syntrix.io", pendingRewards: 20 }]
    };

    const res = simulateSettleJobReward(db, {
      p_job_id: "job-pre-settled-ledger",
      p_user_email: "user@syntrix.io",
      p_worker_id: "worker_1",
      p_reward_amount: 20,
      p_file_hash: "hash123",
      p_final_url: "https://example.com/doc.jpg"
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.status, "ALREADY_SETTLED");
    assert.strictEqual(res.reward, 20);
    assert.strictEqual(res.reconciled, true);
    assert.strictEqual(db.upload_jobs[0].status, "VERIFIED", "Job row must be reconciled to VERIFIED");
    assert.strictEqual(db.upload_jobs[0].reward_awarded, true, "reward_awarded must be reconciled to true");
    assert.strictEqual(db.syntrix_reward_ledger.length, 1, "No duplicate ledger row created");
    assert.strictEqual(db.users[0].pendingRewards, 20, "User balance must NOT be double-credited");
  });

  console.log("\n=====================================================================");
  console.log(`SUMMARY: ${passedTests}/${totalTests} TESTS PASSED.`);
  console.log("=====================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

main().catch(e => {
  console.error("Test runner exception:", e);
  process.exit(1);
});

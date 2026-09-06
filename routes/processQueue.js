const express = require("express");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const router = express.Router();

// =====================================================================
// HELPER: Get the next available API key that isn't rate-limited
// =====================================================================
async function getAvailableKey(supabase) {
  const { data: keys, error } = await supabase
    .from("gemini_key_status")
    .select("*")
    .order("total_calls", { ascending: true }); // prefer least-used key

  if (error || !keys || keys.length === 0) return null;

  const now = new Date();

  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];

    // If cooldown has expired, clear it
    if (key.is_on_cooldown && key.cooldown_until) {
      var cooldownEnd = new Date(key.cooldown_until);
      if (now >= cooldownEnd) {
        await supabase
          .from("gemini_key_status")
          .update({ is_on_cooldown: false })
          .eq("key_name", key.key_name);
        key.is_on_cooldown = false;
      }
    }

    if (!key.is_on_cooldown) {
      return key.key_name;
    }
  }

  return null; // All keys on cooldown
}

// =====================================================================
// HELPER: Mark a key as rate-limited (60 min cooldown)
// =====================================================================
async function markKeyCooldown(supabase, keyName) {
  const cooldownUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  await supabase
    .from("gemini_key_status")
    .update({
      is_on_cooldown: true,
      cooldown_until: cooldownUntil
    })
    .eq("key_name", keyName);
}

// =====================================================================
// HELPER: Increment key call count
// =====================================================================
async function incrementKeyCallCount(supabase, keyName) {
  const { data } = await supabase
    .from("gemini_key_status")
    .select("total_calls")
    .eq("key_name", keyName)
    .single();

  if (data) {
    await supabase
      .from("gemini_key_status")
      .update({ total_calls: (data.total_calls || 0) + 1 })
      .eq("key_name", keyName);
  }
}

// =====================================================================
// HELPER: Resolve env var key name to actual API key string
// =====================================================================
function resolveKeyValue(keyName) {
  var mapping = {
    "GEMINI_DOCUMENT_KEY_1": process.env.GEMINI_DOCUMENT_KEY_1 || process.env.GEMINI_API_KEY_DOCS || process.env.GEMINI_API_KEY,
    "GEMINI_DOCUMENT_KEY_2": process.env.GEMINI_DOCUMENT_KEY_2 || process.env.GEMINI_BACKUP_KEY || process.env.GEMINI_API_KEY
  };
  return mapping[keyName] || process.env.GEMINI_API_KEY;
}

// =====================================================================
// HELPER: Extract relative bucket path from a Supabase public URL
// =====================================================================
function getBucketPathFromUrl(url) {
  if (!url) return null;
  var marker = "/storage/v1/object/public/verified_assets/";
  var idx = url.indexOf(marker);
  if (idx === -1) return null;
  return url.substring(idx + marker.length);
}

// =====================================================================
// CORE LOGIC: Process a single upload job
// =====================================================================
async function processUploadJob(supabase, job, keyName, xpFunctions) {
  var apiKeyValue = resolveKeyValue(keyName);
  if (!apiKeyValue) {
    throw { isKeyError: true, message: "No API key value resolved for " + keyName };
  }

  var aiClient = new GoogleGenAI({ apiKey: apiKeyValue });
  var relativeFilePath = getBucketPathFromUrl(job.storage_url);
  var isSelfie = job.task_type === "selfie";

  // ---- ATOMIC CLAIMING (PHASE 2) ----
  // Optimistically lock the job so multiple workers don't process it twice
  var { data: claimData, error: claimErr } = await supabase
    .from("upload_jobs")
    .update({ status: "PROCESSING", assigned_key: keyName })
    .eq("id", job.id)
    .in("status", ["QUEUED", "RETRYING"]) // Only claim if it hasn't been picked up
    .select("id");

  if (claimErr) {
    throw new Error("Failed to claim job: " + claimErr.message);
  }
  
  if (!claimData || claimData.length === 0) {
    // Another worker already claimed this job, or it's no longer QUEUED
    console.warn("[QUEUE] Job " + job.id + " already claimed by another worker. Skipping.");
    return { jobId: job.id, result: "SKIPPED", reason: "Atomic lock failed (Already claimed)" };
  }

  // ---- 1. Fetch image from storage ----
  var imageResponse = await fetch(job.storage_url);
  if (!imageResponse.ok) {
    throw new Error("Failed to fetch image from storage: HTTP " + imageResponse.status);
  }
  var arrayBuffer = await imageResponse.arrayBuffer();
  var imageBuffer = Buffer.from(arrayBuffer);
  var base64Data = imageBuffer.toString("base64");

  // ---- 2. AI Verification ----
  var qualityRules = isSelfie
    ? "Is it a clear, authentic photograph of a real human face taken by a camera? You MUST reject AI-generated faces, cartoons, drawings, photos of photos, and screen captures. Provide a specific reason if it fails."
    : "You are a STRINGENT data quality gatekeeper. You MUST reject this image if ANY of the following are true: (a) It is a screenshot or screen capture of any device. (b) It contains digital/typed/printed text from a computer, phone, or textbook. (c) It is a photo of a textbook, printed book page, or PDF document. (d) It is a random photo of an object, animal, scenery, or food that is NOT a document. (e) It is a blank or nearly blank page. (f) It contains human faces, selfies, or portrait photos. You may ONLY approve images that are authentic photographs of PHYSICAL, HANDWRITTEN notes written on real paper containing: " + (job.content_tags ? job.content_tags.join(", ") : "academic content") + ". The handwriting must be clearly visible and the content must be educational or informational. If rejecting, state the exact reason like 'Screenshot detected', 'Printed/digital text - not handwritten', 'Random photo - not a document', or 'Textbook page - not handwritten notes'.";

  var combinedPrompt = "You are an extremely strict security AI validator for a data quality platform. Your job is to PROTECT the dataset from low-quality or fraudulent submissions. When in doubt, REJECT. Evaluate this image for:\n" +
    "1. QUALITY: " + qualityRules + "\n" +
    "2. PII: Does this image contain Sensitive Personal Identifiable Information (phone numbers, home addresses, government IDs like Aadhaar/SSN, bank account numbers, or passwords)?\n" +
    'You MUST respond STRICTLY with JSON: {"quality_pass": true_or_false, "contains_pii": true_or_false, "reason": "Concise specific reason for your decision"}';

  var response;
  try {
    response = await aiClient.models.generateContent({
      model: "gemini-3.6-flash",
      contents: [
        { text: combinedPrompt },
        { inlineData: { mimeType: "image/jpeg", data: base64Data } }
      ],
      config: { responseMimeType: "application/json" }
    });
  } catch (aiErr) {
    var statusCode = aiErr.status || aiErr.statusCode || (aiErr.message && aiErr.message.indexOf("429") !== -1 ? 429 : 0);
    if (statusCode === 429 || statusCode === 503) {
      // RATE LIMIT HIT — cooldown this key, mark job for retry
      throw { isRateLimit: true, statusCode: statusCode, message: aiErr.message };
    }
    throw aiErr;
  }

  // Track the successful API call
  await incrementKeyCallCount(supabase, keyName);

  var aiVerdict = JSON.parse(response.text.trim());

  // ---- 3. REJECTION: PII or quality fail ----
  if (aiVerdict.contains_pii || !aiVerdict.quality_pass) {
    var rejectReason = aiVerdict.contains_pii ? "Contains Sensitive PII" : aiVerdict.reason;
    var rejectErrorCode = aiVerdict.contains_pii ? "PII_DETECTED" : "QUALITY_FAILED";

    if (relativeFilePath) {
      await supabase.storage.from("verified_assets").remove([relativeFilePath]);
    }

    await supabase.from("upload_jobs").update({
      status: "REJECTED",
      error_code: rejectErrorCode,
      reason: rejectReason,
      processed_at: new Date().toISOString()
    }).eq("id", job.id);

    return { jobId: job.id, result: "REJECTED", reason: rejectReason };
  }

  // ---- 4. SHA-256 Hash Duplicate Check ----
  var imageHash = crypto.createHash("sha256").update(imageBuffer).digest("hex");

  // Check within upload_jobs
  var { data: hashDup } = await supabase
    .from("upload_jobs")
    .select("id")
    .eq("file_hash", imageHash)
    .eq("status", "VERIFIED")
    .neq("id", job.id)
    .limit(1);

  if (hashDup && hashDup.length > 0) {
    if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
    await supabase.from("upload_jobs").update({
      status: "REJECTED",
      error_code: "DUPLICATE_HASH",
      reason: "Duplicate image detected (Hash Match)",
      file_hash: imageHash,
      processed_at: new Date().toISOString()
    }).eq("id", job.id);
    return { jobId: job.id, result: "REJECTED", reason: "Duplicate hash" };
  }

  // Also check legacy syntrix_submissions table
  var { data: legacyHashDup } = await supabase
    .from("syntrix_submissions")
    .select("id")
    .like("reason", "%Hash:" + imageHash + "%")
    .limit(1);

  if (legacyHashDup && legacyHashDup.length > 0) {
    if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
    await supabase.from("upload_jobs").update({
      status: "REJECTED",
      error_code: "DUPLICATE_HASH_LEGACY",
      reason: "Duplicate image (matched legacy system)",
      file_hash: imageHash,
      processed_at: new Date().toISOString()
    }).eq("id", job.id);
    return { jobId: job.id, result: "REJECTED", reason: "Duplicate hash (legacy)" };
  }

  // ---- 5. Vector Embedding Duplicate Check (non-selfies only) ----
  var finalEmbedding = null;
  if (!isSelfie) {
    try {
      var embedRes = await aiClient.models.embedContent({
        model: "gemini-embedding-001",
        contents: "Task: " + job.task_type + " | User: " + job.user_email
      });
      finalEmbedding = embedRes.embeddings[0].values;

      var { data: matchData } = await supabase.rpc("match_homework_vectors", {
        query_embedding: finalEmbedding,
        match_threshold: 0.98,
        match_count: 1
      });

      if (matchData && matchData.length > 0) {
        if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
        await supabase.from("upload_jobs").update({
          status: "REJECTED",
          error_code: "DUPLICATE_VECTOR",
          reason: "Duplicate metadata detected (Vector Match)",
          file_hash: imageHash,
          embedding: finalEmbedding,
          processed_at: new Date().toISOString()
        }).eq("id", job.id);
        return { jobId: job.id, result: "REJECTED", reason: "Duplicate vector" };
      }
    } catch (embedErr) {
      console.warn("[QUEUE] Embedding generation failed for job " + job.id + ":", embedErr.message);
      // Non-fatal: continue without embedding
    }
  }

  // ---- 6. APPROVAL: Move file to verified folder ----
  var verifiedPath = "verified/" + job.user_email + "/" + Date.now() + "_" + job.file_name;
  if (relativeFilePath) {
    await supabase.storage.from("verified_assets").move(relativeFilePath, verifiedPath);
  }
  var { data: finalUrlData } = supabase.storage.from("verified_assets").getPublicUrl(verifiedPath);

  // ---- 7. Calculate reward ----
  var rewardAmount = 48; // base
  if (xpFunctions && xpFunctions.getXPProfile && xpFunctions.calculateFinalTaskReward) {
    try {
      var xpProfile = await xpFunctions.getXPProfile(supabase, job.user_email);
      var rewardInfo = xpFunctions.calculateFinalTaskReward(
        48,
        xpProfile ? xpProfile.currentLevel : 1,
        xpProfile ? xpProfile.dailyStreak : 0
      );
      rewardAmount = rewardInfo.finalReward;
    } catch (xpErr) {
      console.warn("[QUEUE] XP profile lookup failed, using base 48:", xpErr.message);
    }
  }

  // ---- 8. IDEMPOTENT SYNX AWARD ----
  // Uses atomic update: only awards if reward_awarded is still false
  var { data: awardResult, error: awardErr } = await supabase
    .from("upload_jobs")
    .update({
      status: "VERIFIED",
      storage_url: finalUrlData ? finalUrlData.publicUrl : job.storage_url,
      file_hash: imageHash,
      embedding: finalEmbedding,
      reward_amount: rewardAmount,
      reward_awarded: true,
      reason: "Verified Successfully | Hash:" + imageHash + " | Paid " + rewardAmount + " SYNX",
      processed_at: new Date().toISOString()
    })
    .eq("id", job.id)
    .eq("reward_awarded", false) // IDEMPOTENCY GUARD: only update if not already awarded
    .select("id");

  if (awardErr) {
    console.error("[QUEUE] Failed to update job " + job.id + ":", awardErr.message);
    return { jobId: job.id, result: "ERROR", reason: awardErr.message };
  }

  // If awardResult is empty, the reward was already awarded (idempotency caught a double-run)
  if (!awardResult || awardResult.length === 0) {
    console.warn("[QUEUE] Idempotency guard: job " + job.id + " reward already awarded. Skipping.");
    return { jobId: job.id, result: "SKIPPED", reason: "Reward already awarded" };
  }

  // ---- 9. Credit user's pendingRewards ----
  var { data: userData } = await supabase
    .from("users")
    .select("pendingRewards")
    .eq("email", job.user_email)
    .single();

  if (userData) {
    await supabase
      .from("users")
      .update({ pendingRewards: (userData.pendingRewards || 0) + rewardAmount })
      .eq("email", job.user_email);
  } else {
    await supabase
      .from("users")
      .insert([{ email: job.user_email, pendingRewards: rewardAmount }]);
  }

  // ---- 10. Award XP ----
  if (xpFunctions && xpFunctions.awardXP) {
    await xpFunctions.awardXP(
      supabase,
      job.user_email,
      isSelfie ? 60 : 70,
      isSelfie ? "Selfie Verified" : "Document Verified",
      isSelfie ? "selfie" : "document"
    );
  }

  return { jobId: job.id, result: "VERIFIED", reward: rewardAmount };
}

// =====================================================================
// HELPER: Roll up batch status from its jobs
// =====================================================================
async function rollupBatchStatus(supabase, batchId, sendEmailHTTP) {
  var { data: jobs } = await supabase
    .from("upload_jobs")
    .select("status, user_email")
    .eq("batch_id", batchId);

  if (!jobs || jobs.length === 0) return;

  var total = jobs.length;
  var completed = 0;
  var verified = 0;
  var rejected = 0;
  var failed = 0;
  var stillPending = 0;
  var userEmail = jobs[0].user_email;

  jobs.forEach(function(j) {
    if (j.status === "VERIFIED") { completed++; verified++; }
    else if (j.status === "REJECTED") { completed++; rejected++; }
    else if (j.status === "FAILED") { completed++; failed++; }
    else { stillPending++; }
  });

  var batchStatus;
  if (stillPending > 0) {
    batchStatus = "PROCESSING";
  } else if (verified === total) {
    batchStatus = "COMPLETED";
  } else if (failed === total || rejected === total) {
    batchStatus = "FAILED";
  } else {
    batchStatus = "PARTIAL";
  }

  // Check the current status BEFORE updating to avoid spamming emails
  const { data: batchBeforeUpdate } = await supabase
    .from("upload_batches")
    .select("status")
    .eq("id", batchId)
    .single();

  await supabase
    .from("upload_batches")
    .update({ status: batchStatus, completed_jobs: completed })
    .eq("id", batchId);

  // Trigger Email if batch JUST transitioned to a finished state
  if (
    stillPending === 0 && 
    batchBeforeUpdate && 
    batchBeforeUpdate.status !== "COMPLETED" && 
    batchBeforeUpdate.status !== "PARTIAL" && 
    batchBeforeUpdate.status !== "FAILED"
  ) {
    if (sendEmailHTTP && userEmail) {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #000; color: #fff;">
          <h2 style="color: #10b981;">Syntrix AI Batch Complete</h2>
          <p style="color: #a1a1aa;">Your recent document upload batch has finished processing.</p>
          <p style="margin-bottom: 30px;">Log in to your Dashboard and check the <strong>Upload History</strong> tab to see your results, review any rejected files, and claim your SYNX tokens!</p>
          <a href="https://syntrix-frontend-servey-2hl7.vercel.app" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">Go to Dashboard</a>
        </div>
      `;
      sendEmailHTTP(userEmail, "Syntrix AI Batch Processing Complete!", emailHtml)
        .catch(e => console.error("Batch completion email failed:", e));
    }
  }
}

// =====================================================================
// POST /api/process-queue — The main queue processor endpoint
// Secured with x-admin-key header.
// =====================================================================
router.post("/", async (req, res) => {
  try {
    var supabase = req.app.locals.supabase;
    var sendEmailHTTP = req.app.locals.sendEmailHTTP;
    var adminKey = req.headers["x-admin-key"];

    // ---- Auth Check ----
    if (!process.env.ADMIN_SECRET_KEY || adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ success: false, error: "Unauthorized." });
    }

    // ---- Load XP functions (graceful fallback if xpengine is unavailable) ----
    var xpFunctions = {};
    try {
      var xpEngine = require("../xpengine");
      xpFunctions = {
        awardXP: xpEngine.awardXP,
        getXPProfile: xpEngine.getXPProfile,
        calculateFinalTaskReward: xpEngine.calculateFinalTaskReward
      };
    } catch (xpLoadErr) {
      console.warn("[QUEUE] xpengine.js not found — rewards will use base 48 SYNX without multipliers.");
    }

    // ---- 1. Get available Gemini API key ----
    var keyName = await getAvailableKey(supabase);
    if (!keyName) {
      return res.status(200).json({
        success: true,
        status: "ALL_KEYS_COOLING",
        message: "All Gemini API keys are on cooldown. Retry after cooldown expires.",
        processed: 0
      });
    }

    // ---- 2. Fetch queued jobs (Phase 2: Workload Separation & Fallback) ----
    var jobs = [];
    var { data: rpcJobs, error: fetchErr } = await supabase.rpc("get_fair_queued_jobs", { job_limit: 5 });

    if (!fetchErr && rpcJobs && rpcJobs.length > 0) {
        jobs = rpcJobs;
    } else {
        if (fetchErr) console.warn("[QUEUE] RPC get_fair_queued_jobs failed/missing. Using fallback queries...");
        
        // Fallback: Fetch max 3 Documents and max 2 Selfies to separate workloads
        var columns = "id, status, user_email, task_type, storage_url, file_name, file_hash, retry_count, max_retries, batch_id, content_tags";
        
        var { data: docJobs } = await supabase
            .from("upload_jobs")
            .select(columns)
            .in("status", ["QUEUED", "RETRYING"])
            .is("assigned_key", null)
            .neq("task_type", "selfie")
            .order("created_at", { ascending: true })
            .limit(3);
            
        var { data: selfieJobs } = await supabase
            .from("upload_jobs")
            .select(columns)
            .in("status", ["QUEUED", "RETRYING"])
            .is("assigned_key", null)
            .eq("task_type", "selfie")
            .order("created_at", { ascending: true })
            .limit(2);
            
        if (docJobs) jobs = jobs.concat(docJobs);
        if (selfieJobs) jobs = jobs.concat(selfieJobs);
    }

    if (!jobs || jobs.length === 0) {
      return res.status(200).json({
        success: true,
        status: "EMPTY",
        message: "No jobs in queue.",
        processed: 0
      });
    }

    // ---- 3. Process each job sequentially ----
    var results = [];
    var affectedBatchIds = {};
    var shouldStop = false;

    for (var i = 0; i < jobs.length; i++) {
      if (shouldStop) break;

      var job = jobs[i];
      affectedBatchIds[job.batch_id] = true;

      try {
        var result = await processUploadJob(supabase, job, keyName, xpFunctions);
        results.push(result);
      } catch (jobErr) {
        if (jobErr.isRateLimit) {
          // ---- RATE LIMIT: Cooldown key, mark job for retry, STOP processing ----
          console.warn("[QUEUE] Rate limit hit on " + keyName + " (HTTP " + jobErr.statusCode + "). Cooling down.");
          await markKeyCooldown(supabase, keyName);

          var newRetryCount = (job.retry_count || 0) + 1;
          var retryStatus = newRetryCount >= (job.max_retries || 3) ? "FAILED" : "RETRYING";

          await supabase.from("upload_jobs").update({
            status: retryStatus,
            error_code: String(jobErr.statusCode),
            reason: "Rate limited — key " + keyName + " on cooldown",
            retry_count: newRetryCount
          }).eq("id", job.id);

          results.push({
            jobId: job.id,
            result: retryStatus,
            reason: "Rate limit " + jobErr.statusCode
          });

          shouldStop = true; // Stop processing remaining jobs
        } else {
          // ---- General error: Catch silently and retry (Phase 2) ----
          console.error("[QUEUE] Job " + job.id + " failed:", jobErr.message);

          var filePath = getBucketPathFromUrl(job.storage_url);
          var isFatal = jobErr.isKeyError || false; // Don't retry if we literally don't have a key mapped
          
          var newRetryCount = (job.retry_count || 0) + 1;
          var maxRetries = job.max_retries || 3;
          
          if (newRetryCount >= maxRetries || isFatal) {
              // Final failure
              if (filePath) await supabase.storage.from("verified_assets").remove([filePath]).catch(function() {});
              await supabase.from("upload_jobs").update({
                status: "FAILED",
                error_code: "PROCESSING_ERROR",
                reason: "System Error: " + (jobErr.message || "Unknown error"),
                processed_at: new Date().toISOString(),
                retry_count: newRetryCount
              }).eq("id", job.id);
              results.push({ jobId: job.id, result: "FAILED", reason: jobErr.message });
          } else {
              // Safe retry
              await supabase.from("upload_jobs").update({
                status: "RETRYING",
                error_code: "RETRY",
                reason: "Temporary error: " + (jobErr.message || "Unknown"),
                retry_count: newRetryCount
              }).eq("id", job.id);
              results.push({ jobId: job.id, result: "RETRYING", reason: jobErr.message });
          }
        }
      }
    }

    // ---- 4. Roll up batch statuses for all affected batches ----
    var batchIds = Object.keys(affectedBatchIds);
    for (var b = 0; b < batchIds.length; b++) {
      await rollupBatchStatus(supabase, batchIds[b], sendEmailHTTP);
    }

    return res.status(200).json({
      success: true,
      status: "PROCESSED",
      keyUsed: keyName,
      processed: results.length,
      results: results
    });

  } catch (err) {
    console.error("[QUEUE] Unexpected error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error during queue processing."
    });
  }
});

// =====================================================================
// GET /api/process-queue/key-status — View Gemini key pool status
// Secured with x-admin-key header.
// =====================================================================
router.get("/key-status", async (req, res) => {
  try {
    var supabase = req.app.locals.supabase;
    var adminKey = req.headers["x-admin-key"];

    if (!process.env.ADMIN_SECRET_KEY || adminKey !== process.env.ADMIN_SECRET_KEY) {
      return res.status(403).json({ success: false, error: "Unauthorized." });
    }

    var { data: keys, error } = await supabase
      .from("gemini_key_status")
      .select("*")
      .order("key_name", { ascending: true });

    if (error) {
      return res.status(500).json({ success: false, error: "Failed to fetch key status." });
    }

    return res.status(200).json({ success: true, keys: keys || [] });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

module.exports = router;

// =====================================================================
// POST /api/process-queue — Serverless Queue Processor (Phase 3)
// 
// Fetches QUEUED/RETRYING upload_jobs using fair round-robin scheduling,
// processes them through Gemini AI with key pooling & rate limit handling,
// awards SYNX tokens idempotently, and rolls up batch statuses.
//
// Trigger via: Vercel Cron, Supabase Webhook, external scheduler,
// or setInterval in server.js.
// Secured with x-admin-key header.
// =====================================================================

const express = require("express");
const crypto = require("crypto");
const { GoogleGenAI } = require("@google/genai");
const router = express.Router();

// =====================================================================
// IN-MEMORY 3-KEY GEMINI ROTATOR
// =====================================================================
const SELFIE_KEYS = [process.env.GEMINI_API_KEY_SELFIE_1, process.env.GEMINI_API_KEY].filter(Boolean);
const DOC_KEYS = [process.env.GEMINI_API_KEY_DOC_1, process.env.GEMINI_API_KEY_DOC_2, process.env.GEMINI_API_KEY].filter(Boolean);
let selfieIndex = 0; 
let docIndex = 0;

async function getAvailableKey(supabase, taskType) {
  if (taskType === 'selfie' && SELFIE_KEYS.length > 0) {
    const key = SELFIE_KEYS[selfieIndex];
    selfieIndex = (selfieIndex + 1) % SELFIE_KEYS.length;
    return key;
  } else if (DOC_KEYS.length > 0) {
    const key = DOC_KEYS[docIndex];
    docIndex = (docIndex + 1) % DOC_KEYS.length;
    return key;
  }
  return process.env.GEMINI_API_KEY;
}

async function markKeyCooldown(supabase, keyName) { return; }
async function incrementKeyCallCount(supabase, keyName) { return; }
function resolveKeyValue(keyName) { return keyName; }

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
// HELPER: Process a single upload_job through the AI pipeline
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

  // ---- 1.5 Zero-Trust EXIF Pre-Check (Documents Only) ----
  if (!isSelfie) {
    // JPEG EXIF check: Look for EXIF marker (0xFFE1) in JPEG header
    // Real camera photos contain EXIF metadata; pure screenshots/digital files typically don't
    var hasExifMarker = false;
    if (imageBuffer.length > 4 && imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8) {
      // Valid JPEG start - scan for APP1 (EXIF) marker
      for (var ei = 2; ei < Math.min(imageBuffer.length - 1, 65536); ei++) {
        if (imageBuffer[ei] === 0xFF && imageBuffer[ei + 1] === 0xE1) {
          hasExifMarker = true;
          break;
        }
        // Skip past other markers
        if (imageBuffer[ei] === 0xFF && imageBuffer[ei + 1] !== 0x00) {
          if (ei + 3 < imageBuffer.length) {
            var markerLen = (imageBuffer[ei + 2] << 8) | imageBuffer[ei + 3];
            ei += markerLen + 1;
          }
        }
      }
    }
    
    if (!hasExifMarker) {
      // No EXIF data found — likely a screenshot or digitally created image
      if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
      await supabase.from("upload_jobs").update({
        status: "REJECTED",
        error_code: "NO_EXIF_DATA",
        reason: "Digital screenshots rejected. Real-world camera noise required.",
        processed_at: new Date().toISOString()
      }).eq("id", job.id);
      return { jobId: job.id, result: "REJECTED", reason: "Digital screenshots rejected. Real-world camera noise required." };
    }
  }

  // ---- 2. AI Verification ----
  var specificTask = job.assigned_task || "Clear authentic human face looking at the camera";

  var qualityRules = isSelfie
    ? "You are a STRICT auditor. Is this a clear, authentic photograph of a real human face taken by a camera? You MUST reject AI-generated faces, cartoons, drawings, photos of screens, or masks. CRITICAL: You must also verify if the user explicitly complied with this specific directive: '" + specificTask + "'. If they failed this specific directive, or if the lighting/angle is wrong, set quality_pass to false and explain exactly why they failed the specific directive."
    : "You are a STRINGENT data quality gatekeeper. You MUST reject this image if ANY of the following are true: (a) It is a screenshot or screen capture of any device. (b) It contains digital/typed/printed text from a computer, phone, or textbook. (c) It is a photo of a textbook, printed book page, or PDF document. (d) It is a random photo of an object, animal, scenery, or food that is NOT a document. (e) It is a blank or nearly blank page. (f) It contains human faces, selfies, or portrait photos. You may ONLY approve images that are authentic photographs of PHYSICAL, HANDWRITTEN notes written on real paper containing: " + (job.content_tags ? job.content_tags.join(", ") : "academic content") + ". The handwriting must be clearly visible and the content must be educational or informational. If rejecting, state the exact reason like 'Screenshot detected', 'Printed/digital text - not handwritten', 'Random photo - not a document', or 'Textbook page - not handwritten notes'.";

  var combinedPrompt;
  if (isSelfie) {
    combinedPrompt = "You are an extremely strict security AI validator for a data quality platform. Your job is to PROTECT the dataset from low-quality or fraudulent submissions. When in doubt, REJECT. Evaluate this image for:\n" +
      "1. QUALITY: " + qualityRules + "\n" +
      "2. PII: Does this image contain Sensitive Personal Identifiable Information (phone numbers, home addresses, government IDs like Aadhaar/SSN, bank account numbers, or passwords)?\n" +
      "3. VISUAL SIGNATURE: Generate a compact descriptor of the person's appearance. Include clothing color/type, facial hair status, background environment, and lighting. Example: 'blue_tshirt_clean_shaven_white_wall_natural_light'. This is used to prevent duplicate dataset entries.\n" +
      'You MUST respond STRICTLY with JSON: {"quality_pass": true_or_false, "contains_pii": true_or_false, "visual_signature": "compact_descriptor_string", "reason": "Concise specific reason for your decision"}';
  } else {
    combinedPrompt = "Evaluate this document and return a JSON object with 'quality_pass', 'category_tier', 'quality_score', and 'contains_pii'. " +
      "If 'contains_pii' is true (SSN, credit cards, sensitive IDs, Aadhaar numbers, bank account numbers, passwords), immediately flag for purging: set quality_pass to false and yield quality_score 0. " +
      "If false, calculate 'quality_score' (0-100) strictly based on: 40% Information Density (extractable entities/tables), 30% Visual Integrity (OCR confidence, lighting, no glare), 20% Structural Complexity (handwritten margins, mixed layouts), 10% Rarity (unique localized formats). " +
      "GRADING HARSHNESS: A score of 100 should be virtually impossible (0.001% probability). Reserve 90+ ONLY for flawless, perfectly lit, highly dense academic notes with zero artifacts. Most decent submissions should score 60-80. Be ruthless. " +
      "Classify 'category_tier' as 1 (High Value: Invoices, Contracts, Medical Records), 2 (Mid Value: Receipts, Handwritten Notes, Academic), or 3 (Low Value: Menus, Flyers, Generic Prints). " +
      "ADDITIONAL REJECTION RULES: " + qualityRules + " " +
      "If the image fails quality rules, set quality_pass to false and quality_score to 0. " +
      'You MUST respond STRICTLY with JSON: {"quality_pass": true_or_false, "contains_pii": true_or_false, "category_tier": 1_or_2_or_3, "quality_score": 0_to_100, "reason": "Concise specific reason for your decision"}';
  }

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

  // ---- 6a. VISUAL SIGNATURE ANTI-FRAUD (Selfies Only) ----
  if (isSelfie && aiVerdict.visual_signature) {
    var { data: pastSelfies } = await supabase
      .from("upload_jobs")
      .select("visual_signature")
      .eq("user_email", job.user_email)
      .eq("task_type", "selfie")
      .eq("status", "VERIFIED")
      .not("visual_signature", "is", null)
      .neq("id", job.id);

    if (pastSelfies && pastSelfies.length > 0) {
      var newSigWords = aiVerdict.visual_signature.toLowerCase().split("_");
      for (var ps = 0; ps < pastSelfies.length; ps++) {
        var oldSigWords = (pastSelfies[ps].visual_signature || "").toLowerCase().split("_");
        var matchCount = 0;
        for (var w = 0; w < newSigWords.length; w++) {
          if (oldSigWords.indexOf(newSigWords[w]) !== -1) matchCount++;
        }
        var similarity = newSigWords.length > 0 ? (matchCount / newSigWords.length) : 0;
        if (similarity >= 0.8) {
          if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
          await supabase.from("upload_jobs").update({
            status: "REJECTED",
            error_code: "VISUAL_DUPLICATE",
            reason: "Visual duplicate detected. To ensure dataset variance, please change your clothing, lighting, or background environment.",
            visual_signature: aiVerdict.visual_signature,
            processed_at: new Date().toISOString()
          }).eq("id", job.id);
          return { jobId: job.id, result: "REJECTED", reason: "Visual duplicate detected" };
        }
      }
    }
  }

  var verifiedPath = "verified/" + job.user_email + "/" + Date.now() + "_" + job.file_name;
  if (relativeFilePath) {
    await supabase.storage.from("verified_assets").move(relativeFilePath, verifiedPath);
  }
  var { data: finalUrlData } = supabase.storage.from("verified_assets").getPublicUrl(verifiedPath);

  // ---- 7. Calculate reward (Fractional Batch Formula) ----
  var rewardAmount = 0;

  if (isSelfie) {
    // Selfies: flat 40 SYNX
    rewardAmount = 40;
  } else {
    // Documents: Fractional formula = (Files_in_Batch / 5) * 100 * (quality_score / 100)
    // Max 5 files, max 20 SYNX per file, max 100 SYNX per batch
    var batchFileCount = 1;
    if (job.batch_id) {
      var { data: batchInfo } = await supabase
        .from("upload_batches")
        .select("total_jobs")
        .eq("id", job.batch_id)
        .maybeSingle();
      if (batchInfo && batchInfo.total_jobs) {
        batchFileCount = Math.min(batchInfo.total_jobs, 5); // Cap at 5
      }
    }

    var qualityScore = aiVerdict.quality_score || 0;
    if (qualityScore < 70) {
      // Sub-70 data is rejected to protect commercial packages
      if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
      await supabase.from("upload_jobs").update({
        status: "REJECTED",
        error_code: "LOW_QUALITY_SCORE",
        reason: "Quality score " + qualityScore + "/100 below minimum threshold (70). Tier " + (aiVerdict.category_tier || 3) + ".",
        processed_at: new Date().toISOString()
      }).eq("id", job.id);
      return { jobId: job.id, result: "REJECTED", reason: "Quality score " + qualityScore + "/100 below threshold" };
    }

    rewardAmount = Math.floor((batchFileCount / 5) * 100 * (qualityScore / 100));
    rewardAmount = Math.min(rewardAmount, batchFileCount * 20); // Hard cap: 20 SYNX per file
  }

  // Apply XP multiplier on top of the tier-based reward
  if (xpFunctions && xpFunctions.getXPProfile && xpFunctions.calculateFinalTaskReward) {
    try {
      var xpProfile = await xpFunctions.getXPProfile(supabase, job.user_email);
      var rewardInfo = xpFunctions.calculateFinalTaskReward(
        rewardAmount,
        xpProfile ? xpProfile.currentLevel : 1,
        xpProfile ? xpProfile.dailyStreak : 0
      );
      rewardAmount = rewardInfo.finalReward;
    } catch (xpErr) {
      console.warn("[QUEUE] XP profile lookup failed, using tier-based reward " + rewardAmount + ":", xpErr.message);
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
      visual_signature: aiVerdict.visual_signature || null,
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

    // ---- 1. Fetch queued jobs (Phase 2: Workload Separation & Fallback) ----
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

      // Assign job-specific key
      var keyName = await getAvailableKey(supabase, job.task_type);
      if (!keyName) {
        console.warn("[QUEUE] No keys available for task type: " + job.task_type + ". Skipping job " + job.id);
        results.push({ jobId: job.id, result: "SKIPPED", reason: "All keys on cooldown for this task type." });
        continue; // Keep it in QUEUED state
      }

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
      keyUsed: "multi-key",
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


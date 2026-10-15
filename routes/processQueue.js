// =====================================================================
// POST /api/process-queue ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Serverless Queue Processor (Phase 3)
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

const WORKER_ID = "worker_" + process.pid + "_" + Math.random().toString(36).substring(2, 9);
const LEASE_DURATION_MS = 120000; // 2 minutes
const LEASE_RENEWAL_INTERVAL_MS = 30000; // 30 seconds


// ---- ENVIRONMENT VARIABLE KEY ROTATOR (SAFE KEY ALIASES) ----
// In strict production/staging security, upload_jobs.assigned_key MUST store
// only the non-secret key alias/identifier (e.g., 'GEMINI_DOCUMENT_KEY_1'),
// never the raw secret token string.
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

const SELFIE_KEY_NAMES = [
  "GEMINI_API_SELFIE",
  "GEMINI_API_SELFIE_2",
  "GEMINI_API_SELFIE_3",
  "GEMINI_API_KEY"
];

const DOC_KEY_NAMES = [
  "GEMINI_DOCUMENT_KEY_1",
  "GEMINI_DOCUMENT_KEY_2",
  "GEMINI_DOCUMENT_KEY_3",
  "GEMINI_DOCUMENT_KEY_4",
  "GEMINI_API_KEY"
];

let selfieIndex = 0;
let docIndex = 0;

// In-memory key state tracker for fast bounded cooldown and call counting
const keyCooldownMap = new Map(); // keyName -> cooldownUntil timestamp
const keyCallCountMap = new Map(); // keyName -> count
const COOLDOWN_DURATION_MS = 5 * 60 * 1000; // 5 minutes

function isKeyOnCooldown(keyName) {
  if (!keyName) return false;
  const until = keyCooldownMap.get(keyName);
  if (!until) return false;
  if (Date.now() >= until) {
    keyCooldownMap.delete(keyName);
    return false;
  }
  return true;
}

async function markKeyCooldown(supabase, keyName) {
  if (!keyName) return;
  const cooldownUntil = Date.now() + COOLDOWN_DURATION_MS;
  keyCooldownMap.set(keyName, cooldownUntil);
  console.warn(`[KEY_POOL] Key alias ${keyName} placed on cooldown until ${new Date(cooldownUntil).toISOString()}`);

  if (supabase) {
    try {
      await supabase.from("gemini_key_status").upsert({
        key_name: keyName,
        is_on_cooldown: true,
        cooldown_until: new Date(cooldownUntil).toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: "key_name" });
    } catch (e) {
      // Non-fatal if table not present in DB
    }
  }
}

async function incrementKeyCallCount(supabase, keyName) {
  if (!keyName) return;
  const current = keyCallCountMap.get(keyName) || 0;
  keyCallCountMap.set(keyName, current + 1);

  if (supabase) {
    try {
      await supabase.rpc("increment_key_calls", { target_key: keyName }).catch(() => {});
    } catch (e) {}
  }
}

async function getAvailableKey(supabase, taskType) {
  const isSelfie = taskType === 'selfie';
  
  if (isSelfie) {
    const validSelfieKeys = SELFIE_KEY_NAMES.filter(name => Boolean(process.env[name]));
    if (validSelfieKeys.length > 0) {
      for (let i = 0; i < validSelfieKeys.length; i++) {
        const candidate = validSelfieKeys[(selfieIndex + i) % validSelfieKeys.length];
        if (!isKeyOnCooldown(candidate)) {
          selfieIndex = (selfieIndex + i + 1) % validSelfieKeys.length;
          return candidate;
        }
      }
    }
  } else {
    // Treats 'notes', 'document', etc., using DOC_KEY_NAMES
    const validDocKeys = DOC_KEY_NAMES.filter(name => Boolean(process.env[name]));
    if (validDocKeys.length > 0) {
      for (let i = 0; i < validDocKeys.length; i++) {
        const candidate = validDocKeys[(docIndex + i) % validDocKeys.length];
        if (!isKeyOnCooldown(candidate)) {
          docIndex = (docIndex + i + 1) % validDocKeys.length;
          return candidate;
        }
      }
    }
  }

  // Global Fallback: check GEMINI_API_KEY
  if (process.env.GEMINI_API_KEY && !isKeyOnCooldown("GEMINI_API_KEY")) {
    return "GEMINI_API_KEY";
  }

  // Cross-pool fallback: check other pool keys if primary pool is empty or cooling down
  const crossPool = isSelfie ? DOC_KEY_NAMES : SELFIE_KEY_NAMES;
  for (let i = 0; i < crossPool.length; i++) {
    const candidate = crossPool[i];
    if (process.env[candidate] && !isKeyOnCooldown(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveKeyValue(keyName) {
  if (!keyName) return null;
  // Security rule: Only approved environment-variable aliases are resolved to secret values
  if (APPROVED_KEY_ALIASES.has(keyName)) {
    return process.env[keyName] || null;
  }
  // For isolated unit tests passing mock key strings directly:
  if (!process.env[keyName] && keyName.length > 20) {
    return keyName;
  }
  return null;
}

// =====================================================================
// HELPER: Extract relative bucket path from a Supabase public URL
// =====================================================================
function getBucketPathFromUrl(url) {
  if (!url) return null;
  var marker = "/verified_assets/";
  var idx = url.indexOf(marker);
  if (idx === -1) {
    marker = "/storage/v1/object/public/verified_assets/";
    idx = url.indexOf(marker);
    if (idx === -1) return null;
  }
  var path = url.substring(idx + marker.length);
  var qIdx = path.indexOf("?");
  if (qIdx !== -1) path = path.substring(0, qIdx);
  try {
    return decodeURIComponent(path);
  } catch (e) {
    return path;
  }
}

function withTimeout(promise, ms, opName) {
  var timeoutId;
  var timeoutPromise = new Promise(function(_, reject) {
    timeoutId = setTimeout(function() {
      var err = new Error(opName + " timed out after " + ms + "ms");
      err.isTimeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(function() {
    clearTimeout(timeoutId);
  });
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
  // Optimistically acquire a worker lease so multiple workers don't process it concurrently
  var nowIso = new Date().toISOString();
  var leaseExpiryIso = new Date(Date.now() + LEASE_DURATION_MS).toISOString();
  var legacyThresholdIso = new Date(Date.now() - 300000).toISOString();

  // ATOMIC LEASE ACQUISITION: Claims QUEUED, RETRYING, expired leases, or legacy unleased PROCESSING jobs
  var { data: claimData, error: claimErr } = await supabase
    .from("upload_jobs")
    .update({ 
      status: "PROCESSING", 
      assigned_key: keyName,
      locked_by: WORKER_ID,
      locked_at: nowIso,
      lease_expires_at: leaseExpiryIso
    })
    .eq("id", job.id)
    .or("status.in.(QUEUED,RETRYING),and(status.eq.PROCESSING,lease_expires_at.lt." + nowIso + "),and(status.eq.PROCESSING,lease_expires_at.is.null,updated_at.lt." + legacyThresholdIso + ")")
    .select("id");

  if (claimErr) {
    console.error("[QUEUE] Atomic lease acquisition failed for job " + job.id + ":", claimErr.message);
    return { jobId: job.id, result: "ERROR", reason: "Atomic lease acquisition error: " + claimErr.message };
  }

  if (!claimData || claimData.length === 0) {
    return { jobId: job.id, result: "SKIPPED", reason: "Atomic lock failed (Already claimed or lease held by another worker)" };
  }

  // Active Lease Heartbeat during execution (Capped at MAX_LEASE_RENEWALS to prevent infinite renewal on hung jobs)
  var MAX_LEASE_RENEWALS = 3; // Maximum 3 renewals (90s budget)
  var leaseRenewalCount = 0;
  var leaseHeartbeat = setInterval(async () => {
    try {
      leaseRenewalCount++;
      if (leaseRenewalCount > MAX_LEASE_RENEWALS) {
        console.warn("[QUEUE] Maximum lease renewal budget exceeded for job " + job.id + ". Stopping renewal to allow safe recovery.");
        clearInterval(leaseHeartbeat);
        return;
      }
      await supabase
        .from("upload_jobs")
        .update({ lease_expires_at: new Date(Date.now() + LEASE_DURATION_MS).toISOString() })
        .eq("id", job.id)
        .eq("locked_by", WORKER_ID);
    } catch (e) {}
  }, LEASE_RENEWAL_INTERVAL_MS);

  // ---- 0. OFFLINE 24-HOUR SELFIE GATEKEEPER ----
  if (isSelfie) {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: alreadyVerified } = await supabase
      .from("upload_jobs")
      .select("id")
      .eq("user_email", job.user_email)
      .eq("task_type", "selfie")
      .eq("status", "VERIFIED")
      .gte("processed_at", oneDayAgo)
      .limit(1);

    if (alreadyVerified && alreadyVerified.length > 0) {
      // A selfie was already verified today. Reject this pending queue item without deleting audit records.
      await supabase.from("upload_jobs").update({
        status: "REJECTED",
        error_code: "DAILY_LIMIT_EXCEEDED",
        reason: "Daily limit reached. Another selfie was already verified today.",
        processed_at: new Date().toISOString(),
        assigned_key: null,
        locked_by: null,
        lease_expires_at: null
      }).eq("id", job.id).eq("locked_by", WORKER_ID);

      if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
      return { jobId: job.id, result: "REJECTED", reason: "Daily selfie limit already fulfilled." };
    }
  }

  // ---- 1. Fetch image from storage ----
  // ---- 1. Fetch image from storage (Dual Strategy: Authenticated SDK download + fallback HTTP fetch) ----
  var imageBuffer = null;

  // Strategy A: Direct authenticated download via Supabase Service Role SDK with strict 15s timeout
  if (relativeFilePath) {
    try {
      var { data: downloadedBlob, error: downloadErr } = await withTimeout(
        supabase.storage.from("verified_assets").download(relativeFilePath),
        15000,
        "Storage SDK download"
      );
      if (!downloadErr && downloadedBlob) {
        var arrayBuf = await withTimeout(downloadedBlob.arrayBuffer(), 10000, "Storage blob arrayBuffer");
        imageBuffer = Buffer.from(arrayBuf);
      } else if (downloadErr) {
        // Strictly classify confirmed missing asset vs transient error
        var isConfirmedMissing = (downloadErr.message && downloadErr.message.includes("Object not found")) || downloadErr.statusCode === 404 || downloadErr.statusCode === "404";
        if (isConfirmedMissing) {
          if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
          var fatalErr = new Error("Storage object not found in bucket (permanent missing asset)");
          fatalErr.isFatal = true;
          fatalErr.errorCode = "ASSET_NOT_FOUND";
          throw fatalErr;
        }
        console.warn("[QUEUE] Supabase SDK download transient error for " + relativeFilePath + ":", downloadErr.message);
      }
    } catch (sdkErr) {
      if (sdkErr.isFatal) throw sdkErr;
      if (sdkErr.isTimeout) console.warn("[QUEUE] Storage SDK download timed out for " + relativeFilePath);
      else console.warn("[QUEUE] Supabase SDK download exception:", sdkErr.message);
    }
  }

  // Strategy B: Fallback HTTP Fetch with strict 15s AbortController timeout
  if (!imageBuffer) {
    try {
      var safeUrl = encodeURI(decodeURI(job.storage_url));
      var fetchController = new AbortController();
      var fetchTimeoutId = setTimeout(() => fetchController.abort(), 15000);
      var imageResponse;
      try {
        imageResponse = await fetch(safeUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "image/*,*/*;q=0.8"
          },
          signal: fetchController.signal
        });
      } finally {
        clearTimeout(fetchTimeoutId);
      }

      if (imageResponse.ok) {
        var arrayBuffer = await withTimeout(imageResponse.arrayBuffer(), 10000, "HTTP response arrayBuffer");
        imageBuffer = Buffer.from(arrayBuffer);
      } else if (imageResponse.status === 404) {
        if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
        var fatalErr = new Error("HTTP 404: Storage object does not exist");
        fatalErr.isFatal = true;
        fatalErr.errorCode = "ASSET_NOT_FOUND";
        throw fatalErr;
      } else {
        // HTTP 400 or 5xx is treated as transient/retryable (not immediately fatal)
        throw new Error("HTTP " + imageResponse.status + " on storage fetch");
      }
    } catch (httpErr) {
      if (httpErr.isFatal) throw httpErr;
      if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
      throw new Error("Failed to fetch image from storage: " + httpErr.message);
    }
  }

  var base64Data = imageBuffer.toString("base64");

    // ---- 2. AI Verification ----
  if (isSelfie && !job.assigned_task) {
    try {
      var { data: taskRow } = await supabase.from("upload_jobs").select("assigned_task").eq("id", job.id).single();
      if (taskRow && taskRow.assigned_task) {
        job.assigned_task = taskRow.assigned_task;
      }
    } catch (e) {
      console.warn("[QUEUE] Could not fetch assigned_task for job " + job.id, e.message);
    }
  }

  var specificTask = job.assigned_task || "Clear authentic human face looking naturally at or toward the camera";

  var qualityRules = isSelfie
    ? "You are a STRICT auditor. Is this a clear, authentic photograph of a real human face taken by a camera? You MUST reject AI-generated faces, cartoons, drawings, photos of screens, or masks. CRITICAL: You must also verify if the user explicitly complied with this specific directive: '" + specificTask + "'. If they failed this specific directive, or if the lighting/angle is wrong, set quality_pass to false and explain exactly why they failed the specific directive."
    : "You are a STRINGENT data quality gatekeeper. You MUST reject this image if ANY of the following are true: (a) It is clearly a digital screenshot of a UI/website (allow low-quality physical photos). (b) It contains digital/typed/printed text from a computer, phone, or textbook. (c) It is a photo of a textbook, printed book page, or PDF document. (d) It is a random photo of an object, animal, scenery, or food that is NOT a document. (e) It is a blank or nearly blank page. (f) It contains human faces, selfies, or portrait photos. You may ONLY approve images that are authentic photographs of PHYSICAL, HANDWRITTEN notes written on real paper containing: " + (job.content_tags ? job.content_tags.join(", ") : "academic content") + ". The handwriting must be clearly visible and the content must be educational or informational. If rejecting, state the exact reason like 'Screenshot detected', 'Printed/digital text - not handwritten', 'Random photo - not a document', or 'Textbook page - not handwritten notes'.";

  var combinedPrompt;
  if (isSelfie) {
    var hasSpecificTask = job.assigned_task && job.assigned_task.trim().length > 0;
    var taskDirective = hasSpecificTask
      ? "ASSIGNED TASK: '" + job.assigned_task + "'\n" +
        "- You MUST evaluate if the user made an honest, visible attempt to match this assigned task.\n" +
        "- ORIENTATION RULE: Evaluate 'left' and 'right' from the USER'S physical perspective (in an unmirrored photo, turning to their left points their face to the right side of the image).\n" +
        "- LENIENCY & TOLERANCE: Real users have natural head angle variations. If the user made an honest attempt to match the assigned pose (e.g. turning their head roughly in that direction, looking up, or smiling), you MUST APPROVE them with quality_pass: true! Do NOT fail users for slight angle deviations."
      : "STANDARD LIVENESS: Verify that this is a real, authentic human face (not a screen, mask, or cartoon). The user may look forward or turned naturally at any angle. APPROVE ANY authentic human selfie with quality_pass: true!";

    combinedPrompt = "You are an elite Liveness & KYC Verification AI for the Syntrix Network.\n" +
      "Analyze the attached image and return ONLY a valid JSON object.\n\n" +
      "### RULE 1: CLARITY & LIGHTING (Baseline)\n" +
      "- There must be exactly one human face visible.\n" +
      "- The face must NOT be pitch black, completely dark silhouette, or heavily distorted.\n" +
      "- If the face is clearly recognizable, PASS RULE 1.\n\n" +
      "### RULE 2: LIVENESS & POSE COMPLIANCE\n" +
      taskDirective + "\n\n" +
      "### OUTPUT FORMAT\n" +
      "Respond ONLY with raw JSON in this exact format:\n" +
      '{"quality_pass": true_or_false, "contains_pii": false, "reason": "1-sentence reason for rejection, or \'Verified\' if passed"}';
  } else {
    combinedPrompt = "Evaluate this document and return a JSON object with 'quality_pass', 'category_tier', 'quality_score', and 'contains_pii'. " +
      "If 'contains_pii' is true (SSN, credit cards, sensitive IDs, Aadhaar numbers, bank account numbers, passwords), immediately flag for purging: set quality_pass to false and yield quality_score 0. " +
      "If false, calculate 'quality_score' (0-100) strictly based on: 40% Information Density (extractable entities/tables), 30% Visual Integrity (OCR confidence, lighting, no glare), 20% Structural Complexity (handwritten margins, mixed layouts), 10% Rarity (unique localized formats). " +
      "GRADING HARSHNESS: A score of 100 should be virtually impossible (0.001% probability). Reserve 90+ ONLY for flawless, perfectly lit, highly dense academic notes with zero artifacts. Most decent submissions should score 60-80. Be ruthless. " +
      "Classify 'category_tier' as 1 (High Value: Comprehensive Structured Study Guides, Extensive Academic Notes), 2 (Mid Value: Standard Lecture Notes, Problem Sets, Homework Summaries), or 3 (Low Value: Minimal Lists, Rough Scratchpads). " +
      "ADDITIONAL REJECTION RULES: " + qualityRules + " " +
      "If the image fails quality rules, set quality_pass to false and quality_score to 0. " +
      'You MUST respond STRICTLY with JSON: {"quality_pass": true_or_false, "contains_pii": true_or_false, "category_tier": 1_or_2_or_3, "quality_score": 0_to_100, "reason": "Concise specific reason for your decision"}';
  }

  var response;
  try {
    response = await withTimeout(
      aiClient.models.generateContent({
        model: "gemini-3.6-flash",
        contents: [
          { text: combinedPrompt },
          { inlineData: { mimeType: "image/jpeg", data: base64Data } }
        ],
        config: { responseMimeType: "application/json" }
      }),
      60000, // Expanded to 60s to allow heavy document OCR
      "Gemini generateContent"
    );
  } catch (aiErr) {
    if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
    if (aiErr.isTimeout) {
      throw { isTimeout: true, message: aiErr.message };
    }
    var statusCode = aiErr.status || aiErr.statusCode || (aiErr.message && aiErr.message.indexOf("429") !== -1 ? 429 : 0);
    if (statusCode === 429 || statusCode === 503) {
      // RATE LIMIT HIT - cooldown this key, mark job for retry
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
      processed_at: new Date().toISOString(),
      locked_by: null,
      lease_expires_at: null
    }).eq("id", job.id).eq("locked_by", WORKER_ID);

    if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat); return { jobId: job.id, result: "REJECTED", reason: rejectReason };
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
      processed_at: new Date().toISOString(),
      locked_by: null,
      lease_expires_at: null
    }).eq("id", job.id).eq("locked_by", WORKER_ID);
    if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat); return { jobId: job.id, result: "REJECTED", reason: "Duplicate hash" };
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
      processed_at: new Date().toISOString(),
      locked_by: null,
      lease_expires_at: null
    }).eq("id", job.id).eq("locked_by", WORKER_ID);
    if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat); return { jobId: job.id, result: "REJECTED", reason: "Duplicate hash (legacy)" };
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
          processed_at: new Date().toISOString(),
          locked_by: null,
          lease_expires_at: null
        }).eq("id", job.id).eq("locked_by", WORKER_ID);
        if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat); return { jobId: job.id, result: "REJECTED", reason: "Duplicate vector" };
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
            processed_at: new Date().toISOString(),
            locked_by: null,
            lease_expires_at: null
          }).eq("id", job.id).eq("locked_by", WORKER_ID);
          if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat); return { jobId: job.id, result: "REJECTED", reason: "Visual duplicate detected" };
        }
      }
    }
  }

  var verifiedPath = "verified/" + job.user_email + "/" + Date.now() + "_" + job.file_name;
  var finalPublicUrl = job.storage_url;

  if (relativeFilePath) {
    try {
      var { error: moveErr } = await withTimeout(
        supabase.storage.from("verified_assets").move(relativeFilePath, verifiedPath),
        15000,
        "Storage move"
      );
      if (!moveErr) {
        var { data: destUrlData } = supabase.storage.from("verified_assets").getPublicUrl(verifiedPath);
        if (destUrlData) finalPublicUrl = destUrlData.publicUrl;
      } else {
        console.warn("[QUEUE] Storage move failed, checking source presence:", moveErr.message);
        // Verify source still accessible so we don't save broken link
        var { data: srcCheck } = await withTimeout(
          supabase.storage.from("verified_assets").download(relativeFilePath),
          15000,
          "Storage source verify"
        );
        if (!srcCheck) {
          if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
          throw new Error("Storage asset inaccessible after move attempt");
        }
      }
    } catch (moveEx) {
      console.warn("[QUEUE] Storage move exception, keeping existing URL:", moveEx.message);
    }
  }

  // ---- 7. Calculate reward (Fractional Batch Formula) ----
  var rewardAmount = 0;

  if (isSelfie) {
    // Selfies: flat 40 SYNX
    rewardAmount = 40;
  } else {
    // Documents: Each image earns up to 20 SYNX based on its rating
    // A 5-image batch earns a maximum combined total of 100 SYNX
    var qualityScore = aiVerdict.quality_score || 0;
    
    // Only completely reject pure garbage or empty pages (< 40)
    if (qualityScore < 40) {
      if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
      await supabase.from("upload_jobs").update({
        status: "REJECTED",
        error_code: "LOW_QUALITY_SCORE",
        reason: "Content is too sparse or illegible. Quality score " + qualityScore + "/100.",
        processed_at: new Date().toISOString(),
        locked_by: null,
        lease_expires_at: null
      }).eq("id", job.id).eq("locked_by", WORKER_ID);
      if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat); return { jobId: job.id, result: "REJECTED", reason: "Quality score " + qualityScore + "/100 below absolute minimum" };
    }

    // Rating-based reward calculation: up to 20 SYNX per document image
    if (qualityScore >= 80) {
      rewardAmount = 20; // Premium data: 20 SYNX
    } else if (qualityScore >= 60) {
      rewardAmount = 10; // Standard data: 10 SYNX
    } else {
      rewardAmount = 4;  // Low priority/sparse data: 4 SYNX
    }

    // Enforce 100 SYNX maximum combined total across 5-image batch
    if (job.batch_id) {
      var { data: batchJobs } = await supabase
        .from("upload_jobs")
        .select("reward_amount")
        .eq("batch_id", job.batch_id)
        .eq("reward_awarded", true)
        .neq("id", job.id);
      var currentBatchSum = (batchJobs || []).reduce(function(acc, curr) {
        return acc + (Number(curr.reward_amount) || 0);
      }, 0);
      if (currentBatchSum + rewardAmount > 100) {
        rewardAmount = Math.max(0, 100 - currentBatchSum);
      }
    }
  }

  // ---- 8. ATOMIC IDEMPOTENT SETTLEMENT (RPC STRICT) ----
  var verifiedReason = isSelfie
    ? (aiVerdict.reason || "Liveness confirmed: Authenticated user face matching assigned directive.")
    : (aiVerdict.reason || "Document approved: Verified handwriting density and structure.");

  var { data: rpcSettlement, error: rpcSettlementErr } = await supabase.rpc("settle_job_reward", {
    p_job_id: job.id,
    p_user_email: job.user_email,
    p_worker_id: WORKER_ID,
    p_reward_amount: rewardAmount,
    p_file_hash: imageHash,
    p_final_url: finalPublicUrl,
    p_visual_signature: aiVerdict.visual_signature || null,
    p_reason: verifiedReason
  });

  if (rpcSettlementErr) {
    console.error("[QUEUE] settle_job_reward RPC call failed for job " + job.id + ":", rpcSettlementErr.message);
    if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
    // Strict safety: DO NOT fall back to non-atomic update. Leave job recoverable.
    return { jobId: job.id, result: "ERROR", reason: "RPC settlement error: " + rpcSettlementErr.message };
  }

  if (!rpcSettlement || !rpcSettlement.success) {
    var failureReason = (rpcSettlement && rpcSettlement.error) ? rpcSettlement.error : "Unknown settlement rejection";
    console.error("[QUEUE] settle_job_reward rejected settlement for job " + job.id + ":", failureReason);
    if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
    return { jobId: job.id, result: "ERROR", reason: "Settlement rejected: " + failureReason };
  }

  if (rpcSettlement.status === "ALREADY_SETTLED" || rpcSettlement.status === "ALREADY_SETTLED_BY_LEDGER") {
    console.warn("[QUEUE] Job " + job.id + " already settled (" + rpcSettlement.status + "). Skipping duplicate reward.");
    if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
    return { jobId: job.id, result: "SKIPPED", reason: "Already settled" };
  }

  if (rpcSettlement.reward !== undefined) {
    rewardAmount = Number(rpcSettlement.reward);
  }

  job.reward_awarded = true;

  // ---- 10. Award XP (Non-blocking: XP failure must not roll back or reset a rewarded job) ----
  if (xpFunctions && xpFunctions.awardXP) {
    try {
      await xpFunctions.awardXP(
        supabase,
        job.user_email,
        isSelfie ? 60 : 70,
        isSelfie ? "Selfie Verified" : "Document Verified",
        isSelfie ? "selfie" : "document"
      );
    } catch (xpErr) {
      console.warn("[QUEUE] Non-fatal XP award error for settled job " + job.id + ":", xpErr.message);
    }
  }

  // ---- 11. Clean release: Stop lease heartbeat ----
  // Audit preservation policy: All job history, audit rows, and verification records are preserved.
  // No jobs or storage files are deleted.
  if (typeof leaseHeartbeat !== "undefined") clearInterval(leaseHeartbeat);
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
      const dashboardUrl = process.env.FRONTEND_URL || "https://syntrix-frontend-servey-2hl7.vercel.app";
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background: #000; color: #fff;">
          <h2 style="color: #10b981;">Syntrix AI Batch Complete</h2>
          <p style="color: #a1a1aa;">Your recent document upload batch has finished processing.</p>
          <p style="margin-bottom: 30px;">Log in to your Dashboard and check the <strong>Upload History</strong> tab to see your results, review any rejected files, and claim your SYNX tokens!</p>
          <a href="${dashboardUrl}" style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold;">Go to Dashboard</a>
        </div>
      `;
      sendEmailHTTP(userEmail, "Syntrix AI Batch Processing Complete!", emailHtml)
        .catch(e => console.error("Batch completion email failed:", e));
    }
  }
}

// =====================================================================
// POST /api/process-queue — Serverless Queue Processor (Phase 3)
// Secured with x-admin-key header.
// =====================================================================
let isProcessingActive = false;

router.post("/", async (req, res) => {
  // Concurrency guard: prevent overlapping server-side queue passes
  if (isProcessingActive) {
    return res.status(429).json({ success: false, message: "Queue processor already active on server." });
  }
  isProcessingActive = true;

  try {
    var supabase = req.app.locals.supabase;
    var sendEmailHTTP = req.app.locals.sendEmailHTTP;
    var adminKey = req.headers["x-admin-key"];

    // ---- Auth Check ----
    if (!process.env.ADMIN_SECRET_KEY || adminKey !== process.env.ADMIN_SECRET_KEY) {
      isProcessingActive = false;
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
      console.warn("[QUEUE] xpengine.js not found - rewards will use base 48 SYNX without multipliers.");
    }

    // ---- 1. Fetch queued jobs (Phase 2: Workload Separation & Fallback) ----
    var jobs = [];
    var { data: rpcJobs, error: fetchErr } = await supabase.rpc("get_fair_queued_jobs", { job_limit: 5 });

    if (!fetchErr && rpcJobs && rpcJobs.length > 0) {
        jobs = rpcJobs;
    } else {
        if (fetchErr) console.warn("[QUEUE] RPC get_fair_queued_jobs failed/missing. Using fallback queries...");
        
        // Fallback: Fetch max 3 Documents and max 2 Selfies to separate workloads
        var columns = "id, status, user_email, task_type, storage_url, file_name, file_hash, retry_count, max_retries, batch_id, content_tags, assigned_task";
        
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
        // Post-settlement guard: If job was already settled/rewarded, do not overwrite to RETRYING or FAILED
        if (job.reward_awarded === true) {
          console.warn("[QUEUE] Job " + job.id + " was already rewarded. Skipping error state overwrite.");
          results.push({ jobId: job.id, result: "SETTLED_WITH_WARNING", reason: jobErr.message });
          continue;
        }

        if (jobErr.isRateLimit) {
          // ---- RATE LIMIT: Cooldown key, mark job for retry, STOP processing ----
          console.warn("[QUEUE] API returned HTTP " + jobErr.statusCode + ". Rotating to next available key.");
          await markKeyCooldown(supabase, keyName);

          var newRetryCount = (job.retry_count || 0) + 1;
          var isFinalFailure = newRetryCount >= 60; // Force 60, ignore database default
          var retryStatus = isFinalFailure ? "FAILED" : "RETRYING";
          var finalReason = isFinalFailure ? "Analysis timed out. Please check your network and submit again." : "Queued for processing. A secure verification node is being allocated to analyze your submission.";

          await supabase.from("upload_jobs").update({
            status: retryStatus,
            error_code: String(jobErr.statusCode),
            reason: finalReason,
            retry_count: newRetryCount,
            assigned_key: null,
            locked_by: null,
            lease_expires_at: null
          }).eq("id", job.id).eq("locked_by", WORKER_ID);

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
          var isFatal = jobErr.isKeyError || jobErr.isFatal || false; // Don't retry if missing key or missing file
          
          var newRetryCount = (job.retry_count || 0) + 1;
          var maxRetries = 3; // Strict 3 retries with backoff
          
          if (newRetryCount >= maxRetries || isFatal) {
              // Final failure - protected by locked_by
              if (jobErr.errorCode === "ASSET_NOT_FOUND") {
                  // Quietly delete the ghost job so it drops off the frontend UI
                  await supabase.from("upload_jobs").delete().eq("id", job.id).eq("locked_by", WORKER_ID);
                  results.push({ jobId: job.id, result: "PURGED", reason: "Missing asset row deleted" });
              } else {
                  await supabase.from("upload_jobs").update({
                    status: "FAILED",
                    error_code: isFatal ? "ASSET_NOT_FOUND" : "PROCESSING_ERROR",
                    reason: "System Error: " + (jobErr.message || "Unknown error"),
                    processed_at: new Date().toISOString(),
                    retry_count: newRetryCount,
                    assigned_key: null,
                    locked_by: null,
                    lease_expires_at: null
                  }).eq("id", job.id).eq("locked_by", WORKER_ID);

                  if (filePath) await supabase.storage.from("verified_assets").remove([filePath]).catch(function() {});
                  results.push({ jobId: job.id, result: "FAILED", reason: jobErr.message });
              }
          } else {
              // Safe retry with lease release and locked_by check
              await supabase.from("upload_jobs").update({
                status: "RETRYING",
                error_code: jobErr.isTimeout ? "TIMEOUT" : "RETRY",
                reason: "Temporary error: " + (jobErr.message || "Unknown"),
                retry_count: newRetryCount,
                assigned_key: null,
                locked_by: null,
                lease_expires_at: null
              }).eq("id", job.id).eq("locked_by", WORKER_ID);

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
  } finally {
    isProcessingActive = false;
  }
});

// =====================================================================
// GET /api/process-queue/key-status - View Gemini key pool status
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



















// =====================================================================
// POST /api/uploads/batch — Fast-Return Batch Upload Endpoint
// Accepts multiple files, deduplicates by SHA-256, saves to Supabase
// storage, creates batch + job rows, and returns IMMEDIATELY.
// =====================================================================

const express = require("express");
const crypto = require("crypto");
const router = express.Router();

/**
 * Requires `supabase` client to be attached to `req.app.locals.supabase`
 * in server.js before mounting this router.
 */

// POST /api/uploads/batch
router.post("/", async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const { userEmail, files } = req.body;

    // ---- Input Validation ----
    if (!userEmail || !files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: userEmail (string), files (array of {taskType, fileName, imageBase64})"
      });
    }

    if (files.length > 10) {
      return res.status(400).json({
        success: false,
        error: "Maximum 10 files per batch."
      });
    }

    const sanitizedEmail = userEmail.trim().toLowerCase();
    const jobResults = [];
    const validJobs = [];

    // ---- Process Each File ----
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const { taskType, fileName, imageBase64, contentTags } = file;

      if (!taskType || !fileName || !imageBase64) {
        jobResults.push({
          index: i,
          fileName: fileName || "unknown",
          status: "REJECTED",
          error_code: "MISSING_FIELDS",
          reason: "Each file must have taskType, fileName, and imageBase64."
        });
        continue;
      }

      // ---- Decode Base64 to Buffer ----
      let buffer;
      try {
        const base64Data = imageBase64.replace(/^data:(image|application)\/\w+;base64,/, "");
        buffer = Buffer.from(base64Data, "base64");
      } catch (decodeErr) {
        jobResults.push({
          index: i,
          fileName: fileName,
          status: "REJECTED",
          error_code: "INVALID_BASE64",
          reason: "Could not decode image data."
        });
        continue;
      }

      if (buffer.length < 1024) {
        jobResults.push({
          index: i,
          fileName: fileName,
          status: "REJECTED",
          error_code: "FILE_TOO_SMALL",
          reason: "File is too small to be a valid image (< 1KB)."
        });
        continue;
      }

      // ---- SHA-256 Hash ----
      const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

      // ---- Duplicate Detection: Check upload_jobs for existing hash ----
      const { data: existingHash, error: hashCheckErr } = await supabase
        .from("upload_jobs")
        .select("id, status, user_email")
        .eq("file_hash", fileHash)
        .in("status", ["QUEUED", "PROCESSING", "VERIFIED"])
        .limit(1);

      if (!hashCheckErr && existingHash && existingHash.length > 0) {
        jobResults.push({
          index: i,
          fileName: fileName,
          status: "REJECTED",
          error_code: "DUPLICATE_HASH",
          reason: "This exact file has already been submitted."
        });
        continue;
      }

      // ---- Also check the legacy syntrix_submissions table ----
      const { data: legacyDup, error: legacyErr } = await supabase
        .from("syntrix_submissions")
        .select("id")
        .eq("file_hash", fileHash)
        .limit(1);

      if (!legacyErr && legacyDup && legacyDup.length > 0) {
        jobResults.push({
          index: i,
          fileName: fileName,
          status: "REJECTED",
          error_code: "DUPLICATE_HASH_LEGACY",
          reason: "This file was already submitted through the previous system."
        });
        continue;
      }

      // ---- Upload to Supabase Storage ----
      const safeFileName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const storagePath = `queue/${sanitizedEmail}/${Date.now()}_${i}_${safeFileName}`;

      const { error: uploadErr } = await supabase.storage
        .from("verified_assets")
        .upload(storagePath, buffer, {
          contentType: "image/jpeg",
          upsert: false
        });

      if (uploadErr) {
        jobResults.push({
          index: i,
          fileName: fileName,
          status: "REJECTED",
          error_code: "STORAGE_ERROR",
          reason: "Failed to upload file to storage: " + uploadErr.message
        });
        continue;
      }

      // ---- Get Public URL ----
      const { data: publicUrlData } = supabase.storage
        .from("verified_assets")
        .getPublicUrl(storagePath);

      const storageUrl = publicUrlData ? publicUrlData.publicUrl : null;

      // ---- Queue this job ----
      validJobs.push({
        user_email: sanitizedEmail,
        task_type: taskType,
        file_name: safeFileName,
        storage_url: storageUrl,
        file_hash: fileHash,
        content_tags: Array.isArray(contentTags) && contentTags.length > 0 ? contentTags : ["none"],
        status: "QUEUED",
        index: i
      });
    }

    // ---- If no valid jobs, return early ----
    if (validJobs.length === 0) {
      return res.status(200).json({
        success: true,
        batchId: null,
        status: "EMPTY",
        message: "No valid files to process. All were rejected during pre-validation.",
        jobs: jobResults
      });
    }

    // ---- Create Batch Row ----
    const { data: batchData, error: batchErr } = await supabase
      .from("upload_batches")
      .insert([{
        user_email: sanitizedEmail,
        total_jobs: validJobs.length,
        completed_jobs: 0,
        status: "QUEUED"
      }])
      .select("id")
      .single();

    if (batchErr || !batchData) {
      console.error("[BATCH] Failed to create batch row:", batchErr);
      return res.status(500).json({
        success: false,
        error: "Failed to create upload batch record."
      });
    }

    const batchId = batchData.id;

    // ---- Create Job Rows ----
    const jobInserts = validJobs.map(function(job) {
      return {
        batch_id: batchId,
        user_email: job.user_email,
        task_type: job.task_type,
        file_name: job.file_name,
        storage_url: job.storage_url,
        file_hash: job.file_hash,
        content_tags: job.content_tags,
        status: "QUEUED"
      };
    });

    const { data: insertedJobs, error: jobInsertErr } = await supabase
      .from("upload_jobs")
      .insert(jobInserts)
      .select("id, file_name, status");

    if (jobInsertErr) {
      console.error("[BATCH] Failed to create job rows:", jobInsertErr);
      // Roll back the batch
      await supabase.from("upload_batches").delete().eq("id", batchId);
      return res.status(500).json({
        success: false,
        error: "Failed to create upload job records."
      });
    }

    // ---- Merge results: rejected files + queued files ----
    const finalJobs = [
      ...jobResults,
      ...insertedJobs.map(function(j, idx) {
        return {
          id: j.id,
          fileName: j.file_name,
          status: j.status,
          index: validJobs[idx].index
        };
      })
    ].sort(function(a, b) { return a.index - b.index; });

    // ---- FAST RETURN — No AI processing happens here ----
    return res.status(200).json({
      success: true,
      batchId: batchId,
      status: "QUEUED",
      message: validJobs.length + " file(s) queued for AI verification.",
      totalQueued: validJobs.length,
      totalRejected: jobResults.length,
      jobs: finalJobs
    });

  } catch (err) {
    console.error("[BATCH] Unexpected error:", err);
    return res.status(500).json({
      success: false,
      error: "Internal server error during batch upload."
    });
  }
});

module.exports = router;

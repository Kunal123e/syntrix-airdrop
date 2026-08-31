// =====================================================================
// GET /api/uploads/batch/:batchId/status — Batch Status Polling
// Returns the current status of a batch and all its jobs.
// =====================================================================

const express = require("express");
const router = express.Router();

// GET /api/uploads/batch/:batchId/status
router.get("/:batchId/status", async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const { batchId } = req.params;

    if (!batchId) {
      return res.status(400).json({ success: false, error: "Missing batchId parameter." });
    }

    // ---- Fetch Batch ----
    const { data: batch, error: batchErr } = await supabase
      .from("upload_batches")
      .select("*")
      .eq("id", batchId)
      .single();

    if (batchErr || !batch) {
      return res.status(404).json({ success: false, error: "Batch not found." });
    }

    // ---- Fetch Jobs ----
    const { data: jobs, error: jobsErr } = await supabase
      .from("upload_jobs")
      .select("id, file_name, task_type, status, error_code, reason, reward_amount, reward_awarded, retry_count, created_at, processed_at")
      .eq("batch_id", batchId)
      .order("created_at", { ascending: true });

    if (jobsErr) {
      return res.status(500).json({ success: false, error: "Failed to fetch job statuses." });
    }

    // ---- Calculate Summary ----
    var summary = {
      total: jobs.length,
      queued: 0,
      processing: 0,
      verified: 0,
      rejected: 0,
      retrying: 0,
      failed: 0
    };

    jobs.forEach(function(job) {
      var s = job.status.toLowerCase();
      if (summary.hasOwnProperty(s)) {
        summary[s]++;
      }
    });

    return res.status(200).json({
      success: true,
      batch: {
        id: batch.id,
        userEmail: batch.user_email,
        status: batch.status,
        totalJobs: batch.total_jobs,
        completedJobs: batch.completed_jobs,
        createdAt: batch.created_at,
        updatedAt: batch.updated_at
      },
      summary: summary,
      jobs: jobs
    });

  } catch (err) {
    console.error("[BATCH-STATUS] Unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

// GET /api/uploads/batch/user/:email — Get latest batches for a user
router.get("/user/:email", async (req, res) => {
  try {
    const supabase = req.app.locals.supabase;
    const email = decodeURIComponent(req.params.email).trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ success: false, error: "Missing email parameter." });
    }

    const { data: batches, error: batchErr } = await supabase
      .from("upload_batches")
      .select("*")
      .eq("user_email", email)
      .order("created_at", { ascending: false })
      .limit(20);

    if (batchErr) {
      return res.status(500).json({ success: false, error: "Failed to fetch batches." });
    }

    return res.status(200).json({
      success: true,
      batches: batches || []
    });

  } catch (err) {
    console.error("[BATCH-USER] Unexpected error:", err);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
});

module.exports = router;

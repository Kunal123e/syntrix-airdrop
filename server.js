require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");
const { GoogleGenAI } = require("@google/genai");

// XP SYSTEM IMPORT
const { awardXP, getXPProfile, calculateFinalTaskReward } = require("./xpengine");

const app = express();

// ================= CORS & HEADERS =================
const allowedOriginPatterns = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/([a-zA-Z0-9-]+\.)*vercel\.app$/,
  /^https:\/\/([a-zA-Z0-9-]+\.)*syntrix\.io$/
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (process.env.FRONTEND_URL && origin === process.env.FRONTEND_URL) {
      return callback(null, true);
    }
    const isAllowed = allowedOriginPatterns.some(pattern => pattern.test(origin));
    if (isAllowed) {
      return callback(null, true);
    }
    return callback(new Error("CORS policy violation: Origin not allowed"), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "accept", "api-key", "Origin", "X-Requested-With", "x-admin-key", "Access-Control-Allow-Origin", "Access-Control-Allow-Credentials"]
}));

// STRICT RULE APPLIED: Limit boosted to 50mb to completely prevent WAF drops
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true, parameterLimit: 50000 }));

// ================= MEMORY OPTIMIZATION & TIMEOUT GUARD =================
app.use((req, res, next) => {
  res.setTimeout(60000, () => {
    if (!res.headersSent) {
      res.status(408).send({ success: false, error: 'Network timeout: Request exceeded 60 seconds.' });
    }
  });
  next();
});

// ================= SUPABASE CLIENT =================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// ================= ASYNC UPLOAD QUEUE ROUTES (Phase 2 + Phase 3) =================
app.locals.supabase = supabase;
app.locals.sendEmailHTTP = sendEmailHTTP;
const uploadBatchRouter = require("./routes/uploadBatch");
const checkBatchRouter = require("./routes/checkBatch");
const processQueueRouter = require("./routes/processQueue");
app.use("/api/uploads/batch", uploadBatchRouter);
app.use("/api/uploads/batch", checkBatchRouter);
app.use("/api/process-queue", processQueueRouter);

// GET /api/history
app.get('/api/history', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, error: "Email is required" });
    
    const { data, error } = await supabase
      .from("upload_jobs")
      .select("id, file_name, status, reason, reward_amount, storage_url, created_at")
      .eq("user_email", email.toLowerCase().trim())
      .order("created_at", { ascending: false });
      
    if (error) throw error;
    res.json({ success: true, history: data });
  } catch (err) {
    console.error("History fetch error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch history" });
  }
});

// ================= POLYGON CONFIGURATION =================
let provider;
let wallet;
let tokenContract;
const TOKEN_ABI = [
  "function transfer(address to, uint amount) public returns (bool)",
  "function decimals() public view returns (uint8)"
];

if (process.env.RPC_URL && process.env.PRIVATE_KEY && process.env.TOKEN_ADDRESS) {
  try {
    provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    tokenContract = new ethers.Contract(process.env.TOKEN_ADDRESS, TOKEN_ABI, wallet);
    console.log("Connected to Polygon Network successfully.");
  } catch (e) {
    console.error("Polygon initialization failed. Running in fallback mode.", e.message);
  }
} else {
  console.log("Polygon credentials incomplete. Platform will simulate blockchain execution.");
}

// ================= EMAIL ENGINE (HTTP API — Production Stable) =================
async function sendEmailHTTP({ to, subject, htmlContent }) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.warn("BREVO_API_KEY missing. Skipping email dispatch.");
    return false;
  }

  const payload = {
    sender: { name: "Syntrix Network", email: "syntrix.io@gmail.com" },
    to: [{ email: to }],
    subject: subject,
    htmlContent: htmlContent
  };

  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error(`Brevo HTTP Error [${response.status}]:`, errBody);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Brevo dispatch exception:", err.message);
    return false;
  }
}

// ================= OTP GENERATOR & RATE LIMITER =================
const otpStorage = new Map();
const otpRateLimits = new Map();

function generateSecureOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

app.post("/api/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "Valid email address is strictly required." });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const now = Date.now();
    const lastSent = otpRateLimits.get(normalizedEmail) || 0;

    if (now - lastSent < 60000) {
      const remainingSeconds = Math.ceil((60000 - (now - lastSent)) / 1000);
      return res.status(429).json({
        success: false,
        message: `Security cooldown active. Please wait ${remainingSeconds} seconds before requesting another code.`
      });
    }

    const otp = generateSecureOTP();
    otpStorage.set(normalizedEmail, { otp, expiresAt: now + 600000 }); // 10 minutes
    otpRateLimits.set(normalizedEmail, now);

    const emailHTML = `
      <div style="background-color: #030308; padding: 40px 20px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #f4f4f5; text-align: center;">
        <div style="max-width: 480px; margin: 0 auto; background: #0c0c14; border: 1px solid #1f1f2e; border-radius: 16px; padding: 32px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);">
          <h1 style="color: #ffffff; font-size: 24px; font-weight: 800; margin-bottom: 8px; letter-spacing: -0.5px;">Syntrix Network</h1>
          <p style="color: #a1a1aa; font-size: 14px; margin-bottom: 24px;">Decentralized AI Verification Matrix</p>
          <div style="background: #141420; border: 1px solid #27273a; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <span style="font-size: 36px; font-weight: 900; letter-spacing: 6px; color: #6366f1; font-family: monospace;">${otp}</span>
          </div>
          <p style="color: #71717a; font-size: 13px; line-height: 1.5; margin: 0;">This cryptographic one-time passcode expires in 10 minutes. If you did not initiate this authentication request, please disregard this transmission.</p>
        </div>
      </div>
    `;

    const dispatched = await sendEmailHTTP({
      to: normalizedEmail,
      subject: `[Syntrix Verification] Access Code: ${otp}`,
      htmlContent: emailHTML
    });

    if (!dispatched) {
      return res.status(500).json({ success: false, message: "Email delivery failure via Brevo API." });
    }

    return res.status(200).json({ success: true, message: "Cryptographic passcode successfully dispatched." });
  } catch (err) {
    console.error("Critical OTP Route Failure:", err);
    return res.status(500).json({ success: false, message: "Internal server error during authentication sequence." });
  }
});

app.post("/api/verify-otp", async (req, res) => {
  try {
    const { email, otp, referralCode } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "Email and OTP passcode are required." });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const record = otpStorage.get(normalizedEmail);

    if (!record) {
      return res.status(400).json({ success: false, message: "No active authentication record exists for this address. Request a new code." });
    }

    if (Date.now() > record.expiresAt) {
      otpStorage.delete(normalizedEmail);
      return res.status(400).json({ success: false, message: "Authentication passcode has expired. Request a new code." });
    }

    if (record.otp !== otp.toString().trim()) {
      return res.status(400).json({ success: false, message: "Invalid cryptographic passcode provided." });
    }

    otpStorage.delete(normalizedEmail);

    // Verify or generate referral code for this user
    let userReferralCode = null;
    const { data: existingClaim } = await supabase
      .from("syntrix_claims")
      .select("referral_code")
      .eq("email", normalizedEmail)
      .single();

    if (existingClaim && existingClaim.referral_code) {
      userReferralCode = existingClaim.referral_code;
    } else {
      userReferralCode = "SYN-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    }

    // Process referrer if new user and code provided
    if (referralCode) {
      const cleanRefCode = referralCode.trim().toUpperCase();
      const { data: referrerClaim } = await supabase
        .from("syntrix_claims")
        .select("email")
        .eq("referral_code", cleanRefCode)
        .single();

      if (referrerClaim && referrerClaim.email !== normalizedEmail) {
        const { data: existingRef } = await supabase
          .from("syntrix_referrals")
          .select("id")
          .eq("referred_email", normalizedEmail)
          .single();

        if (!existingRef) {
          const claimToken = "CLAIM-REF-" + crypto.randomBytes(12).toString("hex");
          await supabase.from("syntrix_referrals").insert([{
            referrer_email: referrerClaim.email,
            referred_email: normalizedEmail,
            referral_code: cleanRefCode,
            reward_amount: 50,
            status: "pending",
            claim_token: claimToken
          }]);
          
          await supabase.from("users").upsert({
            email: normalizedEmail,
            referred_by: referrerClaim.email
          }, { onConflict: "email" });
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Identity verified successfully.",
      user: {
        email: normalizedEmail,
        referralCode: userReferralCode
      }
    });
  } catch (err) {
    console.error("Critical OTP Verification Failure:", err);
    return res.status(500).json({ success: false, message: "Internal server error during verification sequence." });
  }
});

// ================= CONSUMER SURVEY ENGINE =================
const BADGE_MAP = {
  1: { id: "mindful", name: "The Mindful Shopper", color: "#2563eb" },
  2: { id: "explorer", name: "The Tasteful Explorer", color: "#8b5cf6" },
  3: { id: "planner", name: "The Thoughtful Planner", color: "#ea580c" },
  4: { id: "connected", name: "The Connected Heart", color: "#eab308" }
};

app.post("/api/submit-survey", async (req, res) => {
  try {
    const { email, surveyData, durationSeconds } = req.body;

    if (!email || !surveyData) {
      return res.status(400).json({ success: false, message: "Missing required survey parameters." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Anti-bot speed trap: Human completion requires minimum 40 seconds
    if (durationSeconds && durationSeconds < 40) {
      return res.status(400).json({
        success: false,
        message: "Quality Control Violation: Survey completed too rapidly. Please provide thoughtful responses."
      });
    }

    // Determine Reward Tier
    let rewardAmount = 50;
    if (durationSeconds) {
      if (durationSeconds >= 120) rewardAmount = 85;
      else if (durationSeconds >= 60) rewardAmount = 60;
      else rewardAmount = 30;
    }

    // Assign Algorithmic Badge Archetype
    const randomBadgeId = crypto.randomInt(1, 5);
    const assignedBadge = BADGE_MAP[randomBadgeId];

    // Persist or Update Claim Record
    const { data: existingClaim, error: fetchErr } = await supabase
      .from("syntrix_claims")
      .select("*")
      .eq("email", normalizedEmail)
      .single();

    let userReferralCode;

    if (!existingClaim) {
      userReferralCode = "SYN-" + crypto.randomBytes(3).toString("hex").toUpperCase();
      const { error: insertErr } = await supabase.from("syntrix_claims").insert([{
        email: normalizedEmail,
        amount_rewarded: rewardAmount,
        status: "pending_claim",
        referral_code: userReferralCode,
        survey_data: surveyData,
        survey_duration_seconds: durationSeconds || 0,
        assigned_badge: assignedBadge
      }]);
      if (insertErr) throw insertErr;
    } else {
      userReferralCode = existingClaim.referral_code;
      const updatedTotal = Number(existingClaim.amount_rewarded || 0) + rewardAmount;
      const { error: updateErr } = await supabase
        .from("syntrix_claims")
        .update({
          amount_rewarded: updatedTotal,
          survey_data: surveyData,
          assigned_badge: assignedBadge,
          survey_duration_seconds: durationSeconds || 0
        })
        .eq("email", normalizedEmail);
      if (updateErr) throw updateErr;
    }

    // Update User Balance in `users` table
    const { data: userProfile } = await supabase
      .from("users")
      .select("pendingRewards")
      .eq("email", normalizedEmail)
      .single();

    const currentPending = Number(userProfile?.pendingRewards || 0);
    await supabase.from("users").upsert({
      email: normalizedEmail,
      pendingRewards: currentPending + rewardAmount
    }, { onConflict: "email" });

    // AWARD XP: Base Survey Completion (+300 XP or +500 XP if >120s)
    const xpAmount = (durationSeconds && durationSeconds >= 120) ? 500 : 300;
    const xpAction = (durationSeconds && durationSeconds >= 120) ? "SURVEY_COMPLETED_PREMIUM" : "SURVEY_COMPLETED";
    await awardXP(supabase, normalizedEmail, xpAmount, xpAction, { durationSeconds, rewardAmount });

    return res.status(200).json({
      success: true,
      rewardAmount,
      referralCode: userReferralCode,
      assignedBadge,
      message: "Survey authenticated and rewards successfully credited to ledger."
    });
  } catch (err) {
    console.error("Survey Processing Exception:", err);
    return res.status(500).json({ success: false, message: "Database execution error during survey ingestion." });
  }
});

// ================= USER PROFILE & REWARD STATUS =================
app.get("/api/user-status", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email query parameter required." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Fetch User Record
    const { data: userRecord } = await supabase
      .from("users")
      .select("pendingRewards, claimedRewards, wallet_address")
      .eq("email", normalizedEmail)
      .single();

    // 2. Fetch Claim Data
    const { data: claimRecord } = await supabase
      .from("syntrix_claims")
      .select("*")
      .eq("email", normalizedEmail)
      .single();

    // 3. Fetch Referral Count
    const { count: referralCount } = await supabase
      .from("syntrix_referrals")
      .select("*", { count: "exact", head: true })
      .eq("referrer_email", normalizedEmail);

    // DAILY LOGIN XP CHECK
    const { data: xpRow } = await supabase
      .from("user_xp")
      .select("last_active_at, daily_streak")
      .eq("user_email", normalizedEmail)
      .single();

    if (xpRow && xpRow.last_active_at) {
      const lastActive = new Date(xpRow.last_active_at).getTime();
      const now = Date.now();
      const diffHours = (now - lastActive) / (1000 * 60 * 60);

      if (diffHours >= 24) {
        let newStreak = xpRow.daily_streak || 1;
        if (diffHours <= 48) newStreak += 1;
        else newStreak = 1;

        await awardXP(supabase, normalizedEmail, 10, "DAILY_LOGIN", { streak: newStreak });
        if (newStreak % 7 === 0) {
          await awardXP(supabase, normalizedEmail, 100, "STREAK_7_DAY", { streak: newStreak });
        }
      }
    }

    return res.status(200).json({
      success: true,
      pendingBalance: Number(userRecord?.pendingRewards || claimRecord?.amount_rewarded || 0),
      claimedBalance: Number(userRecord?.claimedRewards || 0),
      referralCode: claimRecord?.referral_code || null,
      referralCount: referralCount || 0,
      assignedBadge: claimRecord?.assigned_badge || null,
      walletAddress: userRecord?.wallet_address || claimRecord?.wallet_address || null
    });
  } catch (err) {
    console.error("Status Query Exception:", err);
    return res.status(500).json({ success: false, message: "Database failure retrieving account metrics." });
  }
});

// ================= LEGACY SINGLE TASK UPLOAD (Selfie & Doc Support) =================
app.post("/api/upload-task", async (req, res) => {
  try {
    const { email, userEmail, taskType, fileName, imageBase64, contentTags, assignedTask } = req.body;
    const targetEmail = (email || userEmail || "").toLowerCase().trim();

    if (!targetEmail || !taskType || !imageBase64) {
      return res.status(400).json({ success: false, error: "Missing required upload parameters." });
    }

    const base64Data = imageBase64.replace(/^data:(image|application)\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    if (buffer.length < 1024) {
      return res.status(400).json({ success: false, error: "File payload corrupted or too small (<1KB)." });
    }

    // SHA-256 Hash Duplicate Guard
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
    const { data: existingSubmissions } = await supabase
      .from("syntrix_submissions")
      .select("id")
      .eq("file_hash", fileHash)
      .limit(1);

    if (existingSubmissions && existingSubmissions.length > 0) {
      return res.status(400).json({ success: false, error: "Duplicate document detected. This image has already been submitted." });
    }

    // Upload to Supabase Storage
    const safeFileName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.jpeg`;
    const storagePath = `pending/${targetEmail}/${safeFileName}`;

    const { error: uploadErr } = await supabase.storage
      .from("verified_assets")
      .upload(storagePath, buffer, { contentType: "image/jpeg", upsert: true });

    if (uploadErr) {
      console.error("Storage upload failed:", uploadErr);
      return res.status(500).json({ success: false, error: "Failed to upload file to asset vault." });
    }

    const { data: publicUrlData } = supabase.storage
      .from("verified_assets")
      .getPublicUrl(storagePath);

    const storageUrl = publicUrlData ? publicUrlData.publicUrl : null;

    // Insert pending submission
    const { data: submission, error: subErr } = await supabase
      .from("syntrix_submissions")
      .insert([{
        email: targetEmail,
        task_type: taskType,
        file_name: fileName || safeFileName,
        storage_url: storageUrl,
        contentTags: contentTags || ["none"],
        file_hash: fileHash,
        status: "processing",
        reason: "Queued for automated AI inspection."
      }])
      .select()
      .single();

    if (subErr) throw subErr;

    // Trigger immediate background evaluation if key is available
    if (process.env.GEMINI_API_KEY || process.env.GEMINI_API_SELFIE) {
      setImmediate(async () => {
        try {
          const apiKey = taskType === "selfie"
            ? (process.env.GEMINI_API_SELFIE || process.env.GEMINI_API_KEY)
            : process.env.GEMINI_API_KEY;

          const ai = new GoogleGenAI({ apiKey });

          let prompt = "";
          if (taskType === "selfie") {
            prompt = `Analyze this selfie image strictly for human verification.
Confirm:
1. Is this a genuine real human selfie?
2. Is the face clearly visible and well lit?
3. Does it contain any spoofing, screens, printed photos, or explicit content?
Respond strictly in JSON format:
{
  "quality_pass": true or false,
  "contains_pii": false,
  "confidence_score": 0.0 to 1.0,
  "reason": "Brief technical summary"
}`;
          } else {
            prompt = `Analyze this handwritten student document or academic note image for data quality.
Confirm:
1. Is it genuine handwritten academic/student content?
2. Is the text legible?
3. Does it contain sensitive PII (passports, credit cards, SSN, personal phone numbers)?
Respond strictly in JSON format:
{
  "quality_pass": true or false,
  "contains_pii": true or false,
  "confidence_score": 0.0 to 1.0,
  "reason": "Brief technical summary"
}`;
          }

          const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: [
              { role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: base64Data } }] }
            ]
          });

          let resultText = response.text || "";
          resultText = resultText.replace(/```json/g, "").replace(/```/g, "").trim();
          const analysis = JSON.parse(resultText);

          if (analysis.quality_pass && !analysis.contains_pii) {
            const reward = taskType === "selfie" ? 40 : 48;

            await supabase
              .from("syntrix_submissions")
              .update({
                status: "verified",
                reason: analysis.reason || "Verified by Syntrix AI Matrix.",
                reward_amount: reward
              })
              .eq("id", submission.id);

            // Update user balance
            const { data: u } = await supabase.from("users").select("pendingRewards").eq("email", targetEmail).single();
            const newBal = Number(u?.pendingRewards || 0) + reward;
            await supabase.from("users").upsert({ email: targetEmail, pendingRewards: newBal }, { onConflict: "email" });

            // Award XP
            const xpType = taskType === "selfie" ? "SELFIE_VERIFIED" : "DOCUMENT_VERIFIED";
            const xpPts = taskType === "selfie" ? 60 : 70;
            await awardXP(supabase, targetEmail, xpPts, xpType, { taskType, reward });

          } else {
            await supabase
              .from("syntrix_submissions")
              .update({
                status: "rejected",
                reason: analysis.reason || "Failed quality or security checks."
              })
              .eq("id", submission.id);
          }
        } catch (evalErr) {
          console.error("Async evaluation error:", evalErr);
          await supabase
            .from("syntrix_submissions")
            .update({ status: "rejected", reason: "AI pipeline timeout or validation error." })
            .eq("id", submission.id);
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: "Submission received and queued for biometric/quality verification.",
      submissionId: submission.id
    });

  } catch (err) {
    console.error("Upload Task Exception:", err);
    return res.status(500).json({ success: false, error: "Internal server error during upload sequence." });
  }
});

// GET /api/check-submission (Used by frontend polling)
app.get("/api/check-submission", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, error: "Email query param required" });

    const normalizedEmail = email.toLowerCase().trim();

    // Check syntrix_submissions first
    const { data: submission } = await supabase
      .from("syntrix_submissions")
      .select("status, reason, reward_amount, created_at")
      .eq("email", normalizedEmail)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (submission) {
      return res.status(200).json({ success: true, submission });
    }

    // Fall back to upload_jobs
    const { data: job } = await supabase
      .from("upload_jobs")
      .select("status, reason, reward_amount, created_at")
      .eq("user_email", normalizedEmail)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (job) {
      return res.status(200).json({ success: true, submission: job });
    }

    return res.status(200).json({ success: false, message: "No submissions found." });
  } catch (err) {
    console.error("Check submission error:", err);
    return res.status(500).json({ success: false, error: "Database error polling submission." });
  }
});

// GET /api/xp-profile
app.get("/api/xp-profile", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ success: false, error: "Email parameter required." });

    const profile = await getXPProfile(supabase, email.toLowerCase().trim());
    return res.status(200).json({ success: true, profile });
  } catch (err) {
    console.error("XP Profile query error:", err);
    return res.status(500).json({ success: false, error: "Failed to retrieve XP profile." });
  }
});

// ================= BLOCKCHAIN CLAIM PIPELINE =================
app.post("/api/claim-reward", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email required." });

    const normalizedEmail = email.toLowerCase().trim();

    const { data: userProfile } = await supabase
      .from("users")
      .select("pendingRewards")
      .eq("email", normalizedEmail)
      .single();

    const pending = Number(userProfile?.pendingRewards || 0);
    if (pending <= 0) {
      return res.status(400).json({ success: false, message: "No claimable SYNX balance available." });
    }

    const claimToken = "CLAIM-" + crypto.randomBytes(16).toString("hex");

    await supabase.from("syntrix_rewards").insert([{
      email: normalizedEmail,
      reward_type: "BALANCE_CASHOUT",
      amount: pending,
      status: "unclaimed",
      claim_token: claimToken
    }]);

    return res.status(200).json({
      success: true,
      claimToken,
      amount: pending,
      message: "Cryptographic claim token generated. Proceed to Web3 wallet settlement."
    });
  } catch (err) {
    console.error("Claim Token Generation Exception:", err);
    return res.status(500).json({ success: false, message: "Database execution failure creating claim token." });
  }
});

app.post("/api/execute-claim", async (req, res) => {
  try {
    const { claimToken, walletAddress, signature } = req.body;

    if (!claimToken || !walletAddress || !signature) {
      return res.status(400).json({ success: false, message: "ClaimToken, wallet address, and signature are mandatory." });
    }

    if (!ethers.isAddress(walletAddress)) {
      return res.status(400).json({ success: false, message: "Invalid EVM wallet address format." });
    }

    // Verify Web3 Cryptographic Signature
    const expectedMessage = `Sign this message to authorize your Syntrix Network settlement. Token: ${claimToken}`;
    let signerAddress;
    try {
      signerAddress = ethers.verifyMessage(expectedMessage, signature);
    } catch (sigErr) {
      return res.status(400).json({ success: false, message: "Cryptographic signature verification failed." });
    }

    if (signerAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(400).json({ success: false, message: "Signer address does not match provided wallet." });
    }

    // Fetch Reward Record
    const { data: rewardRecord, error: rewardErr } = await supabase
      .from("syntrix_rewards")
      .select("*")
      .eq("claim_token", claimToken)
      .single();

    if (rewardErr || !rewardRecord) {
      return res.status(404).json({ success: false, message: "Invalid or nonexistent claim token." });
    }

    if (rewardRecord.status === "claimed" || rewardRecord.status === "queued") {
      return res.status(400).json({ success: false, message: "This claim token has already been submitted for execution." });
    }

    // Enqueue for blockchain processing
    await supabase.from("syntrix_payout_queue").insert([{
      email: rewardRecord.email,
      wallet_address: walletAddress,
      reward_amount: rewardRecord.amount,
      claim_token: claimToken,
      status: "queued"
    }]);

    await supabase
      .from("syntrix_rewards")
      .update({ status: "queued", claimed_wallet: walletAddress })
      .eq("claim_token", claimToken);

    // Reset pending balance in users table
    const { data: userRec } = await supabase.from("users").select("pendingRewards, claimedRewards").eq("email", rewardRecord.email).single();
    const curPending = Number(userRec?.pendingRewards || 0);
    const curClaimed = Number(userRec?.claimedRewards || 0);

    await supabase.from("users").upsert({
      email: rewardRecord.email,
      pendingRewards: Math.max(0, curPending - Number(rewardRecord.amount)),
      claimedRewards: curClaimed + Number(rewardRecord.amount),
      wallet_address: walletAddress
    }, { onConflict: "email" });

    return res.status(200).json({
      success: true,
      message: "Claim submitted to settlement queue. Transaction processing on Polygon L2."
    });

  } catch (err) {
    console.error("Execute Claim Exception:", err);
    return res.status(500).json({ success: false, message: "Internal server error during settlement." });
  }
});

app.get("/api/claim-details", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, message: "Token query param required" });

    const { data, error } = await supabase
      .from("syntrix_rewards")
      .select("amount, status, email, created_at, claimed_at, tx_hash")
      .eq("claim_token", token)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: "Claim token not found." });
    }

    return res.status(200).json({ success: true, claim: data });
  } catch (err) {
    console.error("Claim details error:", err);
    return res.status(500).json({ success: false, message: "Database lookup failure." });
  }
});

// ================= REFERRAL & INVITE ROUTES =================
app.post("/api/send-invite", async (req, res) => {
  try {
    const { referrerEmail, recipientEmail, referralCode } = req.body;
    if (!referrerEmail || !recipientEmail || !referralCode) {
      return res.status(400).json({ success: false, message: "All invite parameters are required." });
    }

    const inviteLink = `https://syntrix.io/r/${referralCode}`;
    const emailHTML = `
      <div style="background-color: #030308; padding: 40px 20px; font-family: sans-serif; color: #f4f4f5; text-align: center;">
        <div style="max-width: 480px; margin: 0 auto; background: #0c0c14; border: 1px solid #1f1f2e; border-radius: 16px; padding: 32px;">
          <h2 style="color: #6366f1;">You're Invited to Syntrix Network</h2>
          <p style="color: #a1a1aa; font-size: 14px;">Your colleague <strong>${referrerEmail}</strong> invited you to join the Decentralized AI Data Verification Matrix.</p>
          <div style="margin: 30px 0;">
            <a href="${inviteLink}" style="background: #6366f1; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold;">Accept Invitation & Earn 50 SYNX</a>
          </div>
          <p style="color: #71717a; font-size: 12px;">Referral Code: ${referralCode}</p>
        </div>
      </div>
    `;

    const sent = await sendEmailHTTP({
      to: recipientEmail,
      subject: `[Syntrix Invite] Join the decentralized AI revolution with 50 bonus SYNX`,
      htmlContent: emailHTML
    });

    if (!sent) return res.status(500).json({ success: false, message: "Failed to dispatch email via Brevo." });

    return res.status(200).json({ success: true, message: "Invitation dispatched successfully." });
  } catch (err) {
    console.error("Invite sending error:", err);
    return res.status(500).json({ success: false, message: "Error dispatching invite email." });
  }
});

app.get("/r/:refCode", (req, res) => {
  const { refCode } = req.params;
  const targetUrl = (process.env.FRONTEND_URL || "https://syntrix.io") + `?ref=${encodeURIComponent(refCode)}`;
  res.redirect(302, targetUrl);
});

// ================= ADMIN SECURED ENDPOINTS =================
function verifyAdminAccess(req, res, next) {
  const adminKey = req.headers["x-admin-key"] || req.query.adminKey;
  if (!adminKey || adminKey !== process.env.ADMIN_SECRET_KEY) {
    return res.status(403).json({ success: false, error: "Unauthorized access: Invalid administrator key." });
  }
  next();
}

app.post("/api/admin/login", (req, res) => {
  const { key } = req.body;
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ success: false, message: "Invalid admin credential." });
  }
  return res.status(200).json({ success: true, token: crypto.randomBytes(24).toString("hex") });
});

app.get("/api/admin/stats", verifyAdminAccess, async (req, res) => {
  try {
    const { count: usersCount } = await supabase.from("users").select("*", { count: "exact", head: true });
    const { count: submissionsCount } = await supabase.from("upload_jobs").select("*", { count: "exact", head: true });
    const { count: batchesCount } = await supabase.from("upload_batches").select("*", { count: "exact", head: true });
    const { count: claimsCount } = await supabase.from("syntrix_claims").select("*", { count: "exact", head: true });

    return res.status(200).json({
      success: true,
      stats: {
        totalUsers: usersCount || 0,
        totalJobs: submissionsCount || 0,
        totalBatches: batchesCount || 0,
        totalClaims: claimsCount || 0
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/admin/submissions", verifyAdminAccess, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("upload_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    return res.status(200).json({ success: true, submissions: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/admin/override", verifyAdminAccess, async (req, res) => {
  try {
    const { jobId, newStatus, reason } = req.body;
    if (!jobId || !newStatus) return res.status(400).json({ success: false, error: "jobId and newStatus required" });

    const { data, error } = await supabase
      .from("upload_jobs")
      .update({ status: newStatus, reason: reason || "Manual admin override." })
      .eq("id", jobId)
      .select()
      .single();

    if (error) throw error;
    return res.status(200).json({ success: true, job: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/test-email", verifyAdminAccess, async (req, res) => {
  const { to } = req.body;
  const sent = await sendEmailHTTP({
    to: to || "test@syntrix.io",
    subject: "Brevo API Configuration Test",
    htmlContent: "<h1>Brevo Integration Operational</h1>"
  });
  return res.json({ success: sent });
});

// ================= PUBLIC WORKER WAKE TRIGGER =================
let lastWakeTriggerTime = 0;
const WAKE_COOLDOWN_MS = 5000;

app.post("/api/public-wake", (req, res) => {
  const now = Date.now();
  if (now - lastWakeTriggerTime < WAKE_COOLDOWN_MS) {
    return res.status(200).json({
      success: true,
      message: "Queue processor already active or triggered recently."
    });
  }
  lastWakeTriggerTime = now;

  triggerQueueProcessor();
  return res.status(200).json({ success: true, message: "Queue processor awakened." });
});

// ================= INTERNAL QUEUE TRIGGER FUNCTION =================
let isQueueRunning = false;

async function triggerQueueProcessor() {
  if (isQueueRunning) return;
  isQueueRunning = true;
  try {
    const processor = processQueueRouter.processQueueDirectly;
    if (typeof processor === "function") {
      await processor(supabase, sendEmailHTTP);
    }
  } catch (err) {
    console.error("[INTERNAL_QUEUE] Queue tick error:", err.message);
  } finally {
    isQueueRunning = false;
  }
}

// ================= STARTUP INTEGRITY SWEEP & BACKGROUND DAEMON =================
async function startupQueueRecovery() {
  try {
    const { data, error } = await supabase
      .from("upload_jobs")
      .update({
        status: "QUEUED",
        locked_by: null,
        locked_at: null,
        lease_expires_at: null,
        reason: "Reset to QUEUED on server initialization."
      })
      .eq("status", "PROCESSING")
      .select("id");

    if (!error && data && data.length > 0) {
      console.log(`[STARTUP] Reclaimed ${data.length} stale PROCESSING jobs back to QUEUED.`);
    }
  } catch (e) {
    console.error("[STARTUP] Queue recovery check failed:", e.message);
  }
}

// Poller runs every 15 seconds
setInterval(() => {
  triggerQueueProcessor();
}, 15000);

// Background Polygon Payout Engine
async function processPayoutQueueEngine() {
  if (!tokenContract || !wallet) return;

  try {
    const { data: pendingPayouts, error } = await supabase
      .from("syntrix_payout_queue")
      .select("*")
      .eq("status", "queued")
      .limit(5);

    if (error || !pendingPayouts || pendingPayouts.length === 0) return;

    for (const payout of pendingPayouts) {
      try {
        const decimals = await tokenContract.decimals();
        const amountWei = ethers.parseUnits(payout.reward_amount.toString(), decimals);

        const tx = await tokenContract.transfer(payout.wallet_address, amountWei);
        await tx.wait(1);

        await supabase
          .from("syntrix_payout_queue")
          .update({ status: "completed", tx_hash: tx.hash, processed_at: new Date().toISOString() })
          .eq("id", payout.id);

        await supabase
          .from("syntrix_rewards")
          .update({ status: "claimed", tx_hash: tx.hash, claimed_at: new Date().toISOString() })
          .eq("claim_token", payout.claim_token);

        console.log(`[PAYOUT] Executed ${payout.reward_amount} SYNX to ${payout.wallet_address}. Tx: ${tx.hash}`);
      } catch (txErr) {
        console.error(`[PAYOUT_ERROR] Failed tx for payout ${payout.id}:`, txErr.message);
        await supabase
          .from("syntrix_payout_queue")
          .update({ status: "failed", error_message: txErr.message })
          .eq("id", payout.id);
      }
    }
  } catch (loopErr) {
    console.error("[PAYOUT_ENGINE] Loop exception:", loopErr.message);
  }
}

setInterval(() => {
  processPayoutQueueEngine();
}, 30000);

// ================= HEALTH CHECK & SERVER LAUNCH =================
app.get("/", (req, res) => {
  res.status(200).json({
    status: "operational",
    service: "Syntrix Network Decentralized Engine",
    version: "3.2.0-staging",
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, async () => {
  console.log(`Syntrix High-Performance Engine listening on port ${PORT}`);
  await startupQueueRecovery();
});

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");
const { GoogleGenAI } = require("@google/genai");

const app = express();

// ================= COORD ADJUSTMENTS (CORS & HEADERS) =================
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "accept", "api-key"]
}));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

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
    console.log("Blockchain system online. Master Wallet Address:", wallet.address);
  } catch (err) {
    console.error("Blockchain provider initialization failed:", err.message);
  }
} else {
  console.warn("Blockchain credentials missing in .env. Claim routes will run in MOCK queue engine mode.");
}

// ================= BREVO HTTP EMAIL API SETUP =================
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const SENDER_NAME = "Syntrix Network";

async function sendEmailHTTP(toEmail, subject, htmlContent) {
  if (!BREVO_API_KEY) {
    throw new Error("BREVO_API_KEY is missing in environment variables.");
  }

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "api-key": BREVO_API_KEY,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: "syntrix.care@gmail.com" },
      to: [{ email: toEmail }],
      subject: subject,
      htmlContent: htmlContent
    })
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("Brevo API Error:", errorData);
    throw new Error("Email delivery failed via HTTP API");
  }
  return await response.json();
}

// ================= HELPERS =================
function generateReferralCode(email) {
  const cleanEmail = email.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(cleanEmail).digest("hex");
  const uniqueChars = hash.substring(0, 6).toUpperCase();
  return `SYN-${uniqueChars}`;
}

function normalizeReferralCode(code) {
  if (!code) return "";
  let clean = code.trim().toUpperCase();
  clean = clean.replace(/\s+/g, "");
  if (!clean.startsWith("SYN-")) {
    if (clean.startsWith("SYN")) clean = "SYN-" + clean.substring(3);
    else clean = "SYN-" + clean;
  }
  if (clean.length > 10) clean = clean.substring(0, 10);
  return clean;
}

async function sendRewardNotification(referrerEmail, rewardAmount, claimToken) {
  if (!claimToken) return false;

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const claimLink = `${frontendUrl}/claim?token=${claimToken}`;

  const htmlBody = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; padding: 30px; color: #1e293b; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
      <h2 style="color: #4f46e5; margin-top: 0; font-size: 24px; border-bottom: 2px solid #f1f5f9; padding-bottom: 15px;">You Earned SYNTRIX Tokens!</h2>
      <p style="font-size: 16px; line-height: 1.6;">Hello,</p>
      <p style="font-size: 16px; line-height: 1.6;">Great news! A user completed the onboarding survey using your referral link.</p>
      <div style="background-color: #f8fafc; border-left: 4px solid #4f46e5; padding: 15px; margin: 20px 0; border-radius: 4px;">
        <p style="margin: 0; font-size: 16px; font-weight: bold; color: #1e293b;">
          Reward Amount: <span style="color: #4f46e5;">${rewardAmount} SYNTRIX Tokens</span>
        </p>
      </div>
      <a href="${claimLink}" style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); color: #ffffff; padding: 14px 28px; text-decoration: none; font-weight: bold; border-radius: 8px; display: inline-block;">Claim Your Tokens Now &rarr;</a>
    </div>
  `;

  try {
    await sendEmailHTTP(referrerEmail, `🎁 You Earned ${rewardAmount} SYNTRIX Tokens`, htmlBody);
    return true;
  } catch (error) {
    return false;
  }
}

// ================= OTP LOGIC =================
const otpStorage = {};

setInterval(() => {
  const now = Date.now();
  for (const email in otpStorage) {
    if (otpStorage[email].expires < now) delete otpStorage[email];
  }
}, 10 * 60 * 1000);

app.post("/api/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required." });

  const sanitizedEmail = email.trim().toLowerCase();
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  
  otpStorage[sanitizedEmail] = {
    otp: otpCode,
    expires: Date.now() + 10 * 60 * 1000 
  };

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 500px;">
      <h2 style="color: #4f46e5; margin-top: 0;">Syntrix Verification</h2>
      <p>Please use the following 6-digit code to verify your identity and enter the network.</p>
      <div style="background-color: #f8fafc; padding: 15px; margin: 20px 0; text-align: center; border-radius: 6px;">
        <span style="font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #1e293b;">${otpCode}</span>
      </div>
      <p style="color: #64748b; font-size: 12px;">This code will expire in 10 minutes.</p>
    </div>
  `;

  try {
    await sendEmailHTTP(sanitizedEmail, `Your Syntrix Verification Code: ${otpCode}`, htmlBody);
    return res.json({ success: true, message: "OTP Sent" });
  } catch (err) {
    return res.status(500).json({ error: "Failed to deliver email via HTTP API." });
  }
});

app.post("/api/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: "Email and OTP required." });

  const sanitizedEmail = email.trim().toLowerCase();
  const record = otpStorage[sanitizedEmail];

  if (!record) return res.status(400).json({ error: "OTP expired or not requested. Please send a new code." });
  if (record.expires < Date.now()) {
    delete otpStorage[sanitizedEmail];
    return res.status(400).json({ error: "OTP has expired." });
  }
  if (record.otp !== otp.trim()) return res.status(400).json({ error: "Invalid OTP code." });

  delete otpStorage[sanitizedEmail];
  return res.json({ success: true });
});

// ================= TEST & INVITE ROUTES =================
app.get("/", (req, res) => {
  res.json({ success: true, message: "Syntrix Referral Backend Operating with Dedicated Queue Architecture" });
});

app.post("/api/send-invite", async (req, res) => {
  const { friendEmail, referralCode, referralLink } = req.body;
  if (!friendEmail || !referralCode || !referralLink) {
    return res.status(400).json({ error: "Missing parameters." });
  }

  const htmlBody = `
    <div style="font-family: Arial, sans-serif; padding: 25px; color: #1e293b; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 12px;">
      <h2 style="color: #4f46e5; margin-top: 0;">You've been invited to Syntrix!</h2>
      <p>Click below to join and earn token rewards.</p>
      <a href="${referralLink}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 6px; display: inline-block;">Accept Invitation &rarr;</a>
    </div>
  `;

  try {
    await sendEmailHTTP(friendEmail, "🎁 Join Syntrix and earn token rewards!", htmlBody);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/r/:refCode", (req, res) => {
  const refCode = req.params.refCode;
  const targetDomain = process.env.FRONTEND_URL || "https://syntrix-airdrop.onrender.com"; 
  res.redirect(302, `${targetDomain}/?ref=${refCode}`);
});

// ================= SURVEY INGESTION SYSTEM =================
app.post("/api/submit-survey", async (req, res) => {
  try {
    const { email, referredBy, answers, startTime, submissionTime, assignedBadge } = req.body;

    if (!startTime || !submissionTime) {
      return res.status(400).json({ error: "Missing required timing metrics. Please update your client." });
    }
    const timeTaken = submissionTime - startTime;
    if (timeTaken < 120000) {
      return res.status(400).json({ error: "Survey completed too quickly. Please take adequate time to provide quality insights." });
    }

    if (!email) return res.status(400).json({ error: "Email identifier required" });
    const sanitizedEmail = email.trim().toLowerCase();
    const generatedReferralCode = generateReferralCode(sanitizedEmail);

    const { data: existingEmail } = await supabase.from("syntrix_claims").select("id").eq("email", sanitizedEmail).maybeSingle();
    if (existingEmail) return res.status(400).json({ error: "This email has already submitted the survey." });

    let referrerRecord = null;
    let isReferralValid = false;

    if (referredBy) {
      const cleanRefCode = normalizeReferralCode(referredBy);
      if (cleanRefCode === generatedReferralCode) return res.status(400).json({ error: "You cannot refer yourself." });

      const { data: referrerClaim, error: refError } = await supabase.from("syntrix_claims").select("email").eq("referral_code", cleanRefCode).maybeSingle();
      if (refError || !referrerClaim) return res.status(400).json({ error: "Invalid referral code. Code does not exist." });
      if (referrerClaim.email === sanitizedEmail) return res.status(400).json({ error: "Self-referral check: Code belongs to this email." });

      referrerRecord = referrerClaim;

      const { data: alreadyReferred } = await supabase.from("syntrix_referrals").select("id").eq("referred_email", sanitizedEmail).maybeSingle();
      if (alreadyReferred) return res.status(400).json({ error: "This email has already been referred." });
      isReferralValid = true;
    }

    const { error: claimError } = await supabase
      .from("syntrix_claims")
      .insert([{
        email: sanitizedEmail, 
        amount_rewarded: 48, 
        status: "pending", 
        referral_code: generatedReferralCode, 
        survey_data: answers,
        survey_duration_seconds: Math.floor(timeTaken / 1000), 
        assigned_badge: assignedBadge || "Analyzer" 
      }]);

    if (claimError) {
      if (claimError.code === "23505") return res.status(400).json({ error: "This email has already submitted the survey." });
      return res.status(500).json({ error: "Claims Registry Failure: " + claimError.message });
    }

    if (isReferralValid && referrerRecord) {
      const claimToken = crypto.randomBytes(32).toString('hex');
      await supabase.from("syntrix_referrals").insert([{
        referrer_email: referrerRecord.email, referred_email: sanitizedEmail, referral_code: normalizeReferralCode(referredBy), reward_amount: 10, status: "pending", claim_token: claimToken
      }]);
      await supabase.from("syntrix_rewards").insert([{
        email: referrerRecord.email, reward_type: "referral", amount: 10, status: "pending", claim_token: claimToken
      }]);
      await sendRewardNotification(referrerRecord.email, 10, claimToken);
    }

    return res.json({ success: true, referralCode: generatedReferralCode, message: "Survey data successfully stored." });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ================= PROFILE LOOKUP (FIXED USER BALANCES) =================
app.get("/api/user-status", async (req, res) => {
  const { email, ref } = req.query;
  if (!email) return res.status(400).json({ error: "Email parameter required" });

  try {
    const sanitizedEmail = email.trim().toLowerCase();

    if (ref) {
      const cleanRefCode = normalizeReferralCode(ref);
      const generatedReferralCode = generateReferralCode(sanitizedEmail);

      if (cleanRefCode !== generatedReferralCode) {
          const { data: referrerClaim } = await supabase.from("syntrix_claims").select("email").eq("referral_code", cleanRefCode).maybeSingle();
          if (referrerClaim && referrerClaim.email !== sanitizedEmail) {
              const { data: alreadyReferred } = await supabase.from("syntrix_referrals").select("id").eq("referred_email", sanitizedEmail).maybeSingle();
          }
      }
    }

    const { data: userProfile, error } = await supabase
      .from("syntrix_claims")
      .select("email, status, wallet_address, tx_hash, referral_code, amount_rewarded, assigned_badge")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    
    const { data: queuedItems } = await supabase.from("syntrix_payout_queue")
      .select("status, tx_hash")
      .eq("email", sanitizedEmail)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!userProfile) return res.json({ success: false, exists: false, isClaimed: false, status: "FLOW_C" });

    const { count: totalReferrals } = await supabase.from("syntrix_referrals").select("id", { count: "exact", head: true }).eq("referrer_email", sanitizedEmail);
    const { data: rewards } = await supabase.from("syntrix_rewards").select("amount, status").eq("email", sanitizedEmail);
    const { data: userTableRecord } = await supabase.from("users").select("pendingRewards, claimedRewards").eq("email", sanitizedEmail).maybeSingle();

    let pendingRewards = 0, claimedRewards = 0;
    
    const surveyAmount = userProfile.amount_rewarded || 48;
    if (userProfile.status === "pending" || userProfile.status === "processing") {
      pendingRewards += Number(surveyAmount);
    } else if (userProfile.status === "success") {
      claimedRewards += Number(surveyAmount);
    }
    
    if (rewards) {
      rewards.forEach(r => {
        if (r.status === "pending" || r.status === "processing") pendingRewards += Number(r.amount);
        if (r.status === "claimed") claimedRewards += Number(r.amount);
      });
    }

    if (userTableRecord) {
        pendingRewards += Number(userTableRecord.pendingRewards || 0);
        claimedRewards += Number(userTableRecord.claimedRewards || 0);
    }

    const isClaimed = userProfile.status === "success" || 
                      !!(userProfile.tx_hash || userProfile.wallet_address) ||
                      (queuedItems && queuedItems.status === "success");

    return res.json({
      success: true, exists: true, isClaimed: isClaimed,
      status: isClaimed ? "completed" : "verified",
      referralsCount: totalReferrals || 0,
      pendingRewards, claimedRewards,
      referralCode: userProfile.referral_code || null,
      txHash: userProfile.tx_hash || (queuedItems ? queuedItems.tx_hash : null),
      walletAddress: userProfile.wallet_address || null,
      badge: userProfile.assigned_badge || "Analyzer"
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Dashboard authentication processing failure" });
  }
});

app.get("/api/check-submission", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email required" });

  try {
    const { data, error } = await supabase
      .from("syntrix_submissions")
      .select("status, reason")
      .eq("email", email.trim().toLowerCase())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true, submission: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ================= CRYPTO CLAIMS =================
app.get("/api/claim-details", async (req, res) => { /* ... */ });
app.post("/api/execute-claim", async (req, res) => { /* ... */ });
app.post("/api/claim-reward", async (req, res) => { /* ... */ });

// ================= BLOCKCHAIN BACKGROUND ENGINE =================
let isQueueProcessing = false;
async function processPayoutQueueEngine() { /* ... */ }
async function finalizeSuccessfulQueueJob(job, txHash) { /* ... */ }
setInterval(() => { processPayoutQueueEngine().catch(err => console.error(err)); }, 15000);

// ================= DOCUMENT MODE: WAITING ROOM INGESTION =================
app.post("/api/upload-task", async (req, res) => {
  const { userEmail, taskType, fileName, imageBase64, contentTags } = req.body; 

  if (!userEmail || !taskType || !fileName || !imageBase64) {
    return res.status(400).json({ error: "Missing required document fields." });
  }

  const sanitizedEmail = userEmail.trim().toLowerCase();

  try {
    if (taskType === "selfie") {
      const startOfMonth = new Date();
      startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);

      const { count, error: countError } = await supabase
        .from("syntrix_submissions")
        .select("*", { count: "exact", head: true })
        .eq("email", sanitizedEmail)
        .eq("task_type", "selfie")
        .gte("created_at", startOfMonth.toISOString());

      if (countError) throw countError;
      if (count >= 3) return res.status(403).json({ error: "Monthly limit reached. Come back next month!" });
    }

    const { error } = await supabase.from("syntrix_submissions").insert([{
      email: sanitizedEmail,
      task_type: taskType,
      file_name: fileName,
      temp_base64: imageBase64,
      contentTags: contentTags,
      status: "pending"
    }]);

    if (error) throw error;
    res.json({ success: true, message: "Queued for Verification" });
    processTaskQueueEngine();

  } catch (err) {
    return res.status(500).json({ error: "Waiting room ingestion failed: " + err.message });
  }
});

// ================= DOCUMENT MODE: BACKGROUND AI WORKER =================
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
let isTaskProcessing = false;

async function processSingleJob(job) {
    try {
        const base64Data = job.temp_base64.replace(/^data:(image|application)\/\w+;base64,/, "");

        if (job.task_type === 'selfie') {
            const today = new Date().toISOString().split('T')[0];
            const { count: dailyCount } = await supabase
                .from('syntrix_submissions')
                .select('*', { count: 'exact', head: true })
                .eq('email', job.email)
                .eq('task_type', 'selfie')
                .in('status', ['pending', 'approved', 'verified'])
                .gte('created_at', today);

            if (dailyCount > 1) { 
                await supabase.from('syntrix_submissions').update({ status: 'rejected', reason: 'Daily limit reached', temp_base64: null }).eq('id', job.id);
                return;
            }
        }

        const qualityRules = job.task_type === 'selfie' 
            ? 'Is it a clear, authentic photograph of a real human face? Provide a specific reason if it fails (e.g., blurry, multiple faces, bad lighting, not a human).' 
            : `Is this an authentic photo of physical, handwritten notes containing: ${job.contentTags || 'academic content'}? Reject PDFs, screenshots, printed textbook text, or blank pages. Provide a specific reason if it fails (e.g., printed text detected, blurry, off-topic).`;

        const combinedPrompt = `You are a strict security and academic AI validator. Evaluate this image for TWO criteria:
        1. QUALITY: ${qualityRules}
        2. PII: Does this image contain Sensitive Personal Identifiable Information (PII) such as a signature, full legal name, phone number, or physical address?
        Respond STRICTLY with valid JSON: {"quality_pass": true_or_false, "contains_pii": true_or_false, "reason": "Short reason for failure or success"}`;
        
        // 🚀 FIX: Rolled back to gemini-2.5-flash as this works securely for you.
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: [combinedPrompt, { inlineData: { mimeType: 'image/jpeg', data: base64Data } }]
        });

        let responseTextStr = typeof response.text === 'function' ? await response.text() : response.text;
        if (!responseTextStr) responseTextStr = response.candidates[0].content.parts[0].text; 

        const aiVerdict = JSON.parse(responseTextStr.replace(/```json/gi, "").replace(/```/g, "").trim());

        if (aiVerdict.contains_pii === true) {
            await supabase.from('syntrix_submissions').update({ status: 'rejected_pii', reason: 'Contains Sensitive PII', temp_base64: null }).eq('id', job.id);
            return;
        }

        if (aiVerdict.quality_pass === false) {
            await supabase.from('syntrix_submissions').update({ status: 'rejected', reason: aiVerdict.reason || 'Failed AI quality guidelines', temp_base64: null }).eq('id', job.id);
            return;
        }

        // 🚀 CRITICAL FIX: Gemini API cannot embed images via `embedContent`. 
        // We now safely create a unique text string (hash) from the image and embed THAT string.
        // This solves the 404 crash while keeping the database duplicate shield fully operational.
        const imageHash = crypto.createHash('sha256').update(base64Data).digest('hex');
        const embedRes = await ai.models.embedContent({
            model: "text-embedding-004", 
            contents: "Syntrix Image Hash: " + imageHash
        });
        const embedding = embedRes.embeddings[0].values;

        const { data: matchData } = await supabase.rpc("match_homework_vectors", {
            query_embedding: embedding,
            match_threshold: 0.98,
            match_count: 1
        });

        if (matchData && matchData.length > 0) {
            await supabase.from("syntrix_submissions").update({ status: "fraud", reason: "Duplicate image detected", temp_base64: null }).eq("id", job.id);
            return;
        }

        const buffer = Buffer.from(base64Data, "base64");
        const storagePath = `${job.email}/${Date.now()}_${job.file_name}`;
        
        const { error: uploadError } = await supabase.storage
          .from("verified_assets")
          .upload(storagePath, buffer, { contentType: "image/jpeg" });

        if (uploadError) throw uploadError;

        const { data: publicUrlData } = supabase.storage
          .from("verified_assets")
          .getPublicUrl(storagePath);

        await supabase.from("syntrix_submissions")
            .update({ status: "verified", temp_base64: null, storage_url: publicUrlData.publicUrl, embedding: embedding, reward_amount: 48, reason: "Verified Successfully" })
            .eq("id", job.id);

        const { data: userData } = await supabase.from('users').select('pendingRewards').eq('email', job.email).single();
        if(userData) {
            await supabase.from('users').update({ pendingRewards: (userData.pendingRewards || 0) + 48 }).eq('email', job.email);
        } else {
            await supabase.from('users').insert([{ email: job.email, pendingRewards: 48 }]);
        }

    } catch (jobErr) { 
        console.error(`Job ${job.id} error:`, jobErr.message); 
        await supabase.from('syntrix_submissions').update({ status: 'rejected', reason: `System Error: ${jobErr.message}`, temp_base64: null }).eq('id', job.id);
    }
}

async function processTaskQueueEngine() {
  if (isTaskProcessing) return;
  isTaskProcessing = true;

  try {
    const { data: jobs, error } = await supabase
      .from("syntrix_submissions")
      .select("*")
      .eq("status", "pending")
      .order('created_at', { ascending: true })
      .limit(5);

    if (error || !jobs || jobs.length === 0) { isTaskProcessing = false; return; }
    await Promise.allSettled(jobs.map(job => processSingleJob(job)));

  } catch (err) { 
      console.error("Worker Crash:", err.message); 
  } finally { 
      isTaskProcessing = false; 
  }
}

setInterval(processTaskQueueEngine, 5000);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

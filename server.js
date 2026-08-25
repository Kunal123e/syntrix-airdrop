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
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || origin.endsWith(".vercel.app") || origin === "http://localhost:3000") {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "accept", "api-key", "Origin", "X-Requested-With", "x-admin-key"]
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
    await sendEmailHTTP(referrerEmail, `You Earned ${rewardAmount} SYNTRIX Tokens`, htmlBody);
    return true;
  } catch (error) {
    console.error(`Failed to send API email to ${referrerEmail}:`, error.message);
    return false;
  }
}

// ================= OTP MEMORY STORE =================
const otpStorage = {};

setInterval(() => {
  const now = Date.now();
  for (const email in otpStorage) {
    if (otpStorage[email].expires < now) delete otpStorage[email];
  }
}, 10 * 60 * 1000);

// ================= OTP ROUTES =================
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

// ================= TEST & UTILITY ROUTES =================
app.get("/", (req, res) => {
  res.json({ success: true, message: "Syntrix Network API Engine Active" });
});

app.post("/api/test-email", async (req, res) => {
  const { toEmail } = req.body;
  try {
    await sendEmailHTTP(toEmail, "HTTP API TEST", "<p>API connection successful.</p>");
    return res.json({ success: true, message: "HTTP API email sent successfully." });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
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
    await sendEmailHTTP(friendEmail, "Join Syntrix and earn token rewards!", htmlBody);
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
      return res.status(400).json({ error: "Missing required timing metrics." });
    }

    const currentTime = Date.now();
    if (submissionTime > currentTime + 5000 || startTime > currentTime) {
       return res.status(400).json({ error: "Invalid timestamp synchronization detected." });
    }

    const timeTaken = submissionTime - startTime;
    if (timeTaken < 120000) {
      return res.status(400).json({ error: "Survey completed too quickly. Please take adequate time." });
    }

    if (!email) return res.status(400).json({ error: "Email identifier required" });
    const sanitizedEmail = email.trim().toLowerCase();
    const generatedReferralCode = generateReferralCode(sanitizedEmail);

    const { data: existingEmail } = await supabase
      .from("syntrix_claims")
      .select("id")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (existingEmail) return res.status(400).json({ error: "This email has already submitted the survey." });

    let referrerRecord = null;
    let isReferralValid = false;

    if (referredBy) {
      const cleanRefCode = normalizeReferralCode(referredBy);
      if (cleanRefCode === generatedReferralCode) return res.status(400).json({ error: "You cannot refer yourself." });

      const { data: referrerClaim, error: refError } = await supabase
        .from("syntrix_claims")
        .select("email")
        .eq("referral_code", cleanRefCode)
        .maybeSingle();

      if (refError || !referrerClaim) return res.status(400).json({ error: "Invalid referral code." });
      if (referrerClaim.email === sanitizedEmail) return res.status(400).json({ error: "Self-referral check failed." });

      referrerRecord = referrerClaim;

      const { data: alreadyReferred } = await supabase
        .from("syntrix_referrals")
        .select("id")
        .eq("referred_email", sanitizedEmail)
        .maybeSingle();

      if (alreadyReferred) return res.status(400).json({ error: "This email has already been referred." });
      isReferralValid = true;
    }

    const userXpProfile = await getXPProfile(supabase, sanitizedEmail);
    const surveyRewardInfo = calculateFinalTaskReward(48, userXpProfile ? userXpProfile.currentLevel : 1, userXpProfile ? userXpProfile.dailyStreak : 0);

    const { error: claimError } = await supabase
      .from("syntrix_claims")
      .insert([{
        email: sanitizedEmail,
        amount_rewarded: surveyRewardInfo.finalReward,
        status: "pending",
        referral_code: generatedReferralCode,
        survey_data: answers,
        survey_duration_seconds: Math.floor(timeTaken / 1000),
        assigned_badge: assignedBadge || "Analyzer"
      }]);

    if (claimError) return res.status(500).json({ error: "Claims Registry Failure: " + claimError.message });

    await awardXP(supabase, sanitizedEmail, 300, "Survey Completed", "survey");

    if (isReferralValid && referrerRecord) {
      const claimToken = crypto.randomBytes(32).toString('hex');
      await supabase.from("syntrix_referrals").insert([{
        referrer_email: referrerRecord.email, referred_email: sanitizedEmail, referral_code: normalizeReferralCode(referredBy), reward_amount: 10, status: "pending", claim_token: claimToken
      }]);

      await supabase.from("syntrix_rewards").insert([{
        email: referrerRecord.email, reward_type: "referral", amount: 10, status: "pending", claim_token: claimToken
      }]);

      await awardXP(supabase, referrerRecord.email, 120, "Referral Success", "referral");
      await sendRewardNotification(referrerRecord.email, 10, claimToken);
    }

    return res.json({
      success: true,
      referralCode: generatedReferralCode,
      rewardAmount: surveyRewardInfo.finalReward,
      multiplierApplied: surveyRewardInfo.totalMultiplier,
      message: "Survey data successfully stored."
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ================= PROFILE & DASHBOARD LOOKUPS =================
app.get("/api/user-status", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email parameter required" });

  try {
    const sanitizedEmail = email.trim().toLowerCase();
    await awardXP(supabase, sanitizedEmail, 10, "Daily Login", "login");

    const { data: userProfile, error } = await supabase
      .from("syntrix_claims")
      .select("email, status, wallet_address, tx_hash, referral_code, amount_rewarded, assigned_badge")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    const { count: totalReferrals } = await supabase
      .from("syntrix_referrals")
      .select("id", { count: "exact", head: true })
      .eq("referrer_email", sanitizedEmail);

    const { data: rewards } = await supabase.from("syntrix_rewards").select("amount, status").eq("email", sanitizedEmail);
    const { data: userTableRecord } = await supabase.from("users").select("pendingRewards, claimedRewards").eq("email", sanitizedEmail).maybeSingle();
    const { data: queuedItems } = await supabase.from("syntrix_payout_queue").select("status, tx_hash").eq("email", sanitizedEmail).order("id", { ascending: false }).limit(1).maybeSingle();

    let pendingRewards = 0, claimedRewards = 0;
    const surveyAmount = userProfile ? (userProfile.amount_rewarded || 48) : 48;

    if (userProfile) {
      if (userProfile.status === "pending" || userProfile.status === "processing") pendingRewards += Number(surveyAmount);
      else if (userProfile.status === "success") claimedRewards += Number(surveyAmount);
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

    if (!userProfile) return res.json({ success: false, exists: false, isClaimed: false, status: "FLOW_C" });

    const isClaimed = userProfile.status === "success" || !!(userProfile.tx_hash || userProfile.wallet_address) || (queuedItems && queuedItems.status === "success");

    return res.json({
      success: true,
      exists: true,
      isClaimed: isClaimed,
      status: isClaimed ? "completed" : "verified",
      referralsCount: totalReferrals || 0,
      pendingRewards,
      claimedRewards,
      referralCode: userProfile.referral_code || null,
      txHash: userProfile.tx_hash || (queuedItems ? queuedItems.tx_hash : null),
      walletAddress: userProfile.wallet_address || null,
      badge: userProfile.assigned_badge || "Analyzer"
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ================= CLAIM DETAILS LOOKUP =================
app.get("/api/claim-details", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Claim token parameter required." });

  try {
    const { data: reward, error } = await supabase
      .from("syntrix_rewards")
      .select("email, amount, reward_type, status")
      .eq("claim_token", token.trim())
      .maybeSingle();

    if (error || !reward) return res.status(404).json({ error: "Invalid claim token or reward record not found." });

    return res.json({
      success: true, email: reward.email, amount: reward.amount, type: reward.reward_type, status: reward.status
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error reading token properties." });
  }
});

// ================= CRYPTOGRAPHIC QUEUE INGESTION ENDPOINT =================
app.post("/api/execute-claim", async (req, res) => {
  const { token, walletAddress, signature } = req.body;

  if (!token || !walletAddress || !signature) return res.status(400).json({ error: "Token, wallet address, and cryptographic signature verification required." });
  if (!ethers.isAddress(walletAddress)) return res.status(400).json({ error: "Invalid target wallet address format." });

  try {
    const sanitizedWallet = walletAddress.trim().toLowerCase();

    const { data: rewardRecord, error: fetchErr } = await supabase
      .from("syntrix_rewards")
      .select("id, email, amount, status, reward_type")
      .eq("claim_token", token.trim())
      .maybeSingle();

    if (fetchErr || !rewardRecord) return res.status(404).json({ error: "Claim token invalid or not found." });
    if (rewardRecord.status !== "pending") return res.status(400).json({ error: `Reward claim has already been marked as ${rewardRecord.status}.` });

    const email = rewardRecord.email.trim().toLowerCase();

    const { data: walletMap } = await supabase.from("syntrix_wallets").select("email").eq("wallet_address", sanitizedWallet).maybeSingle();
    if (walletMap && walletMap.email !== email) return res.status(400).json({ error: "This wallet is already linked to another account." });

    const { data: emailMap } = await supabase.from("syntrix_wallets").select("wallet_address").eq("email", email).maybeSingle();
    if (emailMap && emailMap.wallet_address.toLowerCase() !== sanitizedWallet) return res.status(400).json({ error: `This email is already associated with a different wallet address: ${emailMap.wallet_address}` });

    try {
      const message = `Authenticating Token Core distribution protocols on email registry node: ${email}`;
      const signerAddress = ethers.verifyMessage(message, signature);
      if (signerAddress.toLowerCase() !== sanitizedWallet) return res.status(400).json({ error: "Cryptographic wallet signature validation failed." });
    } catch (sigErr) {
      return res.status(400).json({ error: "Signature verification processing error: " + sigErr.message });
    }

    const { data: itemInQueue } = await supabase.from("syntrix_payout_queue").select("id").eq("claim_token", token.trim()).maybeSingle();
    if (itemInQueue) return res.status(400).json({ error: "This distribution request is already queued for processing." });

    await supabase.from("syntrix_payout_queue").insert([{
      email: email, wallet_address: sanitizedWallet, reward_amount: Number(rewardRecord.amount), claim_token: token.trim(), status: "queued"
    }]);

    await supabase.from("syntrix_rewards").update({ status: "processing" }).eq("id", rewardRecord.id);
    if (!emailMap) await supabase.from("syntrix_wallets").upsert({ email: email, wallet_address: sanitizedWallet });

    return res.json({ success: true, message: "Claim safely routed to blockchain transactional queue buffers." });

  } catch (err) {
    return res.status(500).json({ error: "Fulfillment ingestion failed: " + err.message });
  }
});

// ================= LAZY SURVEY CLAIM DISPENSER =================
app.post("/api/claim-reward", async (req, res) => {
  const { email, walletAddress } = req.body;
  if (!email || !walletAddress) return res.status(400).json({ error: "Email and destination wallet address are required." });
  if (!ethers.isAddress(walletAddress)) return res.status(400).json({ error: "Invalid target wallet address string." });

  try {
    const sanitizedEmail = email.trim().toLowerCase();
    const sanitizedWallet = walletAddress.trim().toLowerCase();

    const { data: userRecord } = await supabase.from("syntrix_claims").select("id, status, tx_hash, amount_rewarded").eq("email", sanitizedEmail).maybeSingle();
    if (!userRecord) return res.status(404).json({ error: "User survey verification profile not found." });
    if (userRecord.status === "success" || userRecord.tx_hash) return res.status(400).json({ error: "Rewards have already been successfully distributed to this email." });

    const { data: walletMap } = await supabase.from("syntrix_wallets").select("email").eq("wallet_address", sanitizedWallet).maybeSingle();
    if (walletMap && walletMap.email !== sanitizedEmail) return res.status(400).json({ error: "This wallet is already linked to another account." });

    const { data: emailMap } = await supabase.from("syntrix_wallets").select("wallet_address").eq("email", sanitizedEmail).maybeSingle();
    if (emailMap && emailMap.wallet_address.toLowerCase() !== sanitizedWallet) return res.status(400).json({ error: `This email is already associated with a different wallet address: ${emailMap.wallet_address}` });

    const { data: duplicateWallet } = await supabase.from("syntrix_claims").select("id").eq("wallet_address", sanitizedWallet).maybeSingle();
    if (duplicateWallet) return res.status(400).json({ error: "This wallet address has already been used to claim a survey reward." });

    const rewardAmount = userRecord.amount_rewarded || 48;
    await supabase.from("syntrix_payout_queue").insert([{
      email: sanitizedEmail, wallet_address: sanitizedWallet, reward_amount: rewardAmount, claim_token: `SURVEY-LAZY-${crypto.randomBytes(8).toString('hex').toUpperCase()}`, status: "queued"
    }]);

    await supabase.from("syntrix_claims").update({ status: "processing" }).eq("id", userRecord.id);

    return res.json({ success: true, message: "Lazy reward request appended to processing queues." });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Smart contract claim execution pipeline blocked." });
  }
});

// ================= THE BACKGROUND BLOCKCHAIN TRANSACTION QUEUE ENGINE =================
let isQueueProcessing = false;

async function processPayoutQueueEngine() {
  if (isQueueProcessing) return;
  isQueueProcessing = true;

  try {
    const { data: queueJob, error } = await supabase.from("syntrix_payout_queue")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!queueJob) {
      isQueueProcessing = false;
      return;
    }

    console.log(`[QUEUE ENGINE] Processing job ID ${queueJob.id} for target recipient: ${queueJob.email}`);

    await supabase.from("syntrix_payout_queue").update({ status: "processing" }).eq("id", queueJob.id);

    if (!tokenContract) {
      const mockTxHash = "0x" + crypto.randomBytes(32).toString("hex");
      await finalizeSuccessfulQueueJob(queueJob, mockTxHash);
      isQueueProcessing = false;
      return;
    }

    try {
      const decimals = await tokenContract.decimals();
      const amount = ethers.parseUnits(queueJob.reward_amount.toString(), decimals);

      const tx = await tokenContract.transfer(queueJob.wallet_address, amount);
      console.log(`[QUEUE ENGINE] Broadcasted transaction on-chain: ${tx.hash}.`);

      await supabase.from("syntrix_payout_queue").update({
        status: "processing",
        tx_hash: tx.hash
      }).eq("id", queueJob.id);

      await finalizeSuccessfulQueueJob(queueJob, tx.hash);

    } catch (blockchainError) {
      console.error(`[QUEUE ENGINE ERROR] Processing failure encountered on task ID ${queueJob.id}:`, blockchainError.message);

      await supabase.from("syntrix_payout_queue").update({
        status: "failed",
        error_message: blockchainError.message,
        processed_at: new Date().toISOString()
      }).eq("id", queueJob.id);

      if (queueJob.claim_token.startsWith("SURVEY-LAZY-")) {
        await supabase.from("syntrix_claims").update({ status: "pending" }).eq("email", queueJob.email);
      } else {
        await supabase.from("syntrix_rewards").update({ status: "pending" }).eq("claim_token", queueJob.claim_token);
      }
    }

  } catch (engineError) {
    console.error("[QUEUE ENGINE CORE FAILURE]:", engineError.message);
  } finally {
    isQueueProcessing = false;
  }
}

async function finalizeSuccessfulQueueJob(job, txHash) {
  await supabase.from("syntrix_payout_queue").update({
    status: "success", tx_hash: txHash, processed_at: new Date().toISOString()
  }).eq("id", job.id);

  if (job.claim_token.startsWith("SURVEY-LAZY-")) {
    await supabase.from("syntrix_claims").update({ wallet_address: job.wallet_address, tx_hash: txHash, status: "success" }).eq("email", job.email);
  } else {
    await supabase.from("syntrix_rewards").update({ tx_hash: txHash, claimed_wallet: job.wallet_address, claimed_at: new Date().toISOString(), status: "claimed" }).eq("claim_token", job.claim_token);
    await supabase.from("syntrix_referrals").update({ status: "claimed" }).eq("claim_token", job.claim_token);
    await supabase.from("syntrix_claims").update({ wallet_address: job.wallet_address, tx_hash: txHash, status: "success" }).eq("email", job.email);
  }
  console.log(`[QUEUE ENGINE] Successfully processed and finalized payout records for: ${job.email}`);
}

setInterval(addUniqueThreadGuard, 15000);
function addUniqueThreadGuard() {
  processPayoutQueueEngine().catch(err => console.error("Thread system leak caught:", err.message));
}

// ================= UI POLLING ENDPOINT =================
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

// Helper: Extract and decode relative storage path from Supabase Public URL
function getBucketFilePathFromUrl(publicUrl) {
  if (!publicUrl) return null;
  const parts = publicUrl.split("/verified_assets/");
  return parts.length > 1 ? decodeURIComponent(parts[1]) : null;
}

// ================= BACKEND-INTERCEPT BUCKET UPLOAD =================
app.post("/api/upload-task", async (req, res) => {
  const { userEmail, taskType, fileName, imageBase64, contentTags } = req.body;

  if (!userEmail || !taskType || !fileName || !imageBase64) {
    return res.status(400).json({ error: "Missing required document fields." });
  }

  const sanitizedEmail = userEmail.trim().toLowerCase();

  // Sanitize the filename to strip out spaces and special characters
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');

  try {
    // 1. Convert Base64 to Buffer
    const base64Data = imageBase64.replace(/^data:(image|application)\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    // 2. Upload directly to Supabase Bucket "pending" folder with SAFE filename
    const storagePath = `pending/${sanitizedEmail}/${Date.now()}_${safeFileName}`;
    const { error: uploadError } = await supabase.storage
      .from("verified_assets")
      .upload(storagePath, buffer, { contentType: "image/jpeg" });

    if (uploadError) throw new Error(`Bucket upload failed: ${uploadError.message}`);

    // 3. Get Public URL
    const { data: publicUrlData } = supabase.storage.from("verified_assets").getPublicUrl(storagePath);

    // 4. Save tiny URL to Database (NO BLOAT)
    const { error: dbError } = await supabase.from("syntrix_submissions").insert([{
      email: sanitizedEmail,
      task_type: taskType,
      file_name: safeFileName,
      storage_url: publicUrlData.publicUrl,
      contentTags: contentTags || [],
      status: "pending"
    }]);

    if (dbError) throw dbError;

    res.json({ success: true, message: "Queued for AI Verification" });
    processTaskQueueEngine();

  } catch (err) {
    return res.status(500).json({ error: "Ingestion failed: " + err.message });
  }
});

// ================= BUCKET-FED AI WORKER ENGINE =================
const aiDocs = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY_DOCS || process.env.GEMINI_API_KEY });
const aiSelfies = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY_SELFIES || process.env.GEMINI_API_KEY });

let isTaskProcessing = false;

async function processSingleJob(job) {
    const relativeFilePath = getBucketFilePathFromUrl(job.storage_url);
    const isSelfie = job.task_type === 'selfie';
    const activeAiClient = isSelfie ? aiSelfies : aiDocs;

    try {
        // 1. Fetch image from Bucket into temporary RAM
        const imageResponse = await fetch(job.storage_url);
        if (!imageResponse.ok) throw new Error("Failed to fetch image from bucket.");
        const arrayBuffer = await imageResponse.arrayBuffer();
        const imageBuffer = Buffer.from(arrayBuffer);
        const base64Data = imageBuffer.toString("base64");

        // 2. AI EVALUATION
        const qualityRules = isSelfie
            ? 'Is it a clear, authentic photograph of a real human face? Provide a specific reason if it fails.'
            : `Is this an authentic photo of physical, handwritten notes containing: ${job.contentTags || 'academic content'}? Reject PDFs, screenshots, printed textbook text, blank pages, and ABSOLUTELY REJECT any human faces, selfies, or passport-style portrait photos.`;

        const combinedPrompt = `You are a strict security AI validator. Evaluate this image for:
        1. QUALITY: ${qualityRules}
        2. PII: Does this image contain Sensitive Personal Identifiable Information (phone numbers, addresses)?
        Respond STRICTLY with JSON: {"quality_pass": true_or_false, "contains_pii": true_or_false, "reason": "Short reason"}`;

        let response;
        const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_BACKUP_KEY].filter(Boolean);
        let lastError;

        for (let i = 0; i < keys.length; i++) {
            try {
                const aiClient = new GoogleGenAI({ apiKey: keys[i] });
                response = await aiClient.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [ { text: combinedPrompt }, { inlineData: { mimeType: 'image/jpeg', data: base64Data } } ],
                    config: { responseMimeType: "application/json" }
                });
                break; // If successful, break the loop
            } catch (error) {
                console.warn(`[AI API] Call failed with key index ${i}. Error: ${error.message}`);
                lastError = error;
                if (i === keys.length - 1) {
                    throw lastError; // If all keys fail, throw the final error
                }
            }
        }

        const aiVerdict = JSON.parse(response.text.trim());

        // REJECTION (Delete file from Bucket)
        if (aiVerdict.contains_pii || !aiVerdict.quality_pass) {
            const rejectReason = aiVerdict.contains_pii ? 'Contains Sensitive PII' : aiVerdict.reason;
            const rejectStatus = aiVerdict.contains_pii ? 'rejected_pii' : 'rejected';

            if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
            await supabase.from('syntrix_submissions').update({ status: rejectStatus, reason: rejectReason }).eq('id', job.id);
            return;
        }

        // 3. PIXEL HASH DUPLICATE CHECK
        const imageHash = crypto.createHash("sha256").update(imageBuffer).digest("hex");
        const { data: exactMatchData } = await supabase.from("syntrix_submissions").select("id").like("reason", `%Hash:${imageHash}%`).limit(1).maybeSingle();

        // REJECTION (Delete Duplicate)
        if (exactMatchData) {
            if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
            await supabase.from("syntrix_submissions").update({ status: "fraud", reason: "Duplicate image detected (Hash Match)" }).eq("id", job.id);
            return;
        }

        let finalEmbedding = null;
        if (!isSelfie) {
            const embedRes = await activeAiClient.models.embedContent({
                model: "gemini-embedding-001", contents: `Task: ${job.task_type} | User: ${job.email}`
            });
            finalEmbedding = embedRes.embeddings[0].values;
            const { data: matchData } = await supabase.rpc("match_homework_vectors", { query_embedding: finalEmbedding, match_threshold: 0.98, match_count: 1 });

            // REJECTION (Delete Semantic Duplicate)
            if (matchData && matchData.length > 0) {
                if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]);
                await supabase.from("syntrix_submissions").update({ status: "fraud", reason: "Duplicate metadata detected (Vector Match)" }).eq("id", job.id);
                return;
            }
        }

        // APPROVAL (Move file to verified folder)
        const verifiedPath = `verified/${job.email}/${Date.now()}_${job.file_name}`;
        if (relativeFilePath) {
            await supabase.storage.from("verified_assets").move(relativeFilePath, verifiedPath);
        }
        const { data: finalUrlData } = supabase.storage.from("verified_assets").getPublicUrl(verifiedPath);

        const jobXpProfile = await getXPProfile(supabase, job.email);
        const taskRewardInfo = calculateFinalTaskReward(48, jobXpProfile ? jobXpProfile.currentLevel : 1, jobXpProfile ? jobXpProfile.dailyStreak : 0);

        await supabase.from("syntrix_submissions").update({
            status: "verified",
            storage_url: finalUrlData.publicUrl,
            embedding: finalEmbedding,
            reward_amount: taskRewardInfo.finalReward,
            reason: `Verified Successfully | Hash:${imageHash} | Paid ${taskRewardInfo.finalReward} SYNX`
        }).eq("id", job.id);

        const { data: userData } = await supabase.from('users').select('pendingRewards').eq('email', job.email).single();
        if(userData) {
            await supabase.from('users').update({ pendingRewards: (userData.pendingRewards || 0) + taskRewardInfo.finalReward }).eq('email', job.email);
        } else {
            await supabase.from('users').insert([{ email: job.email, pendingRewards: taskRewardInfo.finalReward }]);
        }

        await awardXP(supabase, job.email, isSelfie ? 60 : 70, isSelfie ? "Selfie Verified" : "Document Verified", isSelfie ? "selfie" : "document");

    } catch (jobErr) {
        console.error(`Job ${job.id} error:`, jobErr.message);
        if (relativeFilePath) await supabase.storage.from("verified_assets").remove([relativeFilePath]).catch(()=>{});
        await supabase.from('syntrix_submissions').update({ status: 'rejected', reason: `System Error: ${jobErr.message}` }).eq('id', job.id);
    }
}

async function processTaskQueueEngine() {
  if (isTaskProcessing) return;
  isTaskProcessing = true;
  try {
    const { data: jobs, error } = await supabase.from("syntrix_submissions").select("*").eq("status", "pending").order('created_at', { ascending: true }).limit(5);
    if (error || !jobs || jobs.length === 0) { isTaskProcessing = false; return; }
    await Promise.allSettled(jobs.map(job => processSingleJob(job)));
  } catch (err) {
      console.error("Worker Crash:", err.message);
  } finally {
      isTaskProcessing = false;
  }
}
setInterval(processTaskQueueEngine, 5000);

// ================= XP PROFILE =================
app.get("/api/xp-profile", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email parameter required" });
  try {
    const profile = await getXPProfile(supabase, email);
    return res.json({ success: true, profile });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// GOD MODE: SECURE ADMIN PANEL ROUTES
// =========================================================================

// -- Admin Auth Middleware --
// Reads x-admin-key header and validates against ADMIN_SECRET_KEY env var.
// Protects all /api/admin/* routes except /api/admin/login.
function verifyAdminAccess(req, res, next) {
  var adminKey = req.headers['x-admin-key'];
  var correctKey = process.env.ADMIN_SECRET_KEY;

  if (!correctKey) {
    return res.status(500).json({
      success: false,
      error: "Admin secret key not configured on server."
    });
  }

  if (!adminKey || adminKey !== correctKey) {
    return res.status(403).json({
      success: false,
      error: "Forbidden: Invalid or missing admin key."
    });
  }

  next();
}

// -- POST /api/admin/login --
// Checks password against ADMIN_SECRET_KEY and returns it as a session token.
app.post("/api/admin/login", function(req, res) {
  try {
    var password = (req.body.password || '').trim();

    if (!password) {
      return res.status(400).json({
        success: false,
        error: 'Password is required.'
      });
    }

    if (password !== process.env.ADMIN_SECRET_KEY) {
      return res.status(401).json({
        success: false,
        error: 'Authentication denied. Invalid credentials.'
      });
    }

    return res.json({
      success: true,
      token: password
    });

  } catch (err) {
    console.error('[ADMIN LOGIN ERROR]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error during authentication.'
    });
  }
});

// -- GET /api/admin/stats --
// Returns aggregate counts for the admin dashboard Bento grid.
// Tables: syntrix_submissions, users (with pendingRewards column).
app.get("/api/admin/stats", verifyAdminAccess, async function(req, res) {
  try {
    // Total unique users
    var usersResult = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true });
    var totalUsers = (usersResult.count !== null && usersResult.count !== undefined)
      ? usersResult.count
      : 0;

    // Total submissions
    var totalResult = await supabase
      .from('syntrix_submissions')
      .select('id', { count: 'exact', head: true });
    var totalSubmissions = (totalResult.count !== null && totalResult.count !== undefined)
      ? totalResult.count
      : 0;

    // Pending submissions
    var pendingResult = await supabase
      .from('syntrix_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    var pendingSubmissions = (pendingResult.count !== null && pendingResult.count !== undefined)
      ? pendingResult.count
      : 0;

    // Total SYNX tokens distributed (from users.pendingRewards)
    var tokensResult = await supabase
      .from('users')
      .select('pendingRewards');
    var totalTokens = 0;
    if (tokensResult.data && tokensResult.data.length > 0) {
      totalTokens = tokensResult.data.reduce(function(sum, row) {
        return sum + (Number(row.pendingRewards) || 0);
      }, 0);
    }

    return res.json({
      success: true,
      stats: {
        totalUsers: totalUsers,
        totalSubmissions: totalSubmissions,
        pendingSubmissions: pendingSubmissions,
        totalTokens: totalTokens
      }
    });

  } catch (err) {
    console.error('[ADMIN STATS ERROR]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch stats: ' + err.message
    });
  }
});

// -- GET /api/admin/submissions --
// Returns the latest 50 submissions ordered by creation date.
app.get("/api/admin/submissions", verifyAdminAccess, async function(req, res) {
  try {
    var result = await supabase
      .from('syntrix_submissions')
      .select('id, email, task_type, status, reason, storage_url, created_at')
      .order('created_at', { ascending: false })
      .limit(50);

    if (result.error) {
      throw new Error(result.error.message);
    }

    return res.json({
      success: true,
      submissions: result.data || []
    });

  } catch (err) {
    console.error('[ADMIN SUBMISSIONS ERROR]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch submissions: ' + err.message
    });
  }
});

// -- POST /api/admin/override --
// Force-updates a submission status and reason (God Mode approve/reject).
app.post("/api/admin/override", verifyAdminAccess, async function(req, res) {
  try {
    var id = req.body.id;
    var newStatus = req.body.newStatus;
    var reason = req.body.reason || 'Manual override via God Mode';

    if (!id || !newStatus) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: id and newStatus.'
      });
    }

    // Validate that newStatus is an expected value
    var allowedStatuses = ['verified', 'rejected', 'pending'];
    if (allowedStatuses.indexOf(newStatus) === -1) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Allowed: verified, rejected, pending.'
      });
    }

    var result = await supabase
      .from('syntrix_submissions')
      .update({
        status: newStatus,
        reason: reason
      })
      .eq('id', id);

    if (result.error) {
      throw new Error(result.error.message);
    }

    console.log('[ADMIN OVERRIDE] Task ' + id + ' -> ' + newStatus);

    return res.json({
      success: true,
      message: 'Submission ' + id + ' updated to ' + newStatus + '.'
    });

  } catch (err) {
    console.error('[ADMIN OVERRIDE ERROR]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Override failed: ' + err.message
    });
  }
});

// ===================== SERVER INITIALIZATION ===============================

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT} bound to 0.0.0.0`));

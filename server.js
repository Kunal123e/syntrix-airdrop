require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");

const app = express();

// ================= COORD ADJUSTMENTS (CORS & HEADERS) =================
// Fully opens the gateway pipeline so your frontend never triggers a network offline drop
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "accept", "api-key"]
}));
app.use(express.json({ limit: "2mb" }));

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

console.log(`BREVO API KEY FOUND: ${BREVO_API_KEY ? "YES" : "NO"}`);

// Master HTTP Email Helper
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
    console.log(`Notification email sent via API to referrer: ${referrerEmail}`);
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
    console.log(`[OTP] Sent via API to ${sanitizedEmail}`);
    return res.json({ success: true, message: "OTP Sent" });
  } catch (err) {
    console.error(`[OTP] API Delivery Failed for ${sanitizedEmail}:`, err.message);
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

// ================= TEST ROUTES =================
app.get("/", (req, res) => {
  res.json({ success: true, message: "Syntrix Referral Backend Operating with Dedicated Queue Architecture" });
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

// ================= SEND INVITE ROUTE =================
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

// ================= DYNAMIC QR REDIRECTOR =================
app.get("/r/:refCode", (req, res) => {
  const refCode = req.params.refCode;
  const targetDomain = process.env.FRONTEND_URL || "https://syntrix-airdrop.onrender.com"; 
  res.redirect(302, `${targetDomain}/?ref=${refCode}`);
});

// ================= SURVEY INGESTION SYSTEM (QUALITY GATE SECURED) =================
app.post("/api/submit-survey", async (req, res) => {
  try {
    const { email, referredBy, answers, startTime, submissionTime, assignedBadge } = req.body;

    // 🚀 STRICT SERVER-SIDE QUALITY CHECK: 120,000ms = 2 Minutes
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

      if (refError || !referrerClaim) return res.status(400).json({ error: "Invalid referral code. Code does not exist." });
      if (referrerClaim.email === sanitizedEmail) return res.status(400).json({ error: "Self-referral check: Code belongs to this email." });

      referrerRecord = referrerClaim;

      const { data: alreadyReferred } = await supabase
        .from("syntrix_referrals")
        .select("id")
        .eq("referred_email", sanitizedEmail)
        .maybeSingle();

      if (alreadyReferred) return res.status(400).json({ error: "This email has already been referred." });
      isReferralValid = true;
    }

    // 🚀 FIXED: Survey completion amount_rewarded updated, and duration + badges saved to Supabase
    const { data: claimData, error: claimError } = await supabase
      .from("syntrix_claims")
      .insert([{
        email: sanitizedEmail, 
        amount_rewarded: 48, 
        status: "pending", 
        referral_code: generatedReferralCode, 
        survey_data: answers,
        survey_duration_seconds: Math.floor(timeTaken / 1000), // 🚀 Metrics saved directly to Supabase
        assigned_badge: assignedBadge || "Analyzer" // 🚀 Badges saved directly to Supabase
      }])
      .select("id, email, status, wallet_address")
      .single();

    if (claimError) {
      if (claimError.code === "23505") return res.status(400).json({ error: "This email has already submitted the survey." });
      return res.status(500).json({ error: "Claims Registry Failure: " + claimError.message });
    }

    if (isReferralValid && referrerRecord) {
      const claimToken = crypto.randomBytes(32).toString('hex');
      // Referrals remain at 10 tokens
      await supabase.from("syntrix_referrals").insert([{
        referrer_email: referrerRecord.email, referred_email: sanitizedEmail, referral_code: normalizeReferralCode(referredBy), reward_amount: 10, status: "pending", claim_token: claimToken
      }]);

      await supabase.from("syntrix_rewards").insert([{
        email: referrerRecord.email, reward_type: "referral", amount: 10, status: "pending", claim_token: claimToken
      }]);

      await sendRewardNotification(referrerRecord.email, 10, claimToken);
    }

    return res.json({
      success: true,
      referralCode: generatedReferralCode,
      message: "Survey data successfully stored."
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ================= PROFILE LOOKUP (MATCHED TO FRONTEND USER-STATUS) =================
app.get("/api/user-status", async (req, res) => {
  const { email, ref } = req.query;
  if (!email) return res.status(400).json({ error: "Email parameter required" });

  try {
    const sanitizedEmail = email.trim().toLowerCase();

    if (ref) {
      const cleanRefCode = normalizeReferralCode(ref);
      const generatedReferralCode = generateReferralCode(sanitizedEmail);

      if (cleanRefCode === generatedReferralCode) return res.status(400).json({ error: "You cannot refer yourself." });

      const { data: referrerClaim, error: refError } = await supabase
        .from("syntrix_claims")
        .select("email")
        .eq("referral_code", cleanRefCode)
        .maybeSingle();

      if (refError || !referrerClaim) return res.status(400).json({ error: "Invalid referral code. Code does not exist." });
      if (referrerClaim.email === sanitizedEmail) return res.status(400).json({ error: "Self-referral check: Code belongs to this email." });

      const { data: alreadyReferred } = await supabase
        .from("syntrix_referrals")
        .select("id")
        .eq("referred_email", sanitizedEmail)
        .maybeSingle();

      if (alreadyReferred) return res.status(400).json({ error: "This email has already been referred." });
    }

    const { data: userProfile, error } = await supabase
      .from("syntrix_claims")
      .select("email, status, wallet_address, tx_hash, referral_code, amount_rewarded, assigned_badge")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    
    // Check if they have an active task sitting inside our queue table
    const { data: queuedItems } = await supabase.from("syntrix_payout_queue")
      .select("status, tx_hash")
      .eq("email", sanitizedEmail)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!userProfile) return res.json({ success: false, exists: false, isClaimed: false, status: "FLOW_C" });

    // Fetch referral dashboard aggregates directly to return to frontend
    const { count: totalReferrals } = await supabase
      .from("syntrix_referrals")
      .select("id", { count: "exact", head: true })
      .eq("referrer_email", sanitizedEmail);

    const { data: rewards } = await supabase.from("syntrix_rewards").select("amount, status").eq("email", sanitizedEmail);

    let pendingRewards = 0, claimedRewards = 0;
    
    // 🚀 FIXED: Default baseline reward updated from 56 to 48 dynamically 
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

    // Evaluate live transactional states across dependencies
    const isClaimed = userProfile.status === "success" || 
                      !!(userProfile.tx_hash || userProfile.wallet_address) ||
                      (queuedItems && queuedItems.status === "success");

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
    return res.status(500).json({ error: err.message || "Dashboard authentication processing failure" });
  }
});

// ================= CLAIM DETAILS LOOKUP (MATCHED TO FRONTEND) =================
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
      success: true, 
      email: reward.email, 
      amount: reward.amount, 
      type: reward.reward_type, 
      status: reward.status
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

    // Stop duplicate queueing loops if hit concurrently
    const { data: itemInQueue } = await supabase.from("syntrix_payout_queue").select("id").eq("claim_token", token.trim()).maybeSingle();
    if (itemInQueue) return res.status(400).json({ error: "This distribution request is already queued for processing." });

    // Instantly append items to the database transaction log array (Fast execution pathway!)
    await supabase.from("syntrix_payout_queue").insert([{
      email: email,
      wallet_address: sanitizedWallet,
      reward_amount: Number(rewardRecord.amount),
      claim_token: token.trim(),
      status: "queued"
    }]);

    // Lock local database states immediately
    await supabase.from("syntrix_rewards").update({ status: "processing" }).eq("id", rewardRecord.id);
    if (!emailMap) await supabase.from("syntrix_wallets").upsert({ email: email, wallet_address: sanitizedWallet });

    return res.json({ success: true, message: "Claim safely routed to blockchain transactional queue buffers." });

  } catch (err) {
    return res.status(500).json({ error: "Fulfillment ingestion failed: " + err.message });
  }
});

// ================= LAZY SURVEY CLAIM DISPENSER (BACKWARDS COMPATIBLE) =================
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

    // 🚀 FIXED: Lazy reward fallback value updated from 56 to 48
    const rewardAmount = userRecord.amount_rewarded || 48;
    await supabase.from("syntrix_payout_queue").insert([{
      email: sanitizedEmail,
      wallet_address: sanitizedWallet,
      reward_amount: rewardAmount,
      claim_token: `SURVEY-LAZY-${crypto.randomBytes(8).toString('hex').toUpperCase()}`,
      status: "queued"
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
    // Pick up exactly one oldest queued item sequentially
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

    // Set job state to processing immediately to preserve multi-threading barriers
    await supabase.from("syntrix_payout_queue").update({ status: "processing" }).eq("id", queueJob.id);

    if (!tokenContract) {
      // Mock mode pipeline processing if private variables are unpopulated
      const mockTxHash = "0x" + crypto.randomBytes(32).toString("hex");
      await finalizeSuccessfulQueueJob(queueJob, mockTxHash);
      isQueueProcessing = false;
      return;
    }

    // Real On-Chain Blockchain Payout Processing Node Array
    try {
      const decimals = await tokenContract.decimals();
      const amount = ethers.parseUnits(queueJob.reward_amount.toString(), decimals);

      // Execute automated deduction/transfer from primary host wallet balance allocation
      const tx = await tokenContract.transfer(queueJob.wallet_address, amount);
      console.log(`[QUEUE ENGINE] Broadcasted transaction on-chain: ${tx.hash}. Waiting confirmation block metrics...`);
      
      await tx.wait();
      await finalizeSuccessfulQueueJob(queueJob, tx.hash);

    } catch (blockchainError) {
      console.error(`[QUEUE ENGINE ERROR] Processing failure encountered on task ID ${queueJob.id}:`, blockchainError.message);
      
      // Rollback internal metrics so tasks do not log dead locks permanently
      await supabase.from("syntrix_payout_queue").update({ 
        status: "failed", 
        error_message: blockchainError.message,
        processed_at: new Date().toISOString()
      }).eq("id", queueJob.id);

      // Reset local tokens to historical entry baselines
      if (queueJob.claim_token.startsWith("SURVEY-LAZY-")) {
        await supabase.from("syntrix_claims").update({ status: "pending" }).eq("email", queueJob.email);
      } else {
        await supabase.from("syntrix_rewards").update({ status: "pending" }).eq("claim_token", queueJob.claim_token);
      }
    }

  } catch (engineError) {
    console.error("[QUEUE ENGINE ENGINE FAILURE CORE CRASH]:", engineError.message);
  } finally {
    isQueueProcessing = false;
  }
}

// Master Ledger Finalization Query Block Setup
async function finalizeSuccessfulQueueJob(job, txHash) {
  await supabase.from("syntrix_payout_queue").update({
    status: "success",
    tx_hash: txHash,
    processed_at: new Date().toISOString()
  }).eq("id", job.id);

  if (job.claim_token.startsWith("SURVEY-LAZY-")) {
    await supabase.from("syntrix_claims").update({ wallet_address: job.wallet_address, tx_hash: txHash, status: "success" }).eq("email", job.email);
  } else {
    await supabase.from("syntrix_rewards").update({ tx_hash: txHash, claimed_wallet: job.wallet_address, claimed_at: new Date().toISOString(), status: "claimed" }).eq("claim_token", job.claim_token);
    
    // Keep downstream referral logging structures fully linked up
    await supabase.from("syntrix_referrals").update({ status: "claimed" }).eq("claim_token", job.claim_token);
    await supabase.from("syntrix_claims").update({ wallet_address: job.wallet_address, tx_hash: txHash, status: "success" }).eq("email", job.email);
  }
  console.log(`[QUEUE ENGINE] Successfully processed and finalized payout records for: ${job.email}`);
}

// Tick loop tracking clock configurations set to execute every 15 seconds sequentially
setInterval(addUniqueThreadGuard, 15000);
function addUniqueThreadGuard() {
  processPayoutQueueEngine().catch(err => console.error("Thread system leak caught:", err.message));
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

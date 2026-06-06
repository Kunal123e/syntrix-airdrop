require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");

const app = express();

app.use(cors());
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
    console.log("Blockchain configuration initialized successfully.");
  } catch (err) {
    console.error("Blockchain provider initialization failed:", err.message);
  }
} else {
  console.warn("Blockchain credentials missing in .env. Claim routes will run in MOCK mode.");
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
      // THE FIXED SENDER LOOKUP: Pointing to your verified sender email account profile.
      // Brevo will auto-wrap this in its secure tracking mask so Google passes it smoothly!
      sender: { 
        name: SENDER_NAME, 
        email: "syntrix.care@gmail.com" 
      },
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
    await sendEmailHTTP(referrerEmail, "🎁 You Earned 10 SYNTRIX Tokens", htmlBody);
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
  res.json({ success: true, message: "Syntrix Referral Backend Operating with HTTP Email API" });
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

// ================= SURVEY INGESTION SYSTEM =================
app.post("/api/claim-airdrop", async (req, res) => {
  try {
    const { email, referredByCode, answers } = req.body;

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

    if (referredByCode) {
      const cleanRefCode = normalizeReferralCode(referredByCode);
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

    const { data: claimData, error: claimError } = await supabase
      .from("syntrix_claims")
      .insert([{
        email: sanitizedEmail, amount_rewarded: 10, status: "pending", referral_code: generatedReferralCode, survey_data: answers 
      }])
      .select("id, email, status, wallet_address")
      .single();

    if (claimError) {
      if (claimError.code === "23505") return res.status(400).json({ error: "This email has already submitted the survey." });
      return res.status(500).json({ error: "Claims Registry Failure: " + claimError.message });
    }

    if (isReferralValid && referrerRecord) {
      const claimToken = crypto.randomBytes(32).toString('hex');
      await supabase.from("syntrix_referrals").insert([{
        referrer_email: referrerRecord.email, referred_email: sanitizedEmail, referral_code: normalizeReferralCode(referredByCode), reward_amount: 10, status: "pending", claim_token: claimToken
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

// ================= DASHBOARD-AUTH LEDGER RECOVERY =================
app.get("/api/dashboard-auth", async (req, res) => {
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
      .select("email, status, wallet_address, tx_hash, referral_code")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (!userProfile) return res.json({ exists: false, isClaimed: false, status: "FLOW_C" });

    const isClaimed = userProfile.status === "success" || !!(userProfile.tx_hash || userProfile.wallet_address);

    return res.json({
      exists: true,
      isClaimed: isClaimed,
      status: isClaimed ? "FLOW_B" : "FLOW_A",
      txHash: userProfile.tx_hash || null,
      walletAddress: userProfile.wallet_address || null,
      referralCode: userProfile.referral_code || null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || "Dashboard authentication processing failure" });
  }
});

// ================= REFERRAL DASHBOARD DATA API =================
app.get("/api/referral/dashboard", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email parameter required" });

  try {
    const sanitizedEmail = email.trim().toLowerCase();

    const { data: userClaim, error: claimError } = await supabase
      .from("syntrix_claims")
      .select("referral_code")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (claimError || !userClaim) return res.status(404).json({ error: "User claim record not found." });

    const referralCode = userClaim.referral_code || generateReferralCode(sanitizedEmail);

    const { count: totalReferrals } = await supabase
      .from("syntrix_referrals")
      .select("id", { count: "exact", head: true })
      .eq("referrer_email", sanitizedEmail);

    const { data: pendingRewardsData } = await supabase
      .from("syntrix_rewards")
      .select("amount, claim_token, reward_type")
      .eq("email", sanitizedEmail)
      .eq("status", "pending");

    const pendingRewards = (pendingRewardsData || []).reduce((sum, item) => sum + Number(item.amount), 0);

    const { data: claimedRewardsData } = await supabase
      .from("syntrix_rewards")
      .select("amount")
      .eq("email", sanitizedEmail)
      .eq("status", "claimed");

    const claimedRewards = (claimedRewardsData || []).reduce((sum, item) => sum + Number(item.amount), 0);
    const totalEarned = pendingRewards + claimedRewards;
    const referralLink = `${process.env.FRONTEND_URL || "http://localhost:3000"}/?ref=${referralCode}`;

    return res.json({
      success: true, referralCode, referralLink, totalReferrals: totalReferrals || 0,
      pendingRewards, claimedRewards, totalEarned, pendingRewardsList: pendingRewardsData || []
    });

  } catch (err) {
    return res.status(500).json({ error: "Error fetching dashboard statistics" });
  }
});

// ================= CLAIM INFORMATION FETCH ROUTE =================
app.get("/api/rewards/claim-info", async (req, res) => {
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
      success: true, email: reward.email, amount: reward.amount, rewardType: reward.reward_type, status: reward.status
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error reading token properties." });
  }
});

// ================= TOKEN CLAIMS VIA METAMASK =================
app.post("/api/rewards/claim", async (req, res) => {
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
    if (rewardRecord.status !== "pending") return res.status(400).json({ error: `Reward claim has already been ${rewardRecord.status}.` });

    const email = rewardRecord.email.trim().toLowerCase();

    const { data: walletMap } = await supabase.from("syntrix_wallets").select("email").eq("wallet_address", sanitizedWallet).maybeSingle();
    if (walletMap && walletMap.email !== email) return res.status(400).json({ error: "This wallet is already linked to another account." });

    const { data: emailMap } = await supabase.from("syntrix_wallets").select("wallet_address").eq("email", email).maybeSingle();
    if (emailMap && emailMap.wallet_address.toLowerCase() !== sanitizedWallet) return res.status(400).json({ error: `This email is already associated with a different wallet address: ${emailMap.wallet_address}` });

    try {
      const message = `Claiming SYNTRIX Reward\nToken: ${token}\nWallet: ${walletAddress}`;
      const signerAddress = ethers.verifyMessage(message, signature);
      if (signerAddress.toLowerCase() !== sanitizedWallet) return res.status(400).json({ error: "Cryptographic wallet signature validation failed." });
    } catch (sigErr) {
      return res.status(400).json({ error: "Signature verification processing error: " + sigErr.message });
    }

    const { data: claimedRow, error: claimLockErr } = await supabase
      .from("syntrix_rewards")
      .update({ status: "claimed" })
      .eq("id", rewardRecord.id)
      .eq("status", "pending")
      .select()
      .maybeSingle();

    if (claimLockErr || !claimedRow) return res.status(400).json({ error: "This claim is currently being processed or has already been fulfilled." });

    let txHash = "0x" + crypto.randomBytes(32).toString("hex");

    if (tokenContract) {
      try {
        const decimals = await tokenContract.decimals();
        const amount = ethers.parseUnits(rewardRecord.amount.toString(), decimals);
        const tx = await tokenContract.transfer(sanitizedWallet, amount);
        await tx.wait();
        txHash = tx.hash;
      } catch (blockchainErr) {
        await supabase.from("syntrix_rewards").update({ status: "pending" }).eq("id", rewardRecord.id);
        return res.status(500).json({ error: "Blockchain transaction execution failed: " + blockchainErr.message });
      }
    }

    if (!emailMap) await supabase.from("syntrix_wallets").upsert({ email: email, wallet_address: sanitizedWallet });

    await supabase
      .from("syntrix_rewards")
      .update({ tx_hash: txHash, claimed_wallet: sanitizedWallet, claimed_at: new Date().toISOString() })
      .eq("id", rewardRecord.id);

    if (rewardRecord.reward_type === "referral") {
      await supabase.from("syntrix_referrals").update({ status: "claimed" }).eq("claim_token", token.trim());
    }

    return res.json({ success: true, transactionHash: txHash });

  } catch (err) {
    return res.status(500).json({ error: "Fulfillment failed: " + err.message });
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

    const { data: userRecord } = await supabase.from("syntrix_claims").select("id, status, tx_hash").eq("email", sanitizedEmail).maybeSingle();
    if (!userRecord) return res.status(404).json({ error: "User survey verification profile not found." });
    if (userRecord.status === "success" || userRecord.tx_hash) return res.status(400).json({ error: "Rewards have already been successfully distributed to this email." });

    const { data: walletMap } = await supabase.from("syntrix_wallets").select("email").eq("wallet_address", sanitizedWallet).maybeSingle();
    if (walletMap && walletMap.email !== sanitizedEmail) return res.status(400).json({ error: "This wallet is already linked to another account." });

    const { data: emailMap } = await supabase.from("syntrix_wallets").select("wallet_address").eq("email", sanitizedEmail).maybeSingle();
    if (emailMap && emailMap.wallet_address.toLowerCase() !== sanitizedWallet) return res.status(400).json({ error: `This email is already associated with a different wallet address: ${emailMap.wallet_address}` });

    const { data: duplicateWallet } = await supabase.from("syntrix_claims").select("id").eq("wallet_address", sanitizedWallet).maybeSingle();
    if (duplicateWallet) return res.status(400).json({ error: "This wallet address has already been used to claim a survey reward." });

    let txHash = "0x" + crypto.randomBytes(32).toString("hex");

    if (tokenContract) {
      try {
        const decimals = await tokenContract.decimals();
        const amount = ethers.parseUnits("10", decimals);
        const tx = await tokenContract.transfer(sanitizedWallet, amount);
        await tx.wait();
        txHash = tx.hash;
      } catch (blockchainErr) {
        return res.status(502).json({ error: "Blockchain execution failed: " + blockchainErr.message });
      }
    }

    await supabase.from("syntrix_claims").update({ wallet_address: sanitizedWallet, tx_hash: txHash, status: "success" }).eq("id", userRecord.id);
    if (!emailMap) await supabase.from("syntrix_wallets").upsert({ email: sanitizedEmail, wallet_address: sanitizedWallet });

    return res.json({ success: true, transactionHash: txHash });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Smart contract claim execution pipeline blocked." });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

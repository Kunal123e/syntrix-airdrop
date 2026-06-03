require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");
const nodemailer = require("nodemailer");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

// Initialize blockchain providers conditionally to prevent crashes if env is not configured
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

// ================= SMTP EMAIL SETUP =================

const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER_ACCOUNT,
    pass: process.env.GMAIL_APP_PASSWORD 
  }
});

// ================= HELPERS =================

/**
 * Generates a permanent deterministic referral code based on email
 * Format: SYN-AB1234
 */
function generateReferralCode(email) {
  const cleanEmail = email.trim().toLowerCase();
  const hash = crypto.createHash("sha256").update(cleanEmail).digest("hex");
  const uniqueChars = hash.substring(0, 6).toUpperCase();
  return `SYN-${uniqueChars}`;
}

/**
 * Sends a reward claim notification email to the referrer
 */
async function sendRewardNotification(referrerEmail, rewardAmount, claimToken) {
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const claimLink = `${frontendUrl}/claim?token=${claimToken}`;

  const mailOptions = {
    from: `"Syntrix Settlement Network" <${process.env.GMAIL_USER_ACCOUNT}>`,
    to: referrerEmail,
    subject: "🎁 You Earned 10 SYNTRIX Tokens",
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; padding: 30px; color: #1e293b; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
        <h2 style="color: #4f46e5; margin-top: 0; font-size: 24px; border-bottom: 2px solid #f1f5f9; padding-bottom: 15px;">You Earned SYNTRIX Tokens!</h2>
        <p style="font-size: 16px; line-height: 1.6;">Hello,</p>
        <p style="font-size: 16px; line-height: 1.6;">Great news! A user completed the onboarding survey using your referral link.</p>
        <div style="background-color: #f8fafc; border-left: 4px solid #4f46e5; padding: 15px; margin: 20px 0; border-radius: 4px;">
          <p style="margin: 0; font-size: 16px; font-weight: bold; color: #1e293b;">
            Reward Amount: <span style="color: #4f46e5;">${rewardAmount} SYNTRIX Tokens</span>
          </p>
          <p style="margin: 5px 0 0 0; font-size: 14px; color: #64748b;">
            Referral Status: Approved
          </p>
        </div>
        <p style="font-size: 16px; line-height: 1.6; margin-bottom: 25px;">
          Click the button below to connect your MetaMask wallet and claim your tokens directly on the Polygon blockchain:
        </p>
        <a href="${claimLink}" style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%); color: #ffffff; padding: 14px 28px; text-decoration: none; font-weight: bold; border-radius: 8px; display: inline-block; box-shadow: 0 4px 6px -1px rgba(79, 70, 229, 0.2);">
          Claim Your Tokens Now &rarr;
        </a>
        <br><br>
        <hr style="border: none; border-top: 1px solid #f1f5f9;">
        <small style="color: #94a3b8; display: block; margin-top: 15px; line-height: 1.4;">
          This claim link is unique to your reward. One wallet can only be linked to one email address. Please do not forward this message.
        </small>
      </div>
    `
  };

  try {
    await mailTransporter.sendMail(mailOptions);
    console.log(`Notification email sent to referrer: ${referrerEmail}`);
    return true;
  } catch (error) {
    console.error(`Failed to send email to ${referrerEmail}:`, error.message);
    return false;
  }
}

// ================= TEST ROUTE =================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Syntrix Referral Backend Operating with Phase 1-12 Security Integrations"
  });
});

// ================= SURVEY INGESTION SYSTEM (MODIFIED FOR JSONB) =================

app.post("/api/claim-airdrop", async (req, res) => {
  try {
    const {
      email,
      referredByCode, // Referral code from URL parameter / landing page memory
      ...surveyData // Dynamically captures all questionnaire responses from data.js
    } = req.body;

    // ================= VALIDATION =================
    if (!email) {
      return res.status(400).json({ error: "Email identifier required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    const generatedReferralCode = generateReferralCode(sanitizedEmail);

    // ================= EMAIL EXIST CHECK =================
    const { data: existingEmail } = await supabase
      .from("claims")
      .select("id")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (existingEmail) {
      return res.status(400).json({ error: "This email has already submitted the survey." });
    }

    // ================= REFERRAL VALIDATION (PHASE 5) =================
    let referrerRecord = null;
    let isReferralValid = false;

    if (referredByCode) {
      const cleanRefCode = referredByCode.trim().toUpperCase();

      // Rule 3: Self-referral protection (User cannot refer themselves)
      if (cleanRefCode === generatedReferralCode) {
        return res.status(400).json({ error: "You cannot refer yourself." });
      }

      // Rule 1 & 2: Check if code exists and belongs to another user
      const { data: referrerClaim, error: refError } = await supabase
        .from("claims")
        .select("email")
        .eq("referral_code", cleanRefCode)
        .maybeSingle();

      if (refError || !referrerClaim) {
        return res.status(400).json({ error: "Invalid referral code. Code does not exist." });
      }

      if (referrerClaim.email === sanitizedEmail) {
        return res.status(400).json({ error: "Self-referral check: Code belongs to this email." });
      }

      referrerRecord = referrerClaim;

      // Rule 4: One referral reward per referred email
      const { data: alreadyReferred } = await supabase
        .from("syntrix_referrals")
        .select("id")
        .eq("referred_email", sanitizedEmail)
        .maybeSingle();

      if (alreadyReferred) {
        return res.status(400).json({ error: "This email has already been referred." });
      }

      isReferralValid = true;
    }

    // ================= SAVE DATA: SINGLE INSERT (CORE + SURVEY JSONB) =================
    const { data: claimData, error: claimError } = await supabase
      .from("claims")
      .insert([
        {
          email: sanitizedEmail,
          amount_rewarded: 10,
          status: "pending",
          referral_code: generatedReferralCode, // Phase 2: Permanent assignment
          survey_data: surveyData // Store survey inside single JSONB column
        }
      ])
      .select("id")
      .single();

    if (claimError) {
      if (claimError.code === "23505") {
        return res.status(400).json({ error: "This email has already submitted the survey." });
      }
      return res.status(500).json({ error: "Claims Registry Failure: " + claimError.message });
    }

    // ================= REWARD CREATION LOGIC (PHASE 6) =================
    if (isReferralValid && referrerRecord) {
      const claimToken = crypto.randomBytes(32).toString("hex");
      const autoApprove = process.env.AUTO_APPROVE_REFERRALS === "true";
      const referralStatus = autoApprove ? "approved" : "pending";

      // Create record in syntrix_referrals
      await supabase
        .from("syntrix_referrals")
        .insert([
          {
            referrer_email: referrerRecord.email,
            referred_email: sanitizedEmail,
            referral_code: referredByCode.trim().toUpperCase(),
            reward_amount: 10,
            status: referralStatus,
            claim_token: claimToken
          }
        ]);

      // Create record in syntrix_rewards
      await supabase
        .from("syntrix_rewards")
        .insert([
          {
            email: referrerRecord.email,
            reward_type: "referral",
            amount: 10,
            status: "pending", // Pending claim
            claim_token: claimToken
          }
        ]);

      // Legacy referral log backup mapping
      try {
        await supabase
          .from("syntrix_referral_logs")
          .insert([
            {
              referrer_email: referrerRecord.email,
              referred_friend_email: sanitizedEmail,
              status: autoApprove ? "completed" : "pending"
            }
          ]);
      } catch (err) {
        console.warn("Legacy referral logging bypass:", err.message);
      }

      // If auto-approved, send email immediately
      if (autoApprove) {
        await sendRewardNotification(referrerRecord.email, 10, claimToken);
      }
    }

    return res.json({
      success: true,
      referralCode: generatedReferralCode,
      message: "Survey data successfully stored. Eligible to claim rewards via dashboard."
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ================= DASHBOARD-AUTH LEDGER RECOVERY =================

app.get("/api/dashboard-auth", async (req, res) => {
  const { email, ref } = req.query;
  if (!email) return res.status(400).json({ error: "Email parameter required" });

  try {
    const sanitizedEmail = email.trim().toLowerCase();

    const { data: userProfile, error } = await supabase
      .from("claims")
      .select("email, status, wallet_address, tx_hash, referral_code")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (!userProfile) {
      // Legacy referral logs hook
      if (ref) {
        try {
          const { data: potentialReferrer } = await supabase
            .from("claims")
            .select("email")
            .eq("referral_code", ref.trim().toUpperCase())
            .maybeSingle();

          if (potentialReferrer && potentialReferrer.email !== sanitizedEmail) {
            await supabase
              .from("syntrix_referral_logs")
              .insert([
                {
                  referrer_email: potentialReferrer.email,
                  referred_friend_email: sanitizedEmail,
                  status: "pending"
                }
              ]);
          }
        } catch (logErr) {
          console.warn("Legacy referral logging step ignored:", logErr.message);
        }
      }

      return res.json({ 
        exists: false,
        isClaimed: false
      });
    }

    const isClaimed = userProfile.status === "success" || !!(userProfile.tx_hash || userProfile.wallet_address);

    return res.json({
      exists: true,
      isClaimed: isClaimed,
      status: userProfile.status,
      txHash: userProfile.tx_hash || null,
      walletAddress: userProfile.wallet_address || null,
      referralCode: userProfile.referral_code || null
    });

  } catch (err) {
    console.error("Dashboard auth endpoint processing failure:", err);
    return res.status(500).json({ error: "Dashboard authentication processing failure" });
  }
});

// ================= REFERRAL DASHBOARD DATA API (PHASE 7) =================

app.get("/api/referral/dashboard", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email parameter required" });

  try {
    const sanitizedEmail = email.trim().toLowerCase();

    // 1. Get user referral code
    const { data: userClaim, error: claimError } = await supabase
      .from("claims")
      .select("referral_code")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (claimError || !userClaim) {
      return res.status(404).json({ error: "User claim record not found." });
    }

    const referralCode = userClaim.referral_code || generateReferralCode(sanitizedEmail);

    // 2. Count total referrals
    const { count: totalReferrals, error: countError } = await supabase
      .from("syntrix_referrals")
      .select("id", { count: "exact", head: true })
      .eq("referrer_email", sanitizedEmail);

    if (countError) return res.status(500).json({ error: countError.message });

    // 3. Sum Pending rewards (rewards table)
    const { data: pendingRewardsData, error: pendingError } = await supabase
      .from("syntrix_rewards")
      .select("amount")
      .eq("email", sanitizedEmail)
      .eq("status", "pending");

    if (pendingError) return res.status(500).json({ error: pendingError.message });
    const pendingRewards = pendingRewardsData.reduce((sum, item) => sum + Number(item.amount), 0);

    // 4. Sum Claimed rewards (rewards table)
    const { data: claimedRewardsData, error: claimedError } = await supabase
      .from("syntrix_rewards")
      .select("amount")
      .eq("email", sanitizedEmail)
      .eq("status", "claimed");

    if (claimedError) return res.status(500).json({ error: claimedError.message });
    const claimedRewards = claimedRewardsData.reduce((sum, item) => sum + Number(item.amount), 0);

    const totalEarned = pendingRewards + claimedRewards;
    const referralLink = `${process.env.FRONTEND_URL || "http://localhost:3000"}/?ref=${referralCode}`;

    return res.json({
      success: true,
      referralCode,
      referralLink,
      totalReferrals: totalReferrals || 0,
      pendingRewards,
      claimedRewards,
      totalEarned
    });

  } catch (err) {
    console.error("Dashboard calculation error:", err);
    return res.status(500).json({ error: "Error fetching dashboard statistics" });
  }
});

// ================= DIRECT EMAIL INVITATIONS =================

app.post("/api/send-invite", async (req, res) => {
  const { referrerEmail, friendEmail, referralLink } = req.body;

  if (!referrerEmail || !friendEmail || !referralLink) {
    return res.status(400).json({ success: false, error: "Missing required invitation properties parameters." });
  }

  try {
    const sanitizedFriendEmail = friendEmail.trim().toLowerCase();

    // Verify if friend is already recorded
    const { data: existingUser } = await supabase
      .from("claims")
      .select("id")
      .eq("email", sanitizedFriendEmail)
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ success: false, error: "This friend is already registered inside our network." });
    }

    const mailConfigurations = {
      from: `"Syntrix Settlement Network" <${process.env.GMAIL_USER_ACCOUNT}>`,
      to: sanitizedFriendEmail,
      subject: '✨ Syntrix Consumer Research Token Allocation Invitation',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 25px; color: #111111; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 16px;">
          <h2 style="color: #0f172a; margin-top: 0;">You've Been Allocated an Airdrop Entry Slot!</h2>
          <p>A verification profile registered under <strong>${referrerEmail}</strong> has passed an invitation allocation directly to you.</p>
          <p>Complete our strategic consumer analytics metrics module matrix to access your 10 SYNX network token allotment destination.</p>
          <br>
          <a href="${referralLink}" style="background: #0f172a; color: #ffffff; padding: 14px 28px; text-decoration: none; font-weight: bold; border-radius: 8px; display: inline-block;">
            Initialize Modules & Claim Balance &rarr;
          </a>
          <br><br>
          <hr style="border: none; border-top: 1px solid #e2e8f0;">
          <small style="color: #64748b;">This data entry loop is secured. Ensure registration processing finishes through the direct access tracking link mapped above.</small>
        </div>
      `
    };

    await mailTransporter.sendMail(mailConfigurations);
    return res.json({ success: true });

  } catch (err) {
    console.error("Outbound notification transit error:", err);
    return res.status(500).json({ success: false, error: "Systemic execution timeout on transactional email servers." });
  }
});

// ================= CLAIM INFORMATION FETCH ROUTE (PHASE 9) =================

app.get("/api/rewards/claim-info", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Claim token parameter required." });

  try {
    const { data: reward, error } = await supabase
      .from("syntrix_rewards")
      .select("email, amount, reward_type, status")
      .eq("claim_token", token.trim())
      .maybeSingle();

    if (error || !reward) {
      return res.status(404).json({ error: "Invalid claim token or reward record not found." });
    }

    return res.json({
      success: true,
      email: reward.email,
      amount: reward.amount,
      rewardType: reward.reward_type,
      status: reward.status
    });

  } catch (err) {
    console.error("Fetch claim info error:", err);
    return res.status(500).json({ error: "Internal server error reading token properties." });
  }
});

// ================= TOKEN CLAIMS VIA METAMASK (PHASE 9 & 10 & 11) =================

app.post("/api/rewards/claim", async (req, res) => {
  const { token, walletAddress, signature } = req.body;

  if (!token || !walletAddress || !signature) {
    return res.status(400).json({ error: "Token, wallet address, and cryptographic signature verification required." });
  }

  if (!ethers.isAddress(walletAddress)) {
    return res.status(400).json({ error: "Invalid target wallet address format." });
  }

  try {
    const sanitizedWallet = walletAddress.trim().toLowerCase();

    // 1. Resolve reward token claim properties
    const { data: rewardRecord, error: fetchErr } = await supabase
      .from("syntrix_rewards")
      .select("id, email, amount, status, reward_type")
      .eq("claim_token", token.trim())
      .maybeSingle();

    if (fetchErr || !rewardRecord) {
      return res.status(404).json({ error: "Claim token invalid or not found." });
    }

    if (rewardRecord.status !== "pending") {
      return res.status(400).json({ error: `Reward claim has already been ${rewardRecord.status}.` });
    }

    const email = rewardRecord.email.trim().toLowerCase();

    // ================= WALLET PROTECTION RULES (PHASE 10) =================

    // Rule A: One wallet address can belong to only one email account.
    const { data: walletMap } = await supabase
      .from("syntrix_wallets")
      .select("email")
      .eq("wallet_address", sanitizedWallet)
      .maybeSingle();

    if (walletMap && walletMap.email !== email) {
      return res.status(400).json({ error: "This wallet is already linked to another account." });
    }

    // Rule B: One email account can only be associated with one wallet address.
    const { data: emailMap } = await supabase
      .from("syntrix_wallets")
      .select("wallet_address")
      .eq("email", email)
      .maybeSingle();

    if (emailMap && emailMap.wallet_address.toLowerCase() !== sanitizedWallet) {
      return res.status(400).json({ error: `This email is already associated with a different wallet address: ${emailMap.wallet_address}` });
    }

    // ================= CRYPTOGRAPHIC SIGNATURE VERIFICATION =================
    try {
      const message = `Claiming SYNTRIX Reward\nToken: ${token}\nWallet: ${walletAddress}`;
      const signerAddress = ethers.verifyMessage(message, signature);
      if (signerAddress.toLowerCase() !== sanitizedWallet) {
        return res.status(400).json({ error: "Cryptographic wallet signature validation failed." });
      }
    } catch (sigErr) {
      return res.status(400).json({ error: "Signature verification processing error: " + sigErr.message });
    }

    // ================= PREVENT DOUBLE SPENDING (RACE CONDITION) =================
    // Claim the row immediately prior to contract invocation
    const { data: claimedRow, error: claimLockErr } = await supabase
      .from("syntrix_rewards")
      .update({ status: "claimed" })
      .eq("id", rewardRecord.id)
      .eq("status", "pending")
      .select()
      .maybeSingle();

    if (claimLockErr || !claimedRow) {
      return res.status(400).json({ error: "This claim is currently being processed or has already been fulfilled." });
    }

    // ================= BLOCKCHAIN TRANSFER =================
    let txHash = "0x" + crypto.randomBytes(32).toString("hex");

    if (tokenContract) {
      try {
        const decimals = await tokenContract.decimals();
        const amount = ethers.parseUnits(rewardRecord.amount.toString(), decimals);

        const tx = await tokenContract.transfer(sanitizedWallet, amount);
        await tx.wait();
        txHash = tx.hash;
      } catch (blockchainErr) {
        console.error("Contract payout distribution failed. Reverting lock status.", blockchainErr);
        // Rollback state back to pending for retry on error
        await supabase
          .from("syntrix_rewards")
          .update({ status: "pending" })
          .eq("id", rewardRecord.id);
        return res.status(500).json({ error: "Blockchain transaction execution failed: " + blockchainErr.message });
      }
    } else {
      console.warn("Bypassing on-chain token deployment. Using mock hash ID:", txHash);
    }

    // ================= PERSIST REGISTRY STATUS MAPPING (PHASE 10 & 11) =================
    // Map email/wallet permanently
    if (!emailMap) {
      await supabase
        .from("syntrix_wallets")
        .upsert({ email: email, wallet_address: sanitizedWallet });
    }

    // Update reward properties
    await supabase
      .from("syntrix_rewards")
      .update({
        tx_hash: txHash,
        claimed_wallet: sanitizedWallet,
        claimed_at: new Date().toISOString()
      })
      .eq("id", rewardRecord.id);

    // Update referral tracker properties status
    if (rewardRecord.reward_type === "referral") {
      await supabase
        .from("syntrix_referrals")
        .update({ status: "claimed" })
        .eq("claim_token", token.trim());
    }

    return res.json({
      success: true,
      transactionHash: txHash
    });

  } catch (err) {
    console.error("Token distribution pipeline error:", err);
    return res.status(500).json({ error: "Fulfillment failed: " + err.message });
  }
});

// ================= LAZY SURVEY CLAIM DISPENSER (BACKWARDS COMPATIBLE) =================

app.post("/api/claim-reward", async (req, res) => {
  const { email, walletAddress } = req.body;

  if (!email || !walletAddress) {
    return res.status(400).json({ error: "Email and destination wallet address are required." });
  }

  if (!ethers.isAddress(walletAddress)) {
    return res.status(400).json({ error: "Invalid target wallet address string." });
  }

  try {
    const sanitizedEmail = email.trim().toLowerCase();
    const sanitizedWallet = walletAddress.trim().toLowerCase();

    // 1. Verify user profile exists and is still pending
    const { data: userRecord } = await supabase
      .from("claims")
      .select("id, status, tx_hash")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (!userRecord) return res.status(404).json({ error: "User survey verification profile not found." });
    
    if (userRecord.status === "success" || userRecord.tx_hash) {
      return res.status(400).json({ error: "Rewards have already been successfully distributed to this email." });
    }

    // ================= WALLET PROTECTION RULES (PHASE 10) =================
    // Rule A: One wallet address can belong to only one email account.
    const { data: walletMap } = await supabase
      .from("syntrix_wallets")
      .select("email")
      .eq("wallet_address", sanitizedWallet)
      .maybeSingle();

    if (walletMap && walletMap.email !== sanitizedEmail) {
      return res.status(400).json({ error: "This wallet is already linked to another account." });
    }

    // Rule B: One email account can only be associated with one wallet address.
    const { data: emailMap } = await supabase
      .from("syntrix_wallets")
      .select("wallet_address")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (emailMap && emailMap.wallet_address.toLowerCase() !== sanitizedWallet) {
      return res.status(400).json({ error: `This email is already associated with a different wallet address: ${emailMap.wallet_address}` });
    }

    // 2. Prevent double claim by checking duplicate wallet in claims table
    const { data: duplicateWallet } = await supabase
      .from("claims")
      .select("id")
      .eq("wallet_address", sanitizedWallet)
      .maybeSingle();

    if (duplicateWallet) {
      return res.status(400).json({ error: "This wallet address has already been used to claim a survey reward." });
    }

    // 3. Execute Blockchain Token Transfer Asset Execution
    let txHash = "0x" + crypto.randomBytes(32).toString("hex");

    if (tokenContract) {
      const decimals = await tokenContract.decimals();
      const amount = ethers.parseUnits("10", decimals);

      const tx = await tokenContract.transfer(sanitizedWallet, amount);
      await tx.wait();
      txHash = tx.hash;
    } else {
      console.warn("Bypassing on-chain token deployment (survey dispenser). Using mock hash ID:", txHash);
    }

    // 4. Update the primary registry row to close the loop
    const { error: updateError } = await supabase
      .from("claims")
      .update({
        wallet_address: sanitizedWallet,
        tx_hash: txHash,
        status: "success"
      })
      .eq("id", userRecord.id);

    if (updateError) return res.status(500).json({ error: "Registry Finalization Failure: " + updateError.message });

    // Enforce permanent wallet link table
    if (!emailMap) {
      await supabase
        .from("syntrix_wallets")
        .upsert({ email: sanitizedEmail, wallet_address: sanitizedWallet });
    }

    // 5. Update legacy referral logs status cleanly if they were brought in via reference pipelines
    try {
      await supabase
        .from("syntrix_referral_logs")
        .update({ status: "completed" })
        .eq("referred_friend_email", sanitizedEmail);
    } catch (logErr) {
      console.warn("Legacy log update skipped:", logErr.message);
    }

    return res.json({
      success: true,
      transactionHash: txHash
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Smart contract claim execution pipeline blocked." });
  }
});

// ================= ADMIN: REFERRAL APPROVAL ROUTE (PHASE 8 & 12) =================

app.post("/api/admin/referrals/approve", async (req, res) => {
  const { referralId } = req.body;
  if (!referralId) return res.status(400).json({ error: "Referral ID required." });

  try {
    // 1. Fetch pending referral record
    const { data: referral, error: fetchErr } = await supabase
      .from("syntrix_referrals")
      .select("*")
      .eq("id", referralId)
      .maybeSingle();

    if (fetchErr || !referral) {
      return res.status(404).json({ error: "Referral record not found." });
    }

    if (referral.status !== "pending") {
      return res.status(400).json({ error: `Referral status is already ${referral.status}.` });
    }

    // 2. Update status to approved
    const { error: updateErr } = await supabase
      .from("syntrix_referrals")
      .update({ status: "approved" })
      .eq("id", referralId);

    if (updateErr) return res.status(500).json({ error: "Failed to update referral status: " + updateErr.message });

    // 3. Dispatch reward notification email
    const emailSent = await sendRewardNotification(
      referral.referrer_email,
      referral.reward_amount,
      referral.claim_token
    );

    // 4. Update legacy log status to approved
    try {
      await supabase
        .from("syntrix_referral_logs")
        .update({ status: "approved" })
        .eq("referrer_email", referral.referrer_email)
        .eq("referred_friend_email", referral.referred_email);
    } catch (logErr) {
      console.warn("Legacy log status update bypassed:", logErr.message);
    }

    return res.json({
      success: true,
      message: "Referral successfully approved. Email notification sent.",
      emailSent
    });

  } catch (err) {
    console.error("Admin approval error:", err);
    return res.status(500).json({ error: "Internal server error approving referral." });
  }
});

// ================= SERVER =================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

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

// ================= MEMORY OPTIMIZATION & TIMEOUT GUARD =================
// Prevents server crashes and memory leaks by dropping hanging requests after 10 seconds
app.use((req, res, next) => {
  res.setTimeout(10000, () => {
    if (!res.headersSent) {
      res.status(408).send({ success: false, error: 'Network timeout: Request exceeded 10 seconds.' });
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

const emailUser = process.env.EMAIL_USER || process.env.GMAIL_USER_ACCOUNT;
const emailPass = process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD;

// STEP 3 – VERIFY ENV VARIABLES & startup logging
console.log(`SMTP USER FOUND: ${emailUser ? "YES" : "NO"}`);
console.log(`SMTP PASSWORD FOUND: ${emailPass ? "YES" : "NO"}`);

// STEP 5 – VERIFY GMAIL AUTH formats
if (emailUser) {
  if (emailUser.endsWith("@gmail.com") || emailUser.endsWith("@googlemail.com")) {
    console.log("SMTP USER TYPE: Gmail account verified");
  } else {
    console.warn("SMTP USER TYPE: WARNING - USER IS NOT A GMAIL ACCOUNT. SMTP may fail on Gmail service.");
  }
}

if (emailPass) {
  const cleanPass = emailPass.replace(/\s+/g, "");
  if (cleanPass.length === 16 && /^[a-zA-Z]+$/.test(cleanPass)) {
    console.log("SMTP PASSWORD TYPE: App Password format valid (16 characters, letters only)");
  } else {
    console.warn("SMTP PASSWORD TYPE: WARNING - PASSWORD IS NOT A 16-CHARACTER GMAIL APP PASSWORD. A standard password or incorrect format was provided. Gmail SMTP authentication will fail.");
  }
}

const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: emailUser,
    pass: emailPass
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
 * Normalizes user-inputted referral codes to SYN-XXXXXX format
 */
function normalizeReferralCode(code) {
  if (!code) return "";
  let clean = code.trim().toUpperCase();
  clean = clean.replace(/\s+/g, "");
  
  if (!clean.startsWith("SYN-")) {
    if (clean.startsWith("SYN")) {
      clean = "SYN-" + clean.substring(3);
    } else {
      clean = "SYN-" + clean;
    }
  }
  
  if (clean.length > 10) {
    clean = clean.substring(0, 10);
  }
  return clean;
}

/**
 * Sends a reward claim notification email to the referrer
 */
async function sendRewardNotification(referrerEmail, rewardAmount, claimToken) {
  // Prevent sending invalid claim links
  if (!claimToken) {
    console.error("Missing claim token");
    return false;
  }

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const claimLink = `${frontendUrl}/claim?token=${claimToken}`;

  const mailOptions = {
    from: `"Syntrix Settlement Network" <${emailUser}>`,
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
    console.log("EMAIL SENT");
    console.log(`Notification email sent to referrer: ${referrerEmail}`);
    return true;
  } catch (error) {
    console.error(`Failed to send email to ${referrerEmail}:`, error.message);
    return false;
  }
}

// ================= OTP MEMORY STORE =================
// Temporarily stores OTPs in server memory
const otpStorage = {};

// Clears expired OTPs every 10 minutes to save memory
setInterval(() => {
  const now = Date.now();
  for (const email in otpStorage) {
    if (otpStorage[email].expires < now) {
      delete otpStorage[email];
    }
  }
}, 10 * 60 * 1000);

// ================= OTP ROUTES =================

// 1. Send OTP Route
app.post("/api/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email required." });

  const sanitizedEmail = email.trim().toLowerCase();
  
  // Generate a random 6-digit code
  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
  
  // Store it in memory for 10 minutes
  otpStorage[sanitizedEmail] = {
    otp: otpCode,
    expires: Date.now() + 10 * 60 * 1000 // 10 mins
  };

  const mailOptions = {
    from: `"Syntrix Security" <${emailUser}>`,
    to: sanitizedEmail,
    subject: `Your Syntrix Verification Code: ${otpCode}`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 500px;">
        <h2 style="color: #4f46e5; margin-top: 0;">Syntrix Verification</h2>
        <p>Please use the following 6-digit code to verify your identity and enter the network.</p>
        <div style="background-color: #f8fafc; padding: 15px; margin: 20px 0; text-align: center; border-radius: 6px;">
          <span style="font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #1e293b;">${otpCode}</span>
        </div>
        <p style="color: #64748b; font-size: 12px;">This code will expire in 10 minutes. If you did not request this, ignore this email.</p>
      </div>
    `
  };

  try {
    await mailTransporter.sendMail(mailOptions);
    console.log(`[OTP] Sent to ${sanitizedEmail}`);
    return res.json({ success: true, message: "OTP Sent" });
  } catch (err) {
    console.error(`[OTP] Failed to send to ${sanitizedEmail}:`, err.message);
    return res.status(500).json({ error: "Failed to deliver email. Check SMTP settings." });
  }
});

// 2. Verify OTP Route
app.post("/api/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: "Email and OTP required." });

  const sanitizedEmail = email.trim().toLowerCase();
  const record = otpStorage[sanitizedEmail];

  if (!record) {
    return res.status(400).json({ error: "OTP expired or not requested. Please send a new code." });
  }

  if (record.expires < Date.now()) {
    delete otpStorage[sanitizedEmail];
    return res.status(400).json({ error: "OTP has expired." });
  }

  if (record.otp !== otp.trim()) {
    return res.status(400).json({ error: "Invalid OTP code." });
  }

  // If valid, delete the code so it can't be reused, and grant access!
  delete otpStorage[sanitizedEmail];
  return res.json({ success: true });
});

// ================= TEST ROUTE =================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Syntrix Referral Backend Operating with Phase 1-12 Security Integrations"
  });
});

// ================= TEST EMAIL ROUTE =================
app.post("/api/test-email", async (req, res) => {
  const { toEmail } = req.body;
  const targetEmail = toEmail || emailUser;

  if (!targetEmail) {
    return res.status(400).json({ success: false, error: "Recipient email parameter required." });
  }

  console.log(`[SMTP TEST] Attempting to send test email to: ${targetEmail}`);

  const mailOptions = {
    from: `"Syntrix SMTP Test" <${emailUser}>`,
    to: targetEmail,
    subject: "SMTP TEST",
    text: "SMTP connection successful."
  };

  try {
    const info = await mailTransporter.sendMail(mailOptions);
    console.log("[SMTP TEST] Success:", info.response);
    return res.json({
      success: true,
      message: "SMTP connection successful.",
      info: info.response
    });
  } catch (err) {
    console.error("[SMTP TEST] Connection failed:", err);
    return res.status(500).json({
      success: false,
      error: "SMTP connection failed: " + err.message
    });
  }
});

// ================= SEND INVITE ROUTE =================
app.post("/api/send-invite", async (req, res) => {
  const { friendEmail, referralCode, referralLink } = req.body;

  if (!friendEmail || !referralCode || !referralLink) {
    return res.status(400).json({
      success: false,
      error: "Missing parameters. friendEmail, referralCode, and referralLink are required."
    });
  }

  console.log("INVITE EMAIL REQUESTED");

  const mailOptions = {
    from: `"Syntrix Network" <${emailUser}>`,
    to: friendEmail,
    subject: "🎁 Join Syntrix and earn token rewards!",
    html: `
      <div style="font-family: Arial, sans-serif; padding: 25px; color: #1e293b; max-width: 600px; border: 1px solid #e2e8f0; border-radius: 12px;">
        <h2 style="color: #4f46e5; margin-top: 0;">You've been invited to Syntrix!</h2>
        <p>A colleague is inviting you to join the Syntrix Consumer Analytics Network.</p>
        <p>Complete the consumer research survey modules to earn high-utility SYN token rewards.</p>
        
        <div style="background-color: #f8fafc; border-left: 4px solid #4f46e5; padding: 15px; margin: 20px 0;">
          <p style="margin: 0; font-weight: bold;">Referral Code: <span style="color: #4f46e5;">${referralCode}</span></p>
        </div>

        <p>Click the link below to get started and claim your tokens:</p>
        <a href="${referralLink}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 6px; display: inline-block;">
          Accept Invitation &rarr;
        </a>
      </div>
    `
  };

  try {
    await mailTransporter.sendMail(mailOptions);
    console.log("INVITE EMAIL SENT");
    return res.json({ success: true });
  } catch (err) {
    console.error("Invite email delivery failed:", err);
    return res.status(500).json({
      success: false,
      error: "SMTP connection failed: " + err.message
    });
  }
});

// ================= SURVEY INGESTION SYSTEM (MODIFIED FOR JSONB & SCHEMA ALIGNMENT) =================

app.post("/api/claim-airdrop", async (req, res) => {
  try {
    const {
      email,
      referredByCode, 
      answers // CRITICAL FIX: Destructure explicitly from body to capture payload matching script.js
    } = req.body;

    // ================= VALIDATION =================
    if (!email) {
      return res.status(400).json({ error: "Email identifier required" });
    }

    const sanitizedEmail = email.trim().toLowerCase();
    console.log("SURVEY SUBMITTED");
    const generatedReferralCode = generateReferralCode(sanitizedEmail);

    // ================= EMAIL EXIST CHECK =================
    const { data: existingEmail } = await supabase
      .from("syntrix_claims")
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
      const cleanRefCode = normalizeReferralCode(referredByCode);

      // Rule 3: Self-referral protection (User cannot refer themselves)
      if (cleanRefCode === generatedReferralCode) {
        return res.status(400).json({ error: "You cannot refer yourself." });
      }

      // Rule 1 & 2: Check if code exists and belongs to another user
      const { data: referrerClaim, error: refError } = await supabase
        .from("syntrix_claims")
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
      console.log("REFERRAL VALIDATED");
    }

    // ================= SAVE DATA: DIRECT ALIGNMENT WITH WORLD.SQL COLUMNS =================
    // Mapped data straight to your native 'survey_data' JSONB column in the single insert block
    const { data: claimData, error: claimError } = await supabase
      .from("syntrix_claims")
      .insert([
        {
          email: sanitizedEmail,
          amount_rewarded: 10,
          status: "pending",
          referral_code: generatedReferralCode,
          survey_data: answers // Syncs seamlessly with the answers bundle passed from the frontend
        }
      ])
      .select("id, email, status, wallet_address")
      .single();

    if (claimError) {
      if (claimError.code === "23505") {
        return res.status(400).json({ error: "This email has already submitted the survey." });
      }
      return res.status(500).json({ error: "Claims Registry Failure: " + claimError.message });
    }

    if (claimData) {
      console.log("[Survey Submission] Created claim row details:", {
        id: claimData.id,
        email: claimData.email,
        status: claimData.status,
        wallet_address: claimData.wallet_address
      });
    }

    // ================= REWARD CREATION LOGIC =================
    if (isReferralValid && referrerRecord) {
      const claimToken = crypto.randomBytes(32).toString('hex');
      console.log("CLAIM TOKEN GENERATED");

      // Create record in syntrix_referrals
      const { error: refInsertErr } = await supabase
        .from("syntrix_referrals")
        .insert([
          {
            referrer_email: referrerRecord.email,
            referred_email: sanitizedEmail,
            referral_code: normalizeReferralCode(referredByCode),
            reward_amount: 10,
            status: "pending",
            claim_token: claimToken
          }
        ]);

      if (refInsertErr) {
        console.error("Failed to create referral record:", refInsertErr.message);
      } else {
        console.log("REFERRAL CREATED");
      }

      // Create record in syntrix_rewards
      const { error: rewInsertErr } = await supabase
        .from("syntrix_rewards")
        .insert([
          {
            email: referrerRecord.email,
            reward_type: "referral",
            amount: 10,
            status: "pending",
            claim_token: claimToken
          }
        ]);

      if (rewInsertErr) {
        console.error("Failed to create reward record:", rewInsertErr.message);
      } else {
        console.log("REWARD CREATED");
      }

      // Automatically dispatch the reward notification email containing the claim token
      await sendRewardNotification(referrerRecord.email, 10, claimToken);

      // Legacy referral log backup mapping
      try {
        await supabase
          .from("syntrix_referral_logs")
          .insert([
            {
              referrer_email: referrerRecord.email,
              referred_friend_email: sanitizedEmail,
              status: "pending"
            }
          ]);
      } catch (err) {
        console.warn("Legacy referral logging bypass:", err.message);
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

// ================= DASHBOARD-AUTH LEDGER RECOVERY (MODIFIED STRUCTURAL STATES) =================

app.get("/api/dashboard-auth", async (req, res) => {
  const { email, ref } = req.query;
  if (!email) return res.status(400).json({ error: "Email parameter required" });

  try {
    const sanitizedEmail = email.trim().toLowerCase();

    // ================= Live Referral Code Validation on Onboarding =================
    if (ref) {
      const cleanRefCode = normalizeReferralCode(ref);
      const generatedReferralCode = generateReferralCode(sanitizedEmail);

      // Rule 3: Self-referral protection (User cannot refer themselves)
      if (cleanRefCode === generatedReferralCode) {
        return res.status(400).json({ error: "You cannot refer yourself." });
      }

      // Rule 1 & 2: Check if code exists and belongs to another user
      const { data: referrerClaim, error: refError } = await supabase
        .from("syntrix_claims")
        .select("email")
        .eq("referral_code", cleanRefCode)
        .maybeSingle();

      if (refError || !referrerClaim) {
        return res.status(400).json({ error: "Invalid referral code. Code does not exist." });
      }

      if (referrerClaim.email === sanitizedEmail) {
        return res.status(400).json({ error: "Self-referral check: Code belongs to this email." });
      }

      // Rule 4: One referral reward per referred email
      const { data: alreadyReferred } = await supabase
        .from("syntrix_referrals")
        .select("id")
        .eq("referred_email", sanitizedEmail)
        .maybeSingle();

      if (alreadyReferred) {
        return res.status(400).json({ error: "This email has already been referred." });
      }
    }

    const { data: userProfile, error } = await supabase
      .from("syntrix_claims")
      .select("email, status, wallet_address, tx_hash, referral_code")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (!userProfile) {
      // Legacy referral logs hook
      if (ref) {
        const cleanRefCode = normalizeReferralCode(ref);
        try {
          const { data: potentialReferrer } = await supabase
            .from("syntrix_claims")
            .select("email")
            .eq("referral_code", cleanRefCode)
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
        isClaimed: false,
        status: "FLOW_C" // Informs frontend it is a new user path
      });
    }

    const isClaimed = userProfile.status === "success" || !!(userProfile.tx_hash || userProfile.wallet_address);

    return res.json({
      exists: true,
      isClaimed: isClaimed,
      status: isClaimed ? "FLOW_B" : "FLOW_A", // CRITICAL FIX: Frontend now cleanly resolves routing parameters
      txHash: userProfile.tx_hash || null,
      walletAddress: userProfile.wallet_address || null,
      referralCode: userProfile.referral_code || null
    });

  } catch (err) {
    console.error("Dashboard auth endpoint processing failure:", err);
    return res.status(500).json({ error: err.message || "Dashboard authentication processing failure" });
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
      .from("syntrix_claims")
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
      .select("amount, claim_token, reward_type")
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
      totalEarned,
      pendingRewardsList: pendingRewardsData || []
    });

  } catch (err) {
    console.error("Dashboard calculation error:", err);
    return res.status(500).json({ error: "Error fetching dashboard statistics" });
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
        // FIX: Rollback state back to pending for retry on error
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
    console.log(`[Claim Retrieval] Attempting lookup. Email received: "${sanitizedEmail}". Query table: "syntrix_claims"`);

    const { data: userRecord, error: fetchError } = await supabase
      .from("syntrix_claims")
      .select("id, status, tx_hash")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    console.log(`[Claim Retrieval] Query result:`, { userRecord, error: fetchError });

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

    // 2. Prevent double claim by checking duplicate wallet in syntrix_claims table
    const { data: duplicateWallet } = await supabase
      .from("syntrix_claims")
      .select("id")
      .eq("wallet_address", sanitizedWallet)
      .maybeSingle();

    if (duplicateWallet) {
      return res.status(400).json({ error: "This wallet address has already been used to claim a survey reward." });
    }

    // 3. Execute Blockchain Token Transfer
    let txHash = "0x" + crypto.randomBytes(32).toString("hex");

    if (tokenContract) {
      try {
        const decimals = await tokenContract.decimals();
        const amount = ethers.parseUnits("10", decimals);

        const tx = await tokenContract.transfer(sanitizedWallet, amount);
        await tx.wait();
        txHash = tx.hash;
      } catch (blockchainErr) {
        console.warn("Contract execution failed during lazy claim:", blockchainErr);
        // FIX: Return early so we don't accidentally update the database if the blockchain transfer fails
        return res.status(502).json({ error: "Blockchain execution failed: " + blockchainErr.message });
      }
    } else {
      console.warn("Bypassing on-chain token deployment (survey dispenser). Using mock hash ID:", txHash);
    }

    // 4. Update the primary registry row to close the loop
    const { error: updateError } = await supabase
      .from("syntrix_claims")
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

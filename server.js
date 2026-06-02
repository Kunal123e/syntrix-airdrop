require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");

const app = express();

app.use(cors());

app.use(express.json({
  limit: "2mb"
}));

// ================= SUPABASE =================

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// ================= POLYGON =================

const provider = new ethers.JsonRpcProvider(
  process.env.RPC_URL
);

const wallet = new ethers.Wallet(
  process.env.PRIVATE_KEY,
  provider
);

// ================= TOKEN ABI =================

const TOKEN_ABI = [
  "function transfer(address to, uint amount) public returns (bool)",
  "function decimals() public view returns (uint8)"
];

// ================= TOKEN CONTRACT =================

const tokenContract = new ethers.Contract(
  process.env.TOKEN_ADDRESS,
  TOKEN_ABI,
  wallet
);

// ================= TEST ROUTE =================

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Syntrix Multi-Phase Backend Operational"
  });
});

// ================= PHASE 1: SURVEY INGESTION SYSTEM =================

app.post("/api/claim-airdrop", async (req, res) => {
  try {
    const {
      email,
      monthlySpend,
      locationType,
      ageGroup,
      userPersona,
      luxuryAllocation,
      purchaseBlocker,
      shippingCostTolerance,
      paymentPreference,
      returnPolicyImportance,
      discoveryChannel,
      trustAnchor,
      brandRiskTolerance,
      shoppingDevice,
      conversionTrigger,
      decisionTimeline,
      giftingBehavior,
      priceComparisonBehavior,
      peakShoppingTime,
      painPoint,
      bestPoint,
      complementPoint,
      referralVoice,
      shoppingCategories,
      categorySpendCeiling,
      postPurchaseAction,
      returnHistoryReason
    } = req.body;

    // ================= VALIDATION =================
    if (!email) {
      return res.status(400).json({
        error: "Email identifier required"
      });
    }

    const sanitizedEmail = email.trim().toLowerCase();

    // ================= EMAIL EXIST CHECK =================
    const { data: existingEmail } = await supabase
      .from("syntrix_claims")
      .select("id")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (existingEmail) {
      return res.status(400).json({
        error: "This email has already submitted the survey."
      });
    }

    // ================= SAVE DATA: STEP 1 (CORE RECORD) =================
    const { data: claimData, error: claimError } = await supabase
      .from("syntrix_claims")
      .insert([
        {
          email: sanitizedEmail,
          amount_rewarded: 10,
          status: "pending" // Set status to pending. Wallet and Tx will remain empty for now.
        }
      ])
      .select("id")
      .single();

    if (claimError) {
      // Catch Postgres unique constraint violation gracefully
      if (claimError.code === "23505") {
        return res.status(400).json({
          error: "This email has already submitted the survey."
        });
      }
      return res.status(500).json({
        error: "User Claims Registry Failure: " + claimError.message
      });
    }

    const insertedClaimId = claimData.id;

    // ================= SAVE DATA: STEP 2 (SURVEY METRICS) =================
    const { error: surveyError } = await supabase
      .from("syntrix_survey_answers")
      .insert([
        {
          claim_id: insertedClaimId,
          monthly_spend: monthlySpend,
          city_tier: locationType,
          age_group: ageGroup,
          user_persona: userPersona,
          luxury_allocation: luxuryAllocation,
          purchase_blocker: purchaseBlocker,
          shipping_cost_tolerance: shippingCostTolerance,
          payment_preference: paymentPreference,
          return_policy_importance: returnPolicyImportance,
          discovery_channel: discoveryChannel,
          trust_anchor: trustAnchor,
          brand_risk_tolerance: brandRiskTolerance,
          shopping_device: shoppingDevice,
          conversion_trigger: conversionTrigger,
          decision_timeline: decisionTimeline,
          gifting_behavior: giftingBehavior,
          price_comparison_behavior: priceComparisonBehavior,
          peak_shopping_time: peakShoppingTime,
          pain_point: painPoint,
          best_point: bestPoint,
          complement_point: complementPoint,
          referral_voice: referralVoice,
          shopping_categories: shoppingCategories,
          category_spend_ceiling: categorySpendCeiling,
          post_purchase_action: postPurchaseAction,
          return_history_reason: returnHistoryReason
        }
      ]);

    if (surveyError) {
      return res.status(500).json({
        error: "Survey Analytics Storage Failure: " + surveyError.message
      });
    }

    return res.json({
      success: true,
      message: "Survey data successfully stored. Eligible to claim rewards via dashboard."
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: err.message || "Internal server error"
    });
  }
});

// ================= PHASE 2: AUTOMATED LEDGER AUTO-RECOVERY ROUTE =================
// FIX: Converted from .post to .get to perfectly match frontend fetch tracking calls.
// FIX: Changed payload output structures to cleanly return straight flags to script.js.
app.get("/api/dashboard-auth", async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email parameter required" });

  try {
    const sanitizedEmail = email.trim().toLowerCase();

    const { data: userProfile, error } = await supabase
      .from("syntrix_claims")
      .select("email, status, wallet_address, tx_hash")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    // CASE C: If user record does not exist in database, report safely back
    if (!userProfile) {
      return res.json({ 
        exists: false,
        isClaimed: false
      });
    }

    // Evaluate normalized claim status definitions based on table constraints
    const isClaimed = userProfile.status === "success" || !!(userProfile.tx_hash || userProfile.wallet_address);

    // Provide raw mapped objects back to frontend
    return res.json({
      exists: true,
      isClaimed: isClaimed,
      status: userProfile.status,
      txHash: userProfile.tx_hash || null,
      walletAddress: userProfile.wallet_address || null
    });

  } catch (err) {
    console.error("Dashboard auth endpoint processing failure:", err);
    return res.status(500).json({ error: "Dashboard authentication processing failure" });
  }
});

// ================= PHASE 2: LAZY WALLET REWARD DISPENSER =================

app.post("/api/claim-reward", async (req, res) => {
  const { email, walletAddress } = req.body;

  if (!email || !walletAddress) {
    return res.status(400).json({ error: "Email and destination wallet address are required." });
  }

  if (!ethers.isAddress(walletAddress)) {
    return res.status(400).json({ error: "Invalid target wallet address string alignment." });
  }

  try {
    const sanitizedEmail = email.trim().toLowerCase();

    // 1. Verify user profile exists and is still pending
    const { data: userRecord } = await supabase
      .from("syntrix_claims")
      .select("id, status, tx_hash")
      .eq("email", sanitizedEmail)
      .maybeSingle();

    if (!userRecord) return res.status(404).json({ error: "User survey verification profile not found." });
    
    if (userRecord.status === "success" || userRecord.tx_hash) {
      return res.status(400).json({ error: "Rewards have already been successfully distributed to this email." });
    }

    // 2. Prevent a single wallet from claiming rewards multiple times
    const { data: duplicateWallet } = await supabase
      .from("syntrix_claims")
      .select("id")
      .eq("wallet_address", walletAddress)
      .maybeSingle();

    if (duplicateWallet) {
      return res.status(400).json({ error: "This wallet address has already been used to claim a reward." });
    }

    // 3. Execute Blockchain Token Transfer Asset Execution
    const decimals = await tokenContract.decimals();
    const amount = ethers.parseUnits("10", decimals);

    const tx = await tokenContract.transfer(walletAddress, amount);
    await tx.wait();

    // 4. Update the primary registry row to close the loop
    const { error: updateError } = await supabase
      .from("syntrix_claims")
      .update({
        wallet_address: walletAddress,
        tx_hash: tx.hash,
        status: "success"
      })
      .eq("id", userRecord.id);

    if (updateError) return res.status(500).json({ error: "Registry Finalization Failure: " + updateError.message });

    return res.json({
      success: true,
      transactionHash: tx.hash
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Smart contract claim execution pipeline blocked." });
  }
});

// ================= SERVER =================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

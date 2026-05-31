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
    message: "Backend running successfully"
  });
});

// ================= CLAIM API =================

app.post("/api/claim-airdrop", async (req, res) => {

  try {

    const {
      email,
      walletAddress,
      monthlySpend,
      locationType, // Frontend key mapping to database column 'city_tier'
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

    if (!email || !walletAddress) {
      return res.status(400).json({
        error: "Email and wallet required"
      });
    }

    // ================= WALLET CHECK =================

    if (!ethers.isAddress(walletAddress)) {
      return res.status(400).json({
        error: "Invalid wallet address"
      });
    }

    // ================= EMAIL EXIST CHECK =================

    const { data: existingEmail } = await supabase
      .from("syntrix_claims")
      .select("id")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (existingEmail) {
      return res.status(400).json({
        error: "Email already claimed"
      });
    }

    // ================= WALLET EXIST CHECK =================

    const { data: existingWallet } = await supabase
      .from("syntrix_claims")
      .select("id")
      .eq("wallet_address", walletAddress)
      .maybeSingle();

    if (existingWallet) {
      return res.status(400).json({
        error: "Wallet already claimed"
      });
    }

    // ================= TOKEN AMOUNT =================

    const decimals = await tokenContract.decimals();

    const amount = ethers.parseUnits(
      "10",
      decimals
    );

    // ================= SEND TOKENS =================

    const tx = await tokenContract.transfer(
      walletAddress,
      amount
    );

    await tx.wait();

    // ================= SAVE DATA: STEP 1 (CORE USER CLAIM PROFILE) =================

    const { data: claimData, error: claimError } = await supabase
      .from("syntrix_claims")
      .insert([
        {
          email: email.toLowerCase(),
          wallet_address: walletAddress,
          amount_rewarded: 10,
          tx_hash: tx.hash,
          status: "success"
        }
      ])
      .select("id")
      .single();

    if (claimError) {
      return res.status(500).json({
        error: "Claims Registry Failure: " + claimError.message
      });
    }

    // Extract the auto-generated numeric bigint ID from the newly inserted user row
    const insertedClaimId = claimData.id;

    // ================= SAVE DATA: STEP 2 (SPECIFIC CONSUMER ANSWERS) =================

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
        error: "Survey Storage Metrics Failure: " + surveyError.message
      });
    }

    // ================= SUCCESS =================

    return res.json({
      success: true,
      transactionHash: tx.hash
    });

  } catch (err) {

    console.error(err);

    return res.status(500).json({
      error: err.message || "Internal server error"
    });

  }

});

// ================= SERVER =================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {

  console.log(
    `Server running on port ${PORT}`
  );

});

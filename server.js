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
      ...surveyData
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
      .from("claims")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingEmail) {
      return res.status(400).json({
        error: "Email already claimed"
      });
    }

    // ================= WALLET EXIST CHECK =================

    const { data: existingWallet } = await supabase
      .from("claims")
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

    // ================= SAVE DATABASE =================

    const { error } = await supabase
      .from("claims")
      .insert([
        {
          email: email.toLowerCase(),
          wallet_address: walletAddress,
          amount_rewarded: 10,
          tx_hash: tx.hash,
          status: "success",
          survey_data: surveyData
        }
      ]);

    if (error) {
      return res.status(500).json({
        error: error.message
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
-- ========================================================
-- Syntrix Referral System Database Schema (Claims v2)
-- ========================================================

-- 1. Create or ensure existing syntrix_claims table
CREATE TABLE IF NOT EXISTS syntrix_claims (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    email TEXT UNIQUE NOT NULL,
    wallet_address TEXT UNIQUE, -- Allow nullable initially until claimed (retained as unique)
    amount_rewarded NUMERIC DEFAULT 10,
    tx_hash TEXT,
    status TEXT DEFAULT 'pending', -- Default to 'pending' to allow claims flow
    survey_data JSONB
);

-- 2. Add referral_code column to syntrix_claims table (Phase 2)
ALTER TABLE syntrix_claims 
ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;

-- Create index on referral_code for fast verification queries
CREATE INDEX IF NOT EXISTS idx_syntrix_claims_referral_code 
ON syntrix_claims(referral_code);


-- 3. Create syntrix_referrals table to track referred relationships (Phase 1)
CREATE TABLE IF NOT EXISTS syntrix_referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_email TEXT NOT NULL,
    referred_email TEXT NOT NULL UNIQUE, -- Constraint: referred_email must be UNIQUE (Phase 11)
    referral_code TEXT NOT NULL,
    reward_amount NUMERIC DEFAULT 10 NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL 
        CHECK (status IN ('pending', 'approved', 'claimed', 'rejected')),
    claim_token TEXT UNIQUE, -- Links directly to syntrix_rewards
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    
    -- Security: Prevent self-referral (Phase 11)
    CONSTRAINT chk_no_self_referral CHECK (referrer_email <> referred_email)
);

-- Indexing for dashboard statistics & verification queries
CREATE INDEX IF NOT EXISTS idx_syntrix_referrals_referrer_email 
ON syntrix_referrals(referrer_email);

CREATE INDEX IF NOT EXISTS idx_syntrix_referrals_referred_email 
ON syntrix_referrals(referred_email);


-- 4. Create syntrix_rewards table to track claimable tokens (Phase 1)
CREATE TABLE IF NOT EXISTS syntrix_rewards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    reward_type TEXT NOT NULL 
        CHECK (reward_type IN ('survey', 'referral', 'bonus')),
    amount NUMERIC NOT NULL,
    status TEXT DEFAULT 'pending' NOT NULL 
        CHECK (status IN ('pending', 'claimed', 'rejected')),
    claim_token TEXT UNIQUE NOT NULL, -- Constraint: claim_token becomes invalid after claim (Phase 11)
    tx_hash TEXT UNIQUE, -- Stores blockchain transaction hash
    claimed_wallet TEXT, -- Wallet address that received the tokens
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    claimed_at TIMESTAMPTZ
);

-- Indexing for reward lookup & status tracking
CREATE INDEX IF NOT EXISTS idx_syntrix_rewards_email 
ON syntrix_rewards(email);

CREATE INDEX IF NOT EXISTS idx_syntrix_rewards_claim_token 
ON syntrix_rewards(claim_token);


-- 5. Create syntrix_wallets mapping table (Wallet Protection - Phase 10)
-- Rules: One wallet = One email, One email = One wallet
CREATE TABLE IF NOT EXISTS syntrix_wallets (
    email TEXT PRIMARY KEY, -- Enforces only one wallet per email
    wallet_address TEXT UNIQUE NOT NULL, -- Enforces only one email per wallet
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexing wallet address for quick lookup during claims
CREATE INDEX IF NOT EXISTS idx_syntrix_wallets_address 
ON syntrix_wallets(wallet_address);

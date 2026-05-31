-- =========================================================================
-- TABLE 1: Core User Identity & Authentication Registry
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.syntrix_claims (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    email TEXT UNIQUE NOT NULL,
    wallet_address VARCHAR(42) UNIQUE NOT NULL,
    amount_rewarded NUMERIC DEFAULT 10,
    tx_hash TEXT,
    status TEXT DEFAULT 'success'
);

-- =========================================================================
-- TABLE 2: Deep Granular Consumer Analytics & Sentiment Survey Answers
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.syntrix_survey_answers (
    -- Unique internal tracer row ID for the answers sheet
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Foreign Key Link: Linked to the BIGSERIAL primary key from the user registry
    claim_id BIGINT REFERENCES public.syntrix_claims(id) ON DELETE CASCADE NOT NULL,
    
    -- Section 1: Financial Power & Demographics
    monthly_spend TEXT,
    city_tier TEXT,
    age_group TEXT,
    user_persona TEXT,
    luxury_allocation TEXT,
    
    -- Section 2: Checkout Friction & Drop-Off Killers
    purchase_blocker TEXT,
    shipping_cost_tolerance TEXT,
    payment_preference TEXT,
    return_policy_importance TEXT,
    
    -- Section 3: Discovery Engines & Trust Anchors
    discovery_channel TEXT,
    trust_anchor TEXT,
    brand_risk_tolerance TEXT,
    shopping_device TEXT,
    
    -- Section 4: Buying Psychology & Timelines
    conversion_trigger TEXT,
    decision_timeline TEXT,
    gifting_behavior TEXT,
    price_comparison_behavior TEXT,
    peak_shopping_time TEXT,
    
    -- Section 5: High-Fidelity Sentiment (Written Responses)
    pain_point TEXT,
    best_point TEXT,
    complement_point TEXT,
    referral_voice TEXT,
    
    -- Section 6: Niche Vertical - Shopping Categories
    shopping_categories JSONB, -- Clean multi-select checkbox array storage
    category_spend_ceiling TEXT,
    
    -- Section 7: Post-Purchase Behavior
    post_purchase_action TEXT,
    return_history_reason TEXT    
);

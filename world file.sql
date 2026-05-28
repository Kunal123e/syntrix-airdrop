CREATE TABLE IF NOT EXISTS claims (

id BIGSERIAL PRIMARY KEY,

created_at TIMESTAMPTZ DEFAULT NOW(),

email TEXT UNIQUE NOT NULL,

wallet_address TEXT UNIQUE NOT NULL,

amount_rewarded NUMERIC DEFAULT 10,

tx_hash TEXT,

status TEXT DEFAULT 'success',

survey_data JSONB

);

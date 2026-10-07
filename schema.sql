CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT, password_hash TEXT, google_id TEXT UNIQUE,
  credits INTEGER NOT NULL DEFAULT 0 CHECK(credits>=0), created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- credit ledger: every balance change is recorded (signup bonus, spend, refund, purchase, renewal)
CREATE TABLE IF NOT EXISTS credit_transactions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), delta INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
-- payment history: one row per checkout attempt; status pending -> paid
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), provider TEXT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL,
  amount INTEGER NOT NULL, currency TEXT NOT NULL, credits INTEGER NOT NULL, reference TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT DEFAULT CURRENT_TIMESTAMP, paid_at TEXT);
CREATE TABLE IF NOT EXISTS subscriptions(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), plan TEXT NOT NULL, provider TEXT NOT NULL, provider_sub_id TEXT,
  status TEXT NOT NULL DEFAULT 'active', current_period_end TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS generations(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL, prompt TEXT, style TEXT, cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing', provider_job_id TEXT, error TEXT, result_text TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT);
CREATE TABLE IF NOT EXISTS media(id INTEGER PRIMARY KEY, generation_id INTEGER NOT NULL REFERENCES generations(id), user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, file TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_gen_user ON generations(user_id,id); CREATE INDEX IF NOT EXISTS ix_tx_user ON credit_transactions(user_id,id);

CREATE TABLE certification_grants (
  account_id uuid NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(account_id,user_id)
);
CREATE TABLE extension_pairings (
  code_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE TABLE extension_tokens (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL, expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

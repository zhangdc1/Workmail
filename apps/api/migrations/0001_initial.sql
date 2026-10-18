CREATE TABLE users (
  id uuid PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL,
  role text NOT NULL CHECK(role IN ('admin','member','kyc_viewer')),
  disabled boolean NOT NULL DEFAULT false, mailbox_quota integer NOT NULL DEFAULT 10000 CHECK(mailbox_quota >= 0),
  storage_quota bigint NOT NULL DEFAULT 10737418240 CHECK(storage_quota >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE domains (
  id uuid PRIMARY KEY, name text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','retired','disabled')),
  dns jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE domain_grants (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id,domain_id)
);
CREATE TABLE mailboxes (
  id uuid PRIMARY KEY, domain_id uuid NOT NULL REFERENCES domains(id),
  owner_id uuid NOT NULL REFERENCES users(id), address text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '', tags jsonb NOT NULL DEFAULT '[]', note text NOT NULL DEFAULT '',
  quota_bytes bigint NOT NULL DEFAULT 104857600 CHECK(quota_bytes >= 0),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK(used_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mailboxes_owner ON mailboxes(owner_id,created_at);
CREATE TABLE addresses (
  address text PRIMARY KEY, mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES domains(id), enabled boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mailbox_grants (
  mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(mailbox_id,user_id)
);
CREATE TABLE raw_messages (
  id uuid PRIMARY KEY, digest text NOT NULL UNIQUE, path text NOT NULL, size integer NOT NULL,
  envelope_from text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE messages (
  id uuid PRIMARY KEY, mailbox_id uuid NOT NULL REFERENCES mailboxes(id),
  raw_id uuid NOT NULL REFERENCES raw_messages(id), envelope_recipient text NOT NULL,
  from_address text NOT NULL DEFAULT '', from_name text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '',
  text_body text NOT NULL DEFAULT '', html_body text NOT NULL DEFAULT '',
  otp text, links jsonb NOT NULL DEFAULT '[]', is_read boolean NOT NULL DEFAULT false,
  starred boolean NOT NULL DEFAULT false,
  parse_state text NOT NULL DEFAULT 'pending' CHECK(parse_state IN ('pending','ready','failed')),
  parse_error text, size integer NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector,
  UNIQUE(mailbox_id,raw_id)
);
CREATE INDEX messages_mailbox_date ON messages(mailbox_id,received_at DESC,id);
CREATE INDEX messages_unread ON messages(mailbox_id) WHERE NOT is_read;
CREATE INDEX messages_search ON messages USING gin(search_document);
CREATE TABLE attachments (
  id uuid PRIMARY KEY, message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  name text NOT NULL, content_type text NOT NULL, size integer NOT NULL, path text NOT NULL
);
CREATE TABLE business_accounts (
  id uuid PRIMARY KEY, mailbox_id uuid REFERENCES mailboxes(id), email text NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id), platform text NOT NULL DEFAULT 'claude',
  registered boolean NOT NULL DEFAULT false, subscribed boolean NOT NULL DEFAULT false,
  suspended boolean NOT NULL DEFAULT false, tags jsonb NOT NULL DEFAULT '[]', note text NOT NULL DEFAULT '',
  assigned_ip text NOT NULL DEFAULT '', kyc_status text NOT NULL DEFAULT 'unqueried'
    CHECK(kyc_status IN ('unqueried','pending','passed','denied','expired','not_required')),
  kyc_url text NOT NULL DEFAULT '', kyc_expires_at timestamptz, kyc_passed_at timestamptz,
  last_checked_at timestamptz, sync_state text NOT NULL DEFAULT 'idle', sync_message text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0, inquiry_id text NOT NULL DEFAULT '', organization_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(email,platform)
);
CREATE INDEX accounts_owner ON business_accounts(owner_id,created_at);
CREATE TABLE credentials (
  account_id uuid NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('session','proxy')), ciphertext text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,kind)
);
CREATE TABLE certification_events (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES business_accounts(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id), source text NOT NULL, status text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cert_events_account ON certification_events(account_id,created_at DESC);
CREATE TABLE jobs (
  id uuid PRIMARY KEY, kind text NOT NULL, state text NOT NULL DEFAULT 'queued'
    CHECK(state IN ('queued','running','completed','failed','cancelled')),
  owner_id uuid REFERENCES users(id), payload jsonb NOT NULL DEFAULT '{}',
  result jsonb, progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 1,
  cancel_requested boolean NOT NULL DEFAULT false, attempts integer NOT NULL DEFAULT 0,
  error text, lease_until timestamptz, run_token uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_queue ON jobs(kind,created_at) WHERE state='queued';
CREATE TABLE account_query_locks (
  account_id uuid PRIMARY KEY REFERENCES business_accounts(id) ON DELETE CASCADE,
  token uuid NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE shares (
  id uuid PRIMARY KEY, mailbox_id uuid NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE, password_hash text, expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false, created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE share_sessions (
  token_hash text PRIMARY KEY, share_id uuid NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY, actor_id uuid REFERENCES users(id), action text NOT NULL,
  target_id text, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE service_heartbeats (
  name text PRIMARY KEY, updated_at timestamptz NOT NULL DEFAULT now(), detail jsonb NOT NULL DEFAULT '{}'
);
CREATE VIEW postfix_domains AS SELECT name FROM domains WHERE state IN ('active','retired');
CREATE VIEW postfix_recipients AS
  SELECT a.address FROM addresses a JOIN domains d ON d.id=a.domain_id
  JOIN mailboxes m ON m.id=a.mailbox_id JOIN users u ON u.id=m.owner_id
  WHERE a.enabled AND d.state IN ('active','retired') AND NOT u.disabled;

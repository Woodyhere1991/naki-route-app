CREATE TABLE IF NOT EXISTS profile_invites (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  street_address TEXT NOT NULL DEFAULT '',
  town TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  rural_option TEXT NOT NULL DEFAULT '',
  referral_source TEXT NOT NULL DEFAULT '',
  access_notes TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS profile_invites_email
  ON profile_invites(email, created_at DESC);

CREATE INDEX IF NOT EXISTS profile_invites_expiry
  ON profile_invites(expires_at);

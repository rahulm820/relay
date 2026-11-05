-- Issue #17: admin users and server-side sessions.
-- The email is globally unique (lowercased) because login has to find the tenant from the email alone.
CREATE TABLE admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  name text NOT NULL,
  role role NOT NULL,
  password_hash text NOT NULL,          -- scrypt$N=..,r=..,p=..$salt$hash; never plaintext
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX admin_users_email ON admin_users (email);

-- Only the SHA-256 of the session token is stored; the token itself exists only in the browser cookie.
CREATE TABLE admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,       -- absolute expiry
  revoked_at timestamptz
);
CREATE INDEX admin_sessions_user ON admin_sessions (user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_users','admin_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = relay_current_tenant()) WITH CHECK (tenant_id = relay_current_tenant())', t);
  END LOOP;
END $$;

-- Least privilege: the API can read user columns EXCEPT the password hash, cannot create users (the seed does,
-- as the schema owner), and can only manage sessions. The hash is reachable only through the login function below.
GRANT SELECT (id, tenant_id, email, name, role, active, created_at) ON admin_users TO relay_app;
GRANT UPDATE (name, role, active) ON admin_users TO relay_app;
GRANT SELECT, INSERT, UPDATE ON admin_sessions TO relay_app;

-- Pre-tenant lookups (the request has no tenant until the user or session is found), as narrow as relay_resolve_bot.
CREATE FUNCTION relay_find_admin_for_login(p_email text)
  RETURNS TABLE (id uuid, tenant_id uuid, password_hash text, role role, active boolean, name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT u.id, u.tenant_id, u.password_hash, u.role, u.active, u.name FROM admin_users u WHERE u.email = lower(p_email) $$;

-- Validates a session (not revoked, not past its absolute expiry, not idle too long, user still active) and marks it
-- as used, in one statement. Returns nothing for any invalid session.
CREATE FUNCTION relay_resolve_session(p_token_hash text, p_idle_seconds integer)
  RETURNS TABLE (session_id uuid, tenant_id uuid, user_id uuid, email text, name text, role role)
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public
  AS $$ UPDATE admin_sessions s SET last_seen_at = now() FROM admin_users u
        WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(secs => p_idle_seconds)
          AND u.id = s.user_id AND u.active
        RETURNING s.id, s.tenant_id, u.id, u.email, u.name, u.role $$;

REVOKE ALL ON FUNCTION relay_find_admin_for_login(text), relay_resolve_session(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relay_find_admin_for_login(text), relay_resolve_session(text, integer) TO relay_app;

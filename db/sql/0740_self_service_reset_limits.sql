-- 0740_self_service_reset_limits.sql — what an anonymous reset request may do
--
-- POST /api/auth/local/reset without a session is anonymous by design: anybody
-- may ask for a link for any address. Under 0340 every such request ran
-- helm.issue_password_reset(), which invalidated EVERY outstanding token for
-- the user before issuing its own. Two consequences:
--
--   1. An anonymous caller could cancel an administrator's out-of-band code —
--      the one read down the phone during an identity-provider outage, which is
--      exactly when the mailbox the self-service link goes to is also down.
--      Repeating the request every few seconds kept the person locked out.
--
--   2. Nothing limited how often it ran, so a configured delivery channel could
--      be used to flood somebody's mailbox with reset links.
--
-- Now, for origin 'self' only:
--
--   * Only earlier SELF-SERVICE tokens are invalidated. An administrator's code
--     survives an anonymous request; it is still invalidated when an
--     administrator issues another, when it is used, or when the password
--     changes (0340's other triggers are untouched).
--
--   * While a self-service token issued in the last five minutes is still
--     outstanding, a further self-service request issues nothing and returns
--     NULL. The route answers it exactly as it answers an unknown address, so
--     the throttle tells a caller nothing. The first link keeps working.
--
-- An administrator-issued reset behaves exactly as before.

CREATE OR REPLACE FUNCTION helm.issue_password_reset(
  p_user_id      uuid,
  p_token_sha256 bytea,
  p_origin       text,
  p_ttl_minutes  integer DEFAULT 60,
  p_issued_by    uuid DEFAULT NULL,
  p_ip           inet DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = public, helm, extensions, pg_catalog, pg_temp
AS $$
DECLARE
  v_id  uuid;
  v_ttl integer := least(greatest(coalesce(p_ttl_minutes, 60), 5), 1440);
BEGIN
  IF p_origin NOT IN ('self', 'admin') THEN
    RAISE EXCEPTION 'helm: unknown reset origin %', p_origin
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_origin = 'self' THEN
    -- Serialise concurrent self-service requests for one person, so two
    -- arriving together cannot both pass the throttle below.
    PERFORM pg_advisory_xact_lock(hashtextextended('helm.self_reset:' || p_user_id::text, 0));

    IF EXISTS (
      SELECT 1 FROM password_reset
      WHERE user_id = p_user_id
        AND origin = 'self'
        AND used_at IS NULL
        AND invalidated_at IS NULL
        AND expires_at > now()
        AND created_at > now() - interval '5 minutes'
    ) THEN
      RETURN NULL;
    END IF;

    UPDATE password_reset
    SET invalidated_at = now()
    WHERE user_id = p_user_id AND origin = 'self'
      AND used_at IS NULL AND invalidated_at IS NULL;
  ELSE
    UPDATE password_reset
    SET invalidated_at = now()
    WHERE user_id = p_user_id AND used_at IS NULL AND invalidated_at IS NULL;
  END IF;

  INSERT INTO password_reset (user_id, token_sha256, origin, issued_by, expires_at, created_ip)
  VALUES (p_user_id, p_token_sha256, p_origin, p_issued_by,
          now() + make_interval(mins => v_ttl), p_ip)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION helm.issue_password_reset(uuid, bytea, text, integer, uuid, inet) IS
  'Issue a reset token. A self-service request never invalidates an '
  'administrator''s code and is throttled to one outstanding link per five '
  'minutes, returning NULL when throttled (0740).';

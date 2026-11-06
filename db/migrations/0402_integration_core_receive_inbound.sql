-- migration-class: expand
-- integration_core.receive_inbound (ARCHITECTURE 21.6, 25.7; SEC-01 DF-1..DF-4) and the ownership of inbound_message.
--
-- A vendor webhook has no session. The API verifies the request (29.5), sets app.org_id from deployment configuration and
-- calls this function. It inserts one row and reads nothing: no SELECT policy is involved (a bare ON CONFLICT DO NOTHING plus the
-- row count decide inserted or duplicate). It does not touch the queue; the API enqueues the dispatch job itself in the
-- same transaction (TDR-04). EXECUTE is granted to app_api only (DF-1): the worker never receives a webhook.

ALTER TABLE integration_core.inbound_message OWNER TO integration_receiver_owner;

CREATE FUNCTION integration_core.receive_inbound(
  p_source text, p_event_id text, p_type text, p_payload_ciphertext bytea
) RETURNS TABLE (outcome text, message_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_org uuid := kernel.uuid1('app.org_id');
  v_id  uuid := gen_random_uuid();
  v_rows integer;
BEGIN
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'receive_inbound: no organisation in the transaction scope' USING ERRCODE = '22023';
  END IF;
  -- Audiences that must never reach a webhook insert (DF-8 spirit): a signed-in user, a partner session or a job.
  IF coalesce(kernel.setting('app.audience'), '') NOT IN ('', 'anonymous') THEN
    RAISE EXCEPTION 'receive_inbound: only a verified webhook transaction may call this' USING ERRCODE = '42501';
  END IF;
  -- DF-2: format and size checks of the column CHECKs are repeated as explicit errors so the caller gets 22023, not 23514.
  IF p_source IS NULL OR p_source !~ '^[a-z0-9][a-z0-9_.-]{0,63}$'
     OR p_event_id IS NULL OR char_length(p_event_id) NOT BETWEEN 1 AND 255
     OR p_event_id !~ '^[A-Za-z0-9][A-Za-z0-9_.:@=+/-]*$'
     OR p_type IS NULL OR p_type !~ '^[a-z][a-z0-9_.]{0,99}$'
     OR p_payload_ciphertext IS NULL OR octet_length(p_payload_ciphertext) NOT BETWEEN 1 AND 262144 THEN
    RAISE EXCEPTION 'receive_inbound: bad argument' USING ERRCODE = '22023';
  END IF;
  INSERT INTO integration_core.inbound_message (id, organisation_id, source, event_id, message_type, payload)
  VALUES (v_id, v_org, p_source, p_event_id, p_type, p_payload_ciphertext)
  -- A bare ON CONFLICT DO NOTHING: with a conflict target PostgreSQL also asks for SELECT rights and SELECT-policy visibility,
  -- which this role must not have (it reads nothing). The only unique keys are the random id and the de-duplication key.
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 1 THEN
    RETURN QUERY SELECT 'inserted'::text, v_id;
  ELSE
    RETURN QUERY SELECT 'duplicate'::text, NULL::uuid;
  END IF;
END
$$;
-- Privileges first, then the owner: once integration_receiver_owner owns the function, app_owner (SET-only membership,
-- INHERIT FALSE) can no longer grant or revoke on it, and a REVOKE would silently do nothing.
REVOKE ALL ON FUNCTION integration_core.receive_inbound(text, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration_core.receive_inbound(text, text, text, bytea) TO app_api;
ALTER FUNCTION integration_core.receive_inbound(text, text, text, bytea) OWNER TO integration_receiver_owner;

-- migration-class: expand
-- notifications schema, tables and database-side rules (ARCHITECTURE 22.13, 22.16, 21.5; SHARED-BOUNDARIES 8.3 BD-10;
-- ticket BE-06, migrations 0600-0699). RLS and grants: 0601.
--
-- Scope of this ticket: template, notification, delivery_receipt, in_app_read. The staff-alert tables (staff_alert,
-- staff_alert_event, staff_alert_setting) belong to BE-07. Addresses are never stored here (3.2 rule 7).
--
-- The variable allowlist (BD-10) is enforced twice: in the service and here. A template whose variables or placeholders
-- leave the list cannot be inserted or updated, whoever writes. The list names NO service, diagnosis, medicine or
-- clinician field: BQ-2 (clinician name) is open, and TC-NT-01 allows only a log-in prompt and links.

CREATE SCHEMA notifications;
COMMENT ON SCHEMA notifications IS 'Templates, notification jobs, delivery receipts, in-app reads (ARCHITECTURE 22.13)';
REVOKE ALL ON SCHEMA notifications FROM PUBLIC;
GRANT USAGE ON SCHEMA notifications TO app_api, app_worker;

-- The closed allowlist: (name, type). Keep in step with apps/api/src/modules/notifications/allowlist.ts (a test compares them).
CREATE FUNCTION notifications.allowed_variable(name text, type text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  SELECT (name, type) IN (
    ('start_at', 'datetime'), ('end_at', 'datetime'), ('offer_expires_at', 'datetime'),
    ('location_name', 'location_name'),
    ('portal_link', 'url'), ('sign_in_link', 'url'), ('confirm_link', 'url'), ('reschedule_link', 'url'), ('cancel_link', 'url'),
    ('code', 'code'), ('time_zone', 'timezone'),
    ('event_uid', 'uid'))
$$;

-- template.variables: an array of {name, type}, each pair on the allowlist, no duplicate names.
CREATE FUNCTION notifications.variables_declared_ok(doc jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  SELECT jsonb_typeof(doc) = 'array'
     AND jsonb_array_length(doc) <= 20
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(doc) AS e(v)
       WHERE jsonb_typeof(e.v) <> 'object'
          OR (SELECT count(*) FROM jsonb_object_keys(e.v)) <> 2
          OR NOT (e.v ? 'name' AND e.v ? 'type')
          OR jsonb_typeof(e.v -> 'name') <> 'string' OR jsonb_typeof(e.v -> 'type') <> 'string'
          OR NOT notifications.allowed_variable(e.v ->> 'name', e.v ->> 'type'))
     AND (SELECT count(DISTINCT e.v ->> 'name') FROM jsonb_array_elements(doc) AS e(v)) = jsonb_array_length(doc)
$$;

-- notification.variables: an object whose keys are allowlisted names and whose values are short strings.
CREATE FUNCTION notifications.values_ok(doc jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  SELECT jsonb_typeof(doc) = 'object'
     AND pg_column_size(doc) <= 4096
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(doc) AS e(k, v)
       WHERE jsonb_typeof(e.v) <> 'string' OR char_length(e.v #>> '{}') > 500
          OR NOT EXISTS (SELECT 1 FROM (VALUES ('start_at'), ('end_at'), ('offer_expires_at'), ('location_name'), ('portal_link'),
               ('sign_in_link'), ('confirm_link'), ('reschedule_link'), ('cancel_link'), ('code'), ('time_zone'), ('event_uid')) AS a(n) WHERE a.n = e.k))
$$;

-- Placeholders of a text: `{{ name }}` only. Any other `{{` or `}}` makes the text unusable (returns NULL).
CREATE FUNCTION notifications.placeholders_of(txt text) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  SELECT CASE
    WHEN regexp_replace(coalesce(txt, ''), '\{\{ ?[a-z][a-z0-9_]{0,40} ?\}\}', '', 'g') ~ '(\{\{|\}\})' THEN NULL
    ELSE coalesce((SELECT array_agg(DISTINCT m[1]) FROM regexp_matches(coalesce(txt, ''), '\{\{ ?([a-z][a-z0-9_]{0,40}) ?\}\}', 'g') AS m), '{}'::text[])
  END
$$;
REVOKE ALL ON FUNCTION notifications.allowed_variable(text, text), notifications.variables_declared_ok(jsonb),
  notifications.values_ok(jsonb), notifications.placeholders_of(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notifications.allowed_variable(text, text), notifications.variables_declared_ok(jsonb),
  notifications.values_ok(jsonb), notifications.placeholders_of(text) TO app_api, app_worker;

-- template (22.13). A version is published only after the render check (RA-R1-05).
CREATE TABLE notifications.template (
  id                      uuid        PRIMARY KEY,
  organisation_id         uuid        NOT NULL,
  key                     text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,80}$'),
  channel                 text        NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app', 'ics')),
  language                text        NOT NULL CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'),
  version                 integer     NOT NULL CHECK (version >= 1),
  subject                 text        CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 200),
  body                    text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  variables               jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (notifications.variables_declared_ok(variables)),
  status                  text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  render_check_passed_at  timestamptz,
  published_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  created_by_job          uuid,
  row_version             bigint      NOT NULL DEFAULT 1,
  updated_at              timestamptz,
  CONSTRAINT template_version_uq UNIQUE (organisation_id, key, channel, language, version),
  CONSTRAINT template_email_subject CHECK (channel <> 'email' OR subject IS NOT NULL),
  CONSTRAINT template_published_checked CHECK (status = 'draft' OR render_check_passed_at IS NOT NULL),
  CONSTRAINT template_published_at CHECK ((status = 'draft') = (published_at IS NULL))
);
COMMENT ON TABLE notifications.template IS 'class=C1';
CREATE INDEX template_lookup ON notifications.template (organisation_id, key, status, version DESC);

-- Every `{{name}}` in subject and body must be a declared variable; nothing else in braces. Content is frozen once the
-- version leaves draft; transitions are forward-only; editing a draft clears its render check.
CREATE FUNCTION notifications.guard_template() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  used_body text[];
  used_subject text[];
  declared text[];
BEGIN
  used_body := notifications.placeholders_of(NEW.body);
  used_subject := notifications.placeholders_of(NEW.subject);
  IF used_body IS NULL OR used_subject IS NULL THEN
    RAISE EXCEPTION 'notifications.template: malformed placeholder' USING ERRCODE = '23514';
  END IF;
  SELECT coalesce(array_agg(e.v ->> 'name'), '{}'::text[]) INTO declared FROM jsonb_array_elements(NEW.variables) AS e(v);
  IF NOT (used_body <@ declared AND used_subject <@ declared) THEN
    RAISE EXCEPTION 'notifications.template: placeholder not declared on the allowlist' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.key <> OLD.key OR NEW.channel <> OLD.channel
       OR NEW.language <> OLD.language OR NEW.version <> OLD.version THEN
      RAISE EXCEPTION 'notifications.template: identity columns are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'draft' AND (NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body <> OLD.body OR NEW.variables <> OLD.variables) THEN
      RAISE EXCEPTION 'notifications.template: content is frozen after publication' USING ERRCODE = 'PS001';
    END IF;
    IF NOT ((OLD.status = NEW.status) OR (OLD.status = 'draft' AND NEW.status IN ('published', 'retired'))
            OR (OLD.status = 'published' AND NEW.status = 'retired')) THEN
      RAISE EXCEPTION 'notifications.template: illegal status transition' USING ERRCODE = 'PS001';
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'draft'
       AND (NEW.subject IS DISTINCT FROM OLD.subject OR NEW.body <> OLD.body OR NEW.variables <> OLD.variables) THEN
      NEW.render_check_passed_at := NULL;
    END IF;
  ELSIF NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'notifications.template: a version starts as draft' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION notifications.guard_template() FROM PUBLIC;
CREATE TRIGGER template_guard BEFORE INSERT OR UPDATE ON notifications.template
  FOR EACH ROW EXECUTE FUNCTION notifications.guard_template();
CREATE TRIGGER template_bump_row_version BEFORE UPDATE ON notifications.template
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
-- A published or retired version is never deleted (receipts and notifications name it).
CREATE FUNCTION notifications.refuse_delete() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION '%.%: rows are never deleted', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION notifications.refuse_delete() FROM PUBLIC;
CREATE TRIGGER template_no_delete BEFORE DELETE ON notifications.template
  FOR EACH ROW WHEN (OLD.status <> 'draft') EXECUTE FUNCTION notifications.refuse_delete();

-- notification (22.13). No message content and no address: the template (by key and version) and the allowlisted values
-- only. `dedupe_key` names a resource and a purpose and never the recipient (re-pointing must not collide).
CREATE TABLE notifications.notification (
  id                   uuid        PRIMARY KEY,
  organisation_id      uuid        NOT NULL,
  recipient_kind       text        NOT NULL CHECK (recipient_kind IN ('patient', 'principal')),
  patient_id           uuid,
  principal_id         uuid,
  template_key         text        NOT NULL CHECK (template_key ~ '^[a-z][a-z0-9_.]{0,80}$'),
  template_version     integer     NOT NULL CHECK (template_version >= 1),
  channel              text        NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
  language             text        CHECK (language IS NULL OR language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$'),
  variables            jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (notifications.values_ok(variables)),
  status               text        NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed', 'cancelled')),
  suppress_reason      text        CHECK (suppress_reason IS NULL OR suppress_reason IN
                         ('preference_off', 'no_address', 'no_recipient', 'no_template', 'not_permitted', 'patient_inactive')),
  error_class          text        CHECK (error_class IS NULL OR error_class ~ '^[a-z][a-z0-9_.]{0,60}$'),
  provider_message_id  text        CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 200),
  attempts             integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  send_after           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  dedupe_key           text        NOT NULL CHECK (char_length(dedupe_key) BETWEEN 3 AND 200
                         AND dedupe_key ~ '^[a-z][a-z0-9_]*(:[A-Za-z0-9_.-]+)+$'),
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  created_by_job       uuid,
  row_version          bigint      NOT NULL DEFAULT 1,
  updated_at           timestamptz,
  CONSTRAINT notification_dedupe_uq UNIQUE (organisation_id, dedupe_key),
  CONSTRAINT notification_recipient CHECK (
    (recipient_kind = 'patient' AND patient_id IS NOT NULL AND principal_id IS NULL)
    OR (recipient_kind = 'principal' AND principal_id IS NOT NULL AND patient_id IS NULL)),
  -- 22.13: never a recipient identifier inside the key.
  CONSTRAINT notification_dedupe_no_recipient CHECK (
    (patient_id IS NULL OR position(lower(patient_id::text) in lower(dedupe_key)) = 0)
    AND (principal_id IS NULL OR position(lower(principal_id::text) in lower(dedupe_key)) = 0)),
  CONSTRAINT notification_sent_at CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT notification_suppress_reason CHECK ((status = 'suppressed') = (suppress_reason IS NOT NULL))
);
COMMENT ON TABLE notifications.notification IS 'class=C2';
CREATE INDEX notification_patient ON notifications.notification (patient_id, created_at) WHERE patient_id IS NOT NULL;
CREATE INDEX notification_principal ON notifications.notification (principal_id, created_at) WHERE principal_id IS NOT NULL;
CREATE INDEX notification_due ON notifications.notification (status, send_after);
CREATE INDEX notification_dedupe_prefix ON notifications.notification (organisation_id, dedupe_key text_pattern_ops);

-- K states of 22.16 (`sent`, `suppressed`, `cancelled`) are immutable: the immutability trigger and the merge classification
-- are the same set. The remaining transitions are forward-only; the content columns never change after insert.
CREATE FUNCTION notifications.guard_notification() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status IN ('sent', 'suppressed', 'cancelled') THEN
    RAISE EXCEPTION 'notifications.notification: a % row is immutable', OLD.status USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.recipient_kind <> OLD.recipient_kind
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id OR NEW.template_key <> OLD.template_key
     OR NEW.template_version <> OLD.template_version OR NEW.channel <> OLD.channel OR NEW.variables <> OLD.variables
     OR NEW.dedupe_key <> OLD.dedupe_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'notifications.notification: content and identity columns are immutable' USING ERRCODE = 'PS001';
  END IF;
  -- patient_id changes only through the merge participant, and then only to a non-null value.
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id AND (NEW.patient_id IS NULL OR OLD.patient_id IS NULL) THEN
    RAISE EXCEPTION 'notifications.notification: recipient kind cannot change' USING ERRCODE = 'PS001';
  END IF;
  IF NOT ((OLD.status = NEW.status)
          OR (OLD.status = 'queued' AND NEW.status IN ('sending', 'sent', 'suppressed', 'cancelled', 'failed'))
          OR (OLD.status = 'sending' AND NEW.status IN ('queued', 'sent', 'failed', 'suppressed', 'cancelled'))
          OR (OLD.status = 'failed' AND NEW.status IN ('sending', 'sent', 'suppressed', 'cancelled'))) THEN
    RAISE EXCEPTION 'notifications.notification: illegal status transition' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION notifications.guard_notification() FROM PUBLIC;
CREATE TRIGGER notification_guard BEFORE UPDATE ON notifications.notification
  FOR EACH ROW EXECUTE FUNCTION notifications.guard_notification();
CREATE TRIGGER notification_bump_row_version BEFORE UPDATE ON notifications.notification
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER notification_no_delete BEFORE DELETE ON notifications.notification
  FOR EACH ROW EXECUTE FUNCTION notifications.refuse_delete();

-- Append-only guard for receipts and reads (22.13: new rows, never updates).
CREATE FUNCTION notifications.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION '%.%: append-only', TG_TABLE_SCHEMA, TG_TABLE_NAME USING ERRCODE = 'PS001';
END
$$;
REVOKE ALL ON FUNCTION notifications.refuse_change() FROM PUBLIC;

-- delivery_receipt: one row per vendor event, attached to the survivor's patient ID when the notification's patient was merged.
CREATE TABLE notifications.delivery_receipt (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  notification_id  uuid        NOT NULL REFERENCES notifications.notification (id) ON DELETE RESTRICT,
  patient_id       uuid,
  status           text        NOT NULL CHECK (status IN ('delivered', 'bounced', 'complaint', 'failed')),
  received_at      timestamptz NOT NULL,
  vendor_event_id  text        NOT NULL CHECK (char_length(vendor_event_id) BETWEEN 1 AND 200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_by_job   uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz,
  CONSTRAINT delivery_receipt_event_uq UNIQUE (organisation_id, notification_id, vendor_event_id)
);
COMMENT ON TABLE notifications.delivery_receipt IS 'class=C2';
CREATE INDEX delivery_receipt_notification ON notifications.delivery_receipt (notification_id);
CREATE INDEX delivery_receipt_patient ON notifications.delivery_receipt (patient_id) WHERE patient_id IS NOT NULL;
CREATE TRIGGER delivery_receipt_append_only BEFORE UPDATE OR DELETE ON notifications.delivery_receipt
  FOR EACH ROW EXECUTE FUNCTION notifications.refuse_change();

CREATE TABLE notifications.in_app_read (
  notification_id  uuid        PRIMARY KEY REFERENCES notifications.notification (id) ON DELETE RESTRICT,
  organisation_id  uuid        NOT NULL,
  patient_id       uuid        NOT NULL,
  read_at          timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_by_job   uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz
);
COMMENT ON TABLE notifications.in_app_read IS 'class=C2';
CREATE INDEX in_app_read_patient ON notifications.in_app_read (patient_id);
CREATE TRIGGER in_app_read_append_only BEFORE UPDATE OR DELETE ON notifications.in_app_read
  FOR EACH ROW EXECUTE FUNCTION notifications.refuse_change();

-- migration-class: expand
-- Staff alerts: staff_alert, staff_alert_event, staff_alert_setting and their database-side rules (ARCHITECTURE 22.13, 32,
-- ADR-009, ADR-022; ticket BE-07, migrations 1200-1299). RLS and grants: 1201.
--
-- An alert is a database row first and a push second (5.4). The row is written in the transaction that raises it; an AFTER
-- trigger runs `pg_notify('staff_alert', ...)` in that same transaction, so a rolled-back alert notifies nobody and a
-- committed alert always does, whichever code path wrote it. The payload carries IDs only (32.2 point 4).

CREATE TABLE notifications.staff_alert (
  id                    uuid        PRIMARY KEY,
  organisation_id       uuid        NOT NULL,
  type                  text        NOT NULL CHECK (type IN ('red_flag', 'btg_opened', 'privileged_change', 'kill_switch_used',
                          'audit_anchor_mismatch', 'scope_drift', 'note_unsigned', 'integration_down')),
  severity              text        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  patient_id            uuid,
  resource_type         text        NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_]{0,60}$'),
  resource_id           uuid        NOT NULL,
  location_id           uuid,
  target_kind           text        NOT NULL CHECK (target_kind IN ('principal', 'role_location', 'compliance_permission')),
  target_principal_ids  uuid[]      NOT NULL CHECK (cardinality(target_principal_ids) BETWEEN 1 AND 500),
  target_role_key       text        CHECK (target_role_key IS NULL OR target_role_key ~ '^[a-z][a-z0-9_]{0,60}$'),
  target_location_ids   uuid[],
  target_permission     text        CHECK (target_permission IS NULL OR target_permission ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*){1,3}$'),
  status                text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'escalated', 'closed')),
  acknowledged_by       uuid,
  acknowledged_at       timestamptz,
  escalation_level      smallint    NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 3),
  escalate_at           timestamptz,
  seq                   bigint      GENERATED ALWAYS AS IDENTITY,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  created_by_job        uuid,
  row_version           bigint      NOT NULL DEFAULT 1,
  updated_at            timestamptz,
  CONSTRAINT staff_alert_seq_uq UNIQUE (seq),
  -- ADR-022: alerts of the compliance and operations types are about a grant, a request or an anchor, never about a
  -- patient, so an admin sees them without PHI access. Only red_flag and note_unsigned name a patient.
  CONSTRAINT staff_alert_patient_rule CHECK (
       (type = 'red_flag' AND patient_id IS NOT NULL)
    OR (type = 'note_unsigned')
    OR (type NOT IN ('red_flag', 'note_unsigned') AND patient_id IS NULL)),
  CONSTRAINT staff_alert_target_shape CHECK (
       (target_kind = 'principal')
    OR (target_kind = 'role_location' AND target_role_key IS NOT NULL)
    OR (target_kind = 'compliance_permission' AND target_permission IS NOT NULL)),
  CONSTRAINT staff_alert_ack_pair CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL)),
  CONSTRAINT staff_alert_ack_status CHECK (status <> 'acknowledged' OR acknowledged_by IS NOT NULL),
  -- escalatesAt is set only while the alert is open (29.3): acknowledged, escalated and closed alerts have no timer.
  CONSTRAINT staff_alert_escalate_open_only CHECK (escalate_at IS NULL OR status = 'open'),
  CONSTRAINT staff_alert_level_status CHECK (status <> 'escalated' OR escalation_level >= 1)
);
COMMENT ON TABLE notifications.staff_alert IS 'class=C2 (admin-realm types: C1, patient_id always null)';
CREATE INDEX staff_alert_status_escalate ON notifications.staff_alert (status, escalate_at);
CREATE INDEX staff_alert_targets ON notifications.staff_alert USING gin (target_principal_ids);
CREATE INDEX staff_alert_patient ON notifications.staff_alert (patient_id) WHERE patient_id IS NOT NULL;

-- Immutable content, forward-only status, and the closed state is final (22.13: refuse_update_when_terminal('closed')).
-- Who may do what is decided by the policies and column grants of 1201; this function is the second line.
CREATE FUNCTION notifications.guard_staff_alert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'notifications.staff_alert: a closed alert is immutable' USING ERRCODE = 'PS001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.organisation_id <> OLD.organisation_id OR NEW.type <> OLD.type OR NEW.severity <> OLD.severity
     OR NEW.resource_type <> OLD.resource_type OR NEW.resource_id <> OLD.resource_id
     OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.target_kind <> OLD.target_kind
     OR NEW.target_role_key IS DISTINCT FROM OLD.target_role_key OR NEW.target_permission IS DISTINCT FROM OLD.target_permission
     OR NEW.seq <> OLD.seq OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'notifications.staff_alert: identity and content columns are immutable' USING ERRCODE = 'PS001';
  END IF;
  -- patient_id changes only through the merge participant, and only to another patient.
  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id AND (NEW.patient_id IS NULL OR OLD.patient_id IS NULL) THEN
    RAISE EXCEPTION 'notifications.staff_alert: the patient cannot be added or removed' USING ERRCODE = 'PS001';
  END IF;
  IF NOT (OLD.status = NEW.status
          OR (OLD.status = 'open' AND NEW.status IN ('acknowledged', 'escalated', 'closed'))
          OR (OLD.status = 'escalated' AND NEW.status IN ('acknowledged', 'closed'))
          OR (OLD.status = 'acknowledged' AND NEW.status = 'closed')) THEN
    RAISE EXCEPTION 'notifications.staff_alert: illegal status transition' USING ERRCODE = 'PS001';
  END IF;
  -- Acknowledgement is recorded once and never rewritten.
  IF OLD.acknowledged_by IS NOT NULL AND (NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by
                                          OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at) THEN
    RAISE EXCEPTION 'notifications.staff_alert: the acknowledgement is final' USING ERRCODE = 'PS001';
  END IF;
  -- The escalation level only goes up, and targets are only added (22.13: re-resolved at each escalation; a target that
  -- saw the alert keeps seeing it).
  IF NEW.escalation_level < OLD.escalation_level THEN
    RAISE EXCEPTION 'notifications.staff_alert: the escalation level cannot go down' USING ERRCODE = 'PS001';
  END IF;
  IF NOT (OLD.target_principal_ids <@ NEW.target_principal_ids) THEN
    RAISE EXCEPTION 'notifications.staff_alert: targets are only added' USING ERRCODE = 'PS001';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION notifications.guard_staff_alert() FROM PUBLIC;
CREATE TRIGGER staff_alert_guard BEFORE UPDATE ON notifications.staff_alert
  FOR EACH ROW EXECUTE FUNCTION notifications.guard_staff_alert();
CREATE TRIGGER staff_alert_bump_row_version BEFORE UPDATE ON notifications.staff_alert
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();
CREATE TRIGGER staff_alert_no_delete BEFORE DELETE ON notifications.staff_alert
  FOR EACH ROW EXECUTE FUNCTION notifications.refuse_delete();

-- pg_notify in the writing transaction (32.2 point 4). Payload: IDs only, below the 8,000-byte limit. More than 100
-- targets send `broadcast`: each instance then reads the alert under its own streams' scopes and learns who may see it.
--   kind 'alert'  : a new alert, or one whose level or targets changed (escalation)
--   kind 'closed' : acknowledged or closed, so the tray of every target drops it
CREATE FUNCTION notifications.notify_staff_alert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  kind text;
  payload jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    kind := 'alert';
  ELSIF NEW.status IN ('acknowledged', 'closed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    kind := 'closed';
  ELSIF NEW.status = 'escalated' OR NEW.target_principal_ids IS DISTINCT FROM OLD.target_principal_ids THEN
    kind := 'alert';
  ELSE
    RETURN NEW;
  END IF;
  payload := jsonb_build_object('alertId', NEW.id, 'seq', NEW.seq, 'kind', kind);
  IF cardinality(NEW.target_principal_ids) > 100 THEN
    payload := payload || jsonb_build_object('broadcast', true);
  ELSE
    payload := payload || jsonb_build_object('targets', to_jsonb(NEW.target_principal_ids));
  END IF;
  PERFORM pg_notify('staff_alert', payload::text);
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION notifications.notify_staff_alert() FROM PUBLIC;
CREATE TRIGGER staff_alert_notify_insert AFTER INSERT ON notifications.staff_alert
  FOR EACH ROW EXECUTE FUNCTION notifications.notify_staff_alert();
CREATE TRIGGER staff_alert_notify_update AFTER UPDATE ON notifications.staff_alert
  FOR EACH ROW EXECUTE FUNCTION notifications.notify_staff_alert();

-- staff_alert_event: append-only trail of every step (5.4: "the system records every step for audit").
CREATE TABLE notifications.staff_alert_event (
  id               uuid        PRIMARY KEY,
  organisation_id  uuid        NOT NULL,
  alert_id         uuid        NOT NULL REFERENCES notifications.staff_alert (id) ON DELETE RESTRICT,
  patient_id       uuid,
  kind             text        NOT NULL CHECK (kind IN ('created', 'delivered', 'acknowledged', 'escalated', 'closed')),
  principal_id     uuid,
  at               timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  created_by_job   uuid,
  row_version      bigint      NOT NULL DEFAULT 1,
  updated_at       timestamptz
);
COMMENT ON TABLE notifications.staff_alert_event IS 'class=C2';
CREATE INDEX staff_alert_event_alert ON notifications.staff_alert_event (alert_id, at);
-- One `created`, one `acknowledged`, one `escalated` and one `closed` event per alert, enforced here. Two targets
-- acknowledging at the same moment therefore produce exactly one `acknowledged` event (38.2 item 19); R1 schedules one
-- escalation per alert (32.4), so a repeated escalation job cannot add a second `escalated` event.
CREATE UNIQUE INDEX staff_alert_event_once ON notifications.staff_alert_event (alert_id, kind)
  WHERE kind IN ('created', 'acknowledged', 'escalated', 'closed');
CREATE TRIGGER staff_alert_event_append_only BEFORE UPDATE OR DELETE ON notifications.staff_alert_event
  FOR EACH ROW EXECUTE FUNCTION notifications.refuse_change();

-- staff_alert_setting: when an unacknowledged alert escalates, and to which duty role. No row for red_flag means no
-- escalation timer: the value is clinical (D-12a) and is set by the safety reviewer, never defaulted here.
CREATE TABLE notifications.staff_alert_setting (
  id                  uuid        PRIMARY KEY,
  organisation_id     uuid        NOT NULL,
  alert_type          text        NOT NULL CHECK (alert_type IN ('red_flag', 'btg_opened', 'privileged_change', 'kill_switch_used',
                        'audit_anchor_mismatch', 'scope_drift', 'note_unsigned', 'integration_down')),
  location_id         uuid,
  escalate_after_min  integer     NOT NULL CHECK (escalate_after_min BETWEEN 1 AND 10080),
  escalate_to_duty    text        NOT NULL CHECK (escalate_to_duty ~ '^[a-z][a-z0-9_]{0,60}$'),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  created_by_job      uuid,
  row_version         bigint      NOT NULL DEFAULT 1,
  updated_at          timestamptz,
  CONSTRAINT staff_alert_setting_uq UNIQUE NULLS NOT DISTINCT (organisation_id, alert_type, location_id)
);
COMMENT ON TABLE notifications.staff_alert_setting IS 'class=C1';
CREATE TRIGGER staff_alert_setting_bump_row_version BEFORE UPDATE ON notifications.staff_alert_setting
  FOR EACH ROW EXECUTE FUNCTION kernel.bump_row_version();

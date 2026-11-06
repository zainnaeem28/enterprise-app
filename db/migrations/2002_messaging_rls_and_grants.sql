-- migration-class: expand
-- FORCE ROW LEVEL SECURITY, role-targeted policies and least-privilege grants for the messaging tables (ARCHITECTURE 21.4, 22.12;
-- SHARED-BOUNDARIES 6.2, 6.3; ticket BE-19). Templates: T-STAFF (written out, the outer column qualified), T-PAT-OWN, T-PRINCIPAL, T-SYS.
-- Every policy names its roles (M-2).
--
-- A thread is seen by its participants and by its creator (who sees it before the first participant row exists, draft 7), and a
-- patient-linked thread only by staff in scope (or a break-the-glass grant) or by the patient it is about. WHO may be a participant is
-- the policy of thread_participant (22.12, TDR-12): the caller's own `owner` row for a thread the caller created, or any row of a thread
-- where the caller already owns; nobody can make themselves a participant of a thread they did not create. WHOM (an active principal
-- of the same organisation) is the trigger's business (2001). A task is seen by its creator, its assignee, and, for a role-at-location
-- task, by staff at that location (the ROLE is checked by the service: the scope settings carry no roles). There is no admin-realm
-- policy and no DELETE except the participant row. The worker reads (export, merge), re-points the patient of R rows, and creates
-- tasks for events (privacy corrections) under its job.

ALTER TABLE messaging.thread ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.thread FORCE  ROW LEVEL SECURITY;
ALTER TABLE messaging.thread_participant ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.thread_participant FORCE  ROW LEVEL SECURITY;
ALTER TABLE messaging.message ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.message FORCE  ROW LEVEL SECURITY;
ALTER TABLE messaging.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE messaging.task FORCE  ROW LEVEL SECURITY;
-- The policies of thread and thread_participant read each other (a thread is seen by its participants; a participant row is written by the
-- thread's creator or owner), and PostgreSQL refuses a policy cycle ("infinite recursion detected in policy"). The three predicates are
-- therefore functions that run as patient_scope_owner (SECURITY DEFINER, the NOLOGIN function-owner role that already owns this schema's merge guard) and read the two tables through the patient_scope_owner-only policies below; they take the
-- caller's principal and organisation from the scope settings, never from an argument, so they answer only "am I ...?" for the caller.
CREATE FUNCTION messaging.is_participant(p_thread uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT EXISTS (SELECT 1 FROM messaging.thread_participant p
                        WHERE p.thread_id = p_thread AND p.organisation_id = kernel.uuid1('app.org_id') AND p.principal_id = kernel.uuid1('app.principal_id')) $$;
CREATE FUNCTION messaging.is_owner(p_thread uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT EXISTS (SELECT 1 FROM messaging.thread_participant p
                        WHERE p.thread_id = p_thread AND p.organisation_id = kernel.uuid1('app.org_id') AND p.principal_id = kernel.uuid1('app.principal_id') AND p.role = 'owner') $$;
CREATE FUNCTION messaging.is_creator(p_thread uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $$ SELECT EXISTS (SELECT 1 FROM messaging.thread t
                        WHERE t.id = p_thread AND t.organisation_id = kernel.uuid1('app.org_id') AND t.created_by = kernel.uuid1('app.principal_id')) $$;
REVOKE ALL ON FUNCTION messaging.is_participant(uuid), messaging.is_owner(uuid), messaging.is_creator(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION messaging.is_participant(uuid), messaging.is_owner(uuid), messaging.is_creator(uuid) TO app_api, app_worker;
GRANT SELECT ON messaging.thread, messaging.thread_participant TO patient_scope_owner;
GRANT USAGE ON SCHEMA messaging TO patient_scope_owner;
-- The ownership moves to the function-owner role (the same step 2001 takes for the merge guard); its CREATE right is withdrawn again below.
GRANT CREATE ON SCHEMA messaging TO patient_scope_owner;
ALTER FUNCTION messaging.is_participant(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION messaging.is_owner(uuid) OWNER TO patient_scope_owner;
ALTER FUNCTION messaging.is_creator(uuid) OWNER TO patient_scope_owner;
REVOKE CREATE ON SCHEMA messaging FROM patient_scope_owner;
CREATE POLICY thread_definer_select ON messaging.thread FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient'));
CREATE POLICY participant_definer_select ON messaging.thread_participant FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient'));

-- messaging.thread: T-STAFF / T-PAT-OWN by participation, T-SYS
CREATE POLICY thread_staff_select ON messaging.thread
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (messaging.is_participant(thread.id) OR created_by = (SELECT kernel.uuid1('app.principal_id'))) AND (thread.patient_id IS NULL OR EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = thread.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR thread.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY thread_staff_insert ON messaging.thread
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND kind = 'staff' AND status = 'open' AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND (thread.patient_id IS NULL OR EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = thread.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR thread.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY thread_staff_update ON messaging.thread
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (messaging.is_participant(thread.id) OR created_by = (SELECT kernel.uuid1('app.principal_id'))) AND (thread.patient_id IS NULL OR EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = thread.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR thread.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))) AND messaging.is_owner(thread.id))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (thread.patient_id IS NULL OR EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = thread.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR thread.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY thread_patient_select ON messaging.thread
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND kind = 'patient' AND thread.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT thread.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND (messaging.is_participant(thread.id) OR created_by = (SELECT kernel.uuid1('app.principal_id'))));
CREATE POLICY thread_patient_insert ON messaging.thread
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND kind = 'patient' AND status = 'open' AND thread.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT thread.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND created_by = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY thread_patient_update ON messaging.thread
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND kind = 'patient' AND thread.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT thread.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')) AND (messaging.is_participant(thread.id) OR created_by = (SELECT kernel.uuid1('app.principal_id'))) AND messaging.is_owner(thread.id))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND kind = 'patient' AND thread.patient_id = ANY (kernel.uuids('app.patient_ids')) AND NOT thread.patient_id = ANY (kernel.uuids('app.proxy_patient_ids')));
CREATE POLICY thread_system_select ON messaging.thread
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND thread.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY thread_system_update ON messaging.thread
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND thread.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND thread.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- messaging.thread_participant: T-PRINCIPAL (read, read mark); insert and delete as 22.12 (a) or (b); T-SYS read
CREATE POLICY participant_principal_select ON messaging.thread_participant
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient') AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY participant_principal_update ON messaging.thread_participant
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient') AND principal_id = (SELECT kernel.uuid1('app.principal_id')))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient') AND principal_id = (SELECT kernel.uuid1('app.principal_id')));
CREATE POLICY participant_owner_insert ON messaging.thread_participant
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient') AND ((principal_id = (SELECT kernel.uuid1('app.principal_id')) AND role = 'owner' AND messaging.is_creator(thread_participant.thread_id)) OR messaging.is_owner(thread_participant.thread_id)));
CREATE POLICY participant_owner_delete ON messaging.thread_participant
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient') AND ((principal_id = (SELECT kernel.uuid1('app.principal_id')) AND role = 'owner' AND messaging.is_creator(thread_participant.thread_id)) OR messaging.is_owner(thread_participant.thread_id)));
CREATE POLICY participant_system_select ON messaging.thread_participant
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = thread_participant.thread_id));
-- messaging.message: as its thread (the thread's own policy applies inside the EXISTS); append-only, so no UPDATE or DELETE policy exists
CREATE POLICY message_staff_select ON messaging.message
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = message.thread_id));
CREATE POLICY message_staff_insert ON messaging.message
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND author_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND messaging.is_participant(message.thread_id));
CREATE POLICY message_patient_select ON messaging.message
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = message.thread_id));
CREATE POLICY message_patient_insert ON messaging.message
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'patient' AND author_principal_id = (SELECT kernel.uuid1('app.principal_id')) AND messaging.is_participant(message.thread_id));
CREATE POLICY message_system_select ON messaging.message
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND message.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
-- messaging.task: T-STAFF by assignee or creator, T-SYS (read, re-point, create for an event)
CREATE POLICY task_staff_select ON messaging.task
  FOR SELECT TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (assignee_principal_id = (SELECT kernel.uuid1('app.principal_id')) OR created_by = (SELECT kernel.uuid1('app.principal_id')) OR (assignee_kind = 'role_location' AND assignee_location_id = ANY (kernel.uuids('app.location_ids')))) AND (task.patient_id IS NULL OR EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = task.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR task.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY task_staff_insert ON messaging.task
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND source = 'manual' AND status = 'open' AND created_by = (SELECT kernel.uuid1('app.principal_id')) AND (task.patient_id IS NULL OR EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = task.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR task.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY task_staff_update ON messaging.task
  FOR UPDATE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (assignee_principal_id = (SELECT kernel.uuid1('app.principal_id')) OR created_by = (SELECT kernel.uuid1('app.principal_id')) OR (assignee_kind = 'role_location' AND assignee_location_id = ANY (kernel.uuids('app.location_ids')))) AND (task.patient_id IS NULL OR EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = task.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR task.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) = 'staff' AND (SELECT kernel.setting('app.realm')) = 'google' AND (task.patient_id IS NULL OR EXISTS (SELECT 1 FROM patient.staff_scope s WHERE s.patient_id = task.patient_id AND s.location_id = ANY (kernel.uuids('app.location_ids'))) OR task.patient_id = ANY (kernel.uuids('app.btg_patient_ids'))));
CREATE POLICY task_system_select ON messaging.task
  FOR SELECT TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND task.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY task_system_update ON messaging.task
  FOR UPDATE TO app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND task.patient_id = ANY (kernel.uuids('app.job_patient_ids')))))
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND ((SELECT kernel.setting('app.job_scope')) = 'org' OR ((SELECT kernel.setting('app.job_scope')) = 'patients' AND task.patient_id = ANY (kernel.uuids('app.job_patient_ids')))));
CREATE POLICY task_system_insert ON messaging.task
  FOR INSERT TO app_worker
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system' AND (SELECT kernel.setting('app.job_scope')) = 'patients' AND task.patient_id = ANY (kernel.uuids('app.job_patient_ids')) AND source = 'privacy_correction' AND status = 'open' AND created_by IS NULL);

-- Grants -------------------------------------------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA messaging FROM PUBLIC;

GRANT SELECT ON messaging.thread, messaging.thread_participant, messaging.message, messaging.task TO app_api, app_worker;

-- app_api: a thread and its close; participants (insert and delete as the policy allows), the read mark; a message; a task, its edit and completion.
GRANT INSERT (id, organisation_id, kind, patient_id, subject, status, location_id, created_by) ON messaging.thread TO app_api;
GRANT UPDATE (status) ON messaging.thread TO app_api;
GRANT INSERT (thread_id, principal_id, organisation_id, role, added_by) ON messaging.thread_participant TO app_api;
GRANT UPDATE (last_read_at) ON messaging.thread_participant TO app_api;
GRANT DELETE ON messaging.thread_participant TO app_api;
GRANT INSERT (id, organisation_id, thread_id, patient_id, author_principal_id, body, attachment_document_ids) ON messaging.message TO app_api;
GRANT INSERT (id, organisation_id, patient_id, title, detail, assignee_kind, assignee_principal_id, assignee_role_key, assignee_location_id, due_at, source, created_by)
  ON messaging.task TO app_api;
GRANT UPDATE (status, completed_at, completed_by, title, detail, due_at) ON messaging.task TO app_api;

-- app_worker: the merge participant (a patients-scope system job, the job's exact IDs) and the tasks events create.
GRANT UPDATE (patient_id) ON messaging.thread, messaging.task TO app_worker;
GRANT INSERT (id, organisation_id, patient_id, title, detail, assignee_kind, assignee_principal_id, assignee_role_key, assignee_location_id, due_at, source, source_ref, created_by_job)
  ON messaging.task TO app_worker;

-- migration-class: expand
-- INT03-F03 Part B (HEAAA-334), amendment A-4: HEAAA-332 decision-log rev bf854c3a-fb72-4912-8c87-8c017b867d9c, HEAAA-310 ruling rev d9504db5-1908-43fb-8226-82f8b923fddf section 3 B1.
-- messaging.is_participant(uuid) and messaging.is_owner(uuid) stay as accepted SECURITY DEFINER functions (2002). messaging.is_creator(uuid) is
-- refused: the two policies that used it return to the invoker EXISTS on messaging.thread that ARCHITECTURE 22.12 (a) approved. 2204 drops the function.
--
-- Intended behaviour (Cybersecurity Q4, HEAAA-333 comment 5f4974c6): the creator's EXISTS runs under the thread's own SELECT policy, which is_creator skipped.
-- A creator who has lost staff_scope to the thread's patient (and has no break-the-glass grant), a creator whose realm is not `google`, and a
-- patient-audience creator who is a proxy for the patient are therefore REFUSED when adding their own owner row. This is the behaviour 22.12 (a)
-- already required; it is not a regression. The creator of a thread still sees it without being a participant (created_by in thread_staff_select /
-- thread_patient_select): unchanged.
--
-- Privilege narrowing: patient_scope_owner (owner of the two definers) loses every right on messaging.thread (including the policy that let it read each
-- thread's subject) and keeps SELECT on the four columns of thread_participant that the definers read. participant_definer_select is narrowed to the
-- caller's own rows (Cybersecurity C-1): the owner role can no longer read the organisation's membership graph. USAGE on schema messaging stays.
-- No GRANT OPTION anywhere (C-2). Any later change to either function body reopens A-4 and the Cybersecurity input (C-4).

DROP POLICY participant_owner_insert ON messaging.thread_participant;
CREATE POLICY participant_owner_insert ON messaging.thread_participant
  FOR INSERT TO app_api
  WITH CHECK (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient') AND ((principal_id = (SELECT kernel.uuid1('app.principal_id')) AND role = 'owner' AND EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = thread_participant.thread_id AND t.created_by = (SELECT kernel.uuid1('app.principal_id')))) OR messaging.is_owner(thread_participant.thread_id)));
DROP POLICY participant_owner_delete ON messaging.thread_participant;
CREATE POLICY participant_owner_delete ON messaging.thread_participant
  FOR DELETE TO app_api
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient') AND ((principal_id = (SELECT kernel.uuid1('app.principal_id')) AND role = 'owner' AND EXISTS (SELECT 1 FROM messaging.thread t WHERE t.id = thread_participant.thread_id AND t.created_by = (SELECT kernel.uuid1('app.principal_id')))) OR messaging.is_owner(thread_participant.thread_id)));

DROP POLICY thread_definer_select ON messaging.thread;
REVOKE SELECT ON messaging.thread FROM patient_scope_owner;
REVOKE SELECT ON messaging.thread_participant FROM patient_scope_owner;
GRANT SELECT (thread_id, organisation_id, principal_id, role) ON messaging.thread_participant TO patient_scope_owner;

DROP POLICY participant_definer_select ON messaging.thread_participant;
CREATE POLICY participant_definer_select ON messaging.thread_participant FOR SELECT TO patient_scope_owner
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id')) AND principal_id = (SELECT kernel.uuid1('app.principal_id')) AND (SELECT kernel.setting('app.audience')) IN ('staff', 'patient'));

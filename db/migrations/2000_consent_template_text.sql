-- migration-class: expand
-- HEAAA-296 D3: consent wording on the template, the signed language on the consent row. Constraints are added NOT VALID here and
-- validated in 2001 (DEVOPS-PLAN 5.2). No DEFAULT anywhere: a missing language or wording is never invented.

-- D3a: template wording and the patient read
ALTER TABLE organisation.consent_template
  ADD COLUMN title     text,
  ADD COLUMN body_text text;
ALTER TABLE organisation.consent_template ALTER COLUMN body_document_id DROP NOT NULL;
ALTER TABLE organisation.consent_template ADD CONSTRAINT consent_template_title_len
  CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 200) NOT VALID;
ALTER TABLE organisation.consent_template ADD CONSTRAINT consent_template_body_text_len
  CHECK (body_text IS NULL OR char_length(body_text) BETWEEN 1 AND 20000) NOT VALID;
ALTER TABLE organisation.consent_template ADD CONSTRAINT consent_template_published_has_text
  CHECK (status <> 'published' OR num_nulls(title, body_text) = 0) NOT VALID;

-- HEAAA296-S-F02: the patient audience reads published wording only (never draft or retired text).
DROP POLICY consent_template_read ON organisation.consent_template;
CREATE POLICY consent_template_read ON organisation.consent_template
  FOR SELECT TO app_api, app_worker
  USING (organisation_id = (SELECT kernel.uuid1('app.org_id'))
     AND (   (SELECT kernel.setting('app.audience')) IN ('staff', 'partner')
          OR ((SELECT kernel.setting('app.audience')) = 'patient' AND status = 'published')
          OR (current_user = 'app_worker' AND (SELECT kernel.setting('app.audience')) = 'system')));

-- D3b: signed language (HEAAA296-S-F01, option (a))
ALTER TABLE patient.consent ADD COLUMN template_language text;
ALTER TABLE patient.consent ADD CONSTRAINT consent_template_language_len
  CHECK (template_language IS NULL OR char_length(template_language) BETWEEN 2 AND 35) NOT VALID;
ALTER TABLE patient.consent ADD CONSTRAINT consent_template_language_present
  CHECK (num_nulls(template_language) = 0) NOT VALID;

-- HEAAA296-A-F09: app_api inserts with column-level grants (0702 line 424). No UPDATE grant: the language never changes.
GRANT INSERT (template_language) ON patient.consent TO app_api;

-- HEAAA296-A-F10: the existing guard (0801 lines 58-96) also pins template_language. The body is 0801's, verbatim, with one
-- added condition; trigger consent_guard (0701 line 133) is unchanged.
CREATE OR REPLACE FUNCTION patient.guard_consent() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_repoint boolean := NEW.patient_id IS DISTINCT FROM OLD.patient_id
    AND kernel.setting('app.audience') = 'system' AND kernel.setting('app.job_scope') = 'patients'
    AND OLD.patient_id = ANY (kernel.uuids('app.job_patient_ids')) AND NEW.patient_id = ANY (kernel.uuids('app.job_patient_ids'));
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organisation_id IS DISTINCT FROM OLD.organisation_id
     OR (NEW.patient_id IS DISTINCT FROM OLD.patient_id AND NOT v_repoint) OR NEW.template_key IS DISTINCT FROM OLD.template_key
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.template_language IS DISTINCT FROM OLD.template_language THEN
    RAISE EXCEPTION 'a consent keeps its patient and template version' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status IN ('superseded', 'withdrawn') THEN
    RAISE EXCEPTION 'a % consent accepts no change', OLD.status USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'signed', 'withdrawn') THEN
    RAISE EXCEPTION 'illegal consent transition' USING ERRCODE = 'PS001';
  END IF;
  IF OLD.status = 'signed' THEN
    IF NEW.status NOT IN ('signed', 'superseded', 'withdrawn') THEN
      RAISE EXCEPTION 'illegal consent transition' USING ERRCODE = 'PS001';
    END IF;
    IF NEW.signed_at IS DISTINCT FROM OLD.signed_at OR NEW.signer_principal_id IS DISTINCT FROM OLD.signer_principal_id
       OR NEW.signer_relationship IS DISTINCT FROM OLD.signer_relationship OR NEW.signed_name IS DISTINCT FROM OLD.signed_name
       OR NEW.signature_document_id IS DISTINCT FROM OLD.signature_document_id THEN
      RAISE EXCEPTION 'a signed consent keeps its signature' USING ERRCODE = 'PS001';
    END IF;
  END IF;
  IF OLD.status = 'pending' AND NEW.status = 'signed' THEN
    NEW.signed_at := now();
  END IF;
  IF NEW.status = 'withdrawn' AND OLD.status <> 'withdrawn' THEN
    NEW.withdrawn_at := now();
  END IF;
  RETURN NEW;
END
$$;

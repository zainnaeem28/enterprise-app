-- migration-class: expand
-- HEAAA-296 D3: validate the constraints added NOT VALID in 2000. Own file, own transaction: VALIDATE takes SHARE UPDATE EXCLUSIVE.
ALTER TABLE organisation.consent_template VALIDATE CONSTRAINT consent_template_title_len;
ALTER TABLE organisation.consent_template VALIDATE CONSTRAINT consent_template_body_text_len;
ALTER TABLE organisation.consent_template VALIDATE CONSTRAINT consent_template_published_has_text;
ALTER TABLE patient.consent VALIDATE CONSTRAINT consent_template_language_len;
ALTER TABLE patient.consent VALIDATE CONSTRAINT consent_template_language_present;

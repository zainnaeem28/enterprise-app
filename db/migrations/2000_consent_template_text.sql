-- migration-class: expand
-- Consent template wording (HEAAA-296 decision D3, ticket HEAAA-300).
-- A consent template had nowhere to keep its human-readable title and wording (body_document_id has no foreign key and
-- documents.document is per patient, so an organisation-wide text cannot be a document row). The title and the plain text now live on
-- the template row. The table stays class C1 (organisation wording, no PHI). organisation.guard_template_version compares the whole
-- row (to_jsonb), so a published version is immutable for the new columns as well.
-- body_document_id is kept, nullable and unused in R1: nothing is dropped. Safe to constrain now: no template row exists yet
-- (no seeds, and the admin create route is not implemented).

ALTER TABLE organisation.consent_template
  ADD COLUMN title text CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 200);
ALTER TABLE organisation.consent_template
  ADD COLUMN body_text text CHECK (body_text IS NULL OR char_length(body_text) BETWEEN 1 AND 20000);
ALTER TABLE organisation.consent_template
  ALTER COLUMN body_document_id DROP NOT NULL;
-- NOT VALID, then validated: the migration lint asks for it. num_nonnulls(title, body_text) = 2 is "both are set".
ALTER TABLE organisation.consent_template
  ADD CONSTRAINT consent_template_published_has_text
    CHECK (status <> 'published' OR num_nonnulls(title, body_text) = 2) NOT VALID;
ALTER TABLE organisation.consent_template
  VALIDATE CONSTRAINT consent_template_published_has_text;

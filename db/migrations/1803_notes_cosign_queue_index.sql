-- migration-class: expand
-- transaction: none
-- The co-sign queue of GET /clinicians/{id}/cosign-queue (decision HEAAA-286, ARCHITECTURE 22.11 draft 8.3): pending notes by the
-- supervisor they wait for, oldest first. Additive; DDL only (SBR-17). CONCURRENTLY: the table exists (DEVOPS-PLAN 8.1 rule 1).
CREATE INDEX CONCURRENTLY note_cosign_queue_idx ON clinical.note (cosign_required_from, submitted_for_cosign_at, id) WHERE status = 'pending_cosign';

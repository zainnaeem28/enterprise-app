import type { Tx } from '@ehr/kernel';

/** Whether `(key, version, language)` is a published consent template; a version published in one language says nothing about another. */
export async function isConsentTemplatePublished(
  tx: Tx,
  key: string,
  version: number,
  language: string,
): Promise<boolean> {
  return (
    (
      await tx.query(
        `SELECT 1 FROM organisation.consent_template WHERE key = $1 AND version = $2 AND language = $3 AND status = 'published' LIMIT 1`,
        [key, version, language],
      )
    ).rows.length > 0
  );
}

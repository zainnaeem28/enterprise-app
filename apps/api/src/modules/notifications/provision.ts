// Boot-time provisioning of the R1 notification templates (RA-R1-05): the production counterpart of the task-type sync (21.8).
// Without a published `waitlist_offer` (or confirmation, reschedule, cancel ...) template, `send()` refuses with
// `kernel.validation_failed` and the job that sent it retries for ever (INT02-R10-B1). Idempotent and additive: a key that
// already has a published version is left alone (an administrator's edits are never overwritten); a key with none gets one
// version of every channel and language, render-checked and published in one transaction. Concurrent starts serialise on an
// advisory lock. Runs in the admin realm because that is the only realm the template policies let write (0601).
import type { KernelDb, ScopeSettings } from '@ehr/kernel';
import { R1_TEMPLATE_KEYS, r1TemplatesForLanguages } from './r1-templates.js';
import { TemplateService } from './templates.js';

export interface ProvisionResult {
  /** Keys published by this call. */
  provisioned: string[];
  /** Keys that already had a published version. */
  present: string[];
}

export async function provisionR1Templates(
  db: KernelDb,
  orgId: string,
  languages: readonly string[] = ['en'],
): Promise<ProvisionResult> {
  const scope: ScopeSettings = {
    audience: 'staff',
    realm: 'admin_pool',
    orgId,
    phiAccess: 'limited',
  };
  const templates = new TemplateService({ configuredLanguages: () => Promise.resolve(languages) });
  const rows = r1TemplatesForLanguages(languages);
  return db.withScope(scope, async (tx) => {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext('notifications.provision_r1_templates'))`,
    );
    const out: ProvisionResult = { provisioned: [], present: [] };
    for (const key of R1_TEMPLATE_KEYS) {
      const have = await tx.query(
        `SELECT 1 FROM notifications.template WHERE key = $1 AND status = 'published' LIMIT 1`,
        [key],
      );
      if (have.rows.length > 0) {
        out.present.push(key);
        continue;
      }
      let first: string | undefined;
      let version: number | undefined;
      for (const r of rows.filter((x) => x.key === key)) {
        const t = await templates.createDraft(tx, {
          ...r,
          ...(version === undefined ? {} : { version }),
        });
        version = t.version;
        first ??= t.id;
      }
      if (first === undefined) continue;
      await templates.renderCheck(tx, first);
      await templates.publish(tx, first);
      out.provisioned.push(key);
    }
    return out;
  });
}

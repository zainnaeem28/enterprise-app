// Template management (ARCHITECTURE 22.13, 29.4 `/admin/message-templates`; RA-R1-05; SHARED-BOUNDARIES 8.3).
//   * A template binds only allowlisted non-clinical variables. A declaration or a `{{placeholder}}` outside the allowlist
//     is refused on save (422 notifications.render_check_failed, rule `variable_not_allowed` / `placeholder_not_declared`),
//     and the database refuses it again (0600 `guard_template`, CHECK on `variables`).
//   * A VERSION is a set of rows: one per (channel, language). The render check renders every row, for every configured
//     language and channel (email, SMS, push, in-app, .ics), with representative allowlisted values and scans the static text
//     and the output for condition-revealing text. A version is published only after the check passed, and the publish
//     re-runs it. Published content is frozen (trigger); a new version replaces it.
//   * The route guard (permission `notifications.template.manage`, admin realm, elevation) is the caller's: these methods
//     assume it passed. Row-level security limits writes to the admin realm.
import type { Tx } from '@ehr/kernel';
import type { AuditService } from '../audit/index.js';
import {
  SAMPLE_VALUES,
  VARIABLE_ALLOWLIST,
  isAllowedVariable,
  type DeclaredVariable,
} from './allowlist.js';
import {
  NotificationsNotFoundError,
  NotificationsValidationError,
  RenderCheckFailedError,
  type RenderFailure,
} from './errors.js';
import { findForbidden } from './forbidden.js';
import { isUuid, uuidv7 } from './ids.js';
import { CHANNEL_LIMITS, RenderError, renderTemplate, type Channel } from './render.js';

type Row = Record<string, unknown>;

export const TEMPLATE_CHANNELS: readonly Channel[] = ['email', 'sms', 'push', 'in_app', 'ics'];
const KEY = /^[a-z][a-z0-9_.]{0,80}$/;
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/;
const PLACEHOLDER = /\{\{ ?([a-z][a-z0-9_]{0,40}) ?\}\}/g;

export interface TemplateView {
  id: string;
  key: string;
  channel: Channel;
  language: string;
  version: number;
  subject: string | null;
  body: string;
  variables: DeclaredVariable[];
  status: 'draft' | 'published' | 'retired';
  renderCheckPassedAt: Date | null;
  publishedAt: Date | null;
}

export interface NewTemplate {
  key: string;
  channel: Channel;
  language: string;
  /** Omit to start the next version of the key; give the number to add a row to an existing draft version. */
  version?: number;
  subject?: string | null;
  body: string;
  variables: readonly DeclaredVariable[];
}

export interface TemplateDeps {
  /** The deployment's configured languages (organisation settings). Every channel of a version needs all of them. */
  configuredLanguages: (tx: Tx) => Promise<readonly string[]>;
  /** Deployment terms that must not appear in a template either (internal service names, clinician display names). */
  forbiddenTerms?: (tx: Tx) => Promise<readonly string[]>;
  audit?: AuditService;
}

export interface RequestContext {
  requestId: string;
}

const view = (r: Row): TemplateView => ({
  id: String(r['id']),
  key: String(r['key']),
  channel: String(r['channel']) as Channel,
  language: String(r['language']),
  version: Number(r['version']),
  subject: (r['subject'] as string | null) ?? null,
  body: String(r['body']),
  variables: r['variables'] as DeclaredVariable[],
  status: String(r['status']) as TemplateView['status'],
  renderCheckPassedAt: (r['render_check_passed_at'] as Date | null) ?? null,
  publishedAt: (r['published_at'] as Date | null) ?? null,
});

/** The structural rules of "cannot be saved": declared pairs on the allowlist, placeholders declared. */
export function structuralFailures(t: {
  subject?: string | null;
  body: string;
  variables: readonly DeclaredVariable[];
}): RenderFailure[] {
  const out: RenderFailure[] = [];
  const names = new Set<string>();
  for (const v of t.variables) {
    if (
      typeof v?.name !== 'string' ||
      typeof v?.type !== 'string' ||
      !isAllowedVariable(v.name, v.type)
    )
      out.push({ rule: 'variable_not_allowed' });
    else if (names.has(v.name)) out.push({ rule: 'variable_duplicate' });
    else names.add(v.name);
  }
  const stripped = (s: string): string => s.replace(PLACEHOLDER, '');
  for (const text of [t.subject ?? '', t.body]) {
    if (/\{\{|\}\}/.test(stripped(text))) out.push({ rule: 'placeholder_malformed' });
    for (const m of text.matchAll(PLACEHOLDER)) {
      const name = m[1] as string;
      if (!Object.prototype.hasOwnProperty.call(VARIABLE_ALLOWLIST, name))
        out.push({ rule: 'variable_not_allowed' });
      else if (!names.has(name)) out.push({ rule: 'placeholder_not_declared' });
    }
  }
  return dedupe(out);
}

function dedupe(f: RenderFailure[]): RenderFailure[] {
  const seen = new Set<string>();
  return f.filter((x) => {
    const k = `${x.rule}|${x.channel ?? ''}|${x.language ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export class TemplateService {
  constructor(private readonly d: TemplateDeps) {}

  async createDraft(tx: Tx, input: NewTemplate, ctx?: RequestContext): Promise<TemplateView> {
    const bad: string[] = [];
    if (!KEY.test(input.key)) bad.push('key');
    if (!TEMPLATE_CHANNELS.includes(input.channel)) bad.push('channel');
    if (!LANG.test(input.language)) bad.push('language');
    if (typeof input.body !== 'string' || input.body.length < 1 || input.body.length > 20000)
      bad.push('body');
    if (
      input.channel === 'email' &&
      (typeof input.subject !== 'string' || input.subject.length < 1 || input.subject.length > 200)
    )
      bad.push('subject');
    if (input.channel !== 'email' && input.subject !== undefined && input.subject !== null)
      bad.push('subject');
    if (input.version !== undefined && (!Number.isInteger(input.version) || input.version < 1))
      bad.push('version');
    if (!Array.isArray(input.variables)) bad.push('variables');
    if (bad.length > 0) throw new NotificationsValidationError(bad);
    const failures = structuralFailures(input);
    if (failures.length > 0) throw new RenderCheckFailedError(failures);

    let version = input.version;
    if (version === undefined) {
      const r = await tx.query(
        `SELECT coalesce(max(version), 0) + 1 AS v FROM notifications.template WHERE key = $1`,
        [input.key],
      );
      version = Number(r.rows[0]?.['v'] ?? 1);
    } else {
      const r = await tx.query(
        `SELECT status FROM notifications.template WHERE key = $1 AND version = $2 LIMIT 1`,
        [input.key, version],
      );
      if (r.rows[0] !== undefined && r.rows[0]['status'] !== 'draft')
        throw new NotificationsValidationError(['version']);
    }
    const id = uuidv7();
    const orgId = tx.scope.orgId;
    await tx.query(
      `INSERT INTO notifications.template (id, organisation_id, key, channel, language, version, subject, body, variables, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'draft', $10)`,
      [
        id,
        orgId,
        input.key,
        input.channel,
        input.language,
        version,
        input.subject ?? null,
        input.body,
        JSON.stringify(input.variables),
        tx.scope.principalId ?? null,
      ],
    );
    await this.audit(
      tx,
      id,
      {
        key: input.key,
        channel: input.channel,
        language: input.language,
        version,
        status: 'draft',
      },
      ctx,
    );
    return this.get(tx, id);
  }

  /** Edits a DRAFT row. Any content change clears its render check (trigger). */
  async updateDraft(
    tx: Tx,
    id: string,
    patch: { subject?: string | null; body?: string; variables?: readonly DeclaredVariable[] },
    ctx?: RequestContext,
  ): Promise<TemplateView> {
    if (!isUuid(id)) throw new NotificationsNotFoundError();
    const cur = await this.get(tx, id);
    if (cur.status !== 'draft') throw new NotificationsValidationError(['status']);
    const next = {
      subject: patch.subject === undefined ? cur.subject : patch.subject,
      body: patch.body ?? cur.body,
      variables: patch.variables ?? cur.variables,
    };
    const failures = structuralFailures(next);
    if (failures.length > 0) throw new RenderCheckFailedError(failures);
    await tx.query(
      `UPDATE notifications.template SET subject = $2, body = $3, variables = $4::jsonb WHERE id = $1`,
      [id, next.subject, next.body, JSON.stringify(next.variables)],
    );
    await this.audit(
      tx,
      id,
      { key: cur.key, version: cur.version, status: 'draft', edited: true },
      ctx,
    );
    return this.get(tx, id);
  }

  async get(tx: Tx, id: string): Promise<TemplateView> {
    if (!isUuid(id)) throw new NotificationsNotFoundError();
    const r = await tx.query(`SELECT * FROM notifications.template WHERE id = $1::uuid`, [id]);
    if (r.rows[0] === undefined) throw new NotificationsNotFoundError();
    return view(r.rows[0]);
  }

  async list(tx: Tx, filter: { key?: string; status?: string } = {}): Promise<TemplateView[]> {
    const r = await tx.query(
      `SELECT * FROM notifications.template
        WHERE ($1::text IS NULL OR key = $1) AND ($2::text IS NULL OR status = $2)
        ORDER BY key, version DESC, channel, language LIMIT 500`,
      [filter.key ?? null, filter.status ?? null],
    );
    return r.rows.map(view);
  }

  private async versionRows(
    tx: Tx,
    key: string,
    version: number,
    lock: boolean,
  ): Promise<TemplateView[]> {
    const r = await tx.query(
      `SELECT * FROM notifications.template WHERE key = $1 AND version = $2 ORDER BY id ${lock ? 'FOR UPDATE' : ''}`,
      [key, version],
    );
    return r.rows.map(view);
  }

  /** Pure check of one version's rows: every rule, every channel, every configured language. */
  async evaluate(tx: Tx, rows: readonly TemplateView[]): Promise<RenderFailure[]> {
    const languages = await this.d.configuredLanguages(tx);
    const extra = (await this.d.forbiddenTerms?.(tx)) ?? [];
    return evaluateVersion(rows, languages, extra);
  }

  /** `POST /admin/message-templates/{id}/render-check` (id of any row of the version). Marks the version's rows as checked. */
  async renderCheck(
    tx: Tx,
    id: string,
    ctx?: RequestContext,
  ): Promise<{ key: string; version: number; rows: number }> {
    const one = await this.get(tx, id);
    const rows = await this.versionRows(tx, one.key, one.version, true);
    if (rows.some((r) => r.status !== 'draft')) throw new NotificationsValidationError(['status']);
    const failures = await this.evaluate(tx, rows);
    if (failures.length > 0) throw new RenderCheckFailedError(failures);
    await tx.query(
      `UPDATE notifications.template SET render_check_passed_at = now() WHERE key = $1 AND version = $2 AND status = 'draft'`,
      [one.key, one.version],
    );
    await this.audit(tx, id, { key: one.key, version: one.version, renderCheck: 'passed' }, ctx);
    return { key: one.key, version: one.version, rows: rows.length };
  }

  /** `POST /admin/message-templates/{id}/publish`. Publishes the whole version and retires the key's earlier published ones. */
  async publish(
    tx: Tx,
    id: string,
    ctx?: RequestContext,
  ): Promise<{ key: string; version: number; rows: number }> {
    const one = await this.get(tx, id);
    const rows = await this.versionRows(tx, one.key, one.version, true);
    if (rows.some((r) => r.status !== 'draft')) throw new NotificationsValidationError(['status']);
    if (rows.some((r) => r.renderCheckPassedAt === null))
      throw new RenderCheckFailedError([{ rule: 'render_check_not_run' }]);
    const failures = await this.evaluate(tx, rows); // the languages or deployment terms may have changed since the check
    if (failures.length > 0) throw new RenderCheckFailedError(failures);
    await tx.query(
      `UPDATE notifications.template SET status = 'retired' WHERE key = $1 AND status = 'published' AND version <> $2`,
      [one.key, one.version],
    );
    await tx.query(
      `UPDATE notifications.template SET status = 'published', published_at = now() WHERE key = $1 AND version = $2 AND status = 'draft'`,
      [one.key, one.version],
    );
    await this.audit(tx, id, { key: one.key, version: one.version, status: 'published' }, ctx);
    return { key: one.key, version: one.version, rows: rows.length };
  }

  private async audit(
    tx: Tx,
    id: string,
    change: Record<string, unknown>,
    ctx?: RequestContext,
  ): Promise<void> {
    if (this.d.audit === undefined || ctx === undefined) return;
    await this.d.audit.record(tx, {
      action: 'config_change',
      requestId: ctx.requestId,
      resourceType: 'notifications.template',
      resourceId: id,
      change,
    });
  }
}

/** RA-R1-05 as a function: used by the service and by the render-every-template test. */
export function evaluateVersion(
  rows: readonly TemplateView[],
  languages: readonly string[],
  forbiddenExtra: readonly string[] = [],
): RenderFailure[] {
  const failures: RenderFailure[] = [];
  if (rows.length === 0) return [{ rule: 'version_empty' }];
  const channels = [...new Set(rows.map((r) => r.channel))];
  if (!channels.some((c) => c !== 'ics')) failures.push({ rule: 'no_deliverable_channel' });
  if (channels.includes('ics') && !channels.includes('email'))
    failures.push({ rule: 'ics_without_email' });
  for (const channel of channels)
    for (const language of languages)
      if (!rows.some((r) => r.channel === channel && r.language === language))
        failures.push({ rule: 'language_missing', channel, language });
  for (const r of rows) {
    const at = { channel: r.channel, language: r.language };
    for (const f of structuralFailures(r)) failures.push({ ...f, ...at });
    const values: Record<string, string> = {};
    for (const v of r.variables) values[v.name] = SAMPLE_VALUES[v.type];
    for (const f of findForbidden(`${r.subject ?? ''}\n${r.body}`, forbiddenExtra))
      failures.push({ rule: `forbidden_text:${f.rule}`, ...at });
    try {
      const out = renderTemplate(
        {
          channel: r.channel,
          language: r.language,
          subject: r.subject,
          body: r.body,
          declared: r.variables.map((v) => v.name),
        },
        values,
      );
      for (const f of findForbidden(`${out.subject ?? ''}\n${out.body}`, forbiddenExtra))
        failures.push({ rule: `forbidden_text:${f.rule}`, ...at });
      if (out.body.length > CHANNEL_LIMITS[r.channel]) failures.push({ rule: 'too_long', ...at });
    } catch (e) {
      failures.push({ rule: e instanceof RenderError ? e.rule : 'render_failed', ...at });
    }
  }
  return dedupe(failures);
}

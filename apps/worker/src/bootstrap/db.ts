// The real `BootstrapDbPort`: one connection as `app_bootstrap`, one transaction, one call (decision log 2.1). The caller binding
// (`app.org_id`) is set transaction-locally; the function sets and restores everything else itself.
import { BootstrapRefusedError, type BootstrapCallInput, type BootstrapDbPort } from './ports.js';
import { refusalCodeOf } from './command.js';

const PG: string = 'pg';

export class PgBootstrapDb implements BootstrapDbPort {
  /** `connectionString`: the `app_bootstrap` credential from the secret store (`<env>/db/app-bootstrap`); never logged. */
  constructor(private readonly connectionString: string) {}

  async call(input: BootstrapCallInput): Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pg: any = (await import(PG)).default;
    const c = new pg.Client({
      connectionString: this.connectionString,
      application_name: 'bootstrap-admins',
    });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.org_id', $1, true)", [input.orgId]);
      const r = await c.query(
        `SELECT identity.bootstrap_admins($1, $2, $3::jsonb, $4::jsonb, $5::bytea[]) AS result`,
        [
          input.runRef,
          input.ticketRef,
          JSON.stringify(input.enrollees),
          JSON.stringify(input.custodians),
          input.tokenHashes,
        ],
      );
      await c.query('COMMIT');
      return r.rows[0]?.result;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      const err = e as { code?: string; detail?: string };
      throw new BootstrapRefusedError(
        err.code === 'PS001' || err.code === '42501' ? refusalCodeOf(err.detail) : 'error',
      );
    } finally {
      await c.end().catch(() => undefined);
    }
  }
}

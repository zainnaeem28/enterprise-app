/** Minimal database surface the kernel needs. `pg` satisfies it; tests supply fakes or a real client. */
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount?: number | null;
}
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}
export interface PoolClientLike extends Queryable {
  release(err?: Error | boolean): void;
}
export interface PoolLike {
  connect(): Promise<PoolClientLike>;
}

// Minimal structural types for the Express objects the platform layer touches. `@types/express` is not a declared
// dependency (docs/DEPENDENCIES.md), and the layer only needs these members.

export interface Req {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  ip?: string;
  body?: unknown;
  header(name: string): string | undefined;
  // set by the platform layer
  requestId?: string;
  routeClass?: string;
  bodyLimit?: number;
}

export interface Res {
  statusCode: number;
  headersSent: boolean;
  writableEnded: boolean;
  status(code: number): Res;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  getHeader(name: string): unknown;
  removeHeader(name: string): void;
  json(body: unknown): unknown;
  end(chunk?: string): unknown;
  write(chunk: string): boolean;
  flushHeaders(): void;
  on(event: string, cb: () => void): unknown;
}

export type Next = (err?: unknown) => void;

export function hostOf(req: Req): string {
  const h = req.header('host') ?? '';
  return h.toLowerCase().replace(/:\d+$/, '');
}

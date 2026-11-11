// The `site` runtime: a small Node server that renders pages from the public directory (ARCHITECTURE 3.1, 29.5).
// It holds no credentials, reads no cookies for rendering (so pages are CDN-cacheable for a minute) and calls only
// `GET /public/v1/*` on the `integrations.` host. It is the only caller of that API; browsers never are.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import type { SiteConfig } from './config.js';
import { placeholderContent } from './content.js';
import type { ContentSource } from './content.js';
import { createCmsContent } from './cms-content.js';
import type { ContentProvider } from './cms-content.js';
import { createDirectoryClient } from './directory.js';
import type { DirectoryClient, Freshness } from './directory.js';
import { directoryOrNull, route } from './render.js';
import { robotsTxt, sitemapXml } from './seo.js';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function csp(config: SiteConfig): string {
  const analytics = config.analyticsSrc === null ? '' : ` ${new URL(config.analyticsSrc).origin}`;
  return [
    "default-src 'self'",
    `script-src 'self'${analytics}`,
    `connect-src 'self'${analytics}`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function securityHeaders(config: SiteConfig, res: ServerResponse): void {
  res.setHeader('Content-Security-Policy', csp(config));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

// Pages vary by nothing in the request (no cookie, no header), so one cached copy is right for everyone and an unlisted
// clinician disappears within the TTL (PB-4). `Vary` is deliberately absent. Degraded pages and pages built from the
// directory's stale fallback are never stored (no-store). stale-if-error is bounded by the origin header (<= 300 s).
export const PAGE_CACHE = 'public, max-age=60, stale-while-revalidate=30, stale-if-error=300';

export interface SiteDeps {
  config: SiteConfig;
  client: DirectoryClient;
  /** Fixed content (tests, no CMS configured). Ignored when `contentProvider` is given. */
  content?: ContentSource;
  contentProvider?: ContentProvider;
}

export function createSite(deps: SiteDeps): Server {
  const { config, client } = deps;
  const provider: ContentProvider =
    deps.contentProvider ??
    (async () => ({ content: deps.content ?? placeholderContent, degraded: false }));
  const clientRoot = resolve(config.clientDir);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    securityHeaders(config, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      res.writeHead(405).end();
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const send = (status: number, type: string, body: string, cache: string) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache });
      res.end(req.method === 'HEAD' ? undefined : body);
    };

    if (path === '/healthz') return send(200, 'text/plain; charset=utf-8', 'ok', 'no-store');
    if (path === '/robots.txt')
      return send(200, 'text/plain; charset=utf-8', robotsTxt(config.siteOrigin), PAGE_CACHE);
    if (path === '/sitemap.xml') {
      const fresh: Freshness = { stale: false };
      const dir = await directoryOrNull(client, fresh);
      return send(
        dir === null ? 503 : 200,
        'application/xml; charset=utf-8',
        sitemapXml(config.siteOrigin, dir),
        dir === null || fresh.stale ? 'no-store' : PAGE_CACHE,
      );
    }
    if (path.startsWith('/assets/')) {
      const file = normalize(join(clientRoot, path));
      if (!file.startsWith(clientRoot + sep)) {
        res.writeHead(404).end();
        return;
      }
      try {
        const data = await readFile(file);
        res.writeHead(200, {
          'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
    const { content, degraded } = await provider();
    const r = await route(trimmed, { config, client, content, contentDegraded: degraded });
    send(r.status, 'text/html; charset=utf-8', r.html, r.cacheable ? PAGE_CACHE : 'no-store');
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Cache-Control': 'no-store' });
      res.end();
    });
  });
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  const here = dirname(fileURLToPath(import.meta.url));
  const config = loadConfig(process.env, join(here, '..', 'client'));
  const client = createDirectoryClient({ baseUrl: config.publicApiOrigin });
  const contentProvider =
    config.cmsOrigin === null ? undefined : createCmsContent({ baseUrl: config.cmsOrigin });
  createSite({ config, client, contentProvider }).listen(config.port, () => {
    process.stdout.write(`site listening on ${config.port}\n`);
  });
}

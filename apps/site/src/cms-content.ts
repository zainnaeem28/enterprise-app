// ContentSource backed by the self-hosted CMS (`apps/cms`, C-19): server to server `GET {CMS}/api/globals/site-content`
// and `/organisation`, anonymous, so the CMS returns only PUBLISHED content. The browser never calls the CMS.
// Rules: every value is validated and trimmed; a missing or invalid text falls back to the reviewed static copy for that
// field; an organisation fact that is missing or invalid is omitted (never replaced by a made-up value). Answers are cached
// 60 s; if the CMS cannot be reached the last good answer is served for up to ten minutes, then the static copy with no
// organisation facts. Whoever built a page from either fallback must not let a CDN store it (`degraded`).
import { emptyOrganisation, placeholderContent } from './content.js';
import type { ContentSource, LegalPage, Organisation } from './content.js';

export interface ContentResult {
  content: ContentSource;
  /** True when the CMS could not be read and the page was built from a stale answer or the static copy. */
  degraded: boolean;
}
export type ContentProvider = () => Promise<ContentResult>;

export interface CmsContentOptions {
  /** Origin of the CMS content API (the `cms.` host, or its internal address). */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  staleMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' || t.length > max ? null : t;
};
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const LEGAL_KEYS = ['privacy', 'terms', 'cookies', 'accessibility'] as const;

function legalPage(raw: unknown, fallback: LegalPage): LegalPage {
  if (!isRec(raw)) return fallback;
  const paragraphs = (typeof raw['body'] === 'string' ? raw['body'] : '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  return {
    title: text(raw['title'], 120) ?? fallback.title,
    description: text(raw['description'], 300) ?? fallback.description,
    paragraphs: paragraphs.length > 0 ? paragraphs : fallback.paragraphs,
  };
}

export function parseSiteContent(
  raw: unknown,
  base: ContentSource = placeholderContent,
): ContentSource {
  const r = isRec(raw) ? raw : {};
  const g = (k: string): Rec => (isRec(r[k]) ? r[k] : {});
  const legal = g('legal');
  return {
    ...base,
    home: {
      heading: text(g('home')['heading'], 160) ?? base.home.heading,
      intro: text(g('home')['intro'], 600) ?? base.home.intro,
    },
    about: {
      intro: text(g('about')['intro'], 600) ?? base.about.intro,
      booking: text(g('about')['booking'], 800) ?? base.about.booking,
    },
    contact: { intro: text(g('contact')['intro'], 600) ?? base.contact.intro },
    legal: Object.fromEntries(
      LEGAL_KEYS.map((k) => [k, legalPage(legal[k], base.legal[k])]),
    ) as ContentSource['legal'],
  };
}

export function parseOrganisation(raw: unknown): Organisation {
  if (!isRec(raw)) return emptyOrganisation;
  const email = text(raw['email'], 254);
  const clinicians = Array.isArray(raw['clinicians']) ? raw['clinicians'] : [];
  return {
    name: text(raw['name'], 120),
    addressLines: (typeof raw['address'] === 'string' ? raw['address'] : '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && l.length <= 200)
      .slice(0, 8),
    phone: text(raw['phone'], 40),
    email: email !== null && EMAIL.test(email) ? email : null,
    hours: text(raw['hours'], 300),
    clinicians: clinicians.flatMap((c) => {
      if (!isRec(c)) return [];
      const name = text(c['name'], 120);
      return name === null ? [] : [{ name, title: text(c['title'], 120) }];
    }),
  };
}

export function createCmsContent(opts: CmsContentOptions): ContentProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const ttl = opts.ttlMs ?? 60_000;
  const stale = Math.min(opts.staleMs ?? 600_000, 600_000);
  const timeout = opts.timeoutMs ?? 3000;
  const now = opts.now ?? Date.now;
  const base = new URL(opts.baseUrl).origin;
  let last: { at: number; content: ContentSource } | null = null;
  let inflight: Promise<ContentResult> | null = null;

  // A published global answers 200. A global that has no published version answers 403/404/empty: that is "nothing entered",
  // not a failure. Anything else (5xx, network, timeout, invalid JSON) is a failure.
  async function global(slug: string): Promise<unknown> {
    const res = await doFetch(`${base}/api/globals/${slug}?depth=0`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeout),
    });
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new Error(`cms ${slug} ${res.status}`);
    return (await res.json()) as unknown;
  }

  async function refresh(): Promise<ContentResult> {
    try {
      const [site, org] = await Promise.all([global('site-content'), global('organisation')]);
      const content: ContentSource = {
        ...parseSiteContent(site),
        organisation: parseOrganisation(org),
      };
      last = { at: now(), content };
      return { content, degraded: false };
    } catch {
      if (last !== null && now() - last.at <= stale)
        return { content: last.content, degraded: true };
      return { content: placeholderContent, degraded: true };
    }
  }

  return async () => {
    if (last !== null && now() - last.at < ttl) return { content: last.content, degraded: false };
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

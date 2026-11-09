// Runtime configuration of the `site` server. Everything comes from the environment; nothing is read from a request.
export interface SiteConfig {
  port: number;
  /** Public origin of this site (canonical URLs, sitemap). */
  siteOrigin: string;
  /** The `integrations.` host that serves `/public/v1/*` (server to server only; browsers never call it). */
  publicApiOrigin: string;
  /** The patient portal origin (`my.`) that "Book" hands off to. */
  patientOrigin: string;
  /** Optional analytics script. Loaded in the browser only after the visitor accepts analytics. */
  analyticsSrc: string | null;
  /** Directory `dist/client` with the browser bundle. */
  clientDir: string;
}

const origin = (name: string, value: string): string => {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1')
    throw new Error(`${name} must be https`);
  return u.origin;
};

export function loadConfig(env: Record<string, string | undefined>, clientDir: string): SiteConfig {
  const analytics = env['ANALYTICS_SRC']?.trim();
  if (analytics !== undefined && analytics !== '') {
    origin('ANALYTICS_SRC', analytics);
  }
  return {
    port: Number(env['PORT'] ?? 8080),
    siteOrigin: origin('SITE_ORIGIN', env['SITE_ORIGIN'] ?? 'http://localhost:8080'),
    publicApiOrigin: origin(
      'PUBLIC_API_ORIGIN',
      env['PUBLIC_API_ORIGIN'] ?? 'http://127.0.0.1:3001',
    ),
    patientOrigin: origin('PATIENT_ORIGIN', env['PATIENT_ORIGIN'] ?? 'http://localhost:5173'),
    analyticsSrc: analytics === undefined || analytics === '' ? null : analytics,
    clientDir,
  };
}

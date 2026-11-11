// Browser push (R1: docs/intake/04 lists Web Push as R1; ARCHITECTURE 22 "Web Push for portal users"). Not an AWS service: a VAPID client over
// the `web-push` library, behind the same `ProviderClient` seam as e-mail and SMS. The payload is the rendered title and text of an allowlisted,
// PHI-free template. The subscription comes from a browser, so its endpoint is attacker-influenced: only the known push-service hosts are
// contacted (SSRF guard, INT-N7), over https.
import { selectByEnv, AwsConfigError, type Env, type Logger } from '@ehr/kernel';
import { PushAdapter, ProviderError } from '../jobs/notifications/index.js';
import type { ProviderClient, ProviderRequest } from '../jobs/notifications/adapters.js';

export const VAPID_VARS = [
  'EHR_VAPID_PUBLIC_KEY',
  'EHR_VAPID_PRIVATE_KEY',
  'EHR_VAPID_SUBJECT',
] as const;

/** Push services that browsers hand out endpoints for (FCM/Chrome/Edge, Firefox, Safari/Apple, Windows). Suffix match on the host. */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'web.push.apple.com',
  'push.apple.com',
  'notify.windows.com',
] as const;

export function allowedPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '')
    return false;
  const h = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** `to` of a push is the subscription as JSON, as the browser's `PushSubscription.toJSON()` returns it. */
export function parseSubscription(to: string): PushSubscription | undefined {
  let j: unknown;
  try {
    j = JSON.parse(to);
  } catch {
    return undefined;
  }
  const o = j as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const b64u = /^[A-Za-z0-9_-]{8,200}={0,2}$/;
  if (
    typeof o?.endpoint !== 'string' ||
    typeof o.keys?.p256dh !== 'string' ||
    typeof o.keys.auth !== 'string' ||
    !b64u.test(o.keys.p256dh) ||
    !b64u.test(o.keys.auth) ||
    !allowedPushEndpoint(o.endpoint)
  )
    return undefined;
  return { endpoint: o.endpoint, keys: { p256dh: o.keys.p256dh, auth: o.keys.auth } };
}

export type SendNotification = (
  sub: PushSubscription,
  payload: string,
  options: {
    vapidDetails: { subject: string; publicKey: string; privateKey: string };
    TTL: number;
    urgency: 'normal';
    timeout: number;
  },
) => Promise<{ statusCode: number }>;

export class WebPushProvider implements ProviderClient {
  constructor(
    private readonly vapid: { subject: string; publicKey: string; privateKey: string },
    private readonly sendNotification: SendNotification,
  ) {}

  async send(req: ProviderRequest): Promise<{ messageId: string; httpStatus?: number }> {
    const sub = parseSubscription(req.to);
    if (sub === undefined) throw new ProviderError(false, undefined, 'bad_subscription');
    if (req.signal.aborted) throw new ProviderError(true, undefined, 'aborted');
    try {
      const r = await this.sendNotification(
        sub,
        JSON.stringify({ title: req.subject ?? '', body: req.text }),
        { vapidDetails: this.vapid, TTL: 3600, urgency: 'normal', timeout: 8000 },
      );
      // Web Push returns no message ID; our token stands in for it (there are no delivery receipts for push).
      return { messageId: req.idempotencyToken, httpStatus: r.statusCode };
    } catch (e) {
      const status = (e as { statusCode?: unknown }).statusCode;
      const code = typeof status === 'number' ? status : undefined;
      if (code === 404 || code === 410) throw new ProviderError(false, code, 'subscription_gone');
      throw new ProviderError(
        code === undefined || code >= 500 || code === 429,
        code,
        'push_error',
      );
    }
  }

  // No cheap authenticated call exists for Web Push: configured keys are the health signal.
  health(): Promise<{ ok: boolean }> {
    return Promise.resolve({ ok: true });
  }
}

/** Loads `web-push` only when push is configured. */
async function realSend(): Promise<SendNotification> {
  const mod = (await import('web-push')) as unknown as { sendNotification: SendNotification };
  return mod.sendNotification;
}

export async function selectPushAdapter(
  env: Env,
  log: Logger,
  send?: SendNotification,
): Promise<PushAdapter | undefined> {
  const v = selectByEnv({
    adapter: 'push (Web Push, VAPID)',
    env,
    vars: VAPID_VARS,
    log,
    build: (x) => {
      const subject = x['EHR_VAPID_SUBJECT'] as string;
      if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject))
        throw new AwsConfigError('push (EHR_VAPID_SUBJECT is not a mailto: or https: URL)', [], []);
      return {
        subject,
        publicKey: x['EHR_VAPID_PUBLIC_KEY'] as string,
        privateKey: x['EHR_VAPID_PRIVATE_KEY'] as string,
      };
    },
  });
  if (v === undefined) return undefined;
  return new PushAdapter(new WebPushProvider(v, send ?? (await realSend())), {
    supportsIdempotencyToken: false,
  });
}

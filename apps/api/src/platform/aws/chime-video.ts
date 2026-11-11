// Chime SDK Meetings as the API's video vendor (AWS-BE-4). The API only mints an attendee for a meeting that the worker already created
// (`create_meeting`, apps/worker/src/aws/chime-video.ts); recording is never started here (no media pipeline is created anywhere).
// The attendee's `ExternalUserId` is our opaque participant ID; the join token is returned once and is not logged, stored or put in an error.
// The API only issues join tokens (DL-1, HEAAA-738): it holds no DeleteMeeting right. Closing a meeting is the worker's `telehealth.close_meeting`
// job behind the VendorGateway. Each call writes one structured `vendor_call` log line (ids and outcome only; see `ChimeVideoVendor`).
// Chime gives no per-token lifetime: the token lives as long as the attendee (the meeting). `ttlSeconds` is therefore enforced by OUR
// record (15 minutes, database-capped) and the attendee is deleted when its issue is superseded or the meeting ends (go-live check).
import { ChimeSDKMeetingsClient, CreateAttendeeCommand } from '@aws-sdk/client-chime-sdk-meetings';
import { awsSettings, selectByEnv, type Env, type Logger } from '@ehr/kernel';
import type {
  JoinTokenGrant,
  JoinTokenRequest,
  VideoVendorPort,
} from '../../modules/telehealth/port.js';

export const CHIME_VARS = ['EHR_CHIME_MEDIA_REGION'] as const;
export const CHIME_VENDOR = 'chime';
/** A hung Chime call must not hold the patient's join request open. */
export const CHIME_CLIENT_LIMITS = {
  connectionTimeout: 3000,
  requestTimeout: 8000,
  maxAttempts: 2,
} as const;
const MEETING_ID = /^[\x21-\x7e]{1,200}$/;
const MEDIA_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export interface Sender {
  send(cmd: unknown): Promise<unknown>;
}

type CallOutcome = 'ok' | 'timeout' | 'error' | 'rejected';

export class ChimeVideoVendor implements VideoVendorPort {
  constructor(
    private readonly client: Sender,
    private readonly log: Logger,
  ) {}

  /** One log line per call: the same vocabulary as `outbound_call`. Never the token, attendee, participant or meeting ID, or the vendor's message. */
  private logCall(
    outcome: CallOutcome,
    started: number,
    correlationId: string,
    errorClass?: string,
  ): void {
    const fields = {
      event: 'vendor_call',
      kind: 'video',
      vendor: CHIME_VENDOR,
      operation: 'join_token',
      outcome,
      latencyMs: Date.now() - started,
      correlationId,
      ...(errorClass === undefined ? {} : { errorClass }),
    };
    if (outcome === 'ok') this.log.info('vendor call', fields);
    else this.log.warn('vendor call', fields);
  }

  async issueJoinToken(req: JoinTokenRequest): Promise<JoinTokenGrant> {
    const started = Date.now();
    if (req.vendor !== CHIME_VENDOR || !MEETING_ID.test(req.meetingId)) {
      this.logCall('rejected', started, req.idempotencyToken);
      throw new Error(req.vendor !== CHIME_VENDOR ? 'video vendor mismatch' : 'bad meeting id');
    }
    let r: { Attendee?: { AttendeeId?: string; JoinToken?: string } };
    try {
      r = (await this.client.send(
        new CreateAttendeeCommand({ MeetingId: req.meetingId, ExternalUserId: req.participantRef }),
      )) as typeof r;
    } catch (e) {
      const name = (e as { name?: unknown } | null)?.name;
      const errorClass = typeof name === 'string' && /^\w{1,80}$/.test(name) ? name : 'Error';
      this.logCall(
        errorClass === 'TimeoutError' ? 'timeout' : 'error',
        started,
        req.idempotencyToken,
        errorClass,
      );
      throw e;
    }
    const a = r.Attendee;
    if (
      typeof a?.AttendeeId !== 'string' ||
      typeof a.JoinToken !== 'string' ||
      a.JoinToken.length === 0 ||
      a.JoinToken.length > 4096
    ) {
      this.logCall('rejected', started, req.idempotencyToken);
      throw new Error('video vendor answered without an attendee');
    }
    this.logCall('ok', started, req.idempotencyToken);
    return { attendeeId: a.AttendeeId, attendeeToken: a.JoinToken };
  }
}

export function selectChimeVideoVendor(env: Env, log: Logger): VideoVendorPort | undefined {
  return selectByEnv({
    adapter: 'video (Chime SDK)',
    env,
    vars: CHIME_VARS,
    log,
    build: (v) => {
      if (!MEDIA_REGION.test(v['EHR_CHIME_MEDIA_REGION'] as string))
        throw new Error('EHR_CHIME_MEDIA_REGION is not a region name');
      const s = awsSettings(env, 'video (Chime SDK)');
      return new ChimeVideoVendor(
        new ChimeSDKMeetingsClient({
          region: s.region,
          maxAttempts: CHIME_CLIENT_LIMITS.maxAttempts,
          requestHandler: {
            connectionTimeout: CHIME_CLIENT_LIMITS.connectionTimeout,
            requestTimeout: CHIME_CLIENT_LIMITS.requestTimeout,
          },
          ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
        }),
        log,
      );
    },
  });
}

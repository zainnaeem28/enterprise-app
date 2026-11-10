// Chime SDK Meetings as the API's video vendor (AWS-BE-4). The API only mints an attendee for a meeting that the worker already created
// (`create_meeting`, apps/worker/src/aws/chime-video.ts); recording is never started here (no media pipeline is created anywhere).
// The attendee's `ExternalUserId` is our opaque participant ID; the join token is returned once and is not logged, stored or put in an error.
// Chime gives no per-token lifetime: the token lives as long as the attendee (the meeting). `ttlSeconds` is therefore enforced by OUR
// record (15 minutes, database-capped) and the attendee is deleted when its issue is superseded or the meeting ends (go-live check).
import {
  ChimeSDKMeetingsClient,
  CreateAttendeeCommand,
  DeleteMeetingCommand,
} from '@aws-sdk/client-chime-sdk-meetings';
import { awsSettings, selectByEnv, type Env, type Logger } from '@ehr/kernel';
import type {
  JoinTokenGrant,
  JoinTokenRequest,
  VideoVendorPort,
} from '../../modules/telehealth/port.js';

export const CHIME_VARS = ['EHR_CHIME_MEDIA_REGION'] as const;
export const CHIME_VENDOR = 'chime';
const MEETING_ID = /^[\x21-\x7e]{1,200}$/;
const MEDIA_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export interface Sender {
  send(cmd: unknown): Promise<unknown>;
}

export class ChimeVideoVendor implements VideoVendorPort {
  constructor(private readonly client: Sender) {}

  async issueJoinToken(req: JoinTokenRequest): Promise<JoinTokenGrant> {
    if (req.vendor !== CHIME_VENDOR) throw new Error('video vendor mismatch');
    if (!MEETING_ID.test(req.meetingId)) throw new Error('bad meeting id');
    const r = (await this.client.send(
      new CreateAttendeeCommand({ MeetingId: req.meetingId, ExternalUserId: req.participantRef }),
    )) as { Attendee?: { AttendeeId?: string; JoinToken?: string } };
    const a = r.Attendee;
    if (
      typeof a?.AttendeeId !== 'string' ||
      typeof a.JoinToken !== 'string' ||
      a.JoinToken.length === 0 ||
      a.JoinToken.length > 4096
    )
      throw new Error('video vendor answered without an attendee');
    return { attendeeId: a.AttendeeId, attendeeToken: a.JoinToken };
  }

  async endMeeting(req: {
    vendor: string;
    meetingId: string;
    idempotencyToken: string;
  }): Promise<void> {
    if (req.vendor !== CHIME_VENDOR || !MEETING_ID.test(req.meetingId)) return;
    try {
      await this.client.send(new DeleteMeetingCommand({ MeetingId: req.meetingId }));
    } catch (e) {
      // A meeting that is already gone has ended: that is the goal.
      if ((e as { name?: string } | null)?.name !== 'NotFoundException') throw e;
    }
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
          ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
        }),
      );
    },
  });
}

// Chime SDK Meetings as the worker's `VideoTransport` (AWS-BE-4): the vendor half of `VideoAdapter`. Recording is off: no media-capture
// pipeline is ever created and the adapter refuses an argument asking for one. Chime takes our idempotency token (`ClientRequestToken`)
// on create, so a retry returns the same meeting. A join token is per attendee; the API mints it (apps/api/src/platform/aws/chime-video.ts).
import {
  ChimeSDKMeetingsClient,
  CreateAttendeeCommand,
  CreateMeetingCommand,
  DeleteMeetingCommand,
  GetMeetingCommand,
} from '@aws-sdk/client-chime-sdk-meetings';
import { awsSettings, selectByEnv, type Env, type Logger } from '@ehr/kernel';
import { AdapterFailure } from '../jobs/integration-core/errors.js';
import { VideoAdapter, type VideoTransport } from '../jobs/telehealth/video-adapter.js';

export const CHIME_VARS = ['EHR_CHIME_MEDIA_REGION'] as const;
const MEDIA_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export interface Sender {
  send(cmd: unknown, opts?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

const nameOf = (e: unknown): string => (e as { name?: string } | null)?.name ?? '';
const statusOf = (e: unknown): number | undefined =>
  (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;

/** Maps an SDK error to a class and a status only; Chime's message is never carried. */
function fail(e: unknown): never {
  if (e instanceof AdapterFailure) throw e;
  const status = statusOf(e);
  const retryable = status === undefined || status === 429 || status >= 500;
  throw new AdapterFailure(retryable, status, nameOf(e) || 'chime_error');
}

export class ChimeVideoTransport implements VideoTransport {
  readonly supportsIdempotencyToken = true;
  constructor(
    private readonly client: Sender,
    private readonly mediaRegion: string,
  ) {}

  async createMeeting(
    i: Parameters<VideoTransport['createMeeting']>[0],
  ): Promise<{ meetingId: string }> {
    try {
      const r = (await this.client.send(
        new CreateMeetingCommand({
          ClientRequestToken: i.idempotencyToken,
          ExternalMeetingId: i.externalId,
          MediaRegion: this.mediaRegion,
        }),
        { abortSignal: i.signal },
      )) as { Meeting?: { MeetingId?: string } };
      if (typeof r.Meeting?.MeetingId !== 'string')
        throw new AdapterFailure(false, undefined, 'bad_response');
      return { meetingId: r.Meeting.MeetingId };
    } catch (e) {
      return fail(e);
    }
  }

  async endMeeting(i: Parameters<VideoTransport['endMeeting']>[0]): Promise<void> {
    try {
      await this.client.send(new DeleteMeetingCommand({ MeetingId: i.meetingId }), {
        abortSignal: i.signal,
      });
    } catch (e) {
      if (nameOf(e) === 'NotFoundException') return; // already gone: the goal
      fail(e);
    }
  }

  async createAttendee(
    i: Parameters<VideoTransport['createAttendee']>[0],
  ): Promise<{ attendeeId: string; joinToken: string }> {
    try {
      const r = (await this.client.send(
        new CreateAttendeeCommand({ MeetingId: i.meetingId, ExternalUserId: i.externalUserId }),
        { abortSignal: i.signal },
      )) as { Attendee?: { AttendeeId?: string; JoinToken?: string } };
      const a = r.Attendee;
      if (typeof a?.AttendeeId !== 'string' || typeof a.JoinToken !== 'string')
        throw new AdapterFailure(false, undefined, 'bad_response');
      return { attendeeId: a.AttendeeId, joinToken: a.JoinToken };
    } catch (e) {
      return fail(e);
    }
  }

  /** Chime cannot look a meeting up by external ID; the create token makes the retry safe, so there is nothing to find. */
  findMeeting(): Promise<null> {
    return Promise.resolve(null);
  }

  /** A meeting that does not exist answers 404 only to a caller that is authenticated and allowed. */
  async ping(i: { signal: AbortSignal }): Promise<boolean> {
    try {
      await this.client.send(
        new GetMeetingCommand({ MeetingId: '00000000-0000-4000-8000-000000000000' }),
        { abortSignal: i.signal },
      );
      return true;
    } catch (e) {
      return nameOf(e) === 'NotFoundException';
    }
  }
}

export function selectChimeVideoAdapter(env: Env, log: Logger): VideoAdapter | undefined {
  return selectByEnv({
    adapter: 'video (Chime SDK)',
    env,
    vars: CHIME_VARS,
    log,
    build: (v) => {
      const region = v['EHR_CHIME_MEDIA_REGION'] as string;
      if (!MEDIA_REGION.test(region))
        throw new Error('EHR_CHIME_MEDIA_REGION is not a region name');
      const s = awsSettings(env, 'video (Chime SDK)');
      return new VideoAdapter(
        new ChimeVideoTransport(
          new ChimeSDKMeetingsClient({
            region: s.region,
            ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
          }),
          region,
        ),
      );
    },
  });
}

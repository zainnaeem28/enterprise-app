import type { TelehealthJobService } from './job-service.js';

// What the telehealth API side needs from the video vendor, as a port: issuing a join token, and nothing else (DL-1, HEAAA-738). ARCHITECTURE
// 35.2 allows the join token as a request-path vendor call, and `app_api` has no write right on `outbound_call` (BE-02), so the production
// port (`platform/aws/chime-video.ts`) calls the vendor directly with bounded timeouts and logs one `vendor_call` line per call. Meeting
// creation (`telehealth.create_meeting`) and closing (`telehealth.close_meeting`) are worker jobs behind the VendorGateway; the worker's
// video adapter (apps/worker/src/jobs/telehealth) is the vendor side. A token returned here is handed to the caller once and is never
// logged, stored or put in an audit row. The dbtest kit (`testkit.ts`) runs this port over the gateway to test the worker's adapter.

export interface JoinTokenRequest {
  vendor: string;
  meetingId: string;
  /** Our participant ID: the vendor's external user ID for the attendee (an opaque UUID, no name). */
  participantRef: string;
  role: 'patient' | 'proxy' | 'clinician';
  /** Our token record's ID: the idempotency token of this issue. */
  idempotencyToken: string;
  /** Lifetime asked of the vendor, seconds (the database caps our own record at 15 minutes). */
  ttlSeconds: number;
}

export interface JoinTokenGrant {
  attendeeId: string;
  attendeeToken: string;
}

export interface VideoVendorPort {
  issueJoinToken(req: JoinTokenRequest): Promise<JoinTokenGrant>;
}

// The port the worker's telehealth jobs are written against (apps/worker/src/jobs/telehealth/ports.ts), backed by the job service. The
// worker cannot import this package; the shapes are structurally identical and the integration tests run the worker's real job handlers
// against this adapter.

export interface TelehealthWorkerPort {
  ensureSession: TelehealthJobService['ensureSession'];
  recordMeeting: TelehealthJobService['recordMeeting'];
  meetingToClose: TelehealthJobService['meetingToClose'];
  staleSessions: TelehealthJobService['staleSessions'];
  endStale: TelehealthJobService['endStale'];
  endForVisitOver: TelehealthJobService['endForVisitOver'];
  recordMeetingClosed: TelehealthJobService['recordMeetingClosed'];
}

export function telehealthPort(s: TelehealthJobService): TelehealthWorkerPort {
  return {
    ensureSession: (tx, meta, rid) => s.ensureSession(tx, meta, rid),
    recordMeeting: (tx, meta, sid, vendor, meetingId) =>
      s.recordMeeting(tx, meta, sid, vendor, meetingId),
    meetingToClose: (tx, sid) => s.meetingToClose(tx, sid),
    staleSessions: (tx, limit) => s.staleSessions(tx, limit),
    endStale: (tx, meta, sid) => s.endStale(tx, meta, sid),
    endForVisitOver: (tx, meta, rid, reason) => s.endForVisitOver(tx, meta, rid, reason),
    recordMeetingClosed: (tx, meta, sid) => s.recordMeetingClosed(tx, meta, sid),
  };
}

import type { TelehealthJobService } from './job-service.js';

// What the telehealth API side needs from the video vendor, as a port. The API cannot call a vendor itself: the call log and the circuit
// of integration-core belong to the worker's VendorGateway (BE-02). The composition root implements this port over that gateway
// (`callVendor('video', 'join_token' | 'end_meeting', ...)`); the worker's video adapter (apps/worker/src/jobs/telehealth) is the vendor
// side. A token returned here is handed to the caller once and is never logged, stored or put in an audit row.

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
  /** Best effort after the session ended in our database. A failure is the stale-session job's to retry. */
  endMeeting?(req: { vendor: string; meetingId: string; idempotencyToken: string }): Promise<void>;
}

// The port the worker's telehealth jobs are written against (apps/worker/src/jobs/telehealth/ports.ts), backed by the job service. The
// worker cannot import this package; the shapes are structurally identical and the integration tests run the worker's real job handlers
// against this adapter.

export interface TelehealthWorkerPort {
  ensureSession: TelehealthJobService['ensureSession'];
  recordMeeting: TelehealthJobService['recordMeeting'];
  staleSessions: TelehealthJobService['staleSessions'];
  endStale: TelehealthJobService['endStale'];
}

export function telehealthPort(s: TelehealthJobService): TelehealthWorkerPort {
  return {
    ensureSession: (tx, meta, rid) => s.ensureSession(tx, meta, rid),
    recordMeeting: (tx, meta, sid, vendor, meetingId) =>
      s.recordMeeting(tx, meta, sid, vendor, meetingId),
    staleSessions: (tx, limit) => s.staleSessions(tx, limit),
    endStale: (tx, meta, sid) => s.endStale(tx, meta, sid),
  };
}

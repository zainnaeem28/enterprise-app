// A contract stub of a video vendor, for tests: in memory, deterministic, no network. It is NOT a vendor and proves nothing about one
// (C-11, C-10: the real-vendor cases stay BLOCKED). It honours the `VideoTransport` contract the way a well-behaved vendor would: a
// create with the same idempotency token answers with the same room, an attendee token is unique per call and never repeats, and a
// switch turns the vendor "unavailable" (TC-TH-04).
import { randomUUID } from 'node:crypto';
import { AdapterFailure } from '../integration-core/errors.js';
import type { VideoTransport } from './video-adapter.js';

export interface FakeCall {
  op: 'create' | 'end' | 'attendee' | 'find' | 'ping';
  recording?: boolean;
  externalId?: string;
  meetingId?: string;
  ttlSeconds?: number;
}

export class FakeVideoTransport implements VideoTransport {
  readonly supportsIdempotencyToken: boolean;
  readonly calls: FakeCall[] = [];
  /** externalId -> meeting */
  readonly meetings = new Map<string, { meetingId: string; ended: boolean; recording: boolean }>();
  /** Every attendee token ever handed out: a token must never be handed out twice. */
  readonly tokens = new Set<string>();
  private readonly byIdempotency = new Map<string, string>();
  /** TC-TH-04: every call fails like a vendor outage (HTTP 503). */
  unavailable = false;
  /** Fail the next n calls with a retryable error, then recover. */
  failNext = 0;

  constructor(opts: { supportsIdempotencyToken?: boolean } = {}) {
    this.supportsIdempotencyToken = opts.supportsIdempotencyToken ?? true;
  }

  private gate(): void {
    if (this.unavailable) throw new AdapterFailure(true, 503, 'vendor_unavailable');
    if (this.failNext > 0) {
      this.failNext--;
      throw new AdapterFailure(true, 503, 'vendor_unavailable');
    }
  }

  createMeeting(i: {
    externalId: string;
    idempotencyToken: string;
    recording: false;
  }): Promise<{ meetingId: string }> {
    this.calls.push({ op: 'create', recording: i.recording, externalId: i.externalId });
    this.gate();
    const known = this.byIdempotency.get(i.idempotencyToken);
    if (this.supportsIdempotencyToken && known !== undefined)
      return Promise.resolve({ meetingId: known });
    const meetingId = `mtg-${randomUUID()}`;
    this.meetings.set(i.externalId, { meetingId, ended: false, recording: i.recording });
    this.byIdempotency.set(i.idempotencyToken, meetingId);
    return Promise.resolve({ meetingId });
  }

  endMeeting(i: { meetingId: string }): Promise<void> {
    this.calls.push({ op: 'end', meetingId: i.meetingId });
    this.gate();
    for (const m of this.meetings.values()) if (m.meetingId === i.meetingId) m.ended = true;
    return Promise.resolve();
  }

  createAttendee(i: {
    meetingId: string;
    externalUserId: string;
    ttlSeconds: number;
  }): Promise<{ attendeeId: string; joinToken: string; expiresAt?: string }> {
    this.calls.push({ op: 'attendee', meetingId: i.meetingId, ttlSeconds: i.ttlSeconds });
    this.gate();
    const joinToken = `tok-${randomUUID()}${randomUUID()}`;
    this.tokens.add(joinToken);
    return Promise.resolve({
      attendeeId: `att-${randomUUID()}`,
      joinToken,
      expiresAt: new Date(Date.now() + i.ttlSeconds * 1000).toISOString(),
    });
  }

  findMeeting(i: { externalId: string }): Promise<{ meetingId: string } | null> {
    this.calls.push({ op: 'find', externalId: i.externalId });
    this.gate();
    const m = this.meetings.get(i.externalId);
    return Promise.resolve(m === undefined ? null : { meetingId: m.meetingId });
  }

  ping(): Promise<boolean> {
    this.calls.push({ op: 'ping' });
    return Promise.resolve(!this.unavailable);
  }
}

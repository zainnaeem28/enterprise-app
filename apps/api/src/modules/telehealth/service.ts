// The telehealth service (ARCHITECTURE 22.10, 24 `sessionFor`, `admit`, `join`, `end`, `confirmLocation`; 29.2, 29.3; PRD TL-1, RA-R1-10,
// RA-R1-28; ticket BE-15).
//
// Every method runs in the caller's scoped transaction, so row-level security is the second line after the guard. The invariants are the
// database's (migrations 1500-1502): which moves a session, a participant and a join token may make, that a finished row is never written
// again, that a token exists only for an admitted participant of a live session, that a patient cannot admit themselves. Lock order
// (25.2): the patient root first (`lockPatients`, once, at the start of a transaction that writes), then the rows.
//
//   * Waiting room (SEC-D-14): a patient or proxy who asks to join is `waiting` until the host admits them. Joining never skips it.
//   * Licensing at join (TL-1, RA-R1-28): the person confirms the state they are in (`confirmLocation`: a K row, one per attempt); the
//     rule is evaluated AGAIN at every join from the licensed states as they are now, so a licence removed after the confirmation
//     (TC-TH-08) refuses the join. `telehealth_licensing_mode` is `refuse` (default, fails closed) or `flag` (the visit goes on, marked).
//   * Join token (single use, short life): at most one live token per participant; a new issue supersedes the old. The VENDOR hands out
//     the attendee token, once; it is returned to the caller and appears in no table, log, audit row or idempotency record. The vendor
//     call runs OUTSIDE any transaction (prepare / vendor / finish), so no connection is held while the vendor answers.
//   * A refusal that must leave a trace (the waiting-room entry, the location answer) commits first; the service returns an outcome and
//     the caller throws after the commit. A thrown error would roll the trace back.
import type { KernelDb, Queue, ScopeSettings, Tx } from '@ehr/kernel';
import type { AuditEnvelope, AuditService } from '../audit/index.js';
import type { OrganisationService } from '../organisation/index.js';
import {
  LicensingRefusedError,
  LocationRequiredError,
  NotAdmittedError,
  SessionClosedError,
  SessionNotFoundError,
  TelehealthScopeError,
  TelehealthValidationError,
  TooEarlyError,
  VendorUnavailableError,
  translateDbError,
} from './errors.js';
import { isUuid, uuidv7 } from './ids.js';
import type { VideoVendorPort } from './port.js';
import {
  LOCATION_VALID_HOURS,
  TOKEN_TTL_SECONDS,
  hostWindow,
  joinOpensAt,
  meetingDueAt,
  normaliseState,
  parseDeviceCheck,
  patientWindow,
} from './rules.js';
import type {
  Admission,
  DeviceCheck,
  HostSessionView,
  JoinGrant,
  LicensingResult,
  LocationOutcome,
  ParticipantRole,
  PatientSessionView,
  SessionStatus,
  TelehealthMeta,
  WaitingEntry,
} from './types.js';

type Row = Record<string, unknown>;

export interface TelehealthDeps {
  db: KernelDb;
  audit: AuditService;
  organisation: Pick<OrganisationService, 'licensingCheck' | 'settingOrNull'>;
  vendor: VideoVendorPort;
  /** API-tier queue: `telehealth.patient_waiting` is published, and a missing room is asked for again, through it. */
  queue?: Queue;
  now?: () => Date;
}

/** Occupancy states in which a video visit can still be joined. */
const JOINABLE = ['confirmed', 'checked_in', 'in_consultation'];

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

interface Ctx {
  reservationId: string;
  patientId: string;
  locationId: string;
  clinicianId: string;
  occupancy: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  clinicLocalStart: string;
  sessionId: string | null;
  sessionStatus: SessionStatus | null;
  vendor: string | null;
  meetingId: string | null;
}

const CTX_SQL = `
  SELECT r.id AS reservation_id, r.patient_id, r.location_id, r.clinician_principal_id, o.status AS occupancy,
         lower(o.period) AS starts_at, upper(o.period) AS ends_at, l.time_zone,
         to_char(lower(o.period) AT TIME ZONE l.time_zone, 'YYYY-MM-DD"T"HH24:MI') AS local_start,
         v.id AS session_id, v.status AS session_status, v.vendor, v.vendor_meeting_id
    FROM scheduling.slot_reservation r
    JOIN scheduling.slot_occupancy o ON o.id = r.id
    JOIN organisation.location l ON l.id = r.location_id
    LEFT JOIN telehealth.video_session v ON v.reservation_id = r.id
   WHERE r.id = $1::uuid AND r.mode = 'video'`;

export type JoinPrepared =
  | { kind: 'waiting' }
  | { kind: 'no_meeting' }
  | {
      kind: 'ready';
      tokenId: string;
      participantId: string;
      sessionId: string;
      vendor: string;
      meetingId: string;
      role: ParticipantRole;
      hostJoin: boolean;
      reservationId: string;
      patientId: string;
    };

export class TelehealthService {
  constructor(private readonly deps: TelehealthDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private principal(tx: Tx): string {
    const p = tx.scope.principalId;
    if (p === undefined) throw new TelehealthScopeError();
    return p.toLowerCase();
  }

  private record(
    tx: Tx,
    meta: TelehealthMeta,
    e: Omit<AuditEnvelope, 'requestId' | 'jobId' | 'ip' | 'userAgent'>,
  ): Promise<string> {
    const job = meta.jobId !== undefined && meta.jobId !== null;
    return this.deps.audit.record(tx, {
      ...e,
      requestId: job ? null : meta.requestId,
      ...(job ? { jobId: meta.jobId } : {}),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    });
  }

  /** The visit, its place and its session as the caller's own RLS shows them. 404 for a visit that is hidden, absent or in person. */
  private async context(tx: Tx, reservationId: string): Promise<Ctx> {
    if (!isUuid(reservationId)) throw new TelehealthValidationError(['reservationId']);
    const r = (await tx.query(CTX_SQL, [reservationId.toLowerCase()])).rows[0] as Row | undefined;
    if (r === undefined) throw new SessionNotFoundError();
    return {
      reservationId: String(r['reservation_id']),
      patientId: String(r['patient_id']),
      locationId: String(r['location_id']),
      clinicianId: String(r['clinician_principal_id']),
      occupancy: String(r['occupancy']),
      startsAt: new Date(iso(r['starts_at'])),
      endsAt: new Date(iso(r['ends_at'])),
      timeZone: String(r['time_zone']),
      clinicLocalStart: String(r['local_start']),
      sessionId: r['session_id'] === null ? null : String(r['session_id']),
      sessionStatus: r['session_status'] === null ? null : (r['session_status'] as SessionStatus),
      vendor: r['vendor'] === null ? null : String(r['vendor']),
      meetingId: r['vendor_meeting_id'] === null ? null : String(r['vendor_meeting_id']),
    };
  }

  private requirePatientAudience(tx: Tx): void {
    if (tx.scope.audience !== 'patient') throw new TelehealthScopeError();
  }

  private requireHost(tx: Tx, c: Ctx): string {
    if (tx.scope.audience !== 'staff' || tx.scope.realm !== 'google')
      throw new TelehealthScopeError();
    const p = this.principal(tx);
    if (c.clinicianId.toLowerCase() !== p) throw new TelehealthScopeError();
    return p;
  }

  private roleOf(tx: Tx, patientId: string): ParticipantRole {
    return (tx.scope.proxyPatientIds ?? []).some((x) => x.toLowerCase() === patientId.toLowerCase())
      ? 'proxy'
      : 'patient';
  }

  /** The visit can still happen: the booking is live and the session (if there is one) is not finished. */
  private live(c: Ctx): boolean {
    return (
      JOINABLE.includes(c.occupancy) &&
      (c.sessionStatus === null || c.sessionStatus === 'scheduled' || c.sessionStatus === 'open')
    );
  }

  /** Ask the worker to make the session and its room now (idempotent by job key). Only inside a transaction that commits. */
  private async askForRoom(tx: Tx, c: Ctx): Promise<void> {
    await this.deps.queue?.enqueue(
      tx,
      'telehealth.create_meeting',
      { reservationId: c.reservationId, patientId: c.patientId },
      { runAt: meetingDueAt(c.startsAt, this.now()), jobKey: `create_meeting_${c.reservationId}` },
    );
  }

  // ===== licensing (TL-1) ==============================================================================================

  private async licensedStates(tx: Tx, clinicianId: string): Promise<string[]> {
    const r = await tx.query(
      `SELECT jurisdiction_code FROM identity.licensed_state
        WHERE principal_id = $1::uuid AND (expires_on IS NULL OR expires_on >= current_date)`,
      [clinicianId],
    );
    return (r.rows as Row[]).map((x) => String(x['jurisdiction_code']));
  }

  private async licensingMode(tx: Tx, locationId: string): Promise<'refuse' | 'flag'> {
    const m = await this.deps.organisation.settingOrNull<string>(
      tx,
      'telehealth_licensing_mode',
      locationId,
    );
    return m === 'flag' ? 'flag' : 'refuse';
  }

  /** The rule as of now: the clinician's licensed states today against the operating states (BD-17). Fails closed. */
  private async evaluate(tx: Tx, c: Ctx, state: string): Promise<LicensingResult> {
    return this.deps.organisation.licensingCheck(
      tx,
      await this.licensedStates(tx, c.clinicianId),
      state,
    );
  }

  private async lastConfirmation(
    tx: Tx,
    reservationId: string,
    principal: string,
  ): Promise<{ state: string; at: Date } | undefined> {
    const r = (
      await tx.query(
        `SELECT stated_state, confirmed_at FROM telehealth.location_confirmation
          WHERE reservation_id = $1::uuid AND principal_id = $2::uuid
          ORDER BY confirmed_at DESC, id DESC LIMIT 1`,
        [reservationId, principal],
      )
    ).rows[0] as Row | undefined;
    return r === undefined
      ? undefined
      : { state: String(r['stated_state']), at: new Date(iso(r['confirmed_at'])) };
  }

  /**
   * `POST /appointments/{id}/video-session/location` (29.2): the patient or proxy says which state they are in. Every answer is kept
   * (K, one row per attempt) with what the rule said. `allowed`: go on. Refused in `refuse` mode: the caller throws
   * `LicensingRefusedError` after this commits. Refused in `flag` mode: the row carries `override_reason` and the join is allowed.
   */
  async confirmLocation(
    tx: Tx,
    meta: TelehealthMeta,
    reservationId: string,
    input: { state?: unknown },
  ): Promise<LocationOutcome> {
    this.requirePatientAudience(tx);
    const state = normaliseState(input.state);
    if (state === undefined) throw new TelehealthValidationError(['state']);
    const principal = this.principal(tx);
    const c = await this.context(tx, reservationId);
    if (!this.live(c)) throw new SessionClosedError();
    try {
      await tx.lockPatients([c.patientId], 'key_share');
      const result = await this.evaluate(tx, c, state);
      const flagged =
        result !== 'allowed' && (await this.licensingMode(tx, c.locationId)) === 'flag';
      const id = uuidv7();
      await tx.query(
        `INSERT INTO telehealth.location_confirmation
           (id, organisation_id, reservation_id, patient_id, principal_id, stated_state, result, override_reason, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $4::uuid)`,
        [
          id,
          c.reservationId,
          c.patientId,
          principal,
          state,
          result,
          flagged ? 'licensing_mode_flag' : null,
        ],
      );
      await this.record(tx, meta, {
        action: 'create',
        resourceType: 'telehealth.location_confirmation',
        resourceId: id,
        patientId: c.patientId,
        locationId: c.locationId,
        // The outcome class only. The state itself is the patient's location: it stays in the K row, not in the audit change.
        change: { result, flagged },
      });
      return { result, flagged };
    } catch (e) {
      translateDbError(e);
    }
  }

  /** Throws `LicensingRefusedError` for a refusal that is not flagged. Called by the route after the confirmation committed. */
  static assertAllowed(o: LocationOutcome): void {
    if (o.result !== 'allowed' && !o.flagged) throw new LicensingRefusedError();
  }

  // ===== the patient's view and device check ===========================================================================

  /** `GET /appointments/{id}/video-session` (patient, proxy). Passive (26.2): writes nothing. */
  async patientView(tx: Tx, reservationId: string): Promise<PatientSessionView> {
    this.requirePatientAudience(tx);
    const principal = this.principal(tx);
    const c = await this.context(tx, reservationId);
    const p = (
      await tx.query(
        `SELECT admission FROM telehealth.participant WHERE session_id = $1::uuid AND principal_id = $2::uuid`,
        [c.sessionId, principal],
      )
    ).rows[0] as Row | undefined;
    const needs = await this.needsLocation(tx, c, principal);
    return {
      status: c.sessionStatus ?? (JOINABLE.includes(c.occupancy) ? 'scheduled' : 'ended'),
      admission: p === undefined ? 'waiting' : (p['admission'] as Admission),
      joinOpensAt: joinOpensAt(c.startsAt).toISOString(),
      needsLocationConfirmation: needs,
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      clinicTimeZone: c.timeZone,
      // The same member name as the appointment contract (`locationTimeZone`, TC-TH-02); `clinicTimeZone` is what the portal reads.
      locationTimeZone: c.timeZone,
      clinicLocalStart: c.clinicLocalStart,
    };
  }

  /** True when there is no fresh answer, or (refuse mode) the answer no longer passes the rule as it stands now (TC-TH-08). */
  private async needsLocation(tx: Tx, c: Ctx, principal: string): Promise<boolean> {
    const conf = await this.lastConfirmation(tx, c.reservationId, principal);
    if (conf === undefined) return true;
    if (this.now().getTime() - conf.at.getTime() > LOCATION_VALID_HOURS * 3_600_000) return true;
    if ((await this.evaluate(tx, c, conf.state)) === 'allowed') return false;
    return (await this.licensingMode(tx, c.locationId)) === 'refuse';
  }

  /**
   * `POST /appointments/{id}/video-session/device-check` (29.2): pass or fail for camera, microphone and bandwidth, nothing else. It
   * puts the person in the session's participant list (waiting) if they are not there yet. Needs the session to exist.
   */
  async deviceCheck(
    tx: Tx,
    meta: TelehealthMeta,
    reservationId: string,
    input: unknown,
  ): Promise<DeviceCheck> {
    this.requirePatientAudience(tx);
    const check = parseDeviceCheck(input);
    if (check === undefined) throw new TelehealthValidationError(['deviceCheck']);
    const principal = this.principal(tx);
    const c = await this.context(tx, reservationId);
    if (!this.live(c)) throw new SessionClosedError();
    if (c.sessionId === null) {
      await this.askForRoom(tx, c);
      throw new VendorUnavailableError();
    }
    try {
      await tx.lockPatients([c.patientId], 'key_share');
      const part = await this.ensureParticipant(tx, c, principal, this.roleOf(tx, c.patientId));
      await tx.query(
        `UPDATE telehealth.participant SET device_check = $2::jsonb, device_checked_at = now() WHERE id = $1::uuid`,
        [part.id, JSON.stringify(check)],
      );
      await this.record(tx, meta, {
        action: 'update',
        resourceType: 'telehealth.participant',
        resourceId: part.id,
        patientId: c.patientId,
        locationId: c.locationId,
        change: { deviceCheck: true },
      });
      return check;
    } catch (e) {
      translateDbError(e);
    }
  }

  private async ensureParticipant(
    tx: Tx,
    c: Ctx,
    principal: string,
    role: ParticipantRole,
  ): Promise<{ id: string; admission: Admission; waitingSince: Date | null }> {
    const host = role === 'clinician';
    await tx.query(
      `INSERT INTO telehealth.participant
         (id, organisation_id, session_id, patient_id, role, principal_id, admission, admitted_at, admitted_by, created_by)
       VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4, $5::uuid, $6,
               CASE WHEN $7::boolean THEN now() END, CASE WHEN $7::boolean THEN $5::uuid END, $5::uuid)
       ON CONFLICT (session_id, principal_id) DO NOTHING`,
      [uuidv7(), c.sessionId, c.patientId, role, principal, host ? 'admitted' : 'waiting', host],
    );
    const p = (
      await tx.query(
        `SELECT id, admission, waiting_since FROM telehealth.participant
          WHERE session_id = $1::uuid AND principal_id = $2::uuid FOR UPDATE`,
        [c.sessionId, principal],
      )
    ).rows[0] as Row | undefined;
    if (p === undefined) throw new SessionNotFoundError();
    return {
      id: String(p['id']),
      admission: p['admission'] as Admission,
      waitingSince: p['waiting_since'] === null ? null : new Date(iso(p['waiting_since'])),
    };
  }

  // ===== join (patient, proxy and host) ================================================================================

  /**
   * `POST /appointments/{id}/video-session/join` (29.2, 29.3). Three steps; the vendor is asked between two short transactions.
   * Returns the vendor's attendee token ONCE. Errors: 404 (not yours), 409 `telehealth.too_early`, `session_closed`, `location_required`,
   * `not_admitted`; 422 `telehealth.licensing_refused`; 503 `telehealth.vendor_unavailable`.
   */
  async join(
    scope: ScopeSettings,
    meta: TelehealthMeta,
    reservationId: string,
  ): Promise<JoinGrant> {
    const prep = await this.deps.db.withScope(scope, (tx) =>
      this.joinPrepare(tx, meta, reservationId),
    );
    // Outcomes that must commit their trace first, then answer.
    if (prep.kind === 'waiting') throw new NotAdmittedError();
    if (prep.kind === 'no_meeting') throw new VendorUnavailableError();

    let grant: { attendeeId: string; attendeeToken: string };
    try {
      grant = await this.deps.vendor.issueJoinToken({
        vendor: prep.vendor,
        meetingId: prep.meetingId,
        participantRef: prep.participantId,
        role: prep.role,
        idempotencyToken: prep.tokenId,
        ttlSeconds: TOKEN_TTL_SECONDS,
      });
    } catch {
      // Nothing of the vendor's error is kept or shown. The unused record is revoked; if even that fails it expires in minutes.
      await this.deps.db
        .withScope(scope, (tx) => this.joinFailed(tx, prep.tokenId))
        .catch(() => undefined);
      throw new VendorUnavailableError();
    }
    const ok = await this.deps.db.withScope(scope, (tx) =>
      this.joinFinish(tx, meta, prep, grant.attendeeId),
    );
    // Superseded by a newer issue while the vendor was answering: this token must not be used (single use per participant).
    if (!ok) throw new VendorUnavailableError();
    return { vendor: prep.vendor, meetingId: prep.meetingId, attendeeToken: grant.attendeeToken };
  }

  async joinPrepare(tx: Tx, meta: TelehealthMeta, reservationId: string): Promise<JoinPrepared> {
    const audience = tx.scope.audience;
    if (audience !== 'patient' && audience !== 'staff') throw new TelehealthScopeError();
    const principal = this.principal(tx);
    const c = await this.context(tx, reservationId);
    const hostJoin = audience === 'staff';
    if (hostJoin) this.requireHost(tx, c);

    if (!this.live(c)) throw new SessionClosedError();
    const now = this.now();
    const w = hostJoin ? hostWindow(now, c.startsAt) : patientWindow(now, c.startsAt, c.endsAt);
    if (w === 'early') throw new TooEarlyError(joinOpensAt(c.startsAt).toISOString());
    if (w === 'closed') throw new SessionClosedError();

    if (c.sessionId === null) {
      // The session is made by the worker when the booking is confirmed; ask again now (idempotent by job key) and let the caller retry.
      await this.askForRoom(tx, c);
      return { kind: 'no_meeting' };
    }

    // The licensing rule, as it stands now, for a patient or proxy (the host is not the one whose location is checked).
    if (!hostJoin) {
      const conf = await this.lastConfirmation(tx, c.reservationId, principal);
      if (
        conf === undefined ||
        now.getTime() - conf.at.getTime() > LOCATION_VALID_HOURS * 3_600_000
      )
        throw new LocationRequiredError();
      if ((await this.evaluate(tx, c, conf.state)) !== 'allowed') {
        if ((await this.licensingMode(tx, c.locationId)) === 'refuse')
          throw new LicensingRefusedError();
      }
    }

    try {
      await tx.lockPatients([c.patientId], 'key_share');
      const role: ParticipantRole = hostJoin ? 'clinician' : this.roleOf(tx, c.patientId);
      const part = await this.ensureParticipant(tx, c, principal, role);

      if (part.admission !== 'admitted') {
        // Into the waiting room, and the host is told once. The trace commits; the caller answers `not_admitted`.
        if (part.admission === 'waiting' && part.waitingSince === null) {
          await tx.query(
            `UPDATE telehealth.participant SET waiting_since = now() WHERE id = $1::uuid`,
            [part.id],
          );
          await this.deps.queue?.publish(tx, 'telehealth.patient_waiting', {
            reservationId: c.reservationId,
            patientId: c.patientId,
          });
        }
        return { kind: 'waiting' };
      }

      if (c.meetingId === null || c.vendor === null) {
        await this.askForRoom(tx, c);
        return { kind: 'no_meeting' };
      }

      // Single use: whatever this person held before is superseded, then one new record. The partial unique index backs it.
      await tx.query(
        `UPDATE telehealth.join_token SET status = 'revoked', revoke_reason = 'superseded'
          WHERE participant_id = $1::uuid AND status = 'issued'`,
        [part.id],
      );
      const tokenId = uuidv7();
      await tx.query(
        `INSERT INTO telehealth.join_token
           (id, organisation_id, session_id, participant_id, patient_id, principal_id, status, expires_at, created_by)
         VALUES ($1::uuid, kernel.uuid1('app.org_id'), $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'issued',
                 now() + make_interval(secs => $6::int), $5::uuid)`,
        [tokenId, c.sessionId, part.id, c.patientId, principal, TOKEN_TTL_SECONDS],
      );
      await this.record(tx, meta, {
        action: 'create',
        resourceType: 'telehealth.join_token',
        resourceId: tokenId,
        patientId: c.patientId,
        locationId: c.locationId,
        change: { role },
      });
      return {
        kind: 'ready',
        tokenId,
        participantId: part.id,
        sessionId: c.sessionId,
        vendor: c.vendor,
        meetingId: c.meetingId,
        role,
        hostJoin,
        reservationId: c.reservationId,
        patientId: c.patientId,
      };
    } catch (e) {
      translateDbError(e);
    }
  }

  /** After the vendor answered: record the attendee, open the session for a host, and report whether the token is still the live one. */
  async joinFinish(
    tx: Tx,
    meta: TelehealthMeta,
    p: Extract<JoinPrepared, { kind: 'ready' }>,
    attendeeId: string,
  ): Promise<boolean> {
    if (typeof attendeeId !== 'string' || attendeeId.length === 0 || attendeeId.length > 200)
      return false;
    try {
      await tx.lockPatients([p.patientId], 'key_share');
      // Lock order inside the module: the participant row, then its token (the same as joinPrepare, end and the stale sweep), so a join,
      // a second join and an end never wait on each other in a circle.
      await tx.query(`SELECT 1 FROM telehealth.participant WHERE id = $1::uuid FOR UPDATE`, [
        p.participantId,
      ]);
      const live = await tx.query(
        `SELECT 1 FROM telehealth.join_token WHERE id = $1::uuid AND status = 'issued' FOR UPDATE`,
        [p.tokenId],
      );
      if (live.rows.length === 0) return false;
      await tx.query(
        `UPDATE telehealth.participant
            SET vendor_attendee_id = $2, joined_at = COALESCE(joined_at, now()), left_at = NULL
          WHERE id = $1::uuid`,
        [p.participantId, attendeeId],
      );
      if (p.hostJoin) {
        await tx.query(
          `UPDATE telehealth.video_session SET status = 'open' WHERE id = $1::uuid AND status = 'scheduled'`,
          [p.sessionId],
        );
      }
      await this.record(tx, meta, {
        action: 'update',
        resourceType: 'telehealth.participant',
        resourceId: p.participantId,
        patientId: p.patientId,
        change: { joined: true },
      });
      return true;
    } catch (e) {
      translateDbError(e);
    }
  }

  private async joinFailed(tx: Tx, tokenId: string): Promise<void> {
    await tx.query(
      `UPDATE telehealth.join_token SET status = 'revoked', revoke_reason = 'vendor_failed'
        WHERE id = $1::uuid AND status = 'issued'`,
      [tokenId],
    );
  }

  // ===== the host: waiting room, admit, end ============================================================================

  private async waitingList(tx: Tx, sessionId: string | null): Promise<WaitingEntry[]> {
    if (sessionId === null) return [];
    const r = await tx.query(
      `SELECT id, patient_id, role, waiting_since, device_check FROM telehealth.participant
        WHERE session_id = $1::uuid AND admission = 'waiting' AND waiting_since IS NOT NULL AND role <> 'clinician'
        ORDER BY waiting_since, id`,
      [sessionId],
    );
    return (r.rows as Row[]).map((x) => ({
      participantId: String(x['id']),
      patientId: String(x['patient_id']),
      role: x['role'] as ParticipantRole,
      waitingSince: iso(x['waiting_since']),
      deviceCheck: (x['device_check'] as DeviceCheck | null) ?? null,
    }));
  }

  private async hostViewOf(tx: Tx, c: Ctx): Promise<HostSessionView> {
    return {
      status: c.sessionStatus ?? 'scheduled',
      startsAt: c.startsAt.toISOString(),
      endsAt: c.endsAt.toISOString(),
      joinOpensAt: joinOpensAt(c.startsAt).toISOString(),
      clinicTimeZone: c.timeZone,
      clinicLocalStart: c.clinicLocalStart,
      meetingReady: c.meetingId !== null,
      waiting: await this.waitingList(tx, c.sessionId),
    };
  }

  /** `GET /appointments/{id}/video-session` (staff, host). Passive (26.2): writes nothing. */
  async hostView(tx: Tx, reservationId: string): Promise<HostSessionView> {
    const c = await this.context(tx, reservationId);
    this.requireHost(tx, c);
    return this.hostViewOf(tx, c);
  }

  /** `POST .../admit` (29.3): the host lets one waiting person in (`participantId`), or everyone waiting. Repeating it changes nothing. */
  async admit(
    tx: Tx,
    meta: TelehealthMeta,
    reservationId: string,
    input: { participantId?: unknown },
  ): Promise<HostSessionView> {
    const c = await this.context(tx, reservationId);
    const principal = this.requireHost(tx, c);
    if (input.participantId !== undefined && !isUuid(input.participantId))
      throw new TelehealthValidationError(['participantId']);
    if (!this.live(c) || c.sessionId === null) throw new SessionClosedError();
    try {
      await tx.lockPatients([c.patientId], 'key_share');
      const r = await tx.query(
        `UPDATE telehealth.participant
            SET admission = 'admitted', admitted_at = now(), admitted_by = $2::uuid
          WHERE session_id = $1::uuid AND admission = 'waiting' AND role <> 'clinician'
            AND ($3::uuid IS NULL OR id = $3::uuid)
          RETURNING id`,
        [c.sessionId, principal, input.participantId ?? null],
      );
      if (input.participantId !== undefined && r.rows.length === 0) {
        // Not waiting any more (admitted already, or not in this session): fine when admitted already, 404 when not ours.
        const there = await tx.query(
          `SELECT 1 FROM telehealth.participant WHERE id = $1::uuid AND session_id = $2::uuid`,
          [input.participantId, c.sessionId],
        );
        if (there.rows.length === 0) throw new SessionNotFoundError();
      }
      for (const row of r.rows as Row[]) {
        await this.record(tx, meta, {
          action: 'update',
          resourceType: 'telehealth.participant',
          resourceId: String(row['id']),
          patientId: c.patientId,
          locationId: c.locationId,
          change: { admission: 'admitted' },
        });
      }
      return await this.hostViewOf(tx, c);
    } catch (e) {
      translateDbError(e);
    }
  }

  /**
   * `POST .../end` (29.3): the host ends the visit. Every live join token is revoked first (the database refuses to end a session that
   * still holds one), then the session ends. Repeating it on an ended session changes nothing. Returns what the caller must tell the
   * vendor once this commits (`vendorClose`), or nothing.
   */
  async end(
    tx: Tx,
    meta: TelehealthMeta,
    reservationId: string,
  ): Promise<{
    view: HostSessionView;
    vendorClose?: { vendor: string; meetingId: string; sessionId: string };
  }> {
    const c = await this.context(tx, reservationId);
    this.requireHost(tx, c);
    if (c.sessionId === null) throw new SessionNotFoundError();
    if (c.sessionStatus === 'ended' || c.sessionStatus === 'failed')
      return { view: await this.hostViewOf(tx, c) };
    try {
      await tx.lockPatients([c.patientId], 'key_share');
      await tx.query(
        `UPDATE telehealth.participant SET left_at = now()
          WHERE session_id = $1::uuid AND joined_at IS NOT NULL AND left_at IS NULL`,
        [c.sessionId],
      );
      await tx.query(
        `UPDATE telehealth.join_token SET status = 'revoked', revoke_reason = 'session_ended'
          WHERE session_id = $1::uuid AND status = 'issued'`,
        [c.sessionId],
      );
      await tx.query(
        `UPDATE telehealth.video_session SET status = 'ended' WHERE id = $1::uuid AND status IN ('scheduled', 'open')`,
        [c.sessionId],
      );
      await this.record(tx, meta, {
        action: 'update',
        resourceType: 'telehealth.video_session',
        resourceId: c.sessionId,
        patientId: c.patientId,
        locationId: c.locationId,
        change: { status: 'ended' },
      });
      const view = await this.hostViewOf(tx, { ...c, sessionStatus: 'ended' });
      return c.vendor !== null && c.meetingId !== null
        ? {
            view,
            vendorClose: { vendor: c.vendor, meetingId: c.meetingId, sessionId: c.sessionId },
          }
        : { view };
    } catch (e) {
      translateDbError(e);
    }
  }

  /** After `end` committed: tell the vendor, best effort. A failure is logged by the caller by class only; the vendor room times out. */
  async closeAtVendor(v: {
    vendor: string;
    meetingId: string;
    sessionId: string;
  }): Promise<boolean> {
    try {
      await this.deps.vendor.endMeeting?.({
        vendor: v.vendor,
        meetingId: v.meetingId,
        idempotencyToken: `end-${v.sessionId}`,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ===== what the worker's jobs need (24 `sessionFor`) =================================================================

  /** `sessionFor(reservation)` (24): the session of a video reservation, as the caller's RLS shows it. */
  async sessionFor(
    tx: Tx,
    reservationId: string,
  ): Promise<{ sessionId: string; status: SessionStatus; meetingReady: boolean } | undefined> {
    if (!isUuid(reservationId)) throw new TelehealthValidationError(['reservationId']);
    const r = (
      await tx.query(
        `SELECT id, status, vendor_meeting_id FROM telehealth.video_session WHERE reservation_id = $1::uuid`,
        [reservationId.toLowerCase()],
      )
    ).rows[0] as Row | undefined;
    return r === undefined
      ? undefined
      : {
          sessionId: String(r['id']),
          status: r['status'] as SessionStatus,
          meetingReady: r['vendor_meeting_id'] !== null,
        };
  }
}

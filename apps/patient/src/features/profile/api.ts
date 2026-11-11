import type { components } from '@ehr/contracts';
import type { PatientRuntime } from '../../app/runtime.js';
import { guard, ifMatch, versionOf } from './lib/core.js';
import type { Outcome } from './lib/core.js';
import { parseContact, parseList, parsePreferences, parseProfile, parseProxy } from './types.js';
import type { Contact, Preferences, Profile, ProxyGrant, ProxyScope } from './types.js';

export type ProfileApi = ReturnType<typeof createProfileApi>;

/** Every call the profile, notification-preference and family screens make, over the shell's typed client. */
export function createProfileApi(runtime: PatientRuntime) {
  const { api } = runtime;
  const header = api.header;

  return {
    profile: (patientId: string): Promise<Outcome<Profile>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/profile', {
            params: { header, path: { patientId } },
          }),
        (d, r) => parseProfile(d, versionOf(r)),
      ),

    /** Audited `update` on the server (RA-R1-19). Only the fields in `patch` are sent. */
    saveProfile: (
      patientId: string,
      version: number,
      patch: Record<string, unknown>,
    ): Promise<Outcome<number>> =>
      guard(
        () =>
          api.PATCH('/api/v1/patients/{patientId}/profile', {
            params: { header: { ...header, 'If-Match': ifMatch(version) }, path: { patientId } },
            body: patch,
          }),
        (_d, r) => versionOf(r) ?? version + 1,
      ),

    addContact: (
      patientId: string,
      body: Record<string, unknown>,
      key: string,
    ): Promise<Outcome<Contact>> =>
      guard(
        () =>
          api.POST('/api/v1/patients/{patientId}/contacts', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { patientId } },
            body,
          }),
        (d) => parseContact(d),
      ),

    saveContact: (
      patientId: string,
      id: string,
      version: number,
      body: Record<string, unknown>,
    ): Promise<Outcome<Contact>> =>
      guard(
        () =>
          api.PATCH('/api/v1/patients/{patientId}/contacts/{id}', {
            params: {
              header: { ...header, 'If-Match': ifMatch(version) },
              path: { patientId, id },
            },
            body,
          }),
        (d) => parseContact(d),
      ),

    preferences: (patientId: string): Promise<Outcome<Preferences>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/communication-preferences', {
            params: { header, path: { patientId } },
          }),
        (d, r) => parsePreferences(d, versionOf(r)),
      ),

    /** `If-Match` only once a preference is stored; the first save has none (the server accepts that). */
    savePreferences: (
      patientId: string,
      version: number | undefined,
      body: Record<string, unknown>,
    ): Promise<Outcome<Preferences>> =>
      guard(
        () =>
          api.PUT('/api/v1/patients/{patientId}/communication-preferences', {
            params: {
              // The contract lists `If-Match` as required; the server accepts a first save without it while nothing is stored.
              header: {
                ...header,
                ...(version === undefined ? {} : { 'If-Match': ifMatch(version) }),
              } as typeof header & { 'If-Match': string },
              path: { patientId },
            },
            body,
          }),
        (d, r) => parsePreferences(d, versionOf(r)),
      ),

    proxies: (patientId: string): Promise<Outcome<ProxyGrant[]>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/proxies', {
            params: { header, path: { patientId }, query: {} },
          }),
        (d) => parseList(d, parseProxy),
      ),

    revokeProxy: (patientId: string, grantId: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.DELETE('/api/v1/patients/{patientId}/proxies/{grantId}', {
            params: { header, path: { patientId, grantId } },
          }),
        () => true as const,
      ),

    /** Ruling C item 3: the patient sets what a (non-guardian) proxy may see. `appointments` is always kept. */
    setProxyScopes: (
      patientId: string,
      grantId: string,
      scopes: ProxyScope[],
    ): Promise<Outcome<ProxyGrant>> =>
      guard(
        () =>
          api.PUT('/api/v1/patients/{patientId}/proxies/{grantId}/scopes', {
            params: { header, path: { patientId, grantId } },
            body: { scopes },
          }),
        (d) => parseProxy(d),
      ),

    /** The invited account accepts with the e-mail code. One 422 answer covers a wrong, expired, locked, used or foreign code. */
    acceptInvite: (grantId: string, code: string): Promise<Outcome<ProxyGrant>> =>
      guard(
        () =>
          api.POST('/api/v1/proxy-invites/{grantId}/accept', {
            params: { header, path: { grantId } },
            body: { code },
          }),
        (d) => parseProxy(d),
      ),

    /** A proxy ends their own access now. */
    leaveProxy: (grantId: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/proxy-grants/{grantId}/leave', {
            params: { header, path: { grantId } },
          }),
        () => true as const,
      ),

    /** Blocked on D-7: the server answers `422 identity.proxy_rules_not_configured` until the rule values exist. */
    requestProxy: (
      patientId: string,
      body: components['schemas']['ProxyInviteRequest'],
      key: string,
    ): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/patients/{patientId}/proxy-requests', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { patientId } },
            body,
          }),
        () => true as const,
      ),
  };
}

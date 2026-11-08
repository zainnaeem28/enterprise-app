import { createDocumentsApi } from './documents.js';
import type { PatientRuntime } from '../../app/runtime.js';
import { guard, ifMatch, versionOf } from '../profile/lib/core.js';
import type { Outcome } from '../profile/lib/core.js';
import { parseCoverage, parseForVisit, parseList, parsePrevisit, parseSubmit } from './types.js';
import type { Answer, Coverage, Previsit, QuestionnaireForVisit, SubmitResult } from './types.js';
import type { QResponse } from './types.js';
import { parseResponse } from './types.js';

export type PrevisitApi = ReturnType<typeof createPrevisitApi>;

type Reply = Promise<{ data?: unknown; error?: unknown; response: Response }>;
/**
 * `GET /appointments/{id}/questionnaire` is served by the API (clinical frontdoor) but is not in the OpenAPI contract
 * (the contract puts the template in the `previsit` answer, which carries only three flags). The typed client has no entry for it,
 * so this one call goes through an untyped view of the same client (same headers, CSRF and release handling).
 */
interface Loose {
  GET(path: string, init: { params: { header: unknown; path: Record<string, string> } }): Reply;
}

/** Every call the pre-visit screens make, over the shell's typed client. */
export function createPrevisitApi(runtime: PatientRuntime) {
  const { api } = runtime;
  const header = api.header;
  const loose = api as unknown as Loose;

  return {
    documents: createDocumentsApi(api),

    previsit: (reservationId: string): Promise<Outcome<Previsit>> =>
      guard(
        () =>
          api.GET('/api/v1/appointments/{reservationId}/previsit', {
            params: { header, path: { reservationId } },
          }),
        (d) => parsePrevisit(d),
      ),

    questionnaire: (reservationId: string): Promise<Outcome<QuestionnaireForVisit>> =>
      guard(
        () =>
          loose.GET('/api/v1/appointments/{id}/questionnaire', {
            params: { header, path: { id: reservationId } },
          }),
        (d, r) => parseForVisit(d, versionOf(r)),
      ),

    /** The client names the response ID so a repeat of the first save finds the row (idempotent). First save has no `If-Match`. */
    saveDraft: (
      responseId: string,
      version: number | undefined,
      body: { reservationId: string; templateKey: string; answers: Record<string, Answer> },
    ): Promise<Outcome<QResponse>> =>
      guard(
        () =>
          api.PUT('/api/v1/questionnaire-responses/{responseId}', {
            params: {
              header: {
                ...header,
                ...(version === undefined ? {} : { 'If-Match': ifMatch(version) }),
              } as typeof header & { 'If-Match': string },
              path: { responseId },
            },
            body: version === undefined ? body : { answers: body.answers },
          }),
        (d, r) => {
          const v = parseResponse(d, versionOf(r));
          return v === null ? undefined : v;
        },
      ),

    submit: (responseId: string, version: number, key: string): Promise<Outcome<SubmitResult>> =>
      guard(
        () =>
          api.POST('/api/v1/questionnaire-responses/{responseId}/submit', {
            params: {
              header: { ...header, 'If-Match': ifMatch(version), 'Idempotency-Key': key },
              path: { responseId },
            },
          }),
        (d, r) => parseSubmit(d, versionOf(r)),
      ),

    /** Opens a pending consent for each required template that is missing or outdated. Idempotent. */
    openConsents: (reservationId: string, key: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/appointments/{reservationId}/previsit/consents', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { reservationId } },
          }),
        () => true as const,
      ),

    signConsent: (consentId: string, typedName: string, key: string): Promise<Outcome<true>> =>
      guard(
        () =>
          api.POST('/api/v1/consents/{consentId}/sign', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { consentId } },
            body: { typedName },
          }),
        () => true as const,
      ),

    coverages: (patientId: string): Promise<Outcome<Coverage[]>> =>
      guard(
        () =>
          api.GET('/api/v1/patients/{patientId}/insurance-coverages', {
            params: { header, path: { patientId } },
          }),
        (d) => parseList(d, parseCoverage),
      ),

    addCoverage: (
      patientId: string,
      body: Record<string, unknown>,
      key: string,
    ): Promise<Outcome<Coverage>> =>
      guard(
        () =>
          api.POST('/api/v1/patients/{patientId}/insurance-coverages', {
            params: { header: { ...header, 'Idempotency-Key': key }, path: { patientId } },
            body,
          }),
        (d) => parseCoverage(d),
      ),

    saveCoverage: (
      patientId: string,
      id: string,
      version: number,
      body: Record<string, unknown>,
    ): Promise<Outcome<Coverage>> =>
      guard(
        () =>
          api.PATCH('/api/v1/patients/{patientId}/insurance-coverages/{id}', {
            params: {
              header: { ...header, 'If-Match': ifMatch(version) },
              path: { patientId, id },
            },
            body,
          }),
        (d) => parseCoverage(d),
      ),
  };
}

// Explicit expansions for catalogue cells that the mechanical reader cannot expand ("…/x" shorthand,
// several paths in one cell, or an implied path). Keyed by the exact first-cell text of the document row.
// Each entry: 'METHOD path' with a trailing ' †' where the document marks elevation on that route.
// Interpretations beyond the literal text are listed in docs-free form in packages/contracts/openapi/openapi.yaml
// under x-catalogue-interpretations.
export const EXPANSIONS = {
  '`POST /api/v1/auth/session/extend` (draft 6, TDR-06)': ['POST /api/v1/auth/session/extend'],
  '`POST /api/v1/auth/reauth` (staff)': ['POST /api/v1/auth/reauth'],
  '`POST /api/v1/admin/auth/elevation/options`, `…/verify`': [
    'POST /api/v1/admin/auth/elevation/options',
    'POST /api/v1/admin/auth/elevation/verify',
  ],
  '`POST /api/v1/admin/auth/enrolment/options`, `…/verify`': [
    'POST /api/v1/admin/auth/enrolment/options',
    'POST /api/v1/admin/auth/enrolment/verify',
  ],
  '`GET /appointments/{reservationId}/previsit`, `POST …/consents`': [
    'GET /appointments/{reservationId}/previsit',
    'POST /appointments/{reservationId}/previsit/consents',
  ],
  '`GET/POST /patients/{patientId}/contacts`, `PATCH/DELETE …/contacts/{id}`': [
    'GET /patients/{patientId}/contacts',
    'POST /patients/{patientId}/contacts',
    'PATCH /patients/{patientId}/contacts/{id}',
    'DELETE /patients/{patientId}/contacts/{id}',
  ],
  '`GET/POST /patients/{patientId}/insurance-coverages`, `PATCH …/{id}`': [
    'GET /patients/{patientId}/insurance-coverages',
    'POST /patients/{patientId}/insurance-coverages',
    'PATCH /patients/{patientId}/insurance-coverages/{id}',
  ],
  '`GET/PUT /patients/{patientId}/communication-preferences`': [
    'GET /patients/{patientId}/communication-preferences',
    'PUT /patients/{patientId}/communication-preferences',
  ],
  '`GET /services`, `GET /locations`, `GET /clinicians?serviceId&locationId`': [
    'GET /services',
    'GET /locations',
    'GET /clinicians',
  ],
  '`POST /waitlist-entries`, `DELETE /waitlist-entries/{id}`': [
    'POST /waitlist-entries',
    'DELETE /waitlist-entries/{id}',
  ],
  '`POST /waitlist-offers/{offerId}/accept`, `…/decline`': [
    'POST /waitlist-offers/{offerId}/accept',
    'POST /waitlist-offers/{offerId}/decline',
  ],
  '`GET /notices`, `POST /notices/{id}/read`': ['GET /notices', 'POST /notices/{id}/read'],
  '`GET/POST /patients/{patientId}/threads`, `POST /threads/{id}/messages`': [
    'GET /patients/{patientId}/threads',
    'POST /patients/{patientId}/threads',
    'POST /threads/{id}/messages',
  ],
  '`GET /privacy-requests`, `GET /privacy-requests/{id}`': [
    'GET /privacy-requests',
    'GET /privacy-requests/{id}',
  ],
  '`POST /check-ins` (QR)': ['POST /check-ins'],
  '`GET /patients/{patientId}/banner` (draft 8, AL-01)': ['GET /patients/{patientId}/banner'],
  '`GET/POST /patients/{patientId}/care-team`, `DELETE …/{memberId}`': [
    'GET /patients/{patientId}/care-team',
    'POST /patients/{patientId}/care-team',
    'DELETE /patients/{patientId}/care-team/{memberId}',
  ],
  '`POST /patient-merges/{id}/approve`, `…/reject`': [
    'POST /patient-merges/{id}/approve',
    'POST /patient-merges/{id}/reject',
  ],
  '`POST /holds`, `POST /appointments/{id}/confirm`, `…/cancel`, `…/reschedule`': [
    'POST /holds',
    'POST /appointments/{id}/confirm',
    'POST /appointments/{id}/cancel',
    'POST /appointments/{id}/reschedule',
  ],
  '`GET/POST /clinicians/{id}/availability-templates`, `PUT/DELETE …/{templateId}`': [
    'GET /clinicians/{id}/availability-templates',
    'POST /clinicians/{id}/availability-templates',
    'PUT /clinicians/{id}/availability-templates/{templateId}',
    'DELETE /clinicians/{id}/availability-templates/{templateId}',
  ],
  '`GET/POST/DELETE /clinicians/{id}/blocked-times`': [
    'GET /clinicians/{id}/blocked-times',
    'POST /clinicians/{id}/blocked-times',
    'DELETE /clinicians/{id}/blocked-times',
  ],
  '`GET/POST/DELETE /locations/{id}/roster`': [
    'GET /locations/{id}/roster',
    'POST /locations/{id}/roster',
    'DELETE /locations/{id}/roster',
  ],
  '`GET /locations/{locationId}/check-in-qr` (draft 6)': [
    'GET /locations/{locationId}/check-in-qr',
  ],
  '`GET /calendar-link`, `POST /calendar-link/start`, `GET /calendar-link/callback`, `DELETE /calendar-link`':
    [
      'GET /calendar-link',
      'POST /calendar-link/start',
      'GET /calendar-link/callback',
      'DELETE /calendar-link',
    ],
  '`GET /appointments/{id}/video-session`, `POST …/admit`, `POST …/join`, `POST …/end`': [
    'GET /appointments/{id}/video-session',
    'POST /appointments/{id}/video-session/admit',
    'POST /appointments/{id}/video-session/join',
    'POST /appointments/{id}/video-session/end',
  ],
  '`GET/POST /patients/{patientId}/problems`, `/allergies`, `/medications`, `/immunisations`; `PATCH …/{id}`':
    [
      'GET /patients/{patientId}/problems',
      'POST /patients/{patientId}/problems',
      'GET /patients/{patientId}/allergies',
      'POST /patients/{patientId}/allergies',
      'GET /patients/{patientId}/medications',
      'POST /patients/{patientId}/medications',
      'GET /patients/{patientId}/immunisations',
      'POST /patients/{patientId}/immunisations',
      'PATCH /patients/{patientId}/problems/{id}',
      'PATCH /patients/{patientId}/allergies/{id}',
      'PATCH /patients/{patientId}/medications/{id}',
      'PATCH /patients/{patientId}/immunisations/{id}',
    ],
  '`POST /patients/{patientId}/referrals`, `PATCH /referrals/{id}`, `POST /referrals/{id}/send`': [
    'POST /patients/{patientId}/referrals',
    'PATCH /referrals/{id}',
    'POST /referrals/{id}/send',
  ],
  '`POST /referrals/{id}/accept`, `…/decline`': [
    'POST /referrals/{id}/accept',
    'POST /referrals/{id}/decline',
  ],
  '`POST /patients/{patientId}/document-uploads`, `…/complete`': [
    'POST /patients/{patientId}/document-uploads',
    'POST /document-uploads/{documentId}/complete',
  ],
  '`GET /patients/{patientId}/documents`, `POST /documents/{id}/download-url`': [
    'GET /patients/{patientId}/documents',
    'POST /documents/{id}/download-url',
  ],
  '`PUT /documents/{id}/classification`, `POST /documents/{id}/confirm`': [
    'PUT /documents/{id}/classification',
    'POST /documents/{id}/confirm',
  ],
  '`POST /documents/{id}/deletion-requests`, `POST /deletion-requests/{id}/decide`': [
    'POST /documents/{id}/deletion-requests',
    'POST /deletion-requests/{id}/decide',
  ],
  '`GET/POST /threads`, `POST /threads/{id}/messages`, `GET /threads/{id}/messages`': [
    'GET /threads',
    'POST /threads',
    'POST /threads/{id}/messages',
    'GET /threads/{id}/messages',
  ],
  '`GET/POST /tasks`, `PATCH /tasks/{id}`': ['GET /tasks', 'POST /tasks', 'PATCH /tasks/{id}'],
  '`GET /alerts/open-ids` (draft 6)': ['GET /alerts/open-ids'],
  '`POST /admin/principals` †': ['POST /admin/principals †'],
  '`POST /admin/role-change-requests` †': ['POST /admin/role-change-requests †'],
  '`POST /admin/role-change-requests/{id}/approve` †, `…/reject` †, `…/cancel`': [
    'POST /admin/role-change-requests/{id}/approve †',
    'POST /admin/role-change-requests/{id}/reject †',
    'POST /admin/role-change-requests/{id}/cancel',
  ],
  '`POST /admin/principals/{id}/kill-switch` †': ['POST /admin/principals/{id}/kill-switch †'],
  '`POST /admin/enrolment-tokens` †, `POST /admin/enrolment-tokens/{id}/approve` †': [
    'POST /admin/enrolment-tokens †',
    'POST /admin/enrolment-tokens/{id}/approve †',
  ],
  '`POST /admin/person-links` †, `…/{id}/approve` †': [
    'POST /admin/person-links †',
    'POST /admin/person-links/{id}/approve †',
  ],
  '`GET/PUT /admin/staff-profiles/{principalId}` †': [
    'GET /admin/staff-profiles/{principalId} †',
    'PUT /admin/staff-profiles/{principalId} †',
  ],
  '`GET/POST /admin/staff-support`, `DELETE /admin/staff-support/{id}` † (draft 6, Proposal G-10)':
    ['GET /admin/staff-support', 'POST /admin/staff-support', 'DELETE /admin/staff-support/{id} †'],
  '`GET/POST /admin/clinicians/{id}/availability-templates`, `PUT/DELETE …/{templateId}`, `GET/POST/DELETE /admin/clinicians/{id}/blocked-times` † (draft 6, TDR-01)':
    [
      'GET /admin/clinicians/{id}/availability-templates',
      'POST /admin/clinicians/{id}/availability-templates',
      'PUT /admin/clinicians/{id}/availability-templates/{templateId}',
      'DELETE /admin/clinicians/{id}/availability-templates/{templateId}',
      'GET /admin/clinicians/{id}/blocked-times †',
      'POST /admin/clinicians/{id}/blocked-times †',
      'DELETE /admin/clinicians/{id}/blocked-times †',
    ],
  '`GET/POST/DELETE /admin/locations/{id}/roster` † (draft 6, TDR-01)': [
    'GET /admin/locations/{id}/roster †',
    'POST /admin/locations/{id}/roster †',
    'DELETE /admin/locations/{id}/roster †',
  ],
  '`GET/POST/PATCH /admin/locations`, `/admin/rooms`, `/admin/opening-hours`, `/admin/holidays` †':
    [
      'GET /admin/locations †',
      'POST /admin/locations †',
      'PATCH /admin/locations †',
      'GET /admin/rooms †',
      'POST /admin/rooms †',
      'PATCH /admin/rooms †',
      'GET /admin/opening-hours †',
      'POST /admin/opening-hours †',
      'PATCH /admin/opening-hours †',
      'GET /admin/holidays †',
      'POST /admin/holidays †',
      'PATCH /admin/holidays †',
    ],
  '`GET/POST/PATCH /admin/services`, `/admin/booking-policies` †': [
    'GET /admin/services †',
    'POST /admin/services †',
    'PATCH /admin/services †',
    'GET /admin/booking-policies †',
    'POST /admin/booking-policies †',
    'PATCH /admin/booking-policies †',
  ],
  '`GET/POST /admin/consent-templates`, `/admin/questionnaire-templates`, `POST …/{id}/publish` †':
    [
      'GET /admin/consent-templates',
      'POST /admin/consent-templates',
      'GET /admin/questionnaire-templates',
      'POST /admin/questionnaire-templates',
      'POST /admin/consent-templates/{id}/publish †',
      'POST /admin/questionnaire-templates/{id}/publish †',
    ],
  '`GET/PUT /admin/feature-flags`, `/admin/banners`, `/admin/settings`, `/admin/operating-states` †':
    [
      'GET /admin/feature-flags †',
      'PUT /admin/feature-flags †',
      'GET /admin/banners †',
      'PUT /admin/banners †',
      'GET /admin/settings †',
      'PUT /admin/settings †',
      'GET /admin/operating-states †',
      'PUT /admin/operating-states †',
    ],
  '`GET/POST /admin/message-templates`, `POST …/{id}/render-check`, `POST …/{id}/publish` †': [
    'GET /admin/message-templates',
    'POST /admin/message-templates',
    'POST /admin/message-templates/{id}/render-check',
    'POST /admin/message-templates/{id}/publish †',
  ],
  '`GET/PUT /admin/alert-settings` †': [
    'GET /admin/alert-settings †',
    'PUT /admin/alert-settings †',
  ],
  '`GET /admin/vital-ranges`, `POST /admin/vital-ranges` †, `POST /admin/vital-ranges/{id}/retire` † (draft 8, AL-02)':
    [
      'GET /admin/vital-ranges',
      'POST /admin/vital-ranges †',
      'POST /admin/vital-ranges/{id}/retire †',
    ],
  '`GET /admin/integrations`, `PATCH /admin/integrations/{id}` †': [
    'GET /admin/integrations',
    'PATCH /admin/integrations/{id} †',
  ],
  '`PUT /admin/integrations/{id}/secrets/{name}` †': [
    'PUT /admin/integrations/{id}/secrets/{name} †',
  ],
  '`POST /admin/integrations/{id}/inbound-secret-requests` †, `…/{requestId}/approve` †': [
    'POST /admin/integrations/{id}/inbound-secret-requests †',
    'POST /admin/integrations/{id}/inbound-secret-requests/{requestId}/approve †',
  ],
  '`POST /admin/integrations/{id}/test` †': ['POST /admin/integrations/{id}/test †'],
  '`GET /admin/operations/summary`, `GET /admin/dead-letters`, `POST /admin/dead-letters/{id}/retry` †':
    [
      'GET /admin/operations/summary',
      'GET /admin/dead-letters',
      'POST /admin/dead-letters/{id}/retry †',
    ],
  '`POST /admin/audit-exports` †, `GET /admin/audit-exports/{id}`, `POST /admin/audit-exports/{id}/download-url` †':
    [
      'POST /admin/audit-exports †',
      'GET /admin/audit-exports/{id}',
      'POST /admin/audit-exports/{id}/download-url †',
    ],
  '`GET /admin/btg-grants?reviewStatus`, `POST /admin/btg-grants/{id}/review`': [
    'GET /admin/btg-grants',
    'POST /admin/btg-grants/{id}/review',
  ],
  '`GET /admin/privacy-requests`, `POST /admin/privacy-requests/{id}/verify-identity`, `…/decide`':
    [
      'GET /admin/privacy-requests',
      'POST /admin/privacy-requests/{id}/verify-identity',
      'POST /admin/privacy-requests/{id}/decide',
    ],
  '`GET/POST/PATCH /admin/incidents`': [
    'GET /admin/incidents',
    'POST /admin/incidents',
    'PATCH /admin/incidents',
  ],
  '`GET /public/v1/services`, `/locations`, `/clinicians`': [
    'GET /public/v1/services',
    'GET /public/v1/locations',
    'GET /public/v1/clinicians',
  ],
  '`POST /partner/v1/*`': ['POST /partner/v1/*'],
};

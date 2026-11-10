export const NOW = new Date('2026-06-01T12:00:00Z');
export const goodBootstrap = (o = {}) => ({
  state: 'approved',
  environment: 'staging',
  permitted_actions: ['bootstrap'],
  g3_reference: 'G3-staging-1',
  not_before: '2026-06-01T08:00:00Z',
  expires: '2026-06-02T08:00:00Z',
  approvals: ['custodian-a', 'custodian-b'],
  applier: 'platform-admin',
  ticket_ref: 'TICKET-1',
  custodians: [
    {
      identity_center_user_id: 'u-1',
      role_arn:
        'arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_custodian_a_1',
    },
    {
      identity_center_user_id: 'u-2',
      role_arn:
        'arn:aws:iam::111111111111:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_custodian_b_2',
    },
  ],
  enrollees: [
    {
      handle: 'admin-one',
      display_name: 'Admin One',
      identity_arn: 'arn:aws:iam::111111111111:role/e1',
    },
    {
      handle: 'admin-two',
      display_name: 'Admin Two',
      identity_arn: 'arn:aws:iam::111111111111:role/e2',
    },
  ],
  security_contact_verified_at: '2026-05-30T12:00:00Z',
  security_contact_test_ref: 'step0-2026-05-30',
  ...o,
});
export const goodArchive = (o = {}) => ({
  state: 'approved',
  environment: 'production',
  permitted_actions: ['audit-archive', 'archive:audit.event_2025_01'],
  g3_reference: 'G3-prod-1',
  not_before: '2026-06-01T08:00:00Z',
  expires: '2026-06-02T08:00:00Z',
  approvals: ['approver-a', 'approver-b'],
  applier: 'platform-admin',
  ...o,
});

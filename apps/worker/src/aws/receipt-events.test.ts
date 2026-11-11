import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReceipt } from '../jobs/notifications/receipt.js';
import { sesEventToReceipt, smsEventToReceipt } from './receipt-events.js';

const mail = { messageId: 'm-1', timestamp: '2026-01-01T10:00:00.000Z' };

test('SES delivery, permanent bounce, transient bounce and complaint map to receipt statuses', () => {
  assert.deepEqual(
    sesEventToReceipt({
      eventType: 'Delivery',
      mail,
      delivery: { timestamp: '2026-01-01T10:00:02.000Z' },
    }),
    {
      providerMessageId: 'm-1',
      eventId: 'm-1:delivery',
      status: 'delivered',
      occurredAt: '2026-01-01T10:00:02.000Z',
    },
  );
  assert.equal(
    sesEventToReceipt({
      eventType: 'Bounce',
      mail,
      bounce: { bounceType: 'Permanent', feedbackId: 'f1', timestamp: mail.timestamp },
    })?.status,
    'bounced',
  );
  assert.equal(
    sesEventToReceipt({
      eventType: 'Bounce',
      mail,
      bounce: { bounceType: 'Transient', feedbackId: 'f2', timestamp: mail.timestamp },
    })?.status,
    'failed',
  );
  assert.equal(
    sesEventToReceipt({
      eventType: 'Complaint',
      mail,
      complaint: { feedbackId: 'f3', timestamp: mail.timestamp },
    })?.eventId,
    'f3',
  );
});

test('an SNS Notification envelope is unwrapped; other or malformed events are dropped', () => {
  const inner = { eventType: 'Delivery', mail, delivery: { timestamp: mail.timestamp } };
  assert.equal(
    sesEventToReceipt({ Type: 'Notification', Message: JSON.stringify(inner) })?.status,
    'delivered',
  );
  assert.equal(sesEventToReceipt({ eventType: 'Send', mail }), undefined);
  assert.equal(sesEventToReceipt({ Type: 'Notification', Message: '{' }), undefined);
  assert.equal(sesEventToReceipt('x'), undefined);
  assert.equal(sesEventToReceipt({ eventType: 'Delivery', mail: {}, delivery: {} }), undefined);
});

test('SMS events map; pending is not a result', () => {
  assert.deepEqual(
    smsEventToReceipt({
      eventType: 'TEXT_DELIVERED',
      messageId: 's-1',
      eventTimestamp: 1767261600000,
    }),
    {
      providerMessageId: 's-1',
      eventId: 's-1:TEXT_DELIVERED',
      status: 'delivered',
      occurredAt: '2026-01-01T10:00:00.000Z',
    },
  );
  assert.equal(
    smsEventToReceipt({
      eventType: 'TEXT_CARRIER_UNREACHABLE',
      messageId: 's-1',
      eventTimestamp: 1767261600000,
    })?.status,
    'failed',
  );
  assert.equal(
    smsEventToReceipt({ eventType: 'TEXT_PENDING', messageId: 's-1', eventTimestamp: 1 }),
    undefined,
  );
});

test('output is exactly what notifications.on_receipt parses', () => {
  const r = sesEventToReceipt({
    eventType: 'Delivery',
    mail,
    delivery: { timestamp: mail.timestamp },
  });
  const p = parseReceipt(Buffer.from(JSON.stringify(r)));
  assert.equal(p?.providerMessageId, 'm-1');
  assert.equal(p?.status, 'delivered');
});

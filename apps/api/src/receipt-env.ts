// Delivery-receipt route configuration (INT-N2). Optional as a whole: with none of the variables set the route answers 404 and no
// receipt is recorded. If any is set the set must be complete and valid, and a bad value stops the start with its NAME.
//   EHR_SNS_RECEIPT_REGION        AWS Region of the SNS endpoint (pins the signing-certificate and SubscribeURL host)
//   EHR_SNS_RECEIPT_TOPICS        comma list of `<TopicArn>=email` or `<TopicArn>=sms` (also the TopicArn allowlist)
//   EHR_SNS_TRUST_ANCHORS_PEM     optional PEM certificates the SNS signing certificate must chain to
//   EHR_SNS_RECEIPT_MAX_AGE_SECONDS  optional, 60..86400 (default 3600)
import { X509Certificate } from 'node:crypto';
import { ConfigError } from '@ehr/kernel';
import type { ReceiptPorts } from './composition.js';

const PEM = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g;
const ARN = /^arn:aws:sns:[a-z]{2}(?:-[a-z]+)+-\d:\d{12}:[A-Za-z0-9_-]{1,256}$/;
const REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function loadReceiptEnv(
  env: Readonly<Record<string, string | undefined>>,
): ReceiptPorts | undefined {
  const region = env['EHR_SNS_RECEIPT_REGION']?.trim() ?? '';
  const topicsRaw = env['EHR_SNS_RECEIPT_TOPICS']?.trim() ?? '';
  const anchorsRaw = env['EHR_SNS_TRUST_ANCHORS_PEM'] ?? '';
  const ageRaw = env['EHR_SNS_RECEIPT_MAX_AGE_SECONDS']?.trim() ?? '';
  if (region === '' && topicsRaw === '' && anchorsRaw.trim() === '' && ageRaw === '')
    return undefined;

  const problems: string[] = [];
  if (!REGION.test(region)) problems.push('EHR_SNS_RECEIPT_REGION must be an AWS Region name');
  const topics = new Map<string, 'email' | 'sms'>();
  for (const item of topicsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)) {
    const [arn, channel, ...rest] = item.split('=');
    if (
      arn === undefined ||
      !ARN.test(arn) ||
      (channel !== 'email' && channel !== 'sms') ||
      rest.length > 0 ||
      topics.has(arn)
    ) {
      problems.push('EHR_SNS_RECEIPT_TOPICS must be a list of <TopicArn>=email|sms, each ARN once');
      break;
    }
    topics.set(arn, channel);
  }
  if (topics.size === 0 && !problems.some((p) => p.startsWith('EHR_SNS_RECEIPT_TOPICS')))
    problems.push('EHR_SNS_RECEIPT_TOPICS is required when the receipt route is configured');

  const anchors = anchorsRaw.match(PEM) ?? [];
  if (anchorsRaw.trim() !== '') {
    if (anchors.length === 0 || anchorsRaw.replace(PEM, '').trim() !== '')
      problems.push('EHR_SNS_TRUST_ANCHORS_PEM must hold only PEM certificates');
    else
      for (const a of anchors)
        try {
          new X509Certificate(a);
        } catch {
          problems.push('EHR_SNS_TRUST_ANCHORS_PEM holds a certificate that does not parse');
          break;
        }
  }
  let maxAge: number | undefined;
  if (ageRaw !== '') {
    maxAge = Number(ageRaw);
    if (!Number.isInteger(maxAge) || maxAge < 60 || maxAge > 86_400)
      problems.push('EHR_SNS_RECEIPT_MAX_AGE_SECONDS must be an integer from 60 to 86400');
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    region,
    topics,
    ...(anchors.length > 0 ? { trustAnchorsPem: anchors } : {}),
    ...(maxAge === undefined ? {} : { maxAgeSeconds: maxAge }),
  };
}

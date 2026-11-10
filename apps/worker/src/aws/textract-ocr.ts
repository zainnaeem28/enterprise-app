// Textract as the OCR classification slot (AWS-BE-4): `OcrProviderClient.classify` reads the CLEAN object by S3 reference
// (textract:DetectDocumentText, synchronous), looks for a few unambiguous phrases and answers one of the closed classification list or
// null. It only ever SUGGESTS; staff confirm. The recognised text is used in memory and never logged, returned or stored. A file Textract
// cannot read synchronously (a multi-page PDF, an unsupported type) is "no suggestion", not a failure.
import { DetectDocumentTextCommand, TextractClient } from '@aws-sdk/client-textract';
import { AwsConfigError, awsSettings, type Env, type Logger } from '@ehr/kernel';
import { OcrAdapter, OcrProviderError } from '../jobs/documents/adapters.js';
import type { OcrProviderClient } from '../jobs/documents/adapters.js';
import type { Bucket } from '../jobs/documents/ports.js';

export const OCR_SWITCH = 'EHR_OCR';

/** First rule that matches wins; every phrase needs to be on the page (lower-cased, whitespace collapsed). */
const RULES: readonly { type: string; all: readonly RegExp[] }[] = [
  { type: 'id_document', all: [/passport|driver'?s? licen[cs]e|identity card/] },
  { type: 'insurance_card', all: [/member id|subscriber|policy (no|number)|group (no|number)/] },
  { type: 'referral_letter', all: [/referral|referred by|i am referring/] },
  { type: 'consent', all: [/consent/, /signature|signed/] },
];

export function classifyText(text: string): string | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  for (const r of RULES) if (r.all.every((re) => re.test(t))) return r.type;
  return null;
}

const nameOf = (e: unknown): string => (e as { name?: string } | null)?.name ?? '';
const statusOf = (e: unknown): number | undefined =>
  (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;

/** Errors that mean "this file cannot be read here": no suggestion, no retry. */
const UNREADABLE = new Set([
  'UnsupportedDocumentException',
  'InvalidS3ObjectException',
  'BadDocumentException',
  'DocumentTooLargeException',
]);

export class TextractOcrClient implements OcrProviderClient {
  constructor(
    private readonly textract: Pick<TextractClient, 'send'>,
    private readonly buckets: Readonly<Record<Bucket, string>>,
  ) {}

  async classify(req: {
    bucket: Bucket;
    key: string;
    signal: AbortSignal;
  }): Promise<{ documentType: string | null; vendorRef?: string }> {
    try {
      const r = await this.textract.send(
        new DetectDocumentTextCommand({
          Document: { S3Object: { Bucket: this.buckets[req.bucket], Name: req.key } },
        }),
        { abortSignal: req.signal },
      );
      const text = (r.Blocks ?? [])
        .filter((b) => b.BlockType === 'LINE')
        .map((b) => b.Text ?? '')
        .join(' ');
      const id = r.$metadata?.requestId;
      return { documentType: classifyText(text), ...(id === undefined ? {} : { vendorRef: id }) };
    } catch (e) {
      const n = nameOf(e);
      if (UNREADABLE.has(n)) return { documentType: null };
      const s = statusOf(e);
      throw new OcrProviderError(
        s === undefined || s === 429 || s >= 500,
        s,
        n || 'textract_error',
      );
    }
  }

  health(req: { signal: AbortSignal }): Promise<{ ok: boolean }> {
    // Textract has no free probe call; a probe would be a billed analysis. Health is "the adapter is configured".
    void req;
    return Promise.resolve({ ok: true });
  }
}

/** `EHR_OCR=textract` selects it; the two document buckets are then required. Any other value stops the start. */
export function selectTextractAdapter(env: Env, log: Logger): OcrAdapter | undefined {
  const v = (env[OCR_SWITCH] ?? '').trim();
  if (v === '') {
    log.info('not configured', { adapter: 'OCR (Textract)', vars: OCR_SWITCH });
    return undefined;
  }
  if (v !== 'textract') throw new AwsConfigError(`OCR (${OCR_SWITCH} must be "textract")`, [], []);
  const quarantine = (env['EHR_S3_DOCS_QUARANTINE_BUCKET'] ?? '').trim();
  const clean = (env['EHR_S3_DOCS_CLEAN_BUCKET'] ?? '').trim();
  const missing = [
    ...(quarantine === '' ? ['EHR_S3_DOCS_QUARANTINE_BUCKET'] : []),
    ...(clean === '' ? ['EHR_S3_DOCS_CLEAN_BUCKET'] : []),
  ];
  if (missing.length > 0) throw new AwsConfigError('OCR (Textract)', missing, [OCR_SWITCH]);
  const s = awsSettings(env, 'OCR (Textract)');
  const client = new TextractClient({
    region: s.region,
    ...(s.endpoint === undefined ? {} : { endpoint: s.endpoint }),
  });
  return new OcrAdapter(new TextractOcrClient(client, { quarantine, clean }));
}

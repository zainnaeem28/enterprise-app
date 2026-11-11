import { getPayload } from 'payload';
import config from '../payload.config';
import { seedContent } from './seed';

// `pnpm --filter @ehr/cms seed` (payload run). Needs the CMS settings; touches only the CMS database.
const payload = await getPayload({ config });
const result = await seedContent(payload);
payload.logger.info(`cms seed: site-content ${result.siteContent}`);
await payload.db.destroy?.();
process.exit(0);

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from 'payload';
import { postgresAdapter } from '@payloadcms/db-postgres';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { loadCmsEnv } from './lib/env';
import { Users } from './collections/users';
import { Pages } from './collections/pages';
import { Banners } from './collections/banners';
import { Faqs } from './collections/faqs';
import { brand } from './admin/brand';
import { migrations } from '../migrations';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Fails closed at start-up if production database variables are present or CMS settings are missing (lib/env.ts).
const env = loadCmsEnv(process.env);

export default buildConfig({
  secret: env.payloadSecret,
  serverURL: env.publicUrl,
  cors: [], // same-origin only: the admin and content API share the `cms.` host
  csrf: [env.publicUrl],
  editor: lexicalEditor(),
  collections: [Users, Pages, Banners, Faqs],
  db: postgresAdapter({
    pool: { connectionString: env.databaseUrl, max: 5 },
    migrationDir: './migrations',
    prodMigrations: migrations,
  }),
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: dirname,
      importMapFile: path.resolve(dirname, 'app/(payload)/admin/importMap.ts'),
    },
    meta: { titleSuffix: ` - ${brand.name}`, description: 'Website editor' },
    components: {
      graphics: { Logo: '/admin/Logo#Logo', Icon: '/admin/Logo#Icon' },
      beforeLogin: ['/admin/SignIn#SignIn'],
    },
  },
  graphQL: { disable: true },
  telemetry: false,
  typescript: { outputFile: path.resolve(dirname, 'payload-types.ts') },
});

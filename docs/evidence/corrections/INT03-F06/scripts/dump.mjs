const admin = process.env.EHR_TEST_ADMIN_URL;
const pg = (await import('/tmp/h314/c48/node_modules/pg/lib/index.js')).default;
const db=process.argv[2];
const x=new URL(admin);x.pathname='/'+db;
const c=new pg.Client({connectionString:x.toString()});await c.connect();
const Q={
tables:`SELECT n.nspname||'.'||c.relname||' kind='||c.relkind::text||' owner='||pg_get_userbyid(c.relowner)||' rls='||c.relrowsecurity||'/'||c.relforcerowsecurity||' acl='||coalesce(c.relacl::text,'') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','S','f')`,
columns:`SELECT a.attrelid::regclass||'.'||a.attname||' '||format_type(a.atttypid,a.atttypmod)||' nn='||a.attnotnull||' def='||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||' acl='||coalesce(a.attacl::text,'') FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m')`,
constraints:`SELECT conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid)||' validated='||convalidated FROM pg_constraint WHERE connamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname ~ '^pg_' OR nspname='information_schema')`,
indexes:`SELECT schemaname||'.'||indexname||' '||indexdef FROM pg_indexes WHERE schemaname !~ '^pg_' AND schemaname<>'information_schema'`,
triggers:`SELECT tgrelid::regclass||' '||tgname||' enabled='||tgenabled::text||' '||pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal`,
policies:`SELECT schemaname||'.'||tablename||' '||policyname||' '||permissive||' '||array_to_string(roles,',')||' '||cmd||' using='||coalesce(qual,'')||' check='||coalesce(with_check,'') FROM pg_policies`,
functions:`SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||') owner='||pg_get_userbyid(p.proowner)||' secdef='||p.prosecdef||' cfg='||coalesce(p.proconfig::text,'')||' acl='||coalesce(p.proacl::text,'')||' md5='||md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'`,
schemas:`SELECT nspname||' owner='||pg_get_userbyid(nspowner)||' acl='||coalesce(nspacl::text,'') FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema'`,
types:`SELECT t.typnamespace::regnamespace||'.'||t.typname||' '||t.typtype::text FROM pg_type t WHERE t.typnamespace NOT IN (SELECT oid FROM pg_namespace WHERE nspname ~ '^pg_' OR nspname='information_schema') AND t.typtype IN ('e','d','c') AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.reltype=t.oid AND c.relkind<>'c')`,
enums:`SELECT t.typname||'='||string_agg(e.enumlabel,',' ORDER BY e.enumsortorder) FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid GROUP BY t.typname`,
defacl:`SELECT pg_get_userbyid(defaclrole)||' '||defaclobjtype::text||' '||defaclacl::text FROM pg_default_acl`,
history:`SELECT version||' '||name FROM migration.schema_migration`,
};
for(const [k,q] of Object.entries(Q)){const r=await c.query(q);console.log(`## ${k}`);for(const l of r.rows.map(r=>Object.values(r)[0]).sort())console.log(l);}
await c.end();

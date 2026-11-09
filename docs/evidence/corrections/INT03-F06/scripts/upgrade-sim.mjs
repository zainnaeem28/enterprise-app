// Upgrade simulation: INT-02 (275fdd4) database -> c48db50, by history surgery + manual ordered apply of the files the runner cannot plan.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const admin = process.env.EHR_TEST_ADMIN_URL;
const pg = (await import('/tmp/h314/c48/node_modules/pg/lib/index.js')).default;
const k = await import('/tmp/h314/c48/packages/kernel/dist/db/migrate/index.js');
const u=(user,d)=>{const x=new URL(admin);x.username=user;x.password='';x.pathname='/'+d;return x.toString();};
const c=new pg.Client({connectionString:u('app_owner','h314_up')});await c.connect();
const files=k.loadMigrations('/tmp/h314/c48/db/migrations');
const applied=(await c.query('SELECT version,name,sha256 FROM migration.schema_migration ORDER BY version')).rows;
console.log('applied before:',applied.length);
// 1) history surgery: INT-02 1600..1603 are the merge-guard files, now 1604..1607 (content differs by comments only -> new sha)
const map={1600:1604,1601:1605,1602:1606,1603:1607};
await c.query('BEGIN');
for(const [o,n] of Object.entries(map)){const f=files.find(x=>x.version===n);
  const r=await c.query('UPDATE migration.schema_migration SET version=$1,name=$2,sha256=$3 WHERE version=$4 RETURNING 1',[n,f.name,f.sha256,Number(o)]);
  console.log('rename',o,'->',n,f.name,r.rowCount);}
await c.query('COMMIT');
// 2) runner view of the surgically-fixed DB
const done=new Set((await c.query('SELECT version FROM migration.schema_migration')).rows.map(r=>r.version));
try{ k.planPending(files,(await c.query('SELECT version,name,sha256 FROM migration.schema_migration ORDER BY version')).rows.map(r=>({version:r.version,name:r.name,sha256:r.sha256}))); console.log('planPending OK'); }catch(e){console.log('planPending after surgery:',e.code,e.message.slice(0,200));}
// 3) apply pending files in file order, bypassing the OUT_OF_ORDER guard only
const pending=files.filter(f=>!done.has(f.version));
console.log('pending',pending.map(f=>f.file).join(' '));
for(const f of pending){ if(f.header.transaction==='none'){ for(const st of k.splitStatements?k.splitStatements(f.sql):[{text:f.sql}]) await c.query(st.text); await c.query('INSERT INTO migration.schema_migration(version,name,sha256) VALUES($1,$2,$3)',[f.version,f.name,f.sha256]); console.log('applied(no-tx)',f.file); continue;} await c.query('BEGIN'); try{ await c.query(f.sql); await c.query('INSERT INTO migration.schema_migration(version,name,sha256) VALUES($1,$2,$3)',[f.version,f.name,f.sha256]); await c.query('COMMIT'); console.log('applied',f.file);}catch(e){await c.query('ROLLBACK');console.log('FAIL',f.file,e.message);process.exit(1);} }
await c.end();

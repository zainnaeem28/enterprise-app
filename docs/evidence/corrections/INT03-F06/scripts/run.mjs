import { execFileSync } from 'node:child_process';
const admin = process.env.EHR_TEST_ADMIN_URL;
const pgPath = '/tmp/h314/c48/node_modules/pg/lib/index.js';
const pg = (await import(pgPath)).default;
const urlFor=(u,d)=>{const x=new URL(admin);x.username=u;x.password='';x.pathname='/'+d;return x.toString();};
// keep admin password for admin
const adminFor=(d)=>{const x=new URL(admin);x.pathname='/'+d;return x.toString();};
const names={fresh:'h314_fresh',up:'h314_up'};
const a=new pg.Client({connectionString:admin});await a.connect();
for(const n of Object.values(names)){await a.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);await a.query(`CREATE DATABASE ${n}`);}
const run=(tree,cmd,db)=>{try{return execFileSync(process.execPath,[`${tree}/db/tools/migrate.mjs`,cmd],{env:{PATH:process.env.PATH,EHR_DB_ADMIN_URL:adminFor(db),EHR_DB_MIGRATE_URL:urlFor('app_owner',db)},encoding:'utf8',stdio:['ignore','pipe','pipe']}).split('\n').slice(-4).join('\n');}catch(e){return 'EXIT '+e.status+'\n'+(e.stdout||'').split('\n').slice(-4).join('\n')+(e.stderr||'');}};
const out=[];
const step=(l,r)=>{console.log('### '+l+'\n'+r);};
step('fresh bootstrap c48',run('/tmp/h314/c48','bootstrap',names.fresh).slice(-200));
step('fresh migrate c48',run('/tmp/h314/c48','migrate',names.fresh));
step('upgrade bootstrap int02',run('/tmp/h314/int02','bootstrap',names.up).slice(-200));
step('upgrade migrate int02 (275fdd4)',run('/tmp/h314/int02','migrate',names.up));
step('upgrade PLAN c48',run('/tmp/h314/c48','plan',names.up));
step('upgrade migrate c48',run('/tmp/h314/c48','migrate',names.up));
await a.end();

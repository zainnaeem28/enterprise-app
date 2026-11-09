const root=process.argv[2];
const k=await import(root+'/packages/kernel/dist/index.js');
const {composeWorker}=await import(root+'/apps/worker/dist/compose.js');
const {WORKER_CRONTAB}=await import(root+'/apps/worker/dist/job-registry.js');
const {createPool,startWorker}=await import(root+'/apps/worker/dist/runner.js');
try{
const cfg=k.loadConfig({...process.env,EHR_DEPLOYABLE:'worker'});
const log=k.createLogger({sink:l=>console.log(l)});
const pool=await createPool(cfg);
const {tasks,registry}=await composeWorker({cfg,pool,log,patientHost:process.env.EHR_PATIENT_HOST,qrKey:process.env.EHR_CHECKIN_QR_KEY});
const w=await startWorker({cfg,pool,log,registry,tasks,crontab:WORKER_CRONTAB});
console.log('booted'); await w.stop(); await pool.end();
}catch(e){console.log('ERR',e.stack?.slice(0,800))}

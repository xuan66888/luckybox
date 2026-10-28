import {mkdirSync,writeFileSync,renameSync,readFileSync,statfsSync} from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const mode=process.argv[2];
if(!['health','backup'].includes(mode))throw new Error('Use health or backup');
const data=path.resolve(process.env.DATA_DIR??'./data'),folder=path.join(data,'ops');
mkdirSync(folder,{recursive:true,mode:0o700});
const file=path.join(folder,mode+'.json');
let prior={};try{prior=JSON.parse(readFileSync(file,'utf8'));}catch{/* First run. */}
const state={checkedAt:new Date().toISOString(),ok:false,consecutiveFailures:Number(prior.consecutiveFailures??0)+1,externalNotificationConfigured:false};
try{
  if(mode==='health'){
    const origin=process.env.HEALTH_ORIGIN??'http://127.0.0.1:3000';
    const url=new URL(origin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid health origin');
    for(const route of ['/health/live','/health/ready']){
      const response=await fetch(new URL(route,url),{signal:AbortSignal.timeout(10000),redirect:'error'});
      const body=await response.json();if(!response.ok||!['ok','ready'].includes(body.status))throw Error('Health endpoint not ready');
    }
    const disk=statfsSync(data);state.freeBytes=Number(disk.bavail)*Number(disk.bsize);
    if(state.freeBytes<128*1024*1024)throw Error('Available data disk below128MiB');
    state.service='ready';
  }else{
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('./backup-restore.mjs',import.meta.url))],{env:process.env,encoding:'utf8',timeout:300000,maxBuffer:1024*1024});
    if(result.status!==0||result.error)throw Error('Consistent backup or isolated restore check failed');
    const proof=JSON.parse(result.stdout.trim());
    if(proof.integrity!=='ok'||proof.restoreHashes!=='match'||proof.foreignKeys!=='ok')throw Error('Backup verification failed');
    state.backup=path.basename(proof.backup);state.files=proof.files;state.integrity=proof.integrity;state.restoreHashes=proof.restoreHashes;state.foreignKeys=proof.foreignKeys;
    state.offHostCopyVerified=false;
  }
  state.ok=true;state.consecutiveFailures=0;
}catch{
  state.error=mode==='health'?'服務／資料庫或磁碟檢查失敗，請檢查主機紀錄':'備份或隔離還原驗證失敗，請檢查主機紀錄';process.exitCode=1;
}
const temporary=file+'.tmp';writeFileSync(temporary,JSON.stringify(state,null,2)+'\n',{mode:0o600});renameSync(temporary,file);
console.log(JSON.stringify({mode,...state}));

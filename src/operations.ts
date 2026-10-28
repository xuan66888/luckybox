import path from 'node:path';
import {readFileSync} from 'node:fs';
import type {Config} from './config.js';
export function operationsStatus(config:Config){
  const read=(name:'health'|'backup')=>{try{
    const value=JSON.parse(readFileSync(path.join(config.dataDir,'ops',name+'.json'),'utf8'));
    const checkedAt=typeof value.checkedAt==='string'?value.checkedAt:null;
    const stale=!checkedAt||!Number.isFinite(Date.parse(checkedAt))||Date.now()-Date.parse(checkedAt)>(name==='health'?15*60000:36*3600000);
    return {checkedAt,ok:value.ok===true,stale,consecutiveFailures:Number(value.consecutiveFailures)||0,integrity:value.integrity==='ok'?'ok':null,restoreHashes:value.restoreHashes==='match'?'match':null,externalNotificationConfigured:false,offHostCopyVerified:false};
  }catch{return {checkedAt:null,ok:false,stale:true,consecutiveFailures:0,integrity:null,restoreHashes:null,externalNotificationConfigured:false,offHostCopyVerified:false};}};
  return {health:read('health'),backup:read('backup')};
}

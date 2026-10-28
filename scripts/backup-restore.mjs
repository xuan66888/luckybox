import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync,existsSync,readdirSync,copyFileSync,readFileSync,writeFileSync,mkdtempSync,rmSync,statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash,randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
// Consistent SQLite online backup, immutable content-addressed uploads, restore drill.
// Production operators must copy the result to encrypted off-host storage and test retention.
const source=path.resolve(process.env.DATA_DIR??'./data'),root=path.resolve(process.env.BACKUP_DIR??path.join(source,'backups'));
assert.ok(existsSync(path.join(source,'luckybox.sqlite')),'Source database does not exist');
mkdirSync(root,{recursive:true,mode:0o700});
const dest=path.join(root,'snapshot-'+Date.now()+'-'+randomUUID());mkdirSync(dest,{mode:0o700});
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex'),manifest={};
const db=new DatabaseSync(path.join(source,'luckybox.sqlite'),{readOnly:true});
try{await backup(db,path.join(dest,'luckybox.sqlite'));}finally{db.close();}
manifest['luckybox.sqlite']=hash(path.join(dest,'luckybox.sqlite'));
mkdirSync(path.join(dest,'uploads'),{mode:0o700});
if(existsSync(path.join(source,'uploads')))for(const file of readdirSync(path.join(source,'uploads'))){assert.match(file,/^[a-f0-9-]{36}\.webp$/);assert.ok(statSync(path.join(source,'uploads',file)).isFile());copyFileSync(path.join(source,'uploads',file),path.join(dest,'uploads',file));manifest['uploads/'+file]=hash(path.join(dest,'uploads',file));}
writeFileSync(path.join(dest,'manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),files:manifest},null,2),{mode:0o600});
const restored=mkdtempSync(path.join(os.tmpdir(),'luckybox-recovery-'));
try{
  for(const [file,expected]of Object.entries(manifest)){const to=path.join(restored,file);mkdirSync(path.dirname(to),{recursive:true});copyFileSync(path.join(dest,file),to);assert.equal(hash(to),expected);}
  const check=new DatabaseSync(path.join(restored,'luckybox.sqlite'),{readOnly:true});
  try{assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(check.prepare('PRAGMA foreign_key_check').all().length,0);const uploadCount=check.prepare('SELECT COUNT(*) n FROM uploads').get().n;assert.ok(Object.keys(manifest).length-1>=uploadCount,'Missing registered upload files');}finally{check.close();}
  console.log(JSON.stringify({backup:dest,files:Object.keys(manifest).length,restoreHashes:'match',integrity:'ok',foreignKeys:'ok',liveDataUnchanged:true}));
}finally{assert.ok(path.resolve(restored).startsWith(path.join(os.tmpdir(),'luckybox-recovery-')));rmSync(restored,{recursive:true,force:true});}

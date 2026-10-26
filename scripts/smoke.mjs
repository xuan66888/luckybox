import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const directory = await mkdtemp(path.join(os.tmpdir(),'luckybox-smoke-'));
const password = randomBytes(24).toString('base64url');
const env = {...process.env,NODE_ENV:'production',PUBLIC_ORIGIN:'https://smoke.example.test',HOST:'127.0.0.1',PORT:'0',DATA_DIR:directory,BACKUP_DIR:path.join(directory,'backups'),DEV_INITIAL_POINTS:'0',ADMIN_EMAIL:'smoke@example.test',ADMIN_PASSWORD:password,ALLOW_PAID_DRAWS:'false',MANUAL_TOPUPS_ENABLED:'false'};
async function command(args) { return await new Promise((resolve,reject) => { const child = spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']}); let output=''; child.stdout.on('data',d => { output+=d; }); child.stderr.on('data',d => { output+=d; }); child.once('error',reject); child.once('exit',code => code === 0 ? resolve(output) : reject(new Error(output))); }); }
async function start() {
  const child = spawn(process.execPath,['dist/server.js'],{env,stdio:['ignore','pipe','pipe']});
  const port = await new Promise((resolve,reject) => {
    let output=''; const timeout=setTimeout(() => { child.kill(); reject(new Error('Startup timeout')); },15000);
    child.stdout.on('data',chunk => { output += chunk; const match = /"event":"ready"[^\n]*"port":(\d+)/.exec(output); if (match) { clearTimeout(timeout); resolve(Number(match[1])); } });
    child.once('error',reject); child.once('exit',code => { clearTimeout(timeout); reject(new Error(`Server exited early: ${code}`)); });
  });
  return {child,origin:`http://127.0.0.1:${port}`};
}
async function stop(child) { await new Promise(resolve => { child.once('exit',resolve); child.kill('SIGTERM'); }); }
try {
  await command(['dist/cli.js','migrate']); await command(['dist/cli.js','seed']); await command(['dist/cli.js','seed']);
  for (let i=0;i<2;i++) {
    const {child,origin} = await start();
    try {
      assert.equal((await fetch(origin+'/health/live')).status,200); assert.equal((await fetch(origin+'/health/ready')).status,200);
      const home=await fetch(origin); assert.equal(home.status,200); assert.match(await home.text(),/LUCKYBOX/);
      assert.equal((await fetch(origin+'/app.js')).status,200);
      assert.equal((await fetch(origin+'/investor.html')).status,404);
      assert.equal((await fetch(origin+'/investor.js')).status,404);
      for (const asset of ['/app.css','/holo.css','/assets/luckybox-hero.png','/favicon.svg']) {
        const response = await fetch(origin+asset); assert.equal(response.status,200,asset);
        assert.ok((await response.arrayBuffer()).byteLength > 0, `${asset} is not empty`);
      }
      assert.deepEqual(await (await fetch(origin+'/api/pools')).json(),[], 'Production seed contains no presentation fixtures');
      const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email:env.ADMIN_EMAIL,password})});
      assert.equal(login.status,200); assert.match(login.headers.get('set-cookie'),/__Host-lb_session=/); assert.match(login.headers.get('set-cookie'),/Secure/); assert.match(login.headers.get('set-cookie'),/HttpOnly/);
      assert.match(login.headers.get('strict-transport-security'),/max-age=31536000/);
      assert.equal((await fetch(origin+'/.env')).status,404); assert.equal((await fetch(origin+'/src/server.ts')).status,404);
    } finally { await stop(child); }
  }
  await command(['dist/cli.js','backup']); const files = await readdir(env.BACKUP_DIR); assert.equal(files.length,1);
  const restored = new DatabaseSync(path.join(env.BACKUP_DIR,files[0]),{readOnly:true});
  try { assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok'); assert.equal(restored.prepare('SELECT COUNT(*) n FROM users').get().n,1); } finally { restored.close(); }
  console.log('PASS: production migrations, idempotent seed, start, static assets, health, secure auth cookie, restart persistence, secret-path denial, consistent backup. TLS termination itself is supplied by the deployment proxy.');
} finally { assert.ok(path.resolve(directory).startsWith(path.join(os.tmpdir(),'luckybox-smoke-'))); await rm(directory,{recursive:true,force:true}); }

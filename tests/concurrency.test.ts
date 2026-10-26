import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { fixture, livePool, physicalPool, testPassword } from './helpers.js';
process.env.QUIET_LOGS = 'true';

test('independent server processes competing for seven tickets preserve inventory and balances', {timeout:30000}, async () => {
  const f = await fixture(), children: ChildProcess[] = [];
  try {
    const poolId = await livePool(f,physicalPool(7));
    async function worker(name: string) {
      const child = spawn(process.execPath,['--import','tsx','src/server.ts'],{env:{...process.env,NODE_ENV:'test',DATA_DIR:f.directory,PUBLIC_ORIGIN:f.origin,HOST:'127.0.0.1',PORT:'0',ALLOW_PAID_DRAWS:'true',SETTLEMENT_HOLD_HOURS:'0',QUIET_LOGS:'true'},stdio:['ignore','pipe','pipe']});
      children.push(child);
      const port = await new Promise<number>((resolve,reject) => {
        let output=''; const timer=setTimeout(() => reject(new Error('Worker startup timeout')),10000);
        child.stdout!.on('data',d => { output+=d; const match=/"event":"ready"[^\n]*"port":(\d+)/.exec(output); if(match){clearTimeout(timer);resolve(Number(match[1]));} });
        child.on('error',reject); child.on('exit',code=>{clearTimeout(timer);reject(new Error(`Worker stopped: ${code}`));});
      });
      const origin=`http://127.0.0.1:${port}`;
      const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json'},body:JSON.stringify({email:`${name}@example.test`,password:testPassword})});
      assert.equal(login.status,200); const cookie=login.headers.get('set-cookie')!.split(';')[0], session=await login.json();
      return () => fetch(`${origin}/api/pools/${poolId}/draw`,{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrf,'Idempotency-Key':randomUUID()},body:JSON.stringify({quantity:1})});
    }
    const [a,b] = await Promise.all([worker('player'),worker('other')]);
    const results=await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b)()));
    assert.equal(results.filter(r=>r.status===200).length,7); assert.equal(results.filter(r=>r.status===409).length,13);
    assert.equal(f.store.one('SELECT COUNT(*) n FROM draws')!.n,7);
    assert.equal(f.store.one('SELECT remaining FROM pools WHERE id=?',poolId)!.remaining,0);
    assert.equal(f.store.one('SELECT SUM(remaining) n FROM prizes WHERE pool_id=?',poolId)!.n,0);
    assert.equal(f.store.one('SELECT SUM(points) n FROM users WHERE id IN (?,?)',f.ids.player,f.ids.other)!.n,19300);
    assert.equal(f.store.one('PRAGMA integrity_check')!.integrity_check,'ok');
  } finally {
    await Promise.all(children.map(async child=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}}));
    await f.close();
  }
});

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { z } from 'zod';
import { Store } from './db.js';
import {ensurePracticePool} from './practice.js';
import { readConfig } from './config.js';
import {reconciliation} from './wallet.js';
import { passwordHash, passwordSchema } from './auth.js';
const config = readConfig(), store = new Store(config.dbFile), directory = path.dirname(fileURLToPath(import.meta.url));
try {
  store.migrate(path.join(directory, path.basename(directory) === 'dist' ? 'migrations' : '../migrations'));
  switch (process.argv[2]) {
    case 'practice-pool': {const email=z.email().parse(process.env.PRACTICE_OWNER_EMAIL).toLowerCase();console.log(JSON.stringify(store.tx(()=>ensurePracticePool(store,email))));break;}
    case 'practice-close': {store.tx(()=>{const p=store.one("SELECT id,owner_id FROM practice_pools WHERE code='owner-acceptance-v1'");if(p){store.run("UPDATE practice_pools SET status='cancelled' WHERE id=?",p.id);store.audit(p.owner_id,'practice_pool_close',p.id,{note:'撤下測試池，保留測試歷史'});}});console.log('Practice pool hidden; histories retained.');break;}
    case 'migrate': console.log('Migrations applied.'); break;
    case 'seed': {
      const email = z.email().parse(process.env.ADMIN_EMAIL).toLowerCase();
      const existing = store.one('SELECT role FROM users WHERE email=?', email);
      if (existing) { if (existing.role !== 'admin') throw new Error('Existing account is not an admin; seed will not escalate it'); console.log('Administrator already exists; no changes made.'); break; }
      const password = passwordSchema.parse(process.env.ADMIN_PASSWORD), id = randomUUID(), hash = await passwordHash(password);
      store.tx(() => { store.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,'admin',?)", id, email, 'LUCKYBOX 官方', hash, Date.now()); store.audit(null, 'admin_seed', id); });
      console.log('Administrator created. Remove ADMIN_PASSWORD from the environment. No sample users, pools or balances were seeded.'); break;
    }
    case 'reconcile': {const {items:_items,...totals}=reconciliation(store) as Record<string,any>;console.log(JSON.stringify(totals));if(totals.issues||totals.holdIssues)process.exitCode=1;break;}
    case 'backup': {
      mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
      const file = path.join(config.backupDir, `luckybox-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
      await backup(store.db, file); console.log(`Consistent database backup written: ${file}. Back up uploads separately.`); break;
    }
    default: throw new Error('Use migrate, seed, backup or reconcile');
  }
} finally { store.close(); }

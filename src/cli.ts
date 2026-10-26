import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { backup } from 'node:sqlite';
import { z } from 'zod';
import { Store } from './db.js';
import { readConfig } from './config.js';
import { passwordHash, passwordSchema } from './auth.js';
const config = readConfig(), store = new Store(config.dbFile), directory = path.dirname(fileURLToPath(import.meta.url));
try {
  store.migrate(path.join(directory, path.basename(directory) === 'dist' ? 'migrations' : '../migrations'));
  switch (process.argv[2]) {
    case 'migrate': console.log('Migrations applied.'); break;
    case 'seed': {
      const email = z.email().parse(process.env.ADMIN_EMAIL).toLowerCase();
      const existing = store.one('SELECT role FROM users WHERE email=?', email);
      if (existing) { if (existing.role !== 'admin') throw new Error('Existing account is not an admin; seed will not escalate it'); console.log('Administrator already exists; no changes made.'); break; }
      const password = passwordSchema.parse(process.env.ADMIN_PASSWORD), id = randomUUID(), hash = await passwordHash(password);
      store.tx(() => { store.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,'admin',?)", id, email, 'LUCKYBOX 官方', hash, Date.now()); store.audit(null, 'admin_seed', id); });
      console.log('Administrator created. Remove ADMIN_PASSWORD from the environment. No sample users, pools or balances were seeded.'); break;
    }
    case 'backup': {
      mkdirSync(config.backupDir, { recursive: true, mode: 0o700 });
      const file = path.join(config.backupDir, `luckybox-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
      await backup(store.db, file); console.log(`Consistent database backup written: ${file}. Back up uploads separately.`); break;
    }
    default: throw new Error('Use migrate, seed or backup');
  }
} finally { store.close(); }

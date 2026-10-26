import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  }
  one(sql: string, ...args: SQLInputValue[]): Record<string, any> | undefined { return this.db.prepare(sql).get(...args); }
  all<T extends object = Record<string, any>>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  migrate(directory: string) {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT');
    for (const file of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
      this.tx(() => {
        if (this.one('SELECT name FROM schema_migrations WHERE name=?', file)) return;
        this.db.exec(readFileSync(path.join(directory, file), 'utf8'));
        this.run('INSERT INTO schema_migrations VALUES (?,?)', file, Date.now());
      });
    }
  }
  audit(actor: string | null, action: string, target: string, detail: unknown = {}) {
    this.run('INSERT INTO audit VALUES (?,?,?,?,?,?)', randomUUID(), actor, action, target, JSON.stringify(detail), Date.now());
  }
  balance(user: string, delta: number, kind: string, reference: string) {
    if (!Number.isSafeInteger(delta)) throw new Error('Non-integer ledger delta');
    const changed = this.run('UPDATE users SET points=points+? WHERE id=? AND points+? BETWEEN 0 AND 1000000000', delta, user, delta);
    if (!changed.changes) throw new HttpError(409, '點數不足或超出帳戶上限');
    this.run('INSERT INTO ledger VALUES (?,?,?,?,?,?,?)', randomUUID(), user, delta, requireRow(this.one('SELECT points FROM users WHERE id=?', user)).points, kind, reference, Date.now());
  }
  close() { this.db.close(); }
}
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function requireRow<T extends object>(value: T | undefined): T { if (!value) throw new HttpError(404, '找不到資料'); return value; }

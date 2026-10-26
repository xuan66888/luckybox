import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { sha256 } from './fairness.js';
import type { Config } from './config.js';

export interface User { id: string; email: string; name: string; role: 'player' | 'creator' | 'admin'; points: number; disabled: number; creator_requested: number }
declare global { namespace Express { interface Request { user?: User; session?: { token_hash: string; csrf: string }; } } }
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
export const passwordSchema = z.string().min(12).max(128);
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, hash] = stored.split(':');
  const key = await derive(password, salt);
  return !!hash && hash.length === 128 && timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
export function cookieName(config: Config) { return config.production ? '__Host-lb_session' : 'lb_session'; }
export function newSession(store: Store, config: Config, userId: string, res: Response) {
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
  store.run('DELETE FROM sessions WHERE expires_at<?', Date.now());
  store.run('INSERT INTO sessions VALUES (?,?,?,?)', sha256(token), userId, csrf, Date.now() + config.sessionHours * 3600000);
  res.cookie(cookieName(config), token, { httpOnly: true, secure: config.production, sameSite: 'strict', path: '/', maxAge: config.sessionHours * 3600000 });
  return csrf;
}
export function authMiddleware(store: Store, config: Config) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const cookie = (req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName(config)}=`));
    const token = cookie?.slice(cookie.indexOf('=') + 1);
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      const row = store.one('SELECT u.id,u.email,u.name,u.role,u.points,u.disabled,u.creator_requested,s.token_hash,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0', sha256(token), Date.now());
      if (row) { req.user = row as User; req.session = { token_hash: row.token_hash, csrf: row.csrf }; }
    }
    next();
  };
}
export function requireAuth(req: Request, _res: Response, next: NextFunction) { if (!req.user) throw new HttpError(401, '請先登入'); next(); }
export function requireAdmin(req: Request, _res: Response, next: NextFunction) { if (req.user?.role !== 'admin') throw new HttpError(403, '只有官方管理員可操作'); next(); }
export function publicUser(user: Record<string, any>) { return { id: user.id, email: user.email, name: user.name, role: user.role, points: user.points, creator_requested: user.creator_requested }; }

import path from 'node:path';
import { z } from 'zod';

export function readConfig(env = process.env) {
  const bool = (key: string, fallback: string) => z.enum(['true', 'false']).parse(env[key] ?? fallback) === 'true';
  const integer = (key: string, fallback: number, max: number) => z.coerce.number().int().min(0).max(max).parse(env[key] ?? fallback);
  const production = env.NODE_ENV === 'production';
  const origin = new URL(env.PUBLIC_ORIGIN ?? 'http://localhost:3000');
  if (origin.origin !== (env.PUBLIC_ORIGIN ?? 'http://localhost:3000')) throw new Error('PUBLIC_ORIGIN must be an origin without path or trailing slash');
  if (!['http:', 'https:'].includes(origin.protocol) || (production && origin.protocol !== 'https:')) throw new Error('Production PUBLIC_ORIGIN must use HTTPS');
  const devPoints = integer('DEV_INITIAL_POINTS', 0, 100000);
  if (production && devPoints) throw new Error('DEV_INITIAL_POINTS is forbidden in production');
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  return {
    production, origin: origin.origin, dataDir,
    dbFile: path.join(dataDir, 'luckybox.sqlite'), uploadDir: path.join(dataDir, 'uploads'),
    backupDir: path.resolve(env.BACKUP_DIR ?? path.join(dataDir, 'backups')),
    host: env.HOST ?? '127.0.0.1', port: integer('PORT', 3000, 65535),
    proxyHops: integer('TRUST_PROXY_HOPS', 0, 1), sessionHours: Math.max(1, integer('SESSION_HOURS', 24, 168)),
    registration: bool('ALLOW_REGISTRATION', 'true'), paidDraws: bool('ALLOW_PAID_DRAWS', 'false'),
    manualTopups: bool('MANUAL_TOPUPS_ENABLED', 'false'), devPoints,
    feeBps: integer('PLATFORM_FEE_BPS', 500, 3000), holdHours: integer('SETTLEMENT_HOLD_HOURS', 48, 8760),
    smtp: { host: env.SMTP_HOST, port: integer('SMTP_PORT', 587, 65535), secure: bool('SMTP_SECURE', 'false'), user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM }
  };
}
export type Config = ReturnType<typeof readConfig>;

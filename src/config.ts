import path from 'node:path';
import { z } from 'zod';

export function readConfig(env = process.env) {
  const bool = (key: string, fallback: string) => z.enum(['true', 'false']).parse(env[key] ?? fallback) === 'true';
  const integer = (key: string, fallback: number, max: number) => z.coerce.number().int().min(0).max(max).parse(env[key] ?? fallback);
  const production = env.NODE_ENV === 'production';
  if(bool('DEMO_MODE','false')||env.APP_BASE_PATH==='/demo')throw new Error('Demo service retired; use the main site');
  const origin = new URL(env.PUBLIC_ORIGIN ?? 'http://localhost:3000');
  if (origin.origin !== (env.PUBLIC_ORIGIN ?? 'http://localhost:3000')) throw new Error('PUBLIC_ORIGIN must be an origin without path or trailing slash');
  if (!['http:', 'https:'].includes(origin.protocol) || (production && origin.protocol !== 'https:')) throw new Error('Production PUBLIC_ORIGIN must use HTTPS');
  const devPoints = integer('DEV_INITIAL_POINTS', 0, 100000);
  if (production && devPoints) throw new Error('DEV_INITIAL_POINTS is forbidden in production');
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  const ecpayEnabled = bool('ECPAY_ENABLED', 'false');
  const ecpayMode = z.enum(['stage','production']).parse(env.ECPAY_MODE ?? 'stage');
  const ecpay = {
    enabled:ecpayEnabled, mode:ecpayMode,
    merchantId:env.ECPAY_MERCHANT_ID ?? '', hashKey:env.ECPAY_HASH_KEY ?? '', hashIV:env.ECPAY_HASH_IV ?? '',
    liveApproved:bool('ECPAY_LIVE_APPROVED', 'false')
  };
  if (ecpayEnabled) {
    if (!/^[0-9]{1,10}$/.test(ecpay.merchantId) || ecpay.hashKey.length !== 16 || ecpay.hashIV.length !== 16) throw new Error('ECPay requires valid server-side MerchantID, HashKey and HashIV');
    if (ecpayMode === 'production' && (!production || !ecpay.liveApproved || ['2000132','3002607','3002599','3365120'].includes(ecpay.merchantId))) throw new Error('ECPay live requires production configuration, reviewed merchant approval and non-test credentials');
    if (production && ecpayMode !== 'production') throw new Error('ECPay stage must use isolated non-production data');
    if (ecpayMode === 'production' && (origin.port || origin.hostname === 'localhost' || !origin.hostname.includes('.') || /^[0-9.]+$/.test(origin.hostname) || origin.hostname.endsWith('.test') || origin.hostname.endsWith('.example'))) throw new Error('ECPay live requires a public HTTPS domain on port 443');
  }
  return {
    demoEnabled: false, demoMode: false,
    basePath: z.enum(['','/demo']).parse(''),
    production, origin: origin.origin, dataDir, ecpay,
    identity: {
      googleId:env.GOOGLE_CLIENT_ID??'', googleSecret:env.GOOGLE_CLIENT_SECRET??'',
      turnstileSite:env.TURNSTILE_SITE_KEY??'', turnstileSecret:env.TURNSTILE_SECRET_KEY??'',
      twilioSid:env.TWILIO_ACCOUNT_SID??'', twilioToken:env.TWILIO_AUTH_TOKEN??'', twilioService:env.TWILIO_VERIFY_SERVICE_SID??'',
      authSecret:env.AUTH_SECRET??'', adminMfaRequired:bool('ADMIN_MFA_REQUIRED','false'),
      smsDailyLimit:Math.max(1,integer('SMS_DAILY_LIMIT',20,1000))
    },
    dbFile: path.join(dataDir, 'luckybox.sqlite'), uploadDir: path.join(dataDir, 'uploads'),
    backupDir: path.resolve(env.BACKUP_DIR ?? path.join(dataDir, 'backups')),
    host: env.HOST ?? '127.0.0.1', port: integer('PORT', 3000, 65535),
    proxyHops: integer('TRUST_PROXY_HOPS', 0, 1), sessionHours: Math.max(1, integer('SESSION_HOURS', 24, 168)),
    registration: bool('ALLOW_REGISTRATION', 'true'), paidDraws: bool('ALLOW_PAID_DRAWS', 'false'),
    refundLossApprovals:bool('REFUND_LOSS_APPROVALS_ENABLED','false'),
    manualTopups: bool('MANUAL_TOPUPS_ENABLED', 'false'), adminBalanceAdjustments:bool('ADMIN_BALANCE_ADJUSTMENTS_ENABLED','false'), devPoints,
    feeBps: integer('PLATFORM_FEE_BPS', 500, 3000), holdHours: integer('SETTLEMENT_HOLD_HOURS', 48, 8760),
    smtp: { host: env.SMTP_HOST, port: integer('SMTP_PORT', 587, 65535), secure: bool('SMTP_SECURE', 'false'), user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM }
  };
}
export type Config = ReturnType<typeof readConfig>;

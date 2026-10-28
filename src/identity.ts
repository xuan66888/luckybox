import { randomBytes, randomUUID, createHmac, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import type { Express, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Store, HttpError, requireRow } from './db.js';
import type { Config } from './config.js';
import { newSession, requireAuth, requireAdmin, passwordMatches, passwordHash, freshCredentialUser } from './auth.js';
import { sha256 } from './fairness.js';
import { qualifyReferral } from './community.js';
import { operationsStatus } from './operations.js';
import {storefrontReady,validateRegistrationPolicy,recordRegistrationConsent} from './storefront-data.js';

export function integrations(config:Config){const i=config.identity;return {google:!!(i.googleId&&i.googleSecret),email:!!config.smtp.host,localMail:!config.demoMode&&!config.production&&!config.smtp.host,sms:!!(i.twilioSid&&i.twilioToken&&/^VA[a-f0-9]{32}$/i.test(i.twilioService)),captcha:!!(i.turnstileSite&&i.turnstileSecret),siteKey:i.turnstileSite,mfa:/^[a-f0-9]{64}$/i.test(i.authSecret)};}
function guard(store:Store,scope:string,key:string,max:number,windowMs:number){const id=`identity:${scope}:${sha256(key)}`,now=Date.now();const n=store.tx(()=>{store.run('DELETE FROM rate_limits WHERE key=? AND expires_at<?',id,now);store.run('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',id,now+windowMs);return requireRow(store.one('SELECT count FROM rate_limits WHERE key=?',id)).count;});if(n>max)throw new HttpError(429,'驗證操作過於頻繁，請稍後再試');}
export function identityGate(store:Store,config:Config){
  const actions:Record<string,string>={'/api/auth/login':'login','/api/auth/admin-login':'admin_login','/api/auth/register':'register','/api/auth/forgot':'forgot','/api/auth/google/start':'google','/api/me/security/email/send':'email','/api/me/security/phone/send':'phone'};
  return async(req:Request,_res:Response,next:NextFunction)=>{try{
    const action=actions[req.path];if(req.method!=='POST'||!action)return next();
    if(!integrations(config).captcha){if(config.identity.turnstileSite||config.identity.turnstileSecret)throw new HttpError(503,'防機器人驗證設定不完整');return next();}
    guard(store,'captcha',req.ip??'unknown',30,60000);
    const token=z.string().min(1).max(2048).safeParse(req.body?.captchaToken);if(!token.success)throw new HttpError(400,'請先完成防機器人驗證');
    let result;try{const r=await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({secret:config.identity.turnstileSecret,response:token.data}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('upstream');result=await r.json() as Record<string,any>;}catch{throw new HttpError(503,'防機器人驗證服務暫時不可用');}
    if(!result.success||result.hostname!==new URL(config.origin).hostname||result.action!==action)throw new HttpError(400,'防機器人驗證失敗或過期，請重新驗證');
    delete req.body.captchaToken;next();
  }catch(e){next(e);}};
}
const base32chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes:Buffer){let bits=0,value=0,out='';for(const b of bytes){value=(value<<8)|b;bits+=8;while(bits>=5){out+=base32chars[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=base32chars[(value<<(5-bits))&31];return out;}
function decode32(s:string){let bits=0,value=0;const out=[];for(const c of s){const n=base32chars.indexOf(c);if(n<0)throw new Error('Invalid base32');value=(value<<5)|n;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function totp(secret:string,counter=Math.floor(Date.now()/30000)){const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(counter));const hash=createHmac('sha1',decode32(secret)).update(b).digest(),offset=hash[19]&15;return String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');}
function cipher(secret:string,key:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',Buffer.from(key,'hex'),iv),body=Buffer.concat([c.update(secret,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
function decipher(secret:string,key:string){const b=Buffer.from(secret,'base64'),d=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),b.subarray(0,12));d.setAuthTag(b.subarray(12,28));return Buffer.concat([d.update(b.subarray(28)),d.final()]).toString('utf8');}
function consumeMfa(store:Store,config:Config,user:string,code:string,allowPending=false){
  const m=store.one('SELECT * FROM admin_mfa WHERE user_id=?',user);if(!m||(!m.enabled&&!allowPending)||!integrations(config).mfa)throw new HttpError(401,'兩步驟驗證尚未啟用');
  const recoveries:string[]=JSON.parse(m.recovery_hashes),hash=sha256(code);if(m.enabled&&recoveries.includes(hash)){store.run('UPDATE admin_mfa SET recovery_hashes=? WHERE user_id=?',JSON.stringify(recoveries.filter(h=>h!==hash)),user);return;}
  if(!/^\d{6}$/.test(code))throw new HttpError(401,'驗證碼錯誤');const now=Math.floor(Date.now()/30000),secret=decipher(m.secret,config.identity.authSecret);
  for(const n of [now-1,now,now+1])if(n>m.last_counter&&timingSafeEqual(Buffer.from(totp(secret,n)),Buffer.from(code))){store.run('UPDATE admin_mfa SET last_counter=? WHERE user_id=?',n,user);return;}
  throw new HttpError(401,'驗證碼錯誤、過期或已使用');
}
export function checkAdminMfa(store:Store,config:Config,user:Record<string,any>,code?:string,inTransaction=false){if(user.role!=='admin')return;const enabled=store.one('SELECT enabled FROM admin_mfa WHERE user_id=?',user.id)?.enabled;if(!enabled){if(config.identity.adminMfaRequired)throw new HttpError(403,'管理員必須先由安全程序設定兩步驟驗證');return;}if(!code)throw new HttpError(401,'請完成此帳號的兩步驗證','MFA_REQUIRED');if(inTransaction)consumeMfa(store,config,user.id,code);else store.tx(()=>consumeMfa(store,config,user.id,code));}
async function sendEmail(config:Config,email:string,url:string,id:string){
  if(config.smtp.host){try{await nodemailer.createTransport({host:config.smtp.host,port:config.smtp.port,secure:config.smtp.secure,requireTLS:!config.smtp.secure,auth:config.smtp.user?{user:config.smtp.user,pass:config.smtp.pass}:undefined,connectionTimeout:10000,socketTimeout:15000}).sendMail({from:config.smtp.from,to:email,subject:'LUCKYBOX 信箱驗證',text:`請於 15 分鐘內以原帳號開啟連結並確認驗證：\n${url}\n非本人操作請忽略。`});}catch{throw new HttpError(503,'驗證信寄送失敗，請稍後再試');}}
  else if(!config.production){const dir=path.join(config.dataDir,'dev-mail');mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(path.join(dir,`${id}-verify.txt`),url,{mode:0o600});}
  else throw new HttpError(503,'信件服務尚未設定');
}
async function sms(config:Config,endpoint:'Verifications'|'VerificationCheck',fields:Record<string,string>){
  if(!integrations(config).sms)throw new HttpError(503,'簡訊服務尚未設定');let r:globalThis.Response;
  try{r=await fetch(`https://verify.twilio.com/v2/Services/${config.identity.twilioService}/${endpoint}`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(config.identity.twilioSid+':'+config.identity.twilioToken).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields),signal:AbortSignal.timeout(10000)});}catch{throw new HttpError(503,'簡訊服務暫時不可用');}
  if(!r.ok)throw new HttpError(r.status===429?429:400,'簡訊驗證失敗、過期或已超過嘗試次數');return await r.json() as Record<string,any>;
}
export function installIdentity(app:Express,store:Store,config:Config){
  app.get('/api/admin/operations',requireAuth,requireAdmin,(_req,res)=>res.json(operationsStatus(config)));
  app.get('/api/integrations/config',(_req,res)=>res.json(integrations(config)));
  app.get('/api/me/security',requireAuth,(req,res)=>{const u=requireRow(store.one('SELECT * FROM users WHERE id=?',req.user!.id));res.json({emailVerified:!!u.email_verified_at,phoneVerified:!!u.phone_verified_at,phone:u.phone_verified_at?u.phone.replace(/.(?=.{4})/g,'＊'):null,googleLinked:!!store.one("SELECT 1 FROM identities WHERE provider='google' AND user_id=?",u.id),mfaEnabled:!!store.one('SELECT enabled FROM admin_mfa WHERE user_id=?',u.id)?.enabled,integrations:integrations(config)});});
  app.post('/api/me/security/email/send',requireAuth,async(req,res)=>{
    guard(store,'email',req.user!.id,4,3600000);const u=requireRow(store.one('SELECT * FROM users WHERE id=?',req.user!.id));if(u.email_verified_at)return res.json({ok:true});
    const token=randomBytes(32).toString('hex');store.tx(()=>{store.run('DELETE FROM email_verifications WHERE user_id=? OR expires_at<?',u.id,Date.now());store.run('INSERT INTO email_verifications VALUES(?,?,?,?)',sha256(token),u.id,u.email,Date.now()+15*60000);});
    try{await sendEmail(config,u.email,`${config.origin}/#verify-email/${token}`,u.id);}catch(e){store.run('DELETE FROM email_verifications WHERE token_hash=?',sha256(token));throw e;}
    store.audit(u.id,'email_verification_sent',u.id);res.json({ok:true,localOnly:integrations(config).localMail});
  });
  app.post('/api/me/security/email/confirm',requireAuth,(req,res)=>{guard(store,'email-confirm',req.user!.id,10,3600000);const{token}=z.object({token:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);store.tx(()=>{const t=store.one('SELECT * FROM email_verifications WHERE token_hash=? AND user_id=? AND expires_at>?',sha256(token),req.user!.id,Date.now());if(!t)throw new HttpError(400,'驗證連結無效或已過期');const u=requireRow(store.one('SELECT email FROM users WHERE id=?',req.user!.id));if(u.email!==t.email)throw new HttpError(409,'信箱已變更，請重新寄送');store.run('UPDATE users SET email_verified_at=? WHERE id=?',Date.now(),req.user!.id);store.run('DELETE FROM email_verifications WHERE user_id=?',req.user!.id);qualifyReferral(store,req.user!.id);store.audit(req.user!.id,'email_verified',req.user!.id);});res.json({ok:true});});
  app.post('/api/me/security/phone/send',requireAuth,async(req,res)=>{
    if(!integrations(config).sms)throw new HttpError(503,'簡訊服務尚未設定');guard(store,'sms-user',req.user!.id,3,3600000);guard(store,'sms-ip',req.ip??'unknown',6,3600000);guard(store,'sms-global','global',config.identity.smsDailyLimit,86400000);
    const{phone}=z.object({phone:z.string().regex(/^\+[1-9][0-9]{7,14}$/)}).strict().parse(req.body);
    if(store.one('SELECT 1 FROM users WHERE phone=? AND phone_verified_at IS NOT NULL',phone))throw new HttpError(409,'此手機已驗證，請使用其他號碼或聯絡客服');
    await sms(config,'Verifications',{To:phone,Channel:'sms'});store.run('INSERT INTO phone_challenges VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,expires_at=excluded.expires_at',req.user!.id,phone,Date.now()+10*60000);res.json({ok:true});
  });
  app.post('/api/me/security/phone/confirm',requireAuth,async(req,res)=>{
    guard(store,'sms-confirm',req.user!.id,5,600000);const{code}=z.object({code:z.string().regex(/^[0-9]{4,10}$/)}).strict().parse(req.body),t=store.one('SELECT * FROM phone_challenges WHERE user_id=? AND expires_at>?',req.user!.id,Date.now());if(!t)throw new HttpError(400,'請先取得簡訊驗證碼');
    if((await sms(config,'VerificationCheck',{To:t.phone,Code:code})).status!=='approved')throw new HttpError(400,'簡訊驗證碼錯誤');
    store.tx(()=>{const fresh=store.one('SELECT * FROM phone_challenges WHERE user_id=? AND phone=? AND expires_at>?',req.user!.id,t.phone,Date.now());if(!fresh)throw new HttpError(409,'驗證請求已變更，請重試');if(store.one('SELECT 1 FROM users WHERE phone=? AND phone_verified_at IS NOT NULL AND id<>?',t.phone,req.user!.id))throw new HttpError(409,'此手機已綁定');store.run('UPDATE users SET phone=?,phone_verified_at=? WHERE id=?',t.phone,Date.now(),req.user!.id);store.run('DELETE FROM phone_challenges WHERE user_id=?',req.user!.id);qualifyReferral(store,req.user!.id);store.audit(req.user!.id,'phone_verified',req.user!.id);});res.json({ok:true});
  });
  const oauth=()=>new OAuth2Client(config.identity.googleId,config.identity.googleSecret,`${config.origin}/auth/google/callback`);
  const stateCookie=config.production?'__Host-lb_oauth':'lb_oauth';
  app.post('/api/auth/google/start',async(req,res)=>{
    if(!integrations(config).google)throw new HttpError(503,'Google 登入尚未設定');guard(store,'google',req.ip??'unknown',10,600000);
    const input=z.object({link:z.boolean().default(false),acceptedPolicies:z.literal(true).optional(),storefrontVersion:z.number().int().min(1).optional()}).strict().parse(req.body),{link}=input;if(link&&!req.user)throw new HttpError(401,'綁定 Google 前請先登入');
    const state=randomBytes(32).toString('hex'),browser=randomBytes(32).toString('hex'),nonce=randomBytes(32).toString('hex'),o=oauth(),{codeVerifier,codeChallenge}=await o.generateCodeVerifierAsync();
    store.tx(()=>{const p=link?null:validateRegistrationPolicy(store,input);store.run('DELETE FROM oauth_states WHERE expires_at<?',Date.now());store.run('INSERT INTO oauth_states VALUES(?,?,?,?,?,?,?)',sha256(state),sha256(browser),codeVerifier,nonce,link?req.user!.id:null,link?req.session!.token_hash:null,Date.now()+10*60000);if(p)store.run('INSERT INTO oauth_policy_intents VALUES(?,?,?)',sha256(state),p.version,p.contentHash);});
    res.cookie(stateCookie,browser,{httpOnly:true,secure:config.production,sameSite:'lax',path:'/',maxAge:600000});res.json({url:o.generateAuthUrl({scope:['openid','email','profile'],state,nonce,code_challenge:codeChallenge,code_challenge_method:'S256' as any,prompt:'select_account'})});
  });
  app.get('/auth/google/callback',async(req,res)=>{
    res.setHeader('Cache-Control','no-store');try{
      if(!integrations(config).google)throw new Error('disabled');const state=z.string().regex(/^[a-f0-9]{64}$/).parse(req.query.state),code=z.string().min(1).max(4096).parse(req.query.code);
      const browser=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(stateCookie+'='))?.slice(stateCookie.length+1)??'';
      const s=store.tx(()=>{const s=store.one('SELECT s.*,p.publication_version policy_version FROM oauth_states s LEFT JOIN oauth_policy_intents p ON p.state_hash=s.state_hash WHERE s.state_hash=? AND s.browser_hash=? AND s.expires_at>?',sha256(state),sha256(browser),Date.now());if(!s)throw new Error('state');store.run('DELETE FROM oauth_states WHERE state_hash=?',sha256(state));return s;});
      res.clearCookie(stateCookie,{httpOnly:true,secure:config.production,sameSite:'lax',path:'/'});
      const o=oauth(),{tokens}=await o.getToken({code,codeVerifier:s.verifier});if(!tokens.id_token)throw new Error('idtoken');const ticket=await o.verifyIdToken({idToken:tokens.id_token,audience:config.identity.googleId}),p=ticket.getPayload() as Record<string,any>|undefined;
      if(!p?.sub||!p.email||!p.email_verified||p.nonce!==s.nonce)throw new Error('claims');const email=z.email().max(254).parse(p.email).toLowerCase(),name=String(p.name??email.split('@')[0]).slice(0,60),newHash=await passwordHash(randomBytes(48).toString('hex'));
      const id=store.tx(()=>{
        const existing=store.one("SELECT * FROM identities WHERE provider='google' AND subject=?",p.sub);
        if(s.user_id){const u=requireRow(store.one('SELECT * FROM users WHERE id=? AND disabled=0',s.user_id));if(!store.one('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',s.session_hash,u.id,Date.now())||u.role==='admin'||(existing&&existing.user_id!==u.id)||store.one("SELECT 1 FROM identities WHERE provider='google' AND user_id=?",u.id))throw new Error('link');store.run("INSERT INTO identities VALUES('google',?,?)",p.sub,u.id);store.audit(u.id,'google_linked',u.id);return u.id;}
        if(existing){const u=requireRow(store.one('SELECT * FROM users WHERE id=? AND disabled=0',existing.user_id));if(u.role==='admin')throw new Error('adminmustusepasswordmfa');return u.id;}
        if(!config.registration||store.one('SELECT 1 FROM users WHERE email=?',email))throw new Error('existingemailmustloginandlink');
        const id=randomUUID();store.run('INSERT INTO users(id,email,name,password_hash,email_verified_at,created_at) VALUES(?,?,?,?,?,?)',id,email,name,newHash,Date.now(),Date.now());recordRegistrationConsent(store,id,{acceptedPolicies:s.policy_version?true:undefined,storefrontVersion:s.policy_version??undefined});store.run("INSERT INTO identities VALUES('google',?,?)",p.sub,id);store.audit(id,'google_register',id);return id;
      });
      if(req.session)store.run('DELETE FROM sessions WHERE token_hash=?',req.session.token_hash);newSession(store,config,id,res);res.redirect(303,'/auth/complete');
    }catch{res.redirect(303,'/#google-error');}
  });
  app.get('/api/admin/readiness',requireAuth,requireAdmin,(_req,res)=>{const i=integrations(config);res.json({integrations:i,production:config.production,payments:config.ecpay.enabled,paidDraws:config.paidDraws,adminMfaRequired:config.identity.adminMfaRequired,operations:operationsStatus(config),checks:[{name:'正式網域與 HTTPS',ready:config.production&&config.origin.startsWith('https://')},{name:'Google OAuth',ready:i.google},{name:'正式寄信',ready:i.email},{name:'簡訊驗證',ready:i.sms},{name:'防機器人',ready:i.captcha},{name:'管理員 MFA 金鑰與強制登入',ready:i.mfa&&config.identity.adminMfaRequired},{name:'商家／客服／配送與政策資訊',ready:storefrontReady(store)},{name:'正式金流商店審核',ready:config.ecpay.enabled&&config.ecpay.mode==='production'&&config.ecpay.liveApproved}]});});
  const activeAdminSession=(req:Request,snapshot?:Record<string,any>)=>{
    const user=snapshot?freshCredentialUser(store,snapshot):store.one('SELECT * FROM users WHERE id=? AND disabled=0',req.user!.id);
    if(!user||user.role!=='admin'||!store.one('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',req.session!.token_hash,user.id,Date.now()))throw new HttpError(403,'管理權限或登入已變更，請重新登入');
    return user;
  };
  const passwordCheck=async(req:Request)=>{
    const{password}=z.object({password:z.string().max(128),code:z.string().max(32).optional()}).strict().parse(req.body),u=requireRow(store.one('SELECT * FROM users WHERE id=?',req.user!.id));
    guard(store,'mfa-password',u.id,5,3600000);
    if(!await passwordMatches(password,u.password_hash))throw new HttpError(401,'密碼錯誤');
    return store.tx(()=>activeAdminSession(req,u));
  };
  app.post('/api/admin/mfa/setup',requireAuth,requireAdmin,async(req,res)=>{
    const actor=await passwordCheck(req);
    if(!integrations(config).mfa)throw new HttpError(503,'請先設定 AUTH_SECRET（32 位元組十六進位）');
    const secret=base32(randomBytes(20));
    store.tx(()=>{
      activeAdminSession(req,actor);
      if(store.one('SELECT enabled FROM admin_mfa WHERE user_id=?',actor.id)?.enabled)throw new HttpError(409,'兩步驟驗證已啟用');
      store.run('INSERT INTO admin_mfa(user_id,secret) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,last_counter=-1,recovery_hashes=\'[]\'',actor.id,cipher(secret,config.identity.authSecret));
    });
    res.json({secret,uri:`otpauth://totp/LUCKYBOX:${encodeURIComponent(actor.email)}?secret=${secret}&issuer=LUCKYBOX&algorithm=SHA1&digits=6&period=30`});
  });
  app.post('/api/admin/mfa/enable',requireAuth,requireAdmin,(req,res)=>{guard(store,'mfa-confirm',req.user!.id,5,600000);const{code}=z.object({code:z.string().regex(/^\d{6}$/)}).strict().parse(req.body),codes=Array.from({length:8},()=>randomBytes(10).toString('hex'));store.tx(()=>{activeAdminSession(req);if(store.one('SELECT enabled FROM admin_mfa WHERE user_id=?',req.user!.id)?.enabled)throw new HttpError(409,'已啟用');consumeMfa(store,config,req.user!.id,code,true);store.run('UPDATE admin_mfa SET enabled=1,recovery_hashes=? WHERE user_id=?',JSON.stringify(codes.map(sha256)),req.user!.id);store.run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?',req.user!.id,req.session!.token_hash);store.audit(req.user!.id,'mfa_enabled',req.user!.id);});res.json({ok:true,recoveryCodes:codes});});
  app.post('/api/admin/mfa/disable',requireAuth,requireAdmin,async(req,res)=>{const actor=await passwordCheck(req);if(config.identity.adminMfaRequired)throw new HttpError(403,'正式設定要求 MFA，不能由此關閉');store.tx(()=>{activeAdminSession(req,actor);consumeMfa(store,config,actor.id,String(req.body.code??''));store.run('DELETE FROM admin_mfa WHERE user_id=?',actor.id);store.audit(actor.id,'mfa_disabled',actor.id);});res.json({ok:true});});
}

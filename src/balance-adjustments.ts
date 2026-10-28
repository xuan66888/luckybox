import {randomUUID} from 'node:crypto';
import type {Express,Request,Response} from 'express';
import {z} from 'zod';
import {HttpError,requireRow,type Store} from './db.js';
import {passwordMatches} from './auth.js';
import {checkAdminMfa} from './identity.js';
import type {Config} from './config.js';
const input=z.object({direction:z.enum(['credit','debit']),amount:z.number().int().min(1).max(100000),expectedBalance:z.number().int().min(0).max(1000000000),reason:z.string().trim().min(5).max(500),reference:z.string().trim().max(120).default(''),password:z.string().min(1).max(128),otp:z.string().max(32).optional()}).strict();
export function installBalanceAdjustments(app:Express,store:Store,config:Config,mutation:(req:Request,res:Response,operation:()=>unknown,fingerprint?:unknown)=>void){
 app.get('/api/admin/members/:id/balance-adjustments',(req,res)=>{
  const id=z.uuid().parse(req.params.id);requireRow(store.one('SELECT id FROM users WHERE id=?',id));
  res.json({enabled:config.adminBalanceAdjustments,items:store.all('SELECT b.*,u.name actor FROM balance_adjustments b JOIN users u ON u.id=b.actor_id WHERE b.user_id=? ORDER BY b.created_at DESC,b.rowid DESC LIMIT 50',id)});
 });
 app.post('/api/admin/members/:id/balance-adjustments',async(req,res)=>{
  if(!config.adminBalanceAdjustments)throw new HttpError(503,'人工調點尚未啟用');
  const id=z.uuid().parse(req.params.id),data=input.parse(req.body),actor=requireRow(store.one('SELECT * FROM users WHERE id=?',req.user!.id));
  const failureKey='balance-reauth:'+actor.id;
  store.run('DELETE FROM rate_limits WHERE key=? AND expires_at<?',failureKey,Date.now());
  if((store.one('SELECT count FROM rate_limits WHERE key=?',failureKey)?.count??0)>=5){res.setHeader('Retry-After','900');throw new HttpError(429,'管理驗證失敗過多，15分鐘後再試');}
  const failed=()=>store.run('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',failureKey,Date.now()+900000);
  if(!await passwordMatches(data.password,actor.password_hash)){failed();throw new HttpError(401,'管理員再次驗證失敗');}
  // The await above can race with logout, password reset, permission revocation.
  const fresh=store.one('SELECT * FROM users WHERE id=? AND disabled=0',actor.id);
  if(!fresh||fresh.role!=='admin'||fresh.password_hash!==actor.password_hash||!store.one('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',req.session!.token_hash,actor.id,Date.now()))throw new HttpError(403,'管理權限或登入已變更，請重新登入');
  const {password:_password,otp:_otp,...safe}=data;
  try{mutation(req,res,()=>{
   if(actor.id===id)throw new HttpError(403,'不可調整自己的點數');
   const member=requireRow(store.one('SELECT id,role,disabled,points FROM users WHERE id=?',id));
   if(member.role==='admin'||member.disabled)throw new HttpError(403,'僅能調整啟用中的一般會員／創作者');
   if(member.points!==data.expectedBalance)throw new HttpError(409,'餘額已變更；請重新開啟調點視窗並確認');
   checkAdminMfa(store,config,fresh,data.otp,true);
   const delta=data.direction==='credit'?data.amount:-data.amount,adjustmentId=randomUUID(),now=Date.now();
   store.balance(id,delta,'admin_adjustment',adjustmentId);
   const after=requireRow(store.one('SELECT points FROM users WHERE id=?',id)).points;
   store.run('INSERT INTO balance_adjustments VALUES(?,?,?,?,?,?,?,?,?)',adjustmentId,actor.id,id,delta,member.points,after,data.reason,data.reference,now);
   store.audit(actor.id,'admin_balance_adjustment',id,{adjustmentId,delta,before:member.points,after,reason:data.reason,reference:data.reference});
   return {id:adjustmentId,userId:id,delta,before:member.points,after,reason:data.reason,reference:data.reference,createdAt:now,countsAsPayment:false};
  },safe);store.run('DELETE FROM rate_limits WHERE key=?',failureKey);}
  catch(error){if(error instanceof HttpError&&error.status===401)failed();throw error;}
 });
}

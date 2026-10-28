import {randomUUID} from 'node:crypto';
import type {Express,Request,Response,RequestHandler} from 'express';
import {z} from 'zod';
import {HttpError,requireRow,type Store} from './db.js';
import {requireAuth,requireAdmin,passwordMatches,freshCredentialUser} from './auth.js';
import {checkAdminMfa} from './identity.js';
import type {Config} from './config.js';
import {effectiveOdds,pickWeighted} from './weighted.js';
import {starterProducts} from './starter-catalog.js';
type Mutation=(req:Request,res:Response,operation:()=>unknown,fingerprint?:unknown)=>void;
export function ensurePracticePool(store:Store,email:string){
 const owner=requireRow(store.one("SELECT id FROM users WHERE email=? AND role='admin' AND disabled=0",email));
 const previous=store.one("SELECT id,status FROM practice_pools WHERE code='owner-acceptance-v1'");
 if(previous)return {created:false,id:previous.id,status:previous.status,testOnly:true};
 const id=randomUUID(),now=Date.now();
 store.run("INSERT INTO practice_pools VALUES(?,'owner-acceptance-v1',?,?,'live',10000,10000,1,?)",id,owner.id,'功能測試獎池｜不扣點・不出貨',now);
 const quantity=[1000,3000,6000],weights=[500,1500,8000];
 starterProducts.forEach((p,i)=>store.run('INSERT INTO practice_prizes VALUES(?,?,?,?,?,?,?)',randomUUID(),id,['大獎','二獎','三獎'][i]+'・'+p.name,'/assets/reference-'+p.code+'.svg',quantity[i],quantity[i],weights[i]));
 store.audit(owner.id,'practice_pool_open',id,{note:'正式站功能驗收：測試籤數不是現貨；不扣點、不發實體、不兌點、不計營收或活動獎勵'});
 return {created:true,id,status:'live',testOnly:true};
}
export function practicePool(store:Store,id:string):Record<string,any>|null{
 const p=store.one('SELECT p.*,u.name creator FROM practice_pools p JOIN users u ON u.id=p.owner_id WHERE p.id=?',id);if(!p)return null;
 const prizes:Record<string,any>[]=effectiveOdds(store.all('SELECT * FROM practice_prizes WHERE pool_id=? ORDER BY quantity,name,id',id)).map((r:Record<string,any>)=>({...r,kind:'physical',value:0,redeem_points:0,testOnly:true}));
 return {...p,kind:'free',price:0,fee_bps:0,reserve_points:0,revenue_points:0,draw_mode:'weighted',testOnly:true,verification:'none',fulfillment:'none',
  description:'正式網站功能測試用獎池。可重複選籤、撕籤、查詢測試紀錄及在後台調整機率；不扣點，不發放實體商品，不提供出貨或兌點，不計活動、邀請、VIP或正式營收。籤數只是測試容量，不是商品庫存。商品圖片來自官方公開參考照片，非本店實拍。',descriptionImages:[],cover:prizes[0]?.image??'',prizes};
}
export function practicePools(store:Store){return store.all("SELECT id FROM practice_pools WHERE status IN('live','sold_out') ORDER BY created_at DESC LIMIT 10").map(p=>practicePool(store,p.id)!);}
export function practiceHistory(store:Store,user:string){return store.all("SELECT d.id,d.pool_id,d.ordinal,d.created_at,d.slot presentationSlot,0 cost,r.name,'physical' kind,0 value,r.image,p.name pool_name,1 testOnly FROM practice_draws d JOIN practice_prizes r ON r.id=d.prize_id JOIN practice_pools p ON p.id=d.pool_id WHERE d.user_id=? ORDER BY d.created_at DESC,d.rowid DESC LIMIT 200",user);}
export function installPractice(app:Express,store:Store,mutation:Mutation,rate:RequestHandler,config:Config){
 app.get('/api/pools/:id',(req,res,next)=>{const p=practicePool(store,String(req.params.id));if(!p)return next();if(p.status==='cancelled'&&req.user?.role!=='admin')throw new HttpError(404,'測試獎池已撤下');res.json(p);});
 app.post('/api/pools/:id/draw',(req,res,next)=>{if(!practicePool(store,String(req.params.id)))return next();requireAuth(req,res,()=>rate(req,res,()=>mutation(req,res,()=>{
  const p=requireRow(store.one('SELECT * FROM practice_pools WHERE id=?',String(req.params.id)));
  const a=z.object({quantity:z.number().int().min(1).max(10),oddsVersion:z.number().int().min(1),presentationSlots:z.array(z.number().int().min(1).max(24)).min(1).max(10).optional()}).strict().parse(req.body);
  if(p.status!=='live'||p.remaining<a.quantity)throw new HttpError(409,'測試池已關閉或測試籤數不足');
  if(p.odds_version!==a.oddsVersion)throw new HttpError(409,'機率已更新，請重新開啟獎池後再測試');
  if(a.presentationSlots&&(a.presentationSlots.length!==a.quantity||new Set(a.presentationSlots).size!==a.quantity))throw new HttpError(400,'選籤張數不符或重複');
  const results=[];
  for(let i=0;i<a.quantity;i++){
   const r=pickWeighted(store.all('SELECT * FROM practice_prizes WHERE pool_id=? ORDER BY id',p.id)),id=randomUUID(),ordinal=p.total-p.remaining+i,slot=a.presentationSlots?.[i];
   store.run('INSERT INTO practice_draws VALUES(?,?,?,?,?,?,?)',id,p.id,req.user!.id,r.id,ordinal,slot??null,Date.now());
   store.run('UPDATE practice_prizes SET remaining=remaining-1 WHERE id=? AND remaining>0',r.id);
   results.push({id,ordinal,prizeId:r.id,name:r.name,kind:'physical',value:0,image:r.image,testOnly:true,...(slot?{presentationSlot:slot}:{})});
  }
  store.run("UPDATE practice_pools SET remaining=remaining-?,status=CASE WHEN remaining=? THEN 'sold_out' ELSE status END WHERE id=?",a.quantity,a.quantity,p.id);
  store.audit(req.user!.id,'practice_draw',p.id,{quantity:a.quantity,cost:0,oddsVersion:p.odds_version,note:'功能測試，不是實體獎項'});
  return {results,testOnly:true,points:requireRow(store.one('SELECT points FROM users WHERE id=?',req.user!.id)).points};
 })));});
 app.get('/api/me/draws/:id',requireAuth,(req,res,next)=>{const d=store.one("SELECT d.id,d.pool_id,d.ordinal,d.created_at,d.slot presentationSlot,0 cost,r.name,'physical' kind,0 value,r.image,p.name pool_name,1 testOnly FROM practice_draws d JOIN practice_prizes r ON r.id=d.prize_id JOIN practice_pools p ON p.id=d.pool_id WHERE d.id=? AND d.user_id=?",String(req.params.id),req.user!.id);if(!d)return next();res.json(d);});
 app.post('/api/admin/pools/:id/odds',(req,res,next)=>{if(!practicePool(store,String(req.params.id)))return next();requireAuth(req,res,()=>requireAdmin(req,res,()=>mutation(req,res,()=>{
  const p=requireRow(store.one('SELECT * FROM practice_pools WHERE id=?',String(req.params.id)));
  if(p.status!=='live')throw new HttpError(409,'測試池已關閉');
  const a=z.object({expectedVersion:z.number().int().min(1),prizes:z.array(z.object({id:z.uuid(),probabilityBps:z.number().int().min(0).max(10000)}).strict()).min(1).max(100)}).strict().parse(req.body);
  const rows=store.all('SELECT id,remaining FROM practice_prizes WHERE pool_id=?',p.id);
  if(a.expectedVersion!==p.odds_version)throw new HttpError(409,'機率已更新，請重新載入');
  if(a.prizes.length!==rows.length||new Set(a.prizes.map(r=>r.id)).size!==rows.length||a.prizes.some(r=>!rows.some(x=>x.id===r.id))||a.prizes.reduce((s,r)=>s+r.probabilityBps,0)!==10000||!rows.some(x=>x.remaining>0&&a.prizes.some(r=>r.id===x.id&&r.probabilityBps>0)))throw new HttpError(400,'獎項與機率不符，合計需100%且可抽測試獎項機率不得全為0');
  for(const r of a.prizes)store.run('UPDATE practice_prizes SET weight_bps=? WHERE id=? AND pool_id=?',r.probabilityBps,r.id,p.id);
  store.run('UPDATE practice_pools SET odds_version=odds_version+1 WHERE id=?',p.id);
  store.audit(req.user!.id,'practice_odds_update',p.id,{version:p.odds_version+1});return {ok:true,testOnly:true,oddsVersion:p.odds_version+1};
 })));});
 app.get('/api/admin/practice',requireAuth,requireAdmin,(_req,res)=>res.json({generatedAt:Date.now(),refreshSeconds:5,pools:store.all('SELECT id FROM practice_pools ORDER BY created_at DESC LIMIT 10').map(p=>practicePool(store,p.id)!),draws:store.all('SELECT d.id,d.created_at,d.ordinal,d.slot,u.name player,u.email,p.name pool,r.name prize FROM practice_draws d JOIN users u ON u.id=d.user_id JOIN practice_pools p ON p.id=d.pool_id JOIN practice_prizes r ON r.id=d.prize_id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 100'),count:store.one('SELECT COUNT(*) n FROM practice_draws')!.n,testOnly:true}));
 app.post('/api/admin/practice/:id/status',requireAuth,requireAdmin,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),input=z.object({action:z.enum(['hide','restore']),expectedVersion:z.number().int().min(1).max(2147483646),confirmed:z.literal(true),password:z.string().min(1).max(128),otp:z.string().max(32).optional()}).strict().parse(req.body);
  const actor=requireRow(store.one('SELECT * FROM users WHERE id=?',req.user!.id)),key='practice-status-reauth:'+actor.id;
  store.run('DELETE FROM rate_limits WHERE key=? AND expires_at<?',key,Date.now());
  if((store.one('SELECT count FROM rate_limits WHERE key=?',key)?.count??0)>=5){res.setHeader('Retry-After','900');throw new HttpError(429,'管理驗證失敗過多，15分鐘後再試');}
  const failed=()=>store.run('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',key,Date.now()+900000);
  if(!await passwordMatches(input.password,actor.password_hash)){failed();throw new HttpError(401,'管理員再次驗證失敗');}
  const activeActor=()=>{
   const fresh=freshCredentialUser(store,actor);
   if(fresh.role!=='admin'||!store.one('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',req.session!.token_hash,actor.id,Date.now()))throw new HttpError(403,'管理權限或登入已變更，請重新登入');
   return fresh;
  };
  activeActor(); // Also reject a revoked session before an idempotent response is returned.
  const{password:_password,otp:_otp,...safe}=input;
  try{mutation(req,res,()=>{
   const fresh=activeActor();
   const p=requireRow(store.one('SELECT * FROM practice_pools WHERE id=?',id));
   if(p.odds_version!==input.expectedVersion)throw new HttpError(409,'測試池版本已更新，請重新載入再確認');
   if(input.action==='hide'&&p.status==='cancelled')throw new HttpError(409,'測試池已下架');
   if(input.action==='restore'&&(p.status!=='cancelled'||p.remaining<=0))throw new HttpError(409,'只可恢復已下架且仍有測試籤的獎池');
   const status=input.action==='hide'?'cancelled':'live';
   checkAdminMfa(store,config,fresh,input.otp,true);
   store.run('UPDATE practice_pools SET status=?,odds_version=odds_version+1 WHERE id=?',status,id);
   store.audit(actor.id,'practice_pool_'+input.action,id,{version:p.odds_version+1,note:'僅變更測試池可見狀態，保留全部紀錄、機率與測試剩餘籤數'});
   return {ok:true,testOnly:true,status,version:p.odds_version+1,historyRetained:true};
  },safe);store.run('DELETE FROM rate_limits WHERE key=?',key);}
  catch(error){if(error instanceof HttpError&&error.status===401)failed();throw error;}
 });
}

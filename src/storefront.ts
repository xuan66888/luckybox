import type {Express,Request,Response} from 'express';
import {z} from 'zod';
import {requireAuth,requireAdmin,passwordMatches,freshCredentialUser} from './auth.js';
import {checkAdminMfa} from './identity.js';
import {sha256} from './fairness.js';
import {HttpError,requireRow,type Store} from './db.js';
import type {Config} from './config.js';
import {storefrontContentSchema,storefrontState,publicStorefront,publicationIssues} from './storefront-data.js';
type Mutation=(req:Request,res:Response,operation:()=>unknown,fingerprint?:unknown)=>void;
const version=z.number().int().min(0).max(2147483646);
export function installStorefront(app:Express,store:Store,config:Config,mutation:Mutation){
 app.get('/api/storefront',(_req,res)=>res.json(publicStorefront(store)));
 app.get('/api/storefront/versions/:version',(req,res)=>{
  const n=z.coerce.number().int().min(1).max(2147483647).parse(req.params.version);
  const row=requireRow(store.one('SELECT * FROM storefront_publications WHERE version=?',n));
  if(sha256(row.content)!==row.content_hash)throw new HttpError(503,'公開資訊紀錄不一致');
  res.json({published:true,archived:storefrontState(store).published?.version!==n,version:n,content:storefrontContentSchema.parse(JSON.parse(row.content)),contentHash:row.content_hash,publishedAt:row.published_at});
 });
 app.get('/api/admin/storefront',requireAuth,requireAdmin,(_req,res)=>{
  const state=storefrontState(store);
  res.json({...state,hasUnpublishedChanges:!state.published||JSON.stringify(state.draft)!==JSON.stringify(state.published.content),history:store.all('SELECT version,content_hash contentHash,published_at publishedAt FROM storefront_publications ORDER BY version DESC LIMIT 20')});
 });
 app.post('/api/admin/storefront/draft',requireAuth,requireAdmin,(req,res)=>mutation(req,res,()=>{
  const input=z.object({expectedVersion:version,content:storefrontContentSchema}).strict().parse(req.body),state=storefrontState(store);
  if(input.expectedVersion!==state.version)throw new HttpError(409,'草稿已被更新，請重新載入後再編輯');
  const next=state.version+1;
  store.run('INSERT INTO storefront_settings VALUES(1,?,?,NULL,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,draft=excluded.draft,updated_at=excluded.updated_at,updated_by=excluded.updated_by',next,JSON.stringify(input.content),Date.now(),req.user!.id);
  store.audit(req.user!.id,'storefront_draft_saved','storefront',{version:next});
  return {ok:true,version:next,issues:publicationIssues(input.content),publishedChanged:false};
 }));
 app.post('/api/admin/storefront/publication',requireAuth,requireAdmin,async(req,res)=>{
  const input=z.object({expectedVersion:version,action:z.enum(['publish','withdraw']),confirmed:z.literal(true),operatorReviewed:z.literal(true).optional(),password:z.string().min(1).max(128),otp:z.string().max(32).optional()}).strict().parse(req.body);
  const actor=requireRow(store.one('SELECT * FROM users WHERE id=?',req.user!.id)),key='storefront-reauth:'+actor.id;
  store.run('DELETE FROM rate_limits WHERE key=? AND expires_at<?',key,Date.now());
  if((store.one('SELECT count FROM rate_limits WHERE key=?',key)?.count??0)>=5){res.setHeader('Retry-After','900');throw new HttpError(429,'管理驗證失敗過多，15分鐘後再試');}
  const failed=()=>store.run('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',key,Date.now()+900000);
  if(!await passwordMatches(input.password,actor.password_hash)){failed();throw new HttpError(401,'管理員再次驗證失敗');}
  const{password:_password,otp:_otp,...safe}=input;
  try{mutation(req,res,()=>{
   const fresh=freshCredentialUser(store,actor);
   if(fresh.role!=='admin'||!store.one('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',req.session!.token_hash,actor.id,Date.now()))throw new HttpError(403,'管理權限或登入已變更，請重新登入');
   const state=storefrontState(store);
   if(input.expectedVersion!==state.version)throw new HttpError(409,'資訊版本已更新，請重新載入後確認');
   if(input.action==='publish'){
    if(!input.operatorReviewed||publicationIssues(state.draft).length)throw new HttpError(400,'請填寫必填欄位，並由營運者確認公開內容');
    checkAdminMfa(store,config,fresh,input.otp,true);
    const next=state.version+1,content=JSON.stringify(state.draft);
    store.run('INSERT INTO storefront_publications VALUES(?,?,?,?,?)',next,content,sha256(content),Date.now(),actor.id);
    store.run('UPDATE storefront_settings SET version=?,published_version=?,updated_at=?,updated_by=? WHERE id=1',next,next,Date.now(),actor.id);
    store.audit(actor.id,'storefront_published','storefront',{version:next,contentHash:sha256(content)});
    return {ok:true,version:next,published:true};
   }
   if(!state.published)throw new HttpError(409,'目前沒有公開版本');
   if(config.production&&(config.ecpay.enabled||config.paidDraws))throw new HttpError(409,'請先關閉正式收款與付費抽獎，再撤下公開資訊');
   checkAdminMfa(store,config,fresh,input.otp,true);
   store.run('UPDATE storefront_settings SET version=version+1,published_version=NULL,updated_at=?,updated_by=? WHERE id=1',Date.now(),actor.id);
   store.audit(actor.id,'storefront_withdrawn','storefront',{version:state.published.version});
   return {ok:true,version:state.version+1,published:false};
  },safe);store.run('DELETE FROM rate_limits WHERE key=?',key);}
  catch(error){if(error instanceof HttpError&&error.status===401)failed();throw error;}
 });
}

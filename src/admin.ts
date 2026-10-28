import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { passwordHash, passwordSchema } from './auth.js';
import { HttpError, requireRow, type Store } from './db.js';
import { effectiveOdds } from './weighted.js';
import {activity,activityCategories} from './activity.js';
import {installBalanceAdjustments} from './balance-adjustments.js';
import type {Config} from './config.js';
import {starterDrafts,starterProducts} from './starter-catalog.js';

const memberFields = 'id,email,name,role,disabled,creator_requested,points,created_at';
const nameSchema = z.string().trim().min(1).max(60);
const emailSchema = z.email().max(254).transform(s => s.toLowerCase());
const roles = z.enum(['player','creator','admin']);
const pageQuery = z.object({q:z.string().trim().max(120).default(''),page:z.coerce.number().int().min(1).max(100000).default(1)});
const like = (value:string) => '%' + value.replace(/[\\%_]/g, c => '\\' + c) + '%';
function must(condition:unknown, message:string, status=409): asserts condition { if (!condition) throw new HttpError(status,message); }

export function dashboard(store:Store, period:'24h'|'7d'|'30d', now=Date.now()) {
  const hour=3600000, day=24*hour, offset=8*hour;
  const step=period==='24h'?hour:day, count=period==='24h'?24:period==='7d'?7:30;
  const end=Math.floor((now+offset)/step)*step-offset+step, start=end-count*step;
  const opening=Number(store.one('SELECT COALESCE(SUM(delta),0) n FROM ledger WHERE created_at<?',start)!.n);
  const candles=store.all(`WITH running AS (
    SELECT rowid n,created_at,CAST((created_at-?)/? AS INTEGER) bucket,
    ?+SUM(delta) OVER(ORDER BY created_at,rowid ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) balance
    FROM ledger WHERE created_at>=? AND created_at<?
  ), ranked AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY bucket ORDER BY created_at DESC,n DESC) last_row FROM running
  ) SELECT bucket,MIN(balance) low,MAX(balance) high,MAX(CASE WHEN last_row=1 THEN balance END) close,COUNT(*) events FROM ranked GROUP BY bucket`, start,step,opening,start,end);
  const drawBuckets=store.all('SELECT CAST((created_at-?)/? AS INTEGER) bucket,COUNT(*) draws,COALESCE(SUM(cost),0) spent FROM draws WHERE created_at>=? AND created_at<? GROUP BY bucket',start,step,start,end);
  const registrations=store.all('SELECT CAST((created_at-?)/? AS INTEGER) bucket,COUNT(*) registrations FROM users WHERE created_at>=? AND created_at<? GROUP BY bucket',start,step,start,end);
  const receipts=store.all("SELECT CAST((paid_at-?)/? AS INTEGER) bucket,COALESCE(SUM(amount),0) paidTwd FROM payment_orders WHERE status='paid' AND environment='production' AND paid_at>=? AND paid_at<? GROUP BY bucket",start,step,start,end);
  const refundBuckets=store.all("SELECT CAST((r.completed_at-?)/? AS INTEGER) bucket,COALESCE(SUM(r.amount),0) refundedTwd FROM refunds r JOIN payment_orders o ON o.order_no=r.order_no WHERE r.status='completed' AND o.status='paid' AND o.environment='production' AND r.completed_at>=? AND r.completed_at<? GROUP BY bucket",start,step,start,end);
  const grossPaidTwd=Number(store.one("SELECT COALESCE(SUM(amount),0) n FROM payment_orders WHERE status='paid' AND environment='production'")!.n),refundedTwd=Number(store.one("SELECT COALESCE(SUM(r.amount),0) n FROM refunds r JOIN payment_orders o ON o.order_no=r.order_no WHERE r.status='completed' AND o.status='paid' AND o.environment='production'")!.n);
  let last=opening, cumulativeDraws=0;
  const series=Array.from({length:count},(_,i) => {
    const c=candles.find(c=>c.bucket===i), d=drawBuckets.find(b=>b.bucket===i), u=registrations.find(b=>b.bucket===i), p=receipts.find(b=>b.bucket===i), r=refundBuckets.find(b=>b.bucket===i);
    const open=last; last=c?Number(c.close):open; cumulativeDraws+=Number(d?.draws??0);
    return {timestamp:start+i*step,open,high:Math.max(open,Number(c?.high??open)),low:Math.min(open,Number(c?.low??open)),close:last,events:Number(c?.events??0),draws:Number(d?.draws??0),spent:Number(d?.spent??0),registrations:Number(u?.registrations??0),grossPaidTwd:Number(p?.paidTwd??0),refundedTwd:Number(r?.refundedTwd??0),paidTwd:Number(p?.paidTwd??0)-Number(r?.refundedTwd??0),cumulativeDraws};
  });
  const today=Math.floor((now+offset)/day)*day-offset;
  const stats={
    users:store.one('SELECT COUNT(*) n FROM users')!.n,
    newToday:store.one('SELECT COUNT(*) n FROM users WHERE created_at>=?',today)!.n,
    admins:store.one("SELECT COUNT(*) n FROM users WHERE role='admin' AND disabled=0")!.n,
    livePools:store.one("SELECT COUNT(*) n FROM pools WHERE status='live'")!.n,
    pendingPools:store.one("SELECT COUNT(*) n FROM pools WHERE status='pending'")!.n,
    pendingShipments:store.one("SELECT COUNT(*) n FROM shipments WHERE status='requested'")!.n,
    drawsToday:store.one('SELECT COUNT(*) n FROM draws WHERE created_at>=?',today)!.n,
    points:store.one('SELECT COALESCE(SUM(points),0) n FROM users')!.n,
    grossPaidTwd,refundedTwd,paidTwd:grossPaidTwd-refundedTwd,
    stagePaidTwd:store.one("SELECT COALESCE(SUM(amount),0) n FROM payment_orders WHERE status='paid' AND environment='stage'")!.n,
    physicalStock:store.one("SELECT COALESCE(SUM(r.remaining),0) n FROM prizes r JOIN pools p ON p.id=r.pool_id WHERE r.kind='physical' AND p.status NOT IN('cancelled','settled')")!.n
  };
  return {period,timezone:'Asia/Taipei',start,end,generatedAt:now,stats,series,definitions:{candles:'全站會員可用點數總量；依帳本事件計算開／高／低／收。無異動區間延續前值，並標記 events=0。不是金融商品價格。',curve:'所選區間累計抽獎次數。收款淨額依 production 已付款訂單減已完成退款；退款以完成時間列入，可為負值。人工登記不代替銀行對帳，stage 不計。'}};
}

export function installAdmin(app:Express, store:Store, options:{
  mutation:(req:Request,res:Response,operation:()=>unknown,fingerprint?:unknown)=>void;
  config:Config;
  prizeSchema:z.ZodType<any>;
  checkImages:(req:Request,refs:string[])=>void;
}) {
  const {mutation,prizeSchema,checkImages,config}=options;
  installBalanceAdjustments(app,store,config,mutation);
  app.get('/api/admin/activity',(req,res)=>{
    const {q,category}=z.object({q:z.string().trim().max(100).default(''),category:z.enum(activityCategories).default('all')}).strict().parse(req.query);
    res.json(activity(store,q,category));
  });
  app.post('/api/admin/catalog/starter-drafts',(req,res)=>mutation(req,res,()=>{z.object({}).strict().parse(req.body);return starterDrafts(store,req.user!.id);}));
  // Installed AFTER /api/admin requireAuth/requireAdmin and global Origin/CSRF checks.
  app.get('/api/admin/dashboard',(req,res)=>{
    const period=z.enum(['24h','7d','30d']).parse(req.query.period??'7d');
    res.json(dashboard(store,period));
  });
  app.get('/api/admin/members',(req,res)=>{
    const query=pageQuery.extend({role:roles.optional(),disabled:z.enum(['0','1']).optional()}).strict().parse(req.query);
    const params:any[]=[like(query.q),like(query.q)];
    let where="(email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')";
    if(query.role){where+=' AND role=?';params.push(query.role);}
    if(query.disabled){where+=' AND disabled=?';params.push(Number(query.disabled));}
    const total=Number(store.one('SELECT COUNT(*) n FROM users WHERE '+where,...params)!.n),pageCount=Math.max(1,Math.ceil(total/20)),page=Math.min(query.page,pageCount);
    res.json({adjustmentsEnabled:config.adminBalanceAdjustments,items:store.all(`SELECT ${memberFields} FROM users WHERE ${where} ORDER BY created_at DESC,id LIMIT 20 OFFSET ?`,...params,(page-1)*20),total,page,pageCount,pageSize:20});
  });
  app.get('/api/admin/members/:id',(req,res)=>res.json(requireRow(store.one(`SELECT ${memberFields} FROM users WHERE id=?`,z.uuid().parse(req.params.id)))));
  app.post('/api/admin/members',async(req,res)=>{
    const data=z.object({email:emailSchema,name:nameSchema,password:passwordSchema,role:roles}).strict().parse(req.body);
    const hash=await passwordHash(data.password);
    mutation(req,res,()=>{
      must(!store.one('SELECT id FROM users WHERE email=?',data.email),'Email 已被註冊');
      const id=randomUUID();
      store.run('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',id,data.email,data.name,hash,data.role,Date.now());
      store.audit(req.user!.id,'admin_member_create',id,{email:data.email,role:data.role});
      return {id,role:data.role};
    });
  });
  app.post('/api/admin/members/:id/profile',(req,res)=>mutation(req,res,()=>{
    const id=z.uuid().parse(req.params.id),data=z.object({email:emailSchema,name:nameSchema}).strict().parse(req.body);
    const old=requireRow(store.one('SELECT id,email FROM users WHERE id=?',id));
    must(!store.one('SELECT id FROM users WHERE email=? AND id<>?',data.email,id),'Email 已被註冊');
    store.run('UPDATE users SET email=?,name=?,email_verified_at=CASE WHEN email=? THEN email_verified_at ELSE NULL END WHERE id=?',data.email,data.name,data.email,id);
    if(old.email!==data.email){
      store.run('DELETE FROM sessions WHERE user_id=?',id);
      store.run('DELETE FROM email_verifications WHERE user_id=?',id);
      store.run('DELETE FROM resets WHERE user_id=?',id);
      store.run('DELETE FROM oauth_states WHERE user_id=?',id);
    }
    store.audit(req.user!.id,'admin_member_profile',id,{emailChanged:old.email!==data.email});
    return {ok:true};
  }));
  app.get('/api/admin/catalog',(req,res)=>{
    const query=pageQuery.strict().parse(req.query),term=like(query.q);
    const where="(p.name LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM prizes r WHERE r.pool_id=p.id AND r.name LIKE ? ESCAPE '\\'))";
    const total=Number(store.one('SELECT COUNT(*) n FROM pools p JOIN users u ON u.id=p.owner_id WHERE '+where,term,term,term)!.n),pageCount=Math.max(1,Math.ceil(total/12)),page=Math.min(query.page,pageCount);
    const items=store.all(`SELECT p.id,p.name,p.status,p.total,p.remaining,p.kind,p.price,p.draw_mode,p.odds_version,u.name creator,s.source_url referenceSource,s.code referenceCode FROM pools p JOIN users u ON u.id=p.owner_id LEFT JOIN starter_catalog s ON s.pool_id=p.id WHERE ${where} ORDER BY p.created_at DESC,p.id LIMIT 12 OFFSET ?`,term,term,term,(page-1)*12).map(p=>({...p,editable:['draft','rejected'].includes(p.status),oddsEditable:!['sold_out','settled','cancelled'].includes(p.status),prizes:effectiveOdds(store.all('SELECT id,name,kind,image,value,redeem_points,quantity,remaining,weight_bps FROM prizes WHERE pool_id=? ORDER BY value DESC,name,id',p.id)).map((item:Record<string,any>)=>{const ref=starterProducts.find(s=>s.code===p.referenceCode&&s.name===item.name&&item.kind==='physical');return {...item,...(ref&&!item.image?{referenceImage:'/assets/reference-'+ref.code+'.svg'}:{})};})}));
    res.json({items,total,page,pageCount,pageSize:12});
  });
  app.post('/api/admin/pools/:id/prizes',(req,res)=>mutation(req,res,()=>{
    const id=z.uuid().parse(req.params.id),pool=requireRow(store.one('SELECT * FROM pools WHERE id=?',id));
    must(['draft','rejected'].includes(pool.status)&&pool.reserve_points===0,'送審後不可改動商品規格或庫存；請使用獨立的機率設定');
    must(!store.one('SELECT pool_id FROM tickets WHERE pool_id=? LIMIT 1',id)&&!store.one('SELECT id FROM draws WHERE pool_id=? LIMIT 1',id),'已有抽獎或承諾序列，禁止修改');
    const {prizes}=z.object({prizes:z.array(prizeSchema).min(1).max(100)}).strict().parse(req.body);
    const total=prizes.reduce((sum,p)=>sum+p.quantity,0);
    must(total<=10000,'總抽數不可超過 10,000',400);
    for(const p of prizes) {

      must(p.kind!=='points'||(p.value>0&&p.redeemPoints===0),'點數獎額必須大於 0，兌點必須為 0',400);
    }
    checkImages(req,prizes.map(p=>p.image));
    const before=store.all('SELECT id,name,kind,quantity,value,redeem_points FROM prizes WHERE pool_id=? ORDER BY id',id);
    store.run('DELETE FROM prizes WHERE pool_id=?',id);
    for(const p of prizes)store.run('INSERT INTO prizes(id,pool_id,name,kind,image,value,redeem_points,quantity,remaining) VALUES (?,?,?,?,?,?,?,?,?)',randomUUID(),id,p.name,p.kind,p.image,p.value,p.redeemPoints,p.quantity,p.quantity);
    store.run("UPDATE pools SET total=?,remaining=?,draw_mode='committed',odds_version=odds_version+1 WHERE id=?",total,total,id);
    store.audit(req.user!.id,'admin_prizes_update',id,{before,after:prizes,total});
    return {ok:true,total,probabilities:prizes.map(p=>({name:p.name,quantity:p.quantity,probability:p.quantity/total}))};
  }));
  app.post('/api/admin/pools/:id/odds',(req,res)=>mutation(req,res,()=>{
    must(!store.one("SELECT 1 FROM prizes WHERE pool_id=? AND kind='none'",z.uuid().parse(req.params.id)), '此舊獎池含未中獎，請在送審前編輯物品或建立新池');
    const id=z.uuid().parse(req.params.id),pool=requireRow(store.one('SELECT * FROM pools WHERE id=?',id));
    must(!['sold_out','settled','cancelled'].includes(pool.status),'已結束的獎池不能調整機率');
    const data=z.object({expectedVersion:z.number().int().min(0),prizes:z.array(z.object({id:z.uuid(),probabilityBps:z.number().int().min(0).max(10000)}).strict()).min(1).max(100)}).strict().parse(req.body);
    must(data.expectedVersion===pool.odds_version,'設定已被更新，請重新載入');
    const before=store.all('SELECT id,name,quantity,remaining,weight_bps FROM prizes WHERE pool_id=? ORDER BY id',id);
    must(data.prizes.length===before.length&&new Set(data.prizes.map(p=>p.id)).size===before.length&&data.prizes.every(p=>before.some(b=>b.id===p.id)),'獎品清單不符',400);
    must(data.prizes.reduce((sum,p)=>sum+p.probabilityBps,0)===10000,'各物品機率合計必須為 100%',400);
    must(before.some(p=>(['draft','rejected'].includes(pool.status)||p.remaining>0)&&data.prizes.some(d=>d.id===p.id&&d.probabilityBps>0)),'至少一項有庫存的物品必須有非零機率',400);
    for(const p of data.prizes)store.run('UPDATE prizes SET weight_bps=? WHERE id=? AND pool_id=?',p.probabilityBps,p.id,id);
    store.run("UPDATE pools SET draw_mode='weighted',odds_version=odds_version+1 WHERE id=?",id);
    store.audit(req.user!.id,'admin_odds_update',id,{before,after:data.prizes,version:pool.odds_version+1});
    return {ok:true,oddsVersion:pool.odds_version+1,drawMode:'weighted'};
  }));
}

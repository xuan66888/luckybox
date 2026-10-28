import { randomBytes, randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { Store, HttpError, requireRow } from './db.js';
import { requireAuth, requireAdmin } from './auth.js';

const taskNames = ['verify_email','verify_phone','first_draw','daily_visit'] as const;
const reward = z.number().int().min(0).max(1000);
export const campaignSchema = z.object({
  rewardsEnabled: z.boolean(), dailyBudget: z.number().int().min(0).max(100000),
  referral: z.object({ enabled:z.boolean(), inviter:reward, invitee:reward, minimumPayment:z.number().int().min(1).max(20000), monthlyLimit:z.number().int().min(1).max(100) }).strict(),
  tasks:z.object({verify_email:reward,verify_phone:reward,first_draw:reward,daily_visit:reward}).strict(),
  vip:z.array(z.object({name:z.string().trim().min(1).max(24),threshold:z.number().int().min(0).max(10000000),perk:z.string().trim().max(120)}).strict()).min(1).max(10),
  announcement:z.string().trim().max(300)
}).strict().superRefine((v,ctx)=>{if(v.vip[0].threshold!==0||v.vip.some((tier,i)=>i>0&&tier.threshold<=v.vip[i-1].threshold))ctx.addIssue({code:'custom',message:'VIP 門檻須由 0 開始遞增',path:['vip']});});
export const defaultCampaign = {
  rewardsEnabled:false,dailyBudget:1000,
  referral:{enabled:false,inviter:50,invitee:20,minimumPayment:100,monthlyLimit:10},
  tasks:{verify_email:10,verify_phone:20,first_draw:10,daily_visit:1},
  vip:[{name:'收藏新星',threshold:0,perk:'基本會員服務'},{name:'銀卡收藏家',threshold:1000,perk:'銀卡徽章'},{name:'金卡收藏家',threshold:5000,perk:'金卡徽章'},{name:'黑曜收藏家',threshold:20000,perk:'黑曜徽章'}],
  announcement:'每抽皆有獎｜機率以各獎池當下公告為準。'
};
export function campaign(store:Store){const row=store.one('SELECT * FROM community_settings WHERE id=1');return {version:row?.version??0,settings:row?campaignSchema.parse(JSON.parse(row.body)):structuredClone(defaultCampaign)};}
const dateKey=(time=Date.now())=>new Date(time+8*3600000).toISOString().slice(0,10);
export function notify(store:Store,user:string,title:string,body:string){store.run('INSERT INTO notifications(id,user_id,title,body,created_at) VALUES(?,?,?,?,?)',randomUUID(),user,title,body,Date.now());}
export function vipState(store:Store,user:string,demo=false){
  const net=demo?requireRow(store.one("SELECT COALESCE(SUM(delta),0) amount FROM ledger WHERE user_id=? AND kind='demo_topup'",user)).amount:requireRow(store.one("SELECT COALESCE(SUM(o.amount-COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.order_no=o.order_no AND r.status='completed'),0)),0) amount FROM payment_orders o WHERE o.user_id=? AND o.status='paid' AND o.environment='production'",user)).amount;
  const tiers=campaign(store).settings.vip,tier=[...tiers].reverse().find(t=>net>=t.threshold)!,next=tiers.find(t=>t.threshold>net);
  return {netPaid:net,tier,next:next??null,progress:next?Math.min(100,Math.floor((net-tier.threshold)/(next.threshold-tier.threshold)*100)):100};
}
function award(store:Store,user:string,points:number,reference:string){
  if(!points||store.one("SELECT 1 FROM ledger WHERE user_id=? AND kind='community_reward' AND reference=?",user,reference))return;
  const c=campaign(store).settings,start=Date.parse(dateKey()+'T00:00:00+08:00');
  const spent=requireRow(store.one("SELECT COALESCE(SUM(delta),0) total FROM ledger WHERE kind='community_reward' AND created_at>=?",start)).total;
  if(spent+points>c.dailyBudget)throw new HttpError(409,'今日活動贈點額度已用完，請稍後再試');
  store.balance(user,points,'community_reward',reference);notify(store,user,'活動點數已入帳',`獲得 ${points} 點；可在點數帳本查詢。`);
}
export function qualifyReferral(store:Store,user:string){
  const c=campaign(store).settings;if(!c.rewardsEnabled||!c.referral.enabled)return;
  const r=store.one('SELECT * FROM referrals WHERE invitee_id=? AND rewarded_at IS NULL',user);if(!r)return;
  const u=store.one('SELECT * FROM users WHERE id=? AND disabled=0',user),inviter=store.one('SELECT * FROM users WHERE id=? AND disabled=0',r.inviter_id);
  if(!u?.email_verified_at||!u.phone_verified_at||!inviter?.email_verified_at||!inviter.phone_verified_at||u.role==='admin'||inviter.role==='admin'||u.phone===inviter.phone)return;
  // Only the first real successful payment qualifies. Stage/manual credits never qualify.
  const first=store.one("SELECT * FROM payment_orders WHERE user_id=? AND status='paid' AND environment='production' ORDER BY paid_at,order_no LIMIT 1",user);
  if(!first||first.created_at<r.created_at||first.amount<c.referral.minimumPayment||store.one("SELECT 1 FROM refunds WHERE order_no=? AND status NOT IN('rejected','cancelled')",first.order_no))return;
  const month=dateKey().slice(0,7),start=Date.parse(month+'-01T00:00:00+08:00');
  if(requireRow(store.one('SELECT COUNT(*) n FROM referrals WHERE inviter_id=? AND rewarded_at>=?',r.inviter_id,start)).n>=c.referral.monthlyLimit)return;
  // Budget exhaustion must never roll back a genuine payment or account verification.
  const budget=requireRow(store.one("SELECT COALESCE(SUM(delta),0) total FROM ledger WHERE kind='community_reward' AND created_at>=?",Date.parse(dateKey()+'T00:00:00+08:00'))).total;
  if(budget+c.referral.inviter+c.referral.invitee>c.dailyBudget)return;
  award(store,r.inviter_id,c.referral.inviter,`referral:${user}:inviter`);award(store,user,c.referral.invitee,`referral:${user}:invitee`);
  store.run('UPDATE referrals SET qualified_order=?,rewarded_at=?,qualification_minimum=? WHERE invitee_id=?',first.order_no,Date.now(),c.referral.minimumPayment,user);store.audit(user,'referral_qualified',first.order_no,{inviter:r.inviter_id});
}
export function paymentCommunity(store:Store,user:string,mode:string){notify(store,user,'儲值入帳',mode==='production'?'正式付款已由金流確認，點數已入帳。':'測試付款已入帳，不計入 VIP 或邀請獎勵。');if(mode==='production')qualifyReferral(store,user);}
function taskState(store:Store,user:string){
  const u=requireRow(store.one('SELECT * FROM users WHERE id=?',user)),c=campaign(store).settings;
  return taskNames.map(id=>{const period=id==='daily_visit'?dateKey():'once',done=id==='verify_email'?!!u.email_verified_at:id==='verify_phone'?!!u.phone_verified_at:id==='first_draw'?!!store.one('SELECT 1 FROM draws WHERE user_id=? LIMIT 1',user):true;
    return{id,period,points:c.tasks[id],done,claimed:!!store.one('SELECT 1 FROM reward_claims WHERE user_id=? AND task=? AND period=?',user,id,period)};});
}
type Mutation=(req:Request,res:Response,fn:()=>unknown)=>void;
export function installCommunity(app:Express,store:Store,mutation:Mutation,demo=false){
  app.get('/api/community/live',(_req,res)=>{
    const c=campaign(store);const events=store.all("SELECT d.id,d.created_at,u.name,r.name prize,p.name pool FROM draws d JOIN users u ON u.id=d.user_id JOIN prizes r ON r.id=d.prize_id JOIN pools p ON p.id=d.pool_id WHERE r.kind<>'none' AND u.disabled=0 ORDER BY d.created_at DESC,d.id LIMIT 20");
    res.json({announcement:c.settings.announcement,events:events.map(e=>({...e,name:[...e.name].slice(0,1).join('')+'＊＊'})),generatedAt:Date.now()});
  });
  app.get('/api/me/community',requireAuth,(req,res)=>{
    const id=req.user!.id;
    store.run('INSERT OR IGNORE INTO referral_codes VALUES(?,?)',id,randomBytes(12).toString('hex'));
    const c=campaign(store);res.json({demo,vip:vipState(store,id,demo),rewardsEnabled:c.settings.rewardsEnabled,referral:c.settings.referral,code:requireRow(store.one('SELECT code FROM referral_codes WHERE user_id=?',id)).code,
      referralBound:!!store.one('SELECT 1 FROM referrals WHERE invitee_id=?',id),invited:requireRow(store.one('SELECT COUNT(*) n FROM referrals WHERE inviter_id=?',id)).n,qualified:requireRow(store.one('SELECT COUNT(*) n FROM referrals WHERE inviter_id=? AND rewarded_at IS NOT NULL AND revoked_at IS NULL',id)).n,
      tasks:taskState(store,id),notifications:store.all('SELECT id,title,body,created_at,read_at FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50',id)});
  });
  app.post('/api/me/referral',requireAuth,(req,res)=>mutation(req,res,()=>{
    const {code}=z.object({code:z.string().regex(/^[a-f0-9]{24}$/)}).strict().parse(req.body),id=req.user!.id;
    const u=requireRow(store.one('SELECT * FROM users WHERE id=?',id));if(u.role==='admin')throw new HttpError(403,'管理帳號不參與邀請活動');
    if(u.created_at<Date.now()-7*86400000||store.one("SELECT 1 FROM payment_orders WHERE user_id=? AND status='paid' AND environment='production'",id))throw new HttpError(409,'僅限註冊 7 天內且尚未正式付款的新會員綁定');
    const ref=store.one('SELECT * FROM referral_codes WHERE code=?',code);if(!ref||ref.user_id===id)throw new HttpError(400,'邀請碼無效，不能邀請自己');
    if(store.one('SELECT 1 FROM referrals WHERE invitee_id=?',id)||store.one('SELECT 1 FROM referrals WHERE invitee_id=? AND inviter_id=?',ref.user_id,id))throw new HttpError(409,'已綁定或屬互相邀請');
    store.run('INSERT INTO referrals(invitee_id,inviter_id,created_at) VALUES(?,?,?)',id,ref.user_id,Date.now());store.audit(id,'referral_bound',ref.user_id);return{ok:true};
  }));
  app.post('/api/me/tasks/claim',requireAuth,(req,res)=>mutation(req,res,()=>{
    const {task}=z.object({task:z.enum(taskNames)}).strict().parse(req.body),c=campaign(store).settings,id=req.user!.id;
    if(!c.rewardsEnabled)throw new HttpError(503,'活動贈點尚未開放');if(req.user!.role==='admin')throw new HttpError(403,'管理帳號不領取活動獎勵');
    const t=taskState(store,id).find(t=>t.id===task)!;if(!t.done||t.claimed)throw new HttpError(409,'尚未完成任務或已領取');
    award(store,id,t.points,`task:${task}:${t.period}`);store.run('INSERT INTO reward_claims VALUES(?,?,?,?,?)',id,task,t.period,t.points,Date.now());store.audit(id,'task_claim',task,{period:t.period,points:t.points});return{ok:true,points:t.points};
  }));
  app.post('/api/me/notifications/read',requireAuth,(req,res)=>mutation(req,res,()=>{const{id}=z.object({id:z.uuid()}).strict().parse(req.body);store.run('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?',Date.now(),id,req.user!.id);return{ok:true};}));
  app.get('/api/admin/campaigns',requireAuth,requireAdmin,(_req,res)=>res.json(campaign(store)));
  app.post('/api/admin/campaigns',requireAuth,requireAdmin,(req,res)=>mutation(req,res,()=>{
    const d=z.object({version:z.number().int().min(0),settings:campaignSchema}).strict().parse(req.body),c=campaign(store);if(c.version!==d.version)throw new HttpError(409,'設定已更新，請重新整理');
    store.run('INSERT INTO community_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,body=excluded.body',d.version+1,JSON.stringify(d.settings));store.audit(req.user!.id,'campaign_settings','community',{version:d.version+1,settings:d.settings});return{ok:true,version:d.version+1};
  }));
}

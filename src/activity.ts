import type {Store} from './db.js';
export const activityCategories=['all','auth','payment','draw','catalog','fulfillment','account','system'] as const;
export type ActivityCategory=typeof activityCategories[number];
export function eventCategory(action:string):ActivityCategory{
 if(['register','login','logout','admin_login','google_login','password_reset'].includes(action))return 'auth';
 if(/^(ecpay_|topup_|refund)/.test(action))return 'payment';
 if(['draw','redeem','practice_draw'].includes(action))return 'draw';
 if(/^(pool_|content_|service_|admin_prizes_|admin_odds_|physical_drafts_)/.test(action))return 'catalog';
 if(/^(shipping_|shipment_)/.test(action))return 'fulfillment';
 if(/^(user_|admin_member_|admin_balance_|mfa_|task_|referral_)/.test(action))return 'account';
 return 'system';
}
const allowed=new Set(['delta','before','after','reason','reference','adjustmentId','quantity','cost','amount','points','mode','code','approve','note','version','drawMode','oddsVersion']);
function safeDetail(raw:string){
 try{return Object.fromEntries(Object.entries(JSON.parse(raw)).filter(([k,v])=>allowed.has(k)&&['string','number','boolean'].includes(typeof v)).map(([k,v])=>[k,typeof v==='string'?v.slice(0,160):v]));}catch{return {};}
}
export function activity(store:Store,q:string,category:ActivityCategory,now=Date.now()){
 const term='%'+q.replace(/[\\%_]/g,c=>'\\'+c)+'%';
 const rows=store.all(`SELECT a.rowid seq,a.id,a.action,a.target,a.detail,a.created_at,u.name actor,u.email,p.name pool
 FROM audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN pools p ON p.id=a.target
 WHERE (a.action LIKE ? ESCAPE '\\' OR a.target LIKE ? ESCAPE '\\' OR COALESCE(u.email,'') LIKE ? ESCAPE '\\' OR COALESCE(u.name,'') LIKE ? ESCAPE '\\' OR COALESCE(p.name,'') LIKE ? ESCAPE '\\')
 ORDER BY a.rowid DESC LIMIT 1000`,term,term,term,term,term);
 const selected=rows.filter(r=>category==='all'||eventCategory(r.action)===category);
 const items=selected.slice(0,50).map(r=>({seq:r.seq,id:r.id,action:r.action,category:eventCategory(r.action),target:r.target,actor:r.actor??'系統',email:r.email??'',pool:r.pool??'',createdAt:r.created_at,detail:safeDetail(r.detail)}));
 const today=Math.floor((now+8*3600000)/86400000)*86400000-8*3600000;
 return {generatedAt:now,refreshSeconds:5,items,scanned:rows.length,limitedToLatest:1000,hasMore:selected.length>50,
  stats:{registrationsToday:store.one('SELECT COUNT(*) n FROM users WHERE created_at>=?',today)!.n,drawsToday:store.one('SELECT COUNT(*) n FROM draws WHERE created_at>=?',today)!.n,
   spentToday:store.one('SELECT COALESCE(SUM(cost),0) n FROM draws WHERE created_at>=?',today)!.n,paidTwdToday:Number(store.one("SELECT COALESCE(SUM(amount),0) n FROM payment_orders WHERE status='paid' AND environment='production' AND paid_at>=?",today)!.n)-Number(store.one("SELECT COALESCE(SUM(r.amount),0) n FROM refunds r JOIN payment_orders o ON o.order_no=r.order_no WHERE r.status='completed' AND o.status='paid' AND o.environment='production' AND r.completed_at>=?",today)!.n)},
  testDrawsToday:store.one('SELECT COUNT(*) n FROM practice_draws WHERE created_at>=?',today)!.n,
  testDraws:store.all('SELECT d.id,d.created_at,u.name player,u.email,r.name prize FROM practice_draws d JOIN users u ON u.id=d.user_id JOIN practice_prizes r ON r.id=d.prize_id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 20'),
  draws:store.all('SELECT d.id,d.created_at,d.cost,u.name player,u.email,p.name pool,r.name prize FROM draws d JOIN users u ON u.id=d.user_id JOIN pools p ON p.id=d.pool_id JOIN prizes r ON r.id=d.prize_id ORDER BY d.created_at DESC,d.rowid DESC LIMIT 20'),
  payments:store.all('SELECT p.order_no,p.created_at,p.paid_at,p.amount,p.points,p.status,p.environment,u.name player,u.email FROM payment_orders p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.rowid DESC LIMIT 20'),
  ledger:store.all('SELECT l.id,l.created_at,l.kind,l.delta,l.balance_after,u.name player,u.email FROM ledger l JOIN users u ON u.id=l.user_id ORDER BY l.created_at DESC,l.rowid DESC LIMIT 20')};
}

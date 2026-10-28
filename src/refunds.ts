import {randomUUID} from 'node:crypto';
import type {Express,Request,Response} from 'express';
import {z} from 'zod';
import {HttpError,requireRow,type Store} from './db.js';
import {requireAuth,requireAdmin,passwordMatches} from './auth.js';
import {checkAdminMfa} from './identity.js';
import {notify} from './community.js';
import type {Config} from './config.js';

type Mutation=(req:Request,res:Response,operation:()=>unknown,fingerprint?:unknown)=>void;
const open="'requested','needs_review','processing','legacy_review'";
const transition=z.object({action:z.enum(['prepare','complete','reject','provider_failed']),expectedVersion:z.number().int().min(0),note:z.string().trim().min(5).max(500),password:z.string().min(1).max(128),otp:z.string().max(32).optional(),providerReference:z.string().trim().min(8).max(100).optional(),providerAmount:z.number().int().min(1).max(20000).optional(),providerOutcome:z.enum(['confirmed_refunded','confirmed_not_refunded']).optional(),providerEligibilityReviewed:z.boolean().optional(),acceptLossPoints:z.number().int().min(0).max(22000).default(0)}).strict();
function event(store:Store,id:string,actor:string,type:string,from:string|null,to:string,version:number,detail:unknown={}){store.run('INSERT INTO refund_events(refund_id,actor_id,event,from_status,to_status,version,detail,created_at) VALUES(?,?,?,?,?,?,?,?)',id,actor,type,from,to,version,JSON.stringify(detail),Date.now());store.audit(actor,'refund_'+type,id,detail);}
function completed(store:Store,order:string){return Number(store.one("SELECT COALESCE(SUM(amount),0) n FROM refunds WHERE order_no=? AND status='completed'",order)!.n);}
export function refundEligibility(store:Store,user:string,order:string){
 const o=requireRow(store.one("SELECT * FROM payment_orders WHERE order_no=? AND user_id=? AND status='paid'",order,user)),refunded=completed(store,order),remaining=Math.max(0,Number(o.amount)-refunded),sourceAvailable=store.sourceBalance(user,{kind:'ecpay_topup',reference:order});
 return {orderNo:order,environment:o.environment,originalAmount:o.amount,completedAmount:refunded,remainingAmount:remaining,sourceAvailable,unspentEligible:Math.min(remaining,sourceAvailable),openCase:!!store.one(`SELECT 1 FROM refunds WHERE order_no=? AND status IN(${open})`,order),automaticBankRefund:false};
}
function checkCaseAccounting(store:Store,id:string){
 for(const u of store.all('SELECT DISTINCT user_id FROM wallet_holds WHERE refund_id=?',id)){
  const total=store.one('SELECT u.points,(SELECT COALESCE(SUM(delta),0) FROM ledger WHERE user_id=u.id) ledger,(SELECT COALESCE(SUM(remaining),0) FROM point_lots WHERE user_id=u.id) lots FROM users u WHERE u.id=?',u.user_id)!;
  if(total.points!==total.ledger||total.points!==total.lots||store.pointHistoryIssues(u.user_id)||store.holdHistoryIssues(u.user_id))throw new HttpError(409,'案件相關點數對帳異常，停止退款處理');
 }
}
function release(store:Store,r:Record<string,any>,actor:string,status:'cancelled'|'rejected',note:string){
 checkCaseAccounting(store,r.id);
 store.run('UPDATE refunds SET status=?,version=version+1,operator_id=?,decision_note=? WHERE id=?',status,actor,note,r.id);
 for(const h of store.all("SELECT * FROM wallet_holds WHERE refund_id=? AND state='active'",r.id)){store.releaseRefundHold(h.id);if(h.user_id!==r.user_id)notify(store,h.user_id,'活動點數凍結已解除','資格複核已結束，原來源點數已退回可用餘額。');}
 for(const u of store.all('SELECT DISTINCT user_id FROM wallet_holds WHERE refund_id=?',r.id))if(store.holdHistoryIssues(u.user_id))throw new HttpError(409,'解凍紀錄不符，已回復本次異動');
 event(store,r.id,actor,status,r.status,status,r.version+1,{note});notify(store,r.user_id,'退款申請'+(status==='cancelled'?'已取消':'已拒絕'),'本次保留的點數已按原來源解除凍結；未登記銀行退款。');
 return {id:r.id,status,version:r.version+1,bankActionPerformed:false};
}
export function installRefunds(app:Express,store:Store,config:Config,mutation:Mutation){
 app.get('/api/me/refund-eligibility',requireAuth,(req,res)=>{const q=z.object({orderNo:z.string().min(1).max(20)}).strict().parse(req.query);res.json(refundEligibility(store,req.user!.id,q.orderNo));});
 app.get('/api/me/refunds',requireAuth,(req,res)=>res.json(store.all("SELECT r.id,r.order_no,r.reason,r.amount,r.status,r.version,r.requested_at,r.completed_at,r.cash_shortfall,COALESCE((SELECT SUM(h.points) FROM wallet_holds h WHERE h.refund_id=r.id AND h.user_id=r.user_id AND h.kind='payment' AND h.state='active'),0) held_points FROM refunds r WHERE r.user_id=? ORDER BY r.requested_at DESC,r.rowid DESC LIMIT 100",req.user!.id)));
 app.post('/api/me/refunds',requireAuth,(req,res)=>mutation(req,res,()=>{
  const d=z.object({orderNo:z.string().min(1).max(20),reason:z.string().trim().min(5).max(500),amount:z.number().int().min(1).max(20000).optional()}).strict().parse(req.body),user=req.user!.id,e=refundEligibility(store,user,d.orderNo);
  if(e.openCase)throw new HttpError(409,'此訂單已有待處理退款');const amount=d.amount??e.remainingAmount;
  if(amount<1||amount>e.remainingAmount)throw new HttpError(409,'退款金額超過訂單剩餘可退上限');
  const o=requireRow(store.one('SELECT * FROM payment_orders WHERE order_no=?',d.orderNo)),referral=store.one('SELECT * FROM referrals WHERE qualified_order=? AND rewarded_at IS NOT NULL AND revoked_at IS NULL',d.orderNo);
  const legacy=o.points!==o.amount||(!store.one("SELECT 1 FROM point_lots WHERE user_id=? AND source_kind='ecpay_topup' AND source_reference=?",user,d.orderNo))||!!(referral&&referral.qualification_minimum===null);
  const id=randomUUID(),cashReserved=legacy?0:Math.min(amount,e.sourceAvailable),cashShortfall=amount-cashReserved,status=legacy?'legacy_review':cashShortfall?'needs_review':'requested';
  store.run('INSERT INTO refunds(id,order_no,user_id,reason,amount,points,status,requested_at,cash_shortfall,legacy) VALUES(?,?,?,?,?,?,?,?,?,?)',id,d.orderNo,user,d.reason,amount,amount,status,Date.now(),cashShortfall,legacy?1:0);
  if(cashReserved)store.reserveRefundHold(id,user,cashReserved,{kind:'ecpay_topup',reference:d.orderNo},'payment');
  let rewardShortfall=0;
  if(!legacy&&referral&&e.remainingAmount-amount<referral.qualification_minimum){
   for(const [uid,suffix] of [[referral.inviter_id,'inviter'],[user,'invitee']]){
    const reference=`referral:${user}:${suffix}`,awarded=Number(store.one("SELECT COALESCE(SUM(delta),0) n FROM ledger WHERE user_id=? AND kind='community_reward' AND reference=? AND delta>0",uid,reference)!.n);
    if(!awarded)continue;const reserved=Math.min(awarded,store.sourceBalance(uid,{kind:'community_reward',reference})),shortfall=awarded-reserved;
    store.run('INSERT INTO referral_recoveries VALUES(?,?,?,?,?,?)',id,uid,reference,awarded,reserved,shortfall);rewardShortfall+=shortfall;
    if(reserved){store.reserveRefundHold(id,uid,reserved,{kind:'community_reward',reference},'referral');if(uid!==user)notify(store,uid,'活動點數資格複核','部分活動點數暫時凍結，複核結束後會通知結果；不影響其他來源點數。');}
   }
   if(rewardShortfall)store.run("UPDATE refunds SET status='needs_review' WHERE id=?",id);
  }
  const finalStatus=rewardShortfall?'needs_review':status;event(store,id,user,'requested',null,finalStatus,0,{amount,cashReserved,cashShortfall,rewardShortfall,legacy:!!legacy});notify(store,user,'退款申請已建立',`申請 NT$${amount}，原付款來源已凍結 ${cashReserved} 點，尚未執行銀行退款。`);
  return {id,status:finalStatus,version:0,amount,heldPoints:cashReserved,bankActionPerformed:false};
 }));
 app.post('/api/me/refunds/:id/cancel',requireAuth,(req,res)=>mutation(req,res,()=>{
  const {expectedVersion}=z.object({expectedVersion:z.number().int().min(0)}).strict().parse(req.body),r=requireRow(store.one('SELECT * FROM refunds WHERE id=? AND user_id=?',z.uuid().parse(req.params.id),req.user!.id));
  if(!['requested','needs_review','legacy_review'].includes(r.status)||r.version!==expectedVersion)throw new HttpError(409,'退款狀態已變更；銀行處理中的申請不能自行取消');
  return release(store,r,req.user!.id,'cancelled','會員在銀行處理前自行取消');
 }));
 app.get('/api/admin/payments',requireAuth,requireAdmin,(_req,res)=>res.json(store.all("SELECT o.order_no,o.environment,o.status,o.amount,o.points,o.created_at,COALESCE((SELECT SUM(l.delta) FROM ledger l WHERE l.user_id=o.user_id AND l.reference=o.order_no AND l.kind='ecpay_topup'),0) credited,COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.order_no=o.order_no AND r.status='completed'),0) refunded,COALESCE((SELECT SUM(h.points) FROM wallet_holds h JOIN refunds r ON r.id=h.refund_id WHERE r.order_no=o.order_no AND h.kind='payment' AND h.state='active'),0) held FROM payment_orders o ORDER BY created_at DESC LIMIT 200")));
 app.get('/api/admin/refunds',requireAuth,requireAdmin,(_req,res)=>res.json(store.all('SELECT r.*,o.amount original_amount,o.environment,u.email FROM refunds r JOIN payment_orders o ON o.order_no=r.order_no JOIN users u ON u.id=r.user_id ORDER BY requested_at DESC,r.rowid DESC LIMIT 200').map(r=>({...r,lossApprovalsEnabled:config.refundLossApprovals,holds:store.all('SELECT id,user_id,points,kind,state FROM wallet_holds WHERE refund_id=?',r.id),recoveries:store.all('SELECT user_id,awarded,reserved,shortfall FROM referral_recoveries WHERE refund_id=?',r.id),events:store.all('SELECT event,from_status,to_status,version,detail,created_at FROM refund_events WHERE refund_id=? ORDER BY seq',r.id)}))));
 app.post('/api/admin/refunds/:id/review',requireAuth,requireAdmin,(_req,res)=>res.status(410).json({error:'舊版先退刷後扣點流程已停用，請使用退款凍結與分步確認流程'}));
 app.post('/api/admin/refunds/:id/transition',requireAuth,requireAdmin,async(req,res)=>{
  const id=z.uuid().parse(req.params.id),d=transition.parse(req.body),actor=requireRow(store.one('SELECT * FROM users WHERE id=?',req.user!.id)),failureKey='refund-reauth:'+actor.id;
  store.run('DELETE FROM rate_limits WHERE key=? AND expires_at<?',failureKey,Date.now());
  if((store.one('SELECT count FROM rate_limits WHERE key=?',failureKey)?.count??0)>=5){res.setHeader('Retry-After','900');throw new HttpError(429,'管理驗證失敗過多，15分鐘後再試');}
  const failed=()=>store.run('INSERT INTO rate_limits VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',failureKey,Date.now()+900000);
  if(!await passwordMatches(d.password,actor.password_hash)){failed();throw new HttpError(401,'管理員再次驗證失敗');}
  const fresh=store.one('SELECT * FROM users WHERE id=? AND disabled=0',actor.id);
  if(!fresh||fresh.role!=='admin'||fresh.password_hash!==actor.password_hash||!store.one('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',req.session!.token_hash,actor.id,Date.now()))throw new HttpError(403,'管理權限或登入已變更，請重新登入');
  const {password:_password,otp:_otp,...safe}=d;
  try{mutation(req,res,()=>{
   const r=requireRow(store.one('SELECT * FROM refunds WHERE id=?',id));
   if(r.user_id===actor.id)throw new HttpError(403,'不可處理自己的退款');
   if(r.version!==d.expectedVersion)throw new HttpError(409,'退款版本已變更，請重新查詢');
   checkCaseAccounting(store,id);
   checkAdminMfa(store,config,fresh,d.otp,true);
   if(d.action==='reject'){
    if(!['requested','needs_review','legacy_review'].includes(r.status))throw new HttpError(409,'處理中的退款不可直接拒絕或解除凍結');
    return release(store,r,actor.id,'rejected',d.note);
   }
   if(d.action==='provider_failed'){
    if(r.status!=='processing'||d.providerOutcome!=='confirmed_not_refunded'||!d.providerReference)throw new HttpError(409,'必須確認金流未退款並填入可核對憑據；狀態不明不可解凍');
    store.run('UPDATE refunds SET provider_outcome=?,provider_reference=? WHERE id=?','operator_attested_not_refunded:'+d.providerReference,d.providerReference,id);
    return release(store,r,actor.id,'rejected',d.note);
   }
   if(d.action==='prepare'){
    if(!['requested','needs_review'].includes(r.status)||r.legacy)throw new HttpError(409,'舊資料或狀態不符，不能自動準備退款');
    if(!d.providerEligibilityReviewed)throw new HttpError(400,'先核對該支付方式／交易狀態允許此退款金額');
    const loss=r.cash_shortfall+Number(store.one('SELECT COALESCE(SUM(shortfall),0) n FROM referral_recoveries WHERE refund_id=?',id)!.n),held=Number(store.one("SELECT COALESCE(SUM(points),0) n FROM wallet_holds WHERE refund_id=? AND kind='payment' AND state='active'",id)!.n);
    if(loss&&!config.refundLossApprovals)throw new HttpError(409,'點數缺口例外核准尚未啟用；不得先退刷，請拒絕解凍或交由營運處理');
    if(held+r.cash_shortfall!==r.points)throw new HttpError(409,'原付款凍結點數不符，停止處理');
    if(d.acceptLossPoints!==loss||(loss&&d.note.length<10))throw new HttpError(409,`需明確確認無法追回的 ${loss} 點及至少10字處理說明，不會改扣其他來源`);
    store.run("UPDATE refunds SET status='processing',version=version+1,prepared_by=?,prepared_at=?,decision_note=?,loss_accepted=? WHERE id=?",actor.id,Date.now(),d.note,loss,id);
    event(store,id,actor.id,'prepared',r.status,'processing',r.version+1,{amount:r.amount,held,lossPoints:loss,note:d.note,bankActionPerformed:false});
    return {id,status:'processing',version:r.version+1,amount:r.amount,bankActionPerformed:false,next:'請營運者在金流後台處理，再以可核對憑據登記成功或確認未退款；未知結果保持凍結'};
   }
   if(r.status!=='processing'||d.providerOutcome!=='confirmed_refunded'||d.providerAmount!==r.amount||!d.providerReference)throw new HttpError(409,'僅可登記處理中的精確金額及已確認退刷憑據');
   const o=requireRow(store.one('SELECT * FROM payment_orders WHERE order_no=?',r.order_no));if(completed(store,r.order_no)+r.amount>o.amount)throw new HttpError(409,'累計退款超過原付款');
   store.balance(r.user_id,0,'payment_refund',id);
   store.run("UPDATE wallet_holds SET state='settled' WHERE refund_id=? AND state='active'",id);
   store.run("UPDATE refunds SET status='completed',version=version+1,operator_id=?,completed_at=?,provider_reference=?,provider_outcome=?,decision_note=? WHERE id=?",actor.id,Date.now(),d.providerReference,'operator_attested_refunded',d.note,id);
   store.run('UPDATE referrals SET revoked_at=?,reversed_refund_id=? WHERE qualified_order=? AND rewarded_at IS NOT NULL AND revoked_at IS NULL AND qualification_minimum>?',Date.now(),id,r.order_no,o.amount-completed(store,r.order_no));
   event(store,id,actor.id,'completed',r.status,'completed',r.version+1,{amount:r.amount,providerReference:d.providerReference,confirmation:'operator_attested',bankActionPerformed:false});notify(store,r.user_id,'退款結果已由營運登記',`已登記 NT$${r.amount} 退款；先前凍結點數已結算，不會再次扣點。銀行入帳以實際金流紀錄為準。`);
   for(const h of store.all("SELECT DISTINCT user_id FROM wallet_holds WHERE refund_id=? AND kind='referral' AND user_id<>?",id,r.user_id))notify(store,h.user_id,'活動資格已撤銷','資格複核結束，本次凍結的活動點數已追回；未扣其他來源點數。');
   return {id,status:'completed',version:r.version+1,amount:r.amount,confirmation:'operator_attested',bankActionPerformed:false};
  },safe);store.run('DELETE FROM rate_limits WHERE key=?',failureKey);}
  catch(error){if(error instanceof HttpError&&error.status===401)failed();throw error;}
 });
}

import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {Express,Request,Response} from 'express';
import {z} from 'zod';
import {Store,requireRow} from './db.js';
import {readConfig,type Config} from './config.js';
import {requireAuth} from './auth.js';
import {defaultCampaign,notify} from './community.js';

export function seedDemo(store:Store){
  if(store.one('SELECT 1 FROM demo_context WHERE id=1'))return;
  if(requireRow(store.one('SELECT COUNT(*) n FROM users')).n)throw Error('Refusing to seed an unmarked nonempty database');
  store.tx(()=>{
    const owner=randomUUID();
    store.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?, 'creator',?)",owner,'catalog@example.test','示範商品目錄','DEMO_ACCOUNT_NO_LOGIN',Date.now());
    const samples=[['霓光收藏卡試抽池（示範）',100,'cards','限定霓光收藏卡','閃耀收藏卡組','迷你收藏卡'],['迷你掌機體驗池（示範）',200,'console','星際迷你掌機','掌機造型模型','掌機主題貼紙'],['星際公仔驚喜池（示範）',50,'figure','星際限定公仔','霓光迷你公仔','收藏徽章']];
    for(const [title,price,art,...prizes]of samples){
      const id=randomUUID(),image='/demo-products/'+art+'.svg';
      store.run("INSERT INTO pools(id,owner_id,name,description,cover,description_images,status,kind,price,total,remaining,fee_bps,created_at,draw_mode,odds_version) VALUES(?,?,?,?,?,'[]','live','paid',?,1000,1000,0,?,'weighted',1)",id,owner,title,'隔離測試商品，非真實庫存；不收款、不提供出貨或現金兌換。每抽必中，三個示範物品的機率為5%／15%／80%。',image,price,Date.now());
      for(let i=0;i<3;i++)store.run('INSERT INTO prizes(id,pool_id,name,kind,image,value,redeem_points,quantity,remaining,weight_bps) VALUES(?,?,?,?,?,?,0,?,?,?)',randomUUID(),id,['大獎','二獎','三獎'][i]+'・'+prizes[i]+'（示範）','physical',image,[5000,500,50][i],[50,150,800][i],[50,150,800][i],[500,1500,8000][i]);
      store.audit(null,'demo_catalog_seed',id,{simulationOnly:true});
    }
    const c=structuredClone(defaultCampaign);c.rewardsEnabled=true;c.referral.enabled=false;c.announcement='隔離模擬體驗｜所有點數與商品均為示範，不收款、不出貨';
    store.run('INSERT INTO community_settings VALUES(1,1,?)',JSON.stringify(c));
    store.run('INSERT INTO demo_context VALUES(1,1,?)',Date.now());
  });
}
export function createDemoService(main:Config,publicDir:string,factory:(s:Store,c:Config,p:string)=>Express){
  const config=readConfig({NODE_ENV:main.production?'production':'test',PUBLIC_ORIGIN:main.origin,DATA_DIR:path.join(main.dataDir,'demo'),DEMO_MODE:'true',APP_BASE_PATH:'/demo',ALLOW_REGISTRATION:'true',ALLOW_PAID_DRAWS:'true',DEV_INITIAL_POINTS:'0',MANUAL_TOPUPS_ENABLED:'false',ECPAY_ENABLED:'false'});
  Object.defineProperty(config,'origin',{get:()=>main.origin,enumerable:true});
  if(config.dbFile===main.dbFile||config.ecpay.enabled||config.manualTopups)throw Error('Unsafe demo isolation');
  const directory=path.dirname(fileURLToPath(import.meta.url));
  const store=new Store(config.dbFile);store.migrate(path.join(directory,path.basename(directory)==='dist'?'migrations':'../migrations'));seedDemo(store);
  return {store,app:factory(store,config,publicDir)};
}
type Mutation=(req:Request,res:Response,fn:()=>unknown)=>void;
export function installDemoPayments(app:Express,store:Store,config:Config,mutation:Mutation){
  if(!config.demoMode)return;
  app.post('/api/demo/orders',requireAuth,(req,res)=>mutation(req,res,()=>{
    const {amount}=z.object({amount:z.number().int().min(1).max(20000)}).strict().parse(req.body);
    const orderNo='DM'+randomBytes(9).toString('hex');
    store.run("INSERT INTO demo_orders VALUES(?,?,?,'pending',?,NULL)",orderNo,req.user!.id,amount,Date.now());store.audit(req.user!.id,'demo_order_created',orderNo,{amount,realMoney:false});
    return {orderNo,amount,points:amount,status:'pending',simulationOnly:true};
  }));
  app.get('/api/demo/orders',requireAuth,(req,res)=>res.json(store.all('SELECT * FROM demo_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 50',req.user!.id)));
  app.post('/api/demo/orders/:id/complete',requireAuth,(req,res)=>mutation(req,res,()=>{
    const {result}=z.object({result:z.enum(['success','failure','cancelled'])}).strict().parse(req.body);
    const order=requireRow(store.one('SELECT * FROM demo_orders WHERE order_no=? AND user_id=?',z.string().regex(/^DM[a-f0-9]{18}$/).parse(req.params.id),req.user!.id));
    if(order.status!=='pending')return {status:order.status,simulationOnly:true};
    const status=result==='success'?'paid':result==='failure'?'failed':'cancelled';
    store.run('UPDATE demo_orders SET status=?,paid_at=? WHERE order_no=?',status,status==='paid'?Date.now():null,order.order_no);
    if(status==='paid'){store.balance(order.user_id,order.amount,'demo_topup',order.order_no);notify(store,order.user_id,'模擬充值完成',`已加入${order.amount}示範點數；沒有任何真實付款。`);}
    store.audit(req.user!.id,'demo_order_'+status,order.order_no,{realMoney:false});return {status,simulationOnly:true};
  }));
}

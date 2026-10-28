import {practiceAdminView} from './practice-view.js';
import {memberPage as parseMemberPage,needsMemberLogin,destinationAfterAuth,historyMode,informationSection,informationVersion,type MemberPage} from './navigation.js';
import {publicInformationView,storefrontAdminView,storefrontFieldKeys,informationSections,policyConsentView} from './storefront-view.js';
import {walletSourceView,memberRefundsView,refundStatus} from './finance-view.js';
import {ticketSelectionView,paperTicketView,mountPaperTicket} from './paper-ticket.js';
import {activityView,activityLiveView} from './activity-view.js';
import { securityView, memberView, campaignView, readinessView, refundView, liveView } from './member-view.js';
import { configureCaptcha, captchaSlot, mountCaptcha, captchaBody, resetCaptcha } from './captcha.js';
import { authFields, mfaField,memberAccessView } from './auth-view.js';
import { installHoloInteractions } from './holo.js';
import { adminFrame, dashboardView, membersView, catalogView } from './admin-view.js';
import { shellView, homeView, collectionCardView, poolDetailView, drawResultView } from './visual.js';
type Row = Record<string, any>;
const root = document.getElementById('app')!;
const siteBase=document.documentElement.dataset.basePath==='/demo'?'/demo':'';
const dialog = document.getElementById('dialog') as HTMLDialogElement;
const adminPortal=document.documentElement.dataset.portal==='admin'&&location.pathname.startsWith('/admin/');
let user: Row | null = null, csrf = '', settings: Row = {}, page:MemberPage = parseMemberPage(location.hash), pools: Row[] = [];
let renderVersion = 0;
let nextPrizeIndex = 1;
let adminTab='overview',adminRange='7d',memberQuery='',memberRole='',memberPage=1,catalogQuery='',catalogPage=1;
let activityQuery='',activityCategory='all',adminLivePaused=false,adminRefreshBusy=false;
const pendingKeys = new Map<string, string>();
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const num = (value: number) => Number(value).toLocaleString('zh-TW');
const when = (value: number) => value ? new Date(value).toLocaleString('zh-TW') : '—';
const labels: Record<string,string> = { draft:'草稿', pending:'待審核', approved:'已核准', live:'開放中', sold_out:'已抽完', rejected:'已拒絕', cancelled:'已取消', settled:'已結算', requested:'待處理', shipped:'已出貨', delivered:'已收貨', available:'待選擇', redeemed:'已兌點', shipping:'出貨處理中', player:'玩家', creator:'創作者', admin:'官方管理員', physical:'實體商品', points:'點數', none:'未中獎', identity:'身分已核驗', inventory:'庫存已核驗' };
const label = (value: string) => labels[value] ?? value;
const status = (value: string) => `<span class="status ${['approved','live','delivered','settled'].includes(value) ? 'ok' : 'wait'}">${esc(label(value))}</span>`;
const button = (text: string, action: string, id = '', extra = '') => `<button type="button" class="btn light" data-action="${esc(action)}" data-id="${esc(id)}" ${extra}>${esc(text)}</button>`;
const empty = (title: string, detail = '') => `<div class="empty"><h3>${esc(title)}</h3><p>${esc(detail)}</p></div>`;
const notice = (message: string) => `<div class="notice">${esc(message)}</div>`;
function withBase(html:string){if(settings.demo)html=html.replaceAll('創作者出貨','示範收藏（不出貨）').replaceAll('官方出貨','示範收藏（不出貨）');return siteBase?html.replace(/(href|src|action)="\/(?!\/)/g,`$1="${siteBase}/`):html;}
function setRoot(html:string){const banner=adminPortal?'':settings.demo?`<aside class="demoNotice" role="note"><strong>隔離模擬體驗｜不扣真錢、不出貨</strong><span>示範帳號、點數、VIP 與商品皆非正式資料，請勿填真實個資或常用密碼。</span><a href="${location.origin}/">返回正式站</a></aside>`:settings.demoAvailable?'<aside class="demoNotice"><strong>先體驗完整流程</strong><span>示範註冊 → 模擬充值 → 每抽必中 → 收藏，與正式帳務完全隔離。</span><a href="/demo/">進入模擬體驗站</a></aside>':'';root.innerHTML=withBase(banner+html);}
function toast(message: string) { const node = document.getElementById('toast')!; node.textContent = message; setTimeout(() => { if (node.textContent === message) node.textContent = ''; }, 5500); }
async function api(url: string, body?: unknown, key?: string) {
  const response = await fetch(`${siteBase}/api${url}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': key ?? crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '操作失敗') as Error & { status?: number; code?: string }; error.status = response.status; error.code=data.code; throw error; }
  return data;
}
async function mutate(url: string, body: unknown = {}) {
  const fingerprint = JSON.stringify([url, body]);
  const key = pendingKeys.get(fingerprint) ?? crypto.randomUUID();
  pendingKeys.set(fingerprint, key);
  try { const data = await api(url, body, key); pendingKeys.delete(fingerprint); return data; }
  catch (error) { if ((error as any).status && (error as any).status < 500) pendingKeys.delete(fingerprint); throw error; }
}
async function session() { const data = await api('/auth/me'); user = data.user; csrf = data.csrf ?? ''; }
let revealTimer: number | undefined;
let cleanupPaper=()=>{};let paperResults:Row[]=[];let paperIndex=0;
let ticketSelection:Row|null=null,balanceDraft:Row|null=null,refundDraft:Row|null=null;
let financePage=1;
let pendingReveal: Row[] | null = null;
let liveData:Row|null=null,livePaused=false;
function shell(content: string) { setRoot(adminPortal ? `<main class="adminPortalBody">${content}</main>` : shellView((liveData?liveView({...liveData,paused:livePaused}):'')+content,{user,page,registration:settings.registration})); void mountCaptcha(root); }
async function refreshLive(){if(adminPortal||document.hidden||livePaused)return;try{liveData=await api('/community/live');const current=root.querySelector('.liveTicker');if(current)current.outerHTML=liveView({...liveData!,paused:livePaused});}catch{/* Keep last confirmed feed during transient network failure. */}}
function adminLiveStatus(message:string,offline=false){const node=root.querySelector<HTMLElement>('[data-admin-live-status]');if(node){node.textContent=message;node.classList.toggle('offline',offline);}}
async function refreshAdminLive(){
 if(!adminPortal||user?.role!=='admin'||adminRefreshBusy||dialog.open||!['activity','overview','practice'].includes(adminTab))return;
 if(document.hidden||adminLivePaused){adminLiveStatus('自動更新已暫停');return;}
 const version=renderVersion,tab=adminTab;adminRefreshBusy=true;
 try{
  const d=await api(tab==='practice'?'/admin/practice':tab==='activity'?'/admin/activity?'+new URLSearchParams({q:activityQuery,category:activityCategory}):'/admin/dashboard?period='+adminRange);
  if(version!==renderVersion||tab!==adminTab||dialog.open||document.hidden||adminLivePaused)return;
  const node=root.querySelector<HTMLElement>(tab==='practice'?'[data-practice-live-content]':tab==='activity'?'[data-admin-live-content]':'[data-admin-dashboard]');
  if(node)node.innerHTML=tab==='practice'?practiceAdminView(d):tab==='activity'?activityLiveView(d):dashboardView(d);
  adminLiveStatus('已更新 '+new Date(d.generatedAt).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}));
 }catch(error){if([401,403].includes((error as {status?:number}).status??0)){user=null;csrf='';await render();}else adminLiveStatus('連線中斷，5秒後重試',true);}
 finally{adminRefreshBusy=false;}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshAdminLive();});

function modal(title: string, body: string, kind = '') {
  cleanupPaper();cleanupPaper=()=>{};window.clearTimeout(revealTimer); pendingReveal = null;
  dialog.className = kind;
  dialog.innerHTML = withBase(`<div class="dialogHead"><div><span class="dialogEyebrow">LUCKYBOX COLLECTION</span><h2 id="dialog-title">${esc(title)}</h2></div>${button('×','close','','aria-label="關閉"')}</div><div class="dialogBody">${body}</div>`);
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  void mountCaptcha(dialog);
}
function finishReveal() {
  if (!pendingReveal || !dialog.open) return;
  const results = pendingReveal;
  if(results[0]?.preview){modal('撕籤預覽完成',notice('這只是紙籤互動預覽，沒有抽獎、扣點或發放商品。正式開抽仍須獎池有已核實庫存並開放。')+button('返回首頁','close'));return;}
  modal('抽獎結果',drawResultView(results),'resultModal');
}
function showDrawResults(results: Row[]) {
  paperResults=results;paperIndex=0;showPaper();
}
function showPaper(){modal('親手撕籤',paperTicketView(paperResults[paperIndex],paperIndex,paperResults.length),'ticketModal');pendingReveal=paperResults;cleanupPaper=mountPaperTicket(dialog);}
const pendingDrawSlot=()=>user?'lb.pendingDraw.'+user.id:'';
function savedDraw():Row|null{try{const s=sessionStorage.getItem(pendingDrawSlot());if(!s)return null;const d=JSON.parse(s);return typeof d.key==='string'&&typeof d.id==='string'&&d.userId===user?.id?d:null;}catch{return null;}}
async function executeTicketDraw(ctx:Row){
 if(!user||user.id!==ctx.userId)throw new Error('登入已變更，請重新選籤');
 sessionStorage.setItem(pendingDrawSlot(),JSON.stringify(ctx));
 try{const result=await api(`/pools/${ctx.id}/draw`,ctx.body,ctx.key);sessionStorage.removeItem(pendingDrawSlot());ticketSelection=null;showDrawResults(result.results);await render();}
 catch(error){const status=(error as {status?:number}).status;if(status&&(status<500||status===503))sessionStorage.removeItem(pendingDrawSlot());throw error;}
}
async function recoverPendingDraw(){const ctx=savedDraw();if(!ctx||adminPortal)return;try{const r=await api('/me/draw-requests/'+ctx.key);sessionStorage.removeItem(pendingDrawSlot());showDrawResults(r.results);}catch(error){if((error as {status?:number}).status!==404)throw error;ticketSelection=ctx;modal('確認中的抽獎',notice('尚未取得結果。不會自動再扣點；按下重查／重試會使用原交易識別碼，避免重複抽取。也可先查看我的收藏紀錄。')+button('使用原交易重試','ticket-retry'));}}
async function balanceForm(id:string){
 const [u,h,s]=await Promise.all([api('/admin/members/'+id),api('/admin/members/'+id+'/balance-adjustments'),api('/me/security')]);
 balanceDraft=null;
 const history=table('人工調點紀錄（最近50筆）',['時間／管理員','變動','調整前 → 後','原因／參考碼'],h.items.map((r:Row)=>[when(r.created_at)+' / '+esc(r.actor),(r.delta>0?'+':'')+num(r.delta),num(r.balance_before)+' → '+num(r.balance_after),esc(r.reason)+' / '+esc(r.reference)]));
 modal('用戶點數調整',notice('只調整站內點數，不執行銀行扣款、綠界退款，也不計入正式實收或付費VIP。')+`<div class="balanceSummary"><b>${esc(u.name)}</b><p>${esc(u.email)}</p><strong>${num(u.points)} pt</strong></div>`+(h.enabled&&u.role!=='admin'&&!u.disabled?form('admin-balance-preview',`<input type="hidden" name="expectedBalance" value="${u.points}"><input type="hidden" name="mfa" value="${s.mfaEnabled?'true':'false'}"><label class="field">調整方式<select name="direction"><option value="credit">加點（補發／故障修正）</option><option value="debit">扣點（錯帳修正）</option></select></label>${field('調整點數（整數，1–100,000）','amount','number','','required min="1" max="100000" step="1"')}<label class="field">原因（至少5字）<textarea name="reason" required minlength="5" maxlength="500"></textarea></label>${field('訂單／工單參考碼（可留空）','reference','text','','maxlength="120"')}`,'預覽並確認',id):notice('此帳戶不可調點，或功能尚未啟用。'))+history);
}
dialog.addEventListener('close',() => { cleanupPaper();cleanupPaper=()=>{}; window.clearTimeout(revealTimer); pendingReveal = null; });
function form(name: string, contents: string, submit: string, id = '') { const action=({login:'login',register:'register','admin-login':'admin_login',forgot:'forgot','google-start':'google','email-send':'email','phone-send':'phone'} as Row)[name];return `<form data-form="${name}" data-id="${esc(id)}">${contents}${action?captchaSlot(action):''}<div class="formError" role="alert"></div><button class="btn primary" type="submit">${esc(submit)}</button></form>`; }
function field(title: string, name: string, type = 'text', value = '', attrs = '') { return `<label class="field">${esc(title)}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`; }
function textArea(title: string, name: string, value = '') { return `<label class="field">${esc(title)}<textarea name="${name}" maxlength="12000">${esc(value)}</textarea></label>`; }
function upload(title: string, name: string, value = '') { return `<label class="field">${esc(title)}<input type="hidden" name="${name}" value="${esc(value)}"><input type="file" data-upload="${name}" accept="image/png,image/jpeg,image/webp"><span class="help">PNG / JPEG / WebP，每張不超過 5 MB</span><span data-preview="${name}">${value ? `<img class="preview" src="${esc(value)}" alt="已上傳圖片">` : ''}</span>${button('清除圖片','clear-image',name)}</label>`; }
function table(title: string, columns: string[], rows: string[][]) { return `<div class="tablewrap"><table class="table"><caption>${esc(title)}</caption><thead><tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}">目前沒有資料</td></tr>`}</tbody></table></div>`; }
async function render() {
  const version = ++renderVersion;
  try {
    await session();
    if(adminPortal){
      if(!user){setRoot(`<main class="adminLoginPage"><section class="adminLoginCard"><a href="/" class="adminLoginBrand">◈ LUCKYBOX<small>MANAGEMENT CONSOLE</small></a><span class="sectionKicker">PRIVATE WORKSPACE</span><h1>管理員登入</h1><p>此入口僅供營運管理使用，與用戶頁面分離。</p>${form('admin-login',authFields('admin-login'),'登入管理中心')}<a class="adminBackLink" href="/">返回用戶網站</a></section></main>`);void mountCaptcha(root);return;}
      if(user.role!=='admin'){setRoot(`<main class="adminLoginPage"><section class="adminLoginCard"><span class="sectionKicker">ACCESS RESTRICTED</span><h1>無後台權限</h1><p>目前帳號不是管理員，不能存取任何管理資料。</p>${button('改用管理員帳號登入','logout')}<a class="adminBackLink" href="/">返回用戶網站</a></section></main>`);return;}
      const adminContent=await renderAdmin();if(version===renderVersion)setRoot(`<main class="adminPortalBody" id="main-content">${adminContent}</main>`);return;
    }
    let content = '';
    if(needsMemberLogin(page,!!user)){shell(memberAccessView(page,settings.registration));return;}
    if (page === 'home' || page === 'free') {
      const upcoming=await api('/catalog/upcoming');pools = await api('/pools'); const list = page === 'free' ? pools.filter(p => p.kind === 'free') : pools;
      content = homeView(list,{user,page,registration:settings.registration},upcoming.items);
    } else if(page==='info'){
      const v=informationVersion(location.hash),data=await api(v?'/storefront/versions/'+v:'/storefront');
      content=publicInformationView(data,informationSection(location.hash));
    } else if (page === 'account') content = `<h1>我的帳戶</h1><section class="panel"><h2>${esc(user!.name)}</h2><p>${esc(user!.email)}</p>${status(user!.role)}<div class="actions"><a class="btn primary" href="#community">VIP・任務・邀請好友</a>${button('登出','logout')}${settings.passwordReset ? button('重設密碼','forgot') : ''}</div></section>`+securityView(await api('/me/security'));
    else if (page === 'community') content=memberView(await api('/me/community'),location.origin+siteBase);
    else if (page === 'wallet') {
      const [ledger, topups,wallet,refunds] = await Promise.all([api('/me/ledger'), api('/me/topups'),api('/me/wallet'),api('/me/refunds')]);
      content = `<h1>點數錢包</h1><div class="actions"><a class="btn light" href="#community">VIP 與會員任務</a>${settings.demo?'':button('申請付款退款','request-refund')}</div><section class="panel"><p>可用點數</p><div class="balanceNumber">◈ ${num(user!.points)}</div><p class="help">點數不可提現；NT$1可購買1點，並非可兌回現金或USDT。</p>${settings.demo?notice('此處僅提供模擬充值，正式收款未開放。'):settings.manualTopups ? button('登記已完成的付款','topup') : notice('目前尚未開放儲值。')}</section>${walletSourceView(wallet)}${memberRefundsView(refunds)}${table('儲值登記',['時間','點數','付款參考碼','狀態'],topups.map((t: Row) => [when(t.created_at),num(t.points),esc(t.reference),status(t.status)]))}${table('點數帳本（最近 200 筆）',['時間','類型','變動','餘額'],ledger.map((l: Row) => [when(l.created_at),esc(({admin_adjustment:'人工調點（非金流）',refund_hold:'退款／活動資格凍結',refund_release:'原來源解除凍結',payment_refund:'凍結結算（不再次扣點）'} as Row)[l.kind]??l.kind),`${l.delta > 0 ? '+' : ''}${num(l.delta)}`,num(l.balance_after)]))}`;
    } else if (page === 'collection') {
      const [items, shipments, draws] = await Promise.all([api('/me/collection'), api('/me/shipments'), api('/me/draws')]);
      content = `<h1>我的收藏</h1><div class="liveGrid">${items.map(collectionCardView).join('') || empty('還沒有收藏','參與獎池後，抽中的實體商品會保存在這裡。')}</div>${table('出貨進度',['收件人','狀態','物流 / 追蹤號碼','操作'],shipments.map((s: Row) => [esc(s.name),status(s.status),`${esc(s.carrier)} ${esc(s.tracking)}`,s.status === 'shipped' ? button('確認收貨','receive',s.id) : '—']))}${table('抽獎紀錄（最近 200 筆）',['時間','獎池','獎品','序號','花費','重看'],draws.map((d: Row) => [when(d.created_at),esc(d.pool_name),esc(d.name),String(d.ordinal + 1),`${num(d.cost)} pt`,button('重看紙籤','draw-replay',d.id)]))}`;
    } else if (page === 'creator') {
      if (user!.role === 'player') content = `<h1>創作者中心</h1>${notice('申請通過後即可建立獎池。官方會檢查身分、商品與履約能力。')}${user!.creator_requested ? status('pending') : button('申請創作者權限','creator-request')}`;
      else {
        const [mine, settlements, shipping] = await Promise.all([api('/creator/pools'), api('/creator/settlements'), api('/fulfillment/shipments')]);
        content = `<div class="sectionhead"><h1>創作者中心</h1>${button('＋ 建立獎池','new-pool')}</div>${notice('點數獎及商品兌點須在送審時預存準備金。獎池全部抽完、商品履約完成且等待期結束後，可申請點數帳本結算；此功能不執行現金匯款。')}${poolManagement(mine,false)}${shippingTable(shipping)}${table('結算紀錄',['獎池','收入點數','平台費','準備金返還','狀態'],settlements.map((s: Row) => [esc(s.pool_id),num(s.gross_points),num(s.fee_points),num(s.reserve_returned),status(s.status)]))}`;
      }
    }
    if(page==='wallet'&&settings.demo){const orders=await api('/demo/orders');content=notice('隔離模擬錢包：這裡的點數不是真實餘額，不提供實物出貨。')+button('模擬充值（不扣真錢）','demo-topup')+content+table('模擬充值訂單',['訂單','模擬金額','狀態'],orders.map((o:Row)=>[esc(o.order_no),num(o.amount),({pending:'待確認',paid:'模擬成功',failed:'模擬失敗',cancelled:'模擬取消'} as Row)[o.status]]));}
    if (page === 'wallet' && settings.ecpay?.enabled) {
      const payments: Row[] = await api('/me/payments');
      content = notice(settings.ecpay.mode === 'stage' ? '綠界測試環境：僅測試點數，不代表真實收款。NT$1＝1點。' : '綠界信用卡儲值：NT$1＝1點。點數不可提現；僅以伺服器確認結果入帳。') + button('綠界信用卡儲值','ecpay') + button('重新查詢付款與餘額','refresh') + content +
        table('綠界付款紀錄（最近 100 筆）',['時間','訂單','NT$','點數','狀態'],payments.map(p => [when(p.created_at),esc(p.order_no),num(p.amount),num(p.points),p.status === 'paid' ? '已入帳' : '待確認付款']));
    }
    if (version === renderVersion) shell(content);
  } catch (error) { if (version === renderVersion) shell(`<h1>暫時無法載入</h1>${notice((error as Error).message)}${button('重新連線','refresh')}`); }
}

async function navigateMember(next:MemberPage){
 page=next;if(historyMode(location.hash,page)==='push')history.pushState(null,'','#'+page);
 await render();window.scrollTo({top:0,behavior:'instant'});
}
async function renderAdmin() {
  if(adminTab==='practice'){const d=await api('/admin/practice');return adminFrame(adminTab,button(adminLivePaused?'恢復自動更新':'暫停自動更新','admin-live-toggle')+'<section data-practice-live-content>'+practiceAdminView(d)+'</section>');}
  if(adminTab==='storefront')return adminFrame(adminTab,storefrontAdminView(await api('/admin/storefront')));
  if(adminTab==='activity')return adminFrame(adminTab,activityView(await api('/admin/activity?'+new URLSearchParams({q:activityQuery,category:activityCategory})),activityQuery,activityCategory,adminLivePaused));
  if(adminTab==='campaigns')return adminFrame(adminTab,campaignView(await api('/admin/campaigns')));
  if(adminTab==='security')return adminFrame(adminTab,readinessView(await api('/admin/readiness'),await api('/me/security')));
  if(adminTab==='refunds')return adminFrame(adminTab,refundView(await api('/admin/refunds'),await api('/admin/payments'),await api('/admin/reconciliation?page='+financePage)));
  if(['users','accounts','balances'].includes(adminTab)){
    const role=adminTab==='accounts'?'admin':memberRole;
    const params=new URLSearchParams({q:memberQuery,page:String(memberPage),...(role?{role}:{})});
    const data=await api('/admin/members?'+params);
    return adminFrame(adminTab,membersView(data,adminTab==='accounts',memberQuery,memberRole,user!.id,settings.registration,adminTab==='balances'));
  }
  if(adminTab==='catalog'){
    const data=await api('/admin/catalog?'+new URLSearchParams({q:catalogQuery,page:String(catalogPage)}));
    return adminFrame(adminTab,catalogView(data,catalogQuery));
  }
  const [allPools,topups,settlements,shipping,audit]=await Promise.all([api('/admin/pools'),api('/admin/topups'),api('/admin/settlements'),api('/fulfillment/shipments'),api('/admin/audit')]);
  const operational=`${notice('審核前請核實商品庫存、身分與收款。所有權限、審核與帳務操作都會記錄。不得審核自己的獎池、儲值或結算。')}${poolManagement(allPools,true)}${table('儲值覆核',['會員','點數','付款參考碼','狀態','操作'],topups.map((t: Row) => [esc(t.email),num(t.points),esc(t.reference),status(t.status),t.status === 'pending' ? button('確認入帳','topup-approve',t.id) + button('拒絕','topup-reject',t.id) : '—']))}${shippingTable(shipping)}${table('結算覆核',['獎池','收入','平台費','準備金','狀態','操作'],settlements.map((s: Row) => [esc(s.pool_id),num(s.gross_points),num(s.fee_points),num(s.reserve_returned),status(s.status),s.status === 'requested' ? button('核准點數結算','settlement-approve',s.id) : '—']))}${table('操作稽核（最近 300 筆）',['時間','操作','對象','內容'],audit.map((a: Row) => [when(a.created_at),esc(a.action),esc(a.target),esc(a.detail)]))}`;
  return adminFrame(adminTab,(adminTab==='overview'?'<section data-admin-dashboard>'+dashboardView(await api('/admin/dashboard?period='+adminRange))+'</section>':'<h2>審核與出貨</h2>')+'<div class="adminSectionTitle"><div><h2>作業待辦與稽核</h2><p>獎池、儲值、履約與結算</p></div></div>'+operational);
}
async function oddsForm(id:string) {
  const p=await api(`/pools/${id}`);
  let remainder=10000;
  const values=p.prizes.map((item:Row,i:number)=>{if(p.draw_mode==='weighted')return item.weight_bps;const value=i===p.prizes.length-1?remainder:Math.floor(item.quantity/p.total*10000);remainder-=value;return value;});
  const kindName:Row={physical:'實體商品',points:'點數獎',none:'未中獎'};
  modal('調整物品機率',`<section class="oddsScope" data-odds-scope="${esc(p.id)}"><span class="sectionKicker">ONLY THIS POOL</span><h3>${esc(p.name)}</h3><p>只套用此獎池，不影響其他獎池。依實際上架清單列出 ${num(p.prizes.length)} 個物品／結果。</p><small>獎池 ID：${esc(p.id)}</small></section>`+notice('物品不限於大獎、二獎、三獎，可自行命名；每抽皆有獎。此池所有物品機率合計須為 100%。售罄物品會排除，其餘按權重重新換算。')+form('admin-odds',`<input type="hidden" name="expectedVersion" value="${p.odds_version}"><label class="field oddsSearch">搜尋此獎池的物品<input type="search" data-odds-search placeholder="輸入物品名稱" maxlength="120"></label><small data-odds-visible>顯示全部 ${num(p.prizes.length)} 個結果；儲存時會包含所有結果。</small><div class="oddsEditor">${p.prizes.map((item:Row,i:number)=>`<div class="oddsEditorRow ${item.kind==='none'?'noWinRow':''}" data-odds-row data-item-name="${esc(item.name.toLowerCase())}"><div class="oddsItem">${item.image?`<img src="${esc(item.image)}" alt="">`:`<span class="oddsItemIcon">${item.kind==='none'?'∅':'◇'}</span>`}<div><span class="adminPill">${kindName[item.kind]}</span><b>${esc(item.name)}</b><small>${item.kind==='none'?'剩餘空籤':'剩餘庫存'} ${num(item.remaining)} / ${num(item.quantity)}${item.kind==='none'?' · 不發放商品或點數':''}</small></div></div><label>${esc(item.name)} 機率 (%)<input name="probability${i}" data-odds-input data-prize-id="${esc(item.id)}" type="number" min="0" max="100" step="0.01" required value="${(values[i]/100).toFixed(2)}"></label></div>`).join('')}</div><div class="oddsTotal" data-odds-total>機率合計：100.00%</div><p class="help">0% 不會抽中。機率可與庫存比例不同；每池最多 100 個物品／結果。儲存後使用即時權重抽獎，不提供舊的承諾序列驗證。</p>`,'儲存機率',id));
}

document.addEventListener('input',event=>{
  const input=event.target as HTMLInputElement;
  if(input.matches('[data-odds-search]')){
    const form=input.closest('form')!,query=input.value.trim().toLowerCase(),rows=[...form.querySelectorAll<HTMLElement>('[data-odds-row]')];
    for(const row of rows)row.hidden=!row.dataset.itemName!.includes(query);
    form.querySelector<HTMLElement>('[data-odds-visible]')!.textContent=`顯示 ${rows.filter(row=>!row.hidden).length} / ${rows.length} 個結果；儲存時仍包含所有結果。`;
    return;
  }
  if(!input.matches('[data-odds-input]'))return;
  const form=input.closest('form')!,total=[...form.querySelectorAll<HTMLInputElement>('[data-odds-input]')].reduce((sum,n)=>sum+Math.round(Number(n.value)*100),0);
  const label=form.querySelector<HTMLElement>('[data-odds-total]')!;label.textContent='機率合計：'+(total/100).toFixed(2)+'%';label.classList.toggle('invalid',total!==10000);
});

document.addEventListener('change',event=>{
  const input=event.target as HTMLSelectElement;if(!input.matches('select[name="prizeKind"]'))return;
  const row=input.closest('.prizeEditor')!,none=input.value==='none';
  for(const name of ['prizeValue','prizeRedeem']){const value=row.querySelector<HTMLInputElement>(`[name="${name}"]`)!;value.readOnly=none;if(none)value.value='0';}
  const name=row.querySelector<HTMLInputElement>('[name="prizeName"]')!;if(none&&!name.value.trim())name.value='未中獎';
});

function poolManagement(list: Row[], admin: boolean) {
  return table(admin ? '獎池審核與管理' : '我的獎池',['名稱 / 狀態','庫存 / 收入','介紹與服務','操作'],list.map(p => [
    `<b>${esc(p.name)}</b><p>${status(p.status)}</p><small>${esc(p.review_note)}</small>`, `${p.remaining}/${p.total}<br>${num(p.revenue_points)} pt`,
    `${p.verification === 'none' ? '未認證' : esc(label(p.verification))} / ${p.fulfillment === 'official' ? '官方出貨' : '創作者出貨'}<div class="actions">${button('修改介紹','edit-content',p.id)}${!admin ? button('申請認證 / 官方出貨','service',p.id) : ''}</div>${p.pendingContent ? '介紹修改待審核' : ''}${p.serviceRequest ? `<p>${esc(JSON.stringify(p.serviceRequest))}</p>` : ''}`,
    `<div class="actions">${button('查看','pool',p.id)}${['draft','rejected'].includes(p.status) && p.owner_id === user!.id ? button('送審','submit-pool',p.id) : ''}${p.status === 'approved' ? button('開放抽獎','open-pool',p.id) : ''}${p.status === 'sold_out' && p.owner_id === user!.id ? button('申請結算','settlement',p.id) : ''}${admin && p.status === 'pending' ? button('核准','approve-pool',p.id) + button('拒絕','reject-pool',p.id) : ''}${admin && p.pendingContent ? button('核准介紹','content-approve',p.id) + button('拒絕介紹','content-reject',p.id) : ''}${admin && p.serviceRequest ? button('核准服務','service-approve',p.id) + button('拒絕服務','service-reject',p.id) : ''}${admin ? button('抽獎稽核','draw-audit',p.id) : ''}${admin && p.remaining === p.total && !['cancelled','settled'].includes(p.status) ? button('取消獎池','cancel-pool',p.id) : ''}</div>`
  ]));
}
function shippingTable(rows: Row[]) { return table('出貨工作台',['收件資料','商品','狀態','物流','操作'],rows.map(s => [`${esc(s.name)}<br>${esc(s.phone)}<br>${esc(s.address)}`,s.items.map((i: Row) => esc(i.name)).join('<br>'),status(s.status),`${esc(s.carrier)} ${esc(s.tracking)}`,s.status === 'requested' ? button('登記出貨','ship-order',s.id) : '—'])); }
async function authForm(register = false) {
  if(register&&!settings.registration){toast('目前暫停新會員註冊');return;}
  if(register){try{settings.storefront=await api('/storefront');}catch(error){toast((error as Error).message);return;}}
  modal(register ? '加入 LUCKYBOX' : '登入 LUCKYBOX',form(register ? 'register' : 'login',authFields(register?'register':'member-login',settings.storefront?.published?settings.storefront.version:undefined).replace('name="email" type="email"',settings.demo&&register?'name="email" type="email" readonly value="guest-'+crypto.randomUUID().slice(0,12)+'@example.test"':'name="email" type="email"'),register ? '建立帳戶' : '登入') + `<div class="actions">${settings.integrations?.google ? button('使用 Google 繼續','google-login') : ''}${settings.registration ? button(register ? '已有帳戶，登入' : '註冊新帳戶',register ? 'login' : 'register') : ''}${settings.passwordReset ? button('忘記密碼','forgot') : ''}</div>`);
}
async function openPool(id: string) {
  const p = await api(`/pools/${id}`);
  modal(p.name,poolDetailView(p,p.creator ?? user?.name ?? 'LUCKYBOX'),'poolModal');
}
function prizeEditor(index: number,kind='physical') { return `<section class="prizeEditor"><h4>物品／結果 ${index + 1}</h4><div class="formgrid">${field('獎品名稱','prizeName','text',kind==='none'?'未中獎':'','required maxlength="120" placeholder="填入實際物品名稱，可自訂"')}<label class="field">類型<select name="prizeKind"><option value="physical" ${kind==='physical'?'selected':''}>實體商品</option><option value="points" ${kind==='points'?'selected':''}>點數獎</option></select></label>${field('數量（獎品庫存）','prizeQuantity','number','1','required min="1" max="10000"')}${field('參考價值 / 點數獎額','prizeValue','number','0','required min="0" max="1000000" '+(kind==='none'?'readonly':''))}${field('實體商品兌點額','prizeRedeem','number','0','required min="0" max="1000000" '+(kind==='none'?'readonly':''))}${upload('獎品圖片',`prizeImage${index}`)}</div><p class="help">每抽皆有獎；可新增實體商品或點數獎，機率依各獎池獨立設定。</p>${button('移除此獎项','remove-prize')}</section>`; }

function contentFields(p?: Row) { return `<div class="stack">${textArea('商品 / 活動介紹','description',p?.description ?? '')}${upload('獎池封面','cover',p?.cover ?? '')}<h3>介紹圖片（最多 12 張）</h3><div id="detail-upload-list">${(p?.descriptionImages ?? []).map((v: string, i: number) => upload(`介紹圖 ${i + 1}`,`detail${i}`,v)).join('')}</div>${button('新增介紹圖','add-detail')}</div>`; }
function newPool() {
  if (!user) { authForm(); return; }
  if (user.role === 'player') { page = 'creator'; dialog.close(); void render(); return; }
  nextPrizeIndex = 1;
  modal('建立獎池',notice('先儲存為草稿，再送交官方審核。點數獎額與商品兌點額的總和會在送審時凍結為準備金。') + form('new-pool',`<div class="formgrid">${field('獎池名稱','name','text','','required maxlength="120"')}<label class="field">獎池類型<select name="kind"><option value="free">免費抽</option><option value="paid">點數付費抽</option></select></label>${field('每抽點數（免費池填 0）','price','number','0','required min="0" max="100000"')}</div>${contentFields()}<h3>獎品清單</h3><p class="help">「點數獎」把獎額填在參考價值欄，兌點額填 0。每抽皆有獎，沒有未中獎選項。</p><div id="prize-list">${prizeEditor(0)}</div>${button('＋ 新增獎項','add-prize')}<br><br>`,'儲存草稿'));
}
async function action(name: string, id: string, target: HTMLElement) {
  if(name==='password-visibility'){
   const input=document.getElementById(target.dataset.inputId??'') as HTMLInputElement|null;
   if(!input||!['password','confirmPassword'].includes(input.name)||!target.closest('form')?.contains(input))return;
   const visible=input.type==='password';input.type=visible?'text':'password';target.setAttribute('aria-pressed',String(visible));target.setAttribute('aria-label',(visible?'隱藏':'顯示')+(target.dataset.fieldLabel??'密碼'));target.textContent=visible?'隱藏':'顯示';input.focus();return;
  }

  if(settings.demo&&['shipping','ship-order','request-refund','ecpay','topup','new-pool'].includes(name)){toast('體驗站不提供真實付款、出貨或上架操作');return;}
  if(name==='demo-topup'){modal('模擬充值（不扣真錢）',notice('這是隔離測試，不會跳轉綠界，也不會扣款。1元模擬金額＝1示範點數。')+form('demo-order',field('模擬充值金額','amount','number','1000','required min="1" max="20000" step="1"'),'建立模擬訂單'));return;}
  if(name==='preview-ticket'){ticketSelection={preview:true,quantity:1,selected:[]};modal('試撕紙籤（不抽獎）',ticketSelectionView(1,12,true),'ticketModal');return;}
  if(name==='admin-balance'){await balanceForm(id);return;}
  if(name==='practice-status'){
   const [d,s]=await Promise.all([api('/admin/practice'),api('/me/security')]),p=d.pools.find((p:Row)=>p.id===id);if(!p)throw new Error('測試池不存在，請重新整理');
   const restore=p.status==='cancelled';
   modal(restore?'恢復測試池・確認':'下架測試池・確認',notice(restore?'將測試池恢復到正式首頁，仍然不扣點、不發實體、不出貨。':'只隱藏測試池並停止新測試，不刪除帳戶、歷史結果、機率或剩餘測試籤。')+`<h3>${esc(p.name)}</h3><p>目前版本 ${p.odds_version} · 剩餘測試籤 ${num(p.remaining)} / ${num(p.total)}</p>`+form('practice-status',`<input type="hidden" name="action" value="${restore?'restore':'hide'}"><input type="hidden" name="expectedVersion" value="${p.odds_version}"><input type="hidden" name="requestKey" value="${crypto.randomUUID()}"><label class="checkField"><input type="checkbox" name="confirmed" required> 我確認${restore?'恢復':'下架'}這個測試池，歷史紀錄保留</label>${field('目前管理員密碼','password','password','','required maxlength="128" autocomplete="current-password"')}${s.mfaEnabled?mfaField():''}`,restore?'確認恢復':'確認下架',id));return;
  }
  if(name==='product-preview'){
   const p=(await api('/catalog/upcoming')).items.find((p:Row)=>p.code===id);if(!p)throw new Error('此展示商品已更新，請重新整理首頁');
   modal('實體商品・展示',`<img class="referenceDetailPhoto" src="${esc(p.image)}" alt="${esc(p.name)}實體商品參考照片，非本店實拍"><h3>${esc(p.name)}</h3>`+notice('展示商品尚未確認現貨、價格與開抽日期；不扣點、不出貨。')+`<p class="help">商品參考照片，非本店實拍。圖片來源：<a href="${esc(p.photoSource)}" target="_blank" rel="noopener noreferrer">${esc(p.photoCredit)}</a>；商標及圖片屬原權利人。</p>`+button('試撕紙籤（不抽獎）','preview-ticket'));return;
  }
  if(name==='paper-open')return;
  if(name==='paper-next'){if(!dialog.querySelector('.paperSurface.revealed'))return;if(paperIndex+1<paperResults.length){paperIndex++;showPaper();}else finishReveal();return;}
  if(name==='paper-all'){finishReveal();return;}
  if(name==='draw-replay'){showDrawResults([await api('/me/draws/'+id)]);return;}
  if(name==='ticket-retry'){if(ticketSelection)await executeTicketDraw(ticketSelection);return;}
  if(name==='ticket-pick'){
   if(!ticketSelection||ticketSelection.busy)return;
   const selected=ticketSelection.selected as number[],n=Number(id),at=selected.indexOf(n);
   if(at>=0)selected.splice(at,1);else if(selected.length<ticketSelection.quantity)selected.push(n);else{toast('已選足張數；可先取消其他籤');return;}
   target.setAttribute('aria-pressed',String(selected.includes(n)));dialog.querySelector('[data-ticket-count]')!.textContent=`已選 ${selected.length} / ${ticketSelection.quantity} 張`;
   (dialog.querySelector('[data-action="ticket-confirm"]') as HTMLButtonElement).disabled=selected.length!==ticketSelection.quantity;return;
  }
  if(name==='ticket-confirm'){
   const t=ticketSelection;if(!t||t.selected.length!==t.quantity)return;
   if(t.preview){ticketSelection=null;showDrawResults([{preview:true,name:'商品展示位置（動畫預覽）',ordinal:0,presentationSlot:t.selected[0],image:''}]);return;}
   modal('確認這次抽取',notice(t.testOnly?'功能測試：不扣點、不發放實體商品、不出貨；結果會保存為測試紀錄。':'確認後才扣點並固定結果；撕籤不會影響公告機率。')+`<div class="balanceSummary"><b>${esc(t.name)}</b><p>選擇籤面：${t.selected.map((n:number)=>'#'+n).join('、')}</p><strong>${num(t.price*t.quantity)} pt / ${t.quantity} 抽</strong></div>`+form('draw-confirm','<p>結果保存後，即使關閉或重新整理，也可從抽獎紀錄重看。</p>','確認抽取並開始撕籤',t.id));return;
  }
  if(name==='pause-live'){livePaused=!livePaused;target.setAttribute('aria-pressed',String(livePaused));target.textContent=livePaused?'▶':'Ⅱ';target.closest('.liveTicker')?.classList.toggle('paused',livePaused);return;}
  if(name==='claim-task'){await mutate('/me/tasks/claim',{task:id});toast('任務獎勵已入帳');await render();return;}
  if(name==='read-notification'){await mutate('/me/notifications/read',{id});await render();return;}
  if(name==='copy-invite'){try{await navigator.clipboard.writeText(id);toast('邀請連結已複製');}catch{toast('請長按邀請連結欄位複製');}return;}
  if(name==='bind-referral'){modal('綁定邀請碼',form('bind-referral',field('邀請碼','code','text',sessionStorage.getItem('invite')??'','required pattern="[a-f0-9]{24}" maxlength="24"'),'綁定邀請'));return;}
  if(name==='verify-email'){modal('寄送 Email 驗證信',form('email-send',notice('寄到目前帳號信箱；本機未設定 SMTP 時僅輸出測試信，不會真的寄送。'),'寄送驗證信'));return;}
  if(name==='verify-phone'){modal('手機驗證',form('phone-send',field('手機（國際格式）','phone','tel','','required placeholder="+886912345678" autocomplete="tel"'),'取得簡訊碼'));return;}
  if(name==='google-login'||name==='google-link'){
   const published=name==='google-login'?await api('/storefront'):null;
   modal(name==='google-link'?'綁定 Google':'Google 登入',form('google-start',`<input type="hidden" name="link" value="${name==='google-link'?'true':'false'}"><p>前往 Google 授權頁面。既有同信箱帳號必須先登入再綁定，避免帳號被合併。</p>${policyConsentView(published?.published?published.version:undefined)}`,'前往 Google'));return;
  }
  if(name==='storefront-preview'){
   const node=root.querySelector<HTMLFormElement>('[data-form="storefront-draft"]');if(!node)return;
   const values=new FormData(node),content=Object.fromEntries(storefrontFieldKeys.map(k=>[k,String(values.get(k)??'').trim()]));
   modal('目前填寫內容・未公開',informationSections.map(section=>publicInformationView({published:true,draft:true,content},section)).join(''));return;
  }
  if(name==='storefront-publish'||name==='storefront-withdraw'){
   const d=await api('/admin/storefront'),publish=name==='storefront-publish',security=await api('/me/security');
   if(publish&&d.issues.length){toast('草稿仍有必填欄位，請先儲存完整內容');return;}
   modal(publish?'公開已儲存草稿・確認':'撤下公開資訊・確認',notice(publish?'這會將已儲存內容公開給所有訪客。未儲存修改不包含在內；請本人審閱後再確認。':'這會撤下目前版本，但不刪除歷史公開版本、同意紀錄，也無法移除對方已保存的副本。')+(publish?informationSections.map(section=>publicInformationView({published:true,draft:true,content:d.draft},section)).join(''):'')+form('storefront-publication',`<input type="hidden" name="expectedVersion" value="${d.version}"><input type="hidden" name="action" value="${publish?'publish':'withdraw'}"><input type="hidden" name="requestKey" value="${crypto.randomUUID()}"><label class="checkField"><input type="checkbox" name="confirmed" required> 我確認執行${publish?'公開':'撤下'}操作</label>${publish?'<label class="checkField"><input type="checkbox" name="operatorReviewed" required> 我是營運者，已審閱並確認這些資料與政策可對外公開</label>':''}${field('目前管理密碼','password','password','','required autocomplete="current-password" maxlength="128"')}${security.mfaEnabled?field('驗證器碼／復原碼','otp','text','','required maxlength="32" autocomplete="one-time-code"'):''}`,publish?'確認公開':'確認撤下'));return;
  }
  if(name==='request-refund'){
   const paid=(await api('/me/payments')).filter((o:Row)=>o.status==='paid');
   modal('選擇付款訂單',paid.length?form('refund-order',`<label class="field">已入帳訂單<select name="orderNo">${paid.map((o:Row)=>`<option value="${esc(o.order_no)}">${esc(o.order_no)} · NT$${num(o.amount)} · ${esc(o.environment)}</option>`).join('')}</select></label>`,'查詢可退金額'):notice('目前沒有已入帳付款訂單；人工加點不是收款，不提供付款退款。'));return;
  }
  if(name==='refund-cancel'){
   const r=(await api('/me/refunds')).find((r:Row)=>r.id===id);if(!r)throw new Error('退款案件不存在');
   if(!confirm('取消此申請並將保留點數按原來源退回？銀行處理中的申請不可取消。'))return;
   await mutate('/me/refunds/'+id+'/cancel',{expectedVersion:r.version});toast('已取消申請，點數已按原來源解除凍結');await session();await render();return;
  }
  if(name==='finance-page'){financePage=Math.max(1,Number(id)||1);await render();return;}
  if(name==='finance-export'){
   const d=await api('/admin/reconciliation?page='+financePage),u=URL.createObjectURL(new Blob([JSON.stringify(d,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=u;a.download='luckybox-reconciliation-'+d.generatedAt+'.json';a.click();URL.revokeObjectURL(u);return;
  }
  if(name==='refund-manage'){
   refundDraft=null;
   const r=(await api('/admin/refunds')).find((r:Row)=>r.id===id);if(!r)throw new Error('案件不存在，請重新整理');
   const security=await api('/me/security'),loss=r.cash_shortfall+r.recoveries.reduce((n:number,h:Row)=>n+h.shortfall,0);
   const options=r.status==='processing'?'<option value="complete">已確認實際退款，登記結果</option><option value="provider_failed">已確認未退款，拒絕並解凍</option>':r.legacy||(loss&&!r.lossApprovalsEnabled)?'<option value="reject">拒絕並解凍（舊資料／點數缺口需另行處理）</option>':'<option value="prepare">準備金流處理（此步不退錢）</option><option value="reject">拒絕並解除保留</option>';
   modal('退款處理・先核對',notice('本功能不執行銀行操作。結果未知時保持凍結，不能按拒絕解凍。')+`<p>${esc(r.email)} · ${esc(r.order_no)} · 本次 NT$${num(r.amount)} · ${esc(refundStatus[r.status])}</p><p>原付款及邀請獎勵無法追回合計 ${num(loss)} 點，不會改扣其他來源。</p>`+form('refund-draft',`<input type="hidden" name="expectedVersion" value="${r.version}"><input type="hidden" name="caseAmount" value="${r.amount}"><input type="hidden" name="lossPoints" value="${loss}"><input type="hidden" name="mfa" value="${security.mfaEnabled}"><label class="field">操作<select name="action">${options}</select></label>${textArea('處理原因（有點數缺口時至少10字）','note')}${r.status!=='processing'?'<label class="checkField"><input name="providerEligibilityReviewed" type="checkbox"> 準備退款時：已核對支付方式、交易狀態及允許退款金額</label>':''}${loss&&r.lossApprovalsEnabled?'<label class="checkField"><input name="acceptLoss" type="checkbox"> 明確確認本案無法追回 '+num(loss)+' 點；不是銀行損失金額</label>':''}${r.status==='processing'?field('可核對的退款／未退款憑據（至少8字）','providerReference','text','','required minlength="8" maxlength="100"')+field('實際退款 NT$（完成退款時必須精確相符）','providerAmount','number',String(r.amount),'min="1" max="20000" step="1"')+`<label class="field">已核對的金流結果<select name="providerOutcome" required><option value="">請選擇，未知結果請關閉視窗</option><option value="confirmed_refunded">確定已退款</option><option value="confirmed_not_refunded">確定未退款</option></select></label>`:''}`,'再次確認',id));return;
  }
  if(name==='mfa-setup'){modal('設定管理員驗證器',form('mfa-setup',field('目前管理密碼','password','password','','required autocomplete="current-password"'),'建立驗證器金鑰'));return;}
  if(name==='mfa-disable'){modal('關閉管理員驗證器',form('mfa-disable',field('目前管理密碼','password','password','','required')+field('驗證器碼／復原碼','code','text','','required maxlength="32"'),'確認關閉'));return;}
  if(name==='admin-tab'){if(!['overview','activity','users','accounts','catalog','operations','campaigns','security','refunds','storefront','balances','practice'].includes(id))return;adminTab=id;memberPage=1;catalogPage=1;await render();return;}
  if(name==='admin-live-toggle'){adminLivePaused=!adminLivePaused;target.textContent=adminLivePaused?'恢復自動更新':'暫停自動更新';if(adminLivePaused)adminLiveStatus('已暫停自動更新');else await refreshAdminLive();return;}
  if(name==='starter-drafts'){const result=await mutate('/admin/catalog/starter-drafts',{});toast(result.created?'已建立3個實體商品草稿；尚未開抽':'草稿已存在，沒有重複建立');adminTab='catalog';await render();return;}
  if(name==='admin-range'){if(!['24h','7d','30d'].includes(id))return;adminRange=id;await render();return;}
  if(name==='admin-member-page'){memberPage=Math.max(1,Number(id));await render();return;}
  if(name==='admin-catalog-page'){catalogPage=Math.max(1,Number(id));await render();return;}
  if(name==='admin-new-user'){
    const role=id==='admin'?'admin':'player';
    modal(role==='admin'?'新增管理員':'新增用戶',notice('新帳戶初始點數為 0。請為每位管理員建立獨立帳戶，不要共用密碼。')+form('admin-create-member',`<div class="stack">${field('會員名稱','name','text','','required maxlength="60"')}${field('Email','email','email','','required maxlength="254" autocomplete="off"')}${field('初始密碼','password','password','','required minlength="12" maxlength="128" autocomplete="new-password"')}<label class="field">角色<select name="role"><option value="player" ${role==='player'?'selected':''}>一般會員</option><option value="creator">創作者</option><option value="admin" ${role==='admin'?'selected':''}>管理員</option></select></label></div>`,'建立帳戶'));return;
  }
  if(name==='admin-edit-profile'){const u=await api(`/admin/members/${id}`);modal('編輯用戶資料',notice('更換 Email 將撤銷該用戶的現有登入。')+form('admin-profile',`<div class="stack">${field('會員名稱','name','text',u.name,'required maxlength="60"')}${field('Email','email','email',u.email,'required maxlength="254"')}</div>`,'儲存資料',id));return;}
  if(name==='admin-odds'){await oddsForm(id);return;}
  if(name==='admin-prizes'){
    const p=await api(`/pools/${id}`);nextPrizeIndex=p.prizes.length;
    modal('編輯物品',notice('依此獎池的上架清單新增或移除物品，每抽皆有獎。商品規格與數量僅能在送審前修改；儲存後請重新設定此池機率。')+form('admin-prizes',`<div id="prize-list">${p.prizes.map((_:Row,i:number)=>prizeEditor(i)).join('')}</div>${button('＋ 新增獎項','add-prize')}`,'儲存物品',id));
    dialog.querySelectorAll<HTMLElement>('.prizeEditor').forEach((node,i)=>{const item=p.prizes[i];for(const [name,value] of Object.entries({prizeName:item.name,prizeKind:item.kind,prizeQuantity:item.quantity,prizeValue:item.value,prizeRedeem:item.redeem_points})) (node.querySelector(`[name="${name}"]`) as HTMLInputElement).value=String(value);(node.querySelector('input[type=hidden]') as HTMLInputElement).value=item.image;node.querySelector('[data-preview]')!.innerHTML=item.image?`<img class="preview" src="${esc(item.image)}" alt="物品圖片">`:'';});return;
  }
  const mutations: Record<string,[string,unknown,string]> = {
    'creator-request':['/creator/request',{},'創作者申請已送出'], 'submit-pool':[`/pools/${id}/submit`,{},'已送交官方審核'], 'open-pool':[`/pools/${id}/open`,{},'獎池已開放'],
    'redeem':[`/collection/${id}/redeem`,{},'商品已兌為點數'], 'receive':[`/shipments/${id}/receive`,{},'已確認收貨'], 'settlement':[`/pools/${id}/settlement`,{},'結算申請已送出'],
    'content-approve':[`/admin/pools/${id}/content-review`,{approve:true},'介紹修改已核准'],'content-reject':[`/admin/pools/${id}/content-review`,{approve:false},'介紹修改已拒絕'],
    'service-approve':[`/admin/pools/${id}/service-review`,{approve:true},'服務已核准'],'service-reject':[`/admin/pools/${id}/service-review`,{approve:false},'服務已拒絕'],
    'topup-approve':[`/admin/topups/${id}/review`,{approve:true},'儲值已入帳'],'topup-reject':[`/admin/topups/${id}/review`,{approve:false},'儲值已拒絕'],
    'settlement-approve':[`/admin/settlements/${id}/approve`,{},'已完成點數結算']
  };
  if (mutations[name]) {
    const [url, body, message] = mutations[name];
    if (['redeem','topup-approve','settlement-approve','receive','open-pool','service-approve'].includes(name) && !confirm(name === 'topup-approve' ? '已核對銀行或支付後台，確認參考碼與點數額度正確且確實收款？' : '確認執行此操作？')) return;
    await mutate(url,body); toast(message); await render(); return;
  }
  if (name === 'ecpay') modal('綠界信用卡儲值',notice(settings.ecpay.mode === 'stage' ? '測試模式，請勿輸入真實信用卡。NT$1＝1點；模擬通知不入帳。' : 'NT$1＝1點。付款將前往綠界安全頁面；本站不收集信用卡號。') + form('ecpay',field('儲值金額 NT$','amount','number','100','required min="1" max="20000" step="1"'),'前往綠界付款'));
  else if (name === 'close') dialog.close();
  else if (name === 'reveal-now') finishReveal();
  else if (name === 'browse') document.getElementById('pool-section')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  else if (name === 'login') await authForm();
  else if (name === 'register') await authForm(true);
  else if (name === 'logout') { await api('/auth/logout',{}); user = null; csrf = ''; pendingKeys.clear(); page = 'home';history.replaceState(null,'','#home'); await render(); }
  else if (name === 'refresh') await render();
  else if (name === 'forgot') modal('重設密碼',form('forgot',field('Email','email','email',user?.email ?? '','required'),'寄送重設連結'));
  else if (name === 'new-pool') newPool();
  else if (name === 'pool') await openPool(id);
  else if (name === 'proof') { const proof = await api(`/pools/${id}/proof`); modal('抽獎驗證資料',notice(proof.verifiable === false ? '本池已切換即時權重模式，不提供預先承諾序列驗證。' : proof.seed ? '獎池已結束，種子已公開。可使用隨附的驗證工具重建抽獎序列。' : '種子將於全部抽完後公開。可先保存承諾值與獎品清單，日後比對。') + `<pre class="code">${esc(JSON.stringify(proof,null,2))}</pre>`); }
  else if (name === 'edit-content') { const p = await api(`/pools/${id}`); modal('修改商品介紹',notice(user?.role === 'admin' ? '官方修改會立即更新公開介紹；獎品、數量、價格與機率不會被修改。' : '已送審或開放中的獎池，介紹修改須經官方核准；公開頁在核准前維持原內容。') + form('edit-content',contentFields(p),'儲存介紹',id)); }
  else if (name === 'add-detail') { const list = document.getElementById('detail-upload-list')!; const index = list.children.length; if (index < 12) list.insertAdjacentHTML('beforeend',upload(`介紹圖 ${index + 1}`,`detail${index}`)); else toast('最多 12 張介紹圖'); }
  else if (name === 'add-prize') { const list = document.getElementById('prize-list')!; const index = list.querySelectorAll('.prizeEditor').length; if (index < 100) list.insertAdjacentHTML('beforeend',prizeEditor(nextPrizeIndex++)); else toast('每池最多 100 個物品／結果'); }
  else if (name === 'remove-prize') target.closest('.prizeEditor')?.remove();
  else if (name === 'clear-image') { const container = target.closest('.field')!; (container.querySelector('input[type=hidden]') as HTMLInputElement).value = ''; container.querySelector('[data-preview]')!.innerHTML = ''; }
  else if (name === 'shipping') modal('申請出貨',notice('送出後，商品將不能再兌成點數。請確認收件資料正確。') + form('shipping',`<div class="stack">${field('收件人','name','text',user!.name,'required maxlength="80"')}${field('電話','phone','tel','','required minlength="7" maxlength="30"')}${field('完整收件地址','address','text','','required maxlength="500"')}</div>`,'送出出貨申請',id));
  else if (name === 'ship-order') modal('登記出貨',form('ship-order',`<div class="stack">${field('物流公司','carrier','text','','required maxlength="60"')}${field('追蹤號碼','tracking','text','','required minlength="4" maxlength="80"')}</div>`,'確認已交寄',id));
  else if (name === 'topup') modal('付款登記',notice('先依官方客服提供的付款方式完成付款，再登記付款參考碼與約定點數。送出後由官方核對入帳，本頁不會自動付款或立即增加餘額。') + form('topup',`<div class="stack">${field('與官方約定的點數','points','number','100','required min="1" max="100000"')}${field('唯一付款參考碼','reference','text','','required minlength="8" maxlength="100"')}</div>`,'送出付款登記'));
  else if (name === 'permissions') {
    const member: Row = await api(`/admin/members/${id}`);
    modal('修改會員權限',notice('儲存後，此會員的現有登入會失效。') + form('permissions',`<div class="stack"><label class="field">角色<select name="role">${['player','creator','admin'].map(role => `<option value="${role}" ${role === member.role ? 'selected' : ''}>${label(role)}</option>`).join('')}</select></label><label><input type="checkbox" name="disabled" ${member.disabled ? 'checked' : ''}> 停用帳戶</label></div>`,'更新權限',id));
  }
  else if (name === 'service') modal('認證 / 官方出貨申請',form('service',`<div class="stack"><label class="field">申請認證<select name="verification"><option value="identity">身分核驗</option><option value="inventory">庫存核驗</option></select></label><label><input type="checkbox" name="officialFulfillment"> 申請官方代出貨（須先與官方完成庫存交接）</label>${textArea('說明與聯絡資訊','note')}</div>`,'送出申請',id));
  else if (['approve-pool','reject-pool','cancel-pool'].includes(name)) modal(name === 'approve-pool' ? '核准獎池' : name === 'reject-pool' ? '拒絕獎池' : '取消獎池',form(name,textArea('審核 / 取消原因','note'),'確認送出',id));
  else if (name === 'draw-audit') { const rows = await api(`/admin/pools/${id}/draws`); modal('獎池抽獎稽核',table('全部抽獎紀錄',['序號','玩家','Email','獎品','時間'],rows.map((r: Row) => [String(r.ordinal + 1),esc(r.player),esc(r.email),esc(r.prize),when(r.created_at)]))); }
}
async function submitForm(node: HTMLFormElement) {
  const data = new FormData(node), name = node.dataset.form!, id = node.dataset.id!;
  const value = (key: string) => String(data.get(key) ?? '');
  const content = () => ({ description:value('description'),cover:value('cover'),descriptionImages:[...data.entries()].filter(([k,v]) => /^detail\d+$/.test(k) && v).map(([,v]) => String(v)) });
  if(name==='demo-order'){const order=await mutate('/demo/orders',{amount:Number(value('amount'))});modal('模擬收銀台',notice(`示範訂單 ${order.orderNo}，模擬金額 ${order.amount}，沒有真實金流。`)+form('demo-pay','<label class="field">模擬付款結果<select name="result" aria-label="模擬付款結果"><option value="success">模擬成功</option><option value="failure">模擬失敗（不入點）</option><option value="cancelled">模擬取消（不入點）</option></select></label>','確認模擬結果',order.orderNo));return;}
  else if(name==='demo-pay'){const order=await mutate('/demo/orders/'+id+'/complete',{result:value('result')});page='wallet';toast(order.status==='paid'?'模擬充值完成，示範點數已入帳；未扣真錢':order.status==='failed'?'已模擬付款失敗，未入點':'已取消模擬付款，未入點');}
  else if(name==='campaigns'){
    if(data.has('rewardsEnabled')&&!confirm('啟用後會實際發放任務與邀請贈點，確認預算與獎勵數值？'))return;
    const vip=[...node.querySelectorAll('[data-vip-tier]')].map((_,i)=>({name:value('vipName'+i),threshold:Number(value('vipThreshold'+i)),perk:value('vipPerk'+i)}));
    await mutate('/admin/campaigns',{version:Number(value('version')),settings:{rewardsEnabled:data.has('rewardsEnabled'),dailyBudget:Number(value('dailyBudget')),announcement:value('announcement'),vip,referral:{enabled:data.has('referralEnabled'),inviter:Number(value('inviter')),invitee:Number(value('invitee')),minimumPayment:Number(value('minimumPayment')),monthlyLimit:Number(value('monthlyLimit'))},tasks:Object.fromEntries(['verify_email','verify_phone','first_draw','daily_visit'].map(k=>[k,Number(value(k))]))}});toast('VIP 與活動設定已儲存');
  }
  else if(name==='bind-referral'){await mutate('/me/referral',{code:value('code')});sessionStorage.removeItem('invite');toast('邀請關係已綁定');}
  else if(name==='email-send'){const r=await api('/me/security/email/send',{...captchaBody(node)});toast(r.localOnly?'本機測試信已寫入伺服器 dev-mail，並未實際寄出。':'驗證信已寄出');}
  else if(name==='verify-email-confirm'){await api('/me/security/email/confirm',{token:id});history.replaceState(null,'','#account');page='account';toast('Email 已驗證');}
  else if(name==='phone-send'){await api('/me/security/phone/send',{phone:value('phone'),...captchaBody(node)});modal('輸入簡訊碼',form('phone-confirm',field('簡訊驗證碼','code','text','','required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,10}"'),'確認手機驗證'));return;}
  else if(name==='phone-confirm'){await api('/me/security/phone/confirm',{code:value('code')});toast('手機已驗證');}
  else if(name==='google-start'){const r=await api('/auth/google/start',{link:value('link')==='true',...(value('storefrontVersion')?{storefrontVersion:Number(value('storefrontVersion')),acceptedPolicies:value('acceptedPolicies')==='on'?true:undefined}:{}),...captchaBody(node)});const u=new URL(r.url);if(u.origin!=='https://accounts.google.com')throw new Error('Google 網址驗證失敗');location.assign(u.href);return;}
  else if(name==='storefront-draft'){
   const content=Object.fromEntries(storefrontFieldKeys.map(k=>[k,value(k).trim()]));
   await mutate('/admin/storefront/draft',{expectedVersion:Number(value('expectedVersion')),content});toast('草稿已儲存，沒有公開');
  }
  else if(name==='practice-status'){await api('/admin/practice/'+id+'/status',{action:value('action'),expectedVersion:Number(value('expectedVersion')),confirmed:data.has('confirmed'),password:value('password'),...(value('otp')?{otp:value('otp')}:{})},value('requestKey'));toast(value('action')==='hide'?'測試池已下架，歷史紀錄保留':'測試池已恢復到首頁，仍不扣點、不出貨');}
  else if(name==='storefront-publication'){
   await api('/admin/storefront/publication',{expectedVersion:Number(value('expectedVersion')),action:value('action'),confirmed:value('confirmed')==='on',...(value('operatorReviewed')==='on'?{operatorReviewed:true}:{}),password:value('password'),...(value('otp')?{otp:value('otp')}:{})},value('requestKey'));toast(value('action')==='publish'?'營運資訊已公開':'目前公開資訊已撤下，歷史紀錄保留');
  }
  else if(name==='refund-order'){
   const e=await api('/me/refund-eligibility?orderNo='+encodeURIComponent(value('orderNo')));
   if(e.openCase||!e.remainingAmount){modal('無法建立新申請',notice(e.openCase?'此訂單已有待處理退款，請先查看錢包紀錄。':'此訂單已無剩餘可退金額。'));return;}
   modal('付款退款申請',notice('送出後先凍結原付款來源；尚未退錢。已消費造成點數不足時轉人工覆核，不會自動核准。')+`<p>原單 NT$${num(e.originalAmount)} · 已完成退款 NT$${num(e.completedAmount)} · 原付款可用 ${num(e.sourceAvailable)} pt</p>`+form('request-refund',`<input type="hidden" name="orderNo" value="${esc(e.orderNo)}">${field('本次申請 NT$（1元＝1點）','amount','number',String(e.unspentEligible||e.remainingAmount),`required min="1" max="${e.remainingAmount}" step="1"`)}${textArea('退款原因（至少5字）','reason')}`,'送出並保留對應點數'));return;
  }
  else if(name==='request-refund'){const r=await mutate('/me/refunds',{orderNo:value('orderNo'),amount:Number(value('amount')),reason:value('reason')});toast('申請已建立，原付款保留 '+num(r.heldPoints)+' 點；尚未執行銀行退款');}
  else if(name==='refund-draft'){
   const action=value('action'),safe:Row={action,expectedVersion:Number(value('expectedVersion')),note:value('note'),acceptLossPoints:data.has('acceptLoss')?Number(value('lossPoints')):0};
   if(action==='prepare')safe.providerEligibilityReviewed=data.has('providerEligibilityReviewed');
   if(['complete','provider_failed'].includes(action)){safe.providerReference=value('providerReference');safe.providerOutcome=value('providerOutcome');if(action==='complete')safe.providerAmount=Number(value('providerAmount'));}
   if(safe.note.trim().length<5)throw new Error('請填寫至少5字處理原因');
   if(action==='prepare'&&!safe.providerEligibilityReviewed)throw new Error('請先核對支付方式及允許金額');
   if(action==='prepare'&&Number(value('lossPoints'))>0&&(!data.has('acceptLoss')||safe.note.trim().length<10))throw new Error('點數不足需明確確認缺口並填寫至少10字原因');
   const names:Row={prepare:'準備金流處理（不退錢）',complete:'登記已確認退款',reject:'拒絕並解凍',provider_failed:'登記確認未退款並解凍'};
   refundDraft={id,key:crypto.randomUUID(),safe};
   modal('再次確認・'+names[action],notice('此步只記錄站內狀態，不會呼叫銀行。請勿將未知或處理中的金流結果登記為已退款／未退款。')+`<p>案件 ${esc(id)} · v${safe.expectedVersion} · NT$${num(Number(value('caseAmount')))}</p><p>${esc(safe.note)}</p><p>操作：${esc(names[action])}</p>`+form('refund-confirm',field('目前管理員密碼','password','password','','required maxlength="128" autocomplete="current-password"')+(value('mfa')==='true'?field('驗證器碼／復原碼','otp','text','','required maxlength="32" autocomplete="one-time-code"'):''),'確認記錄',id));return;
  }
  else if(name==='refund-confirm'){
   const draft=refundDraft;if(!draft||draft.id!==id)throw new Error('確認已失效，請重新查詢');
   const r=await api('/admin/refunds/'+id+'/transition',{...draft.safe,password:value('password'),...(value('otp')?{otp:value('otp')}:{})},draft.key);refundDraft=null;
   toast(r.status==='processing'?'已進入金流處理中；保留點數未解凍，請由營運者處理金流':r.status==='completed'?'已依人工憑據登記完成，沒有再次扣點':'已拒絕並按原來源解凍');
  }
  else if(name==='mfa-setup'){const r=await api('/admin/mfa/setup',{password:value('password')});modal('綁定驗證器',notice('在驗證器新增帳戶並輸入以下金鑰，再填入 6 位驗證碼。請勿分享此金鑰。')+`<pre class="code">${esc(r.secret)}</pre>`+form('mfa-enable',field('6 位驗證碼','code','text','','required pattern="[0-9]{6}" inputmode="numeric" autocomplete="one-time-code"'),'啟用兩步驟驗證'));return;}
  else if(name==='mfa-enable'){const r=await api('/admin/mfa/enable',{code:value('code')});await render();modal('兩步驟驗證已啟用',notice('立即離線保存下列復原碼；每組只能使用一次，之後不再顯示。')+`<pre class="code">${r.recoveryCodes.map(esc).join('\n')}</pre>`);return;}
  else if(name==='mfa-disable'){await api('/admin/mfa/disable',{password:value('password'),code:value('code')});toast('兩步驟驗證已關閉');}
  else if(name==='admin-login'){const result=await api('/auth/admin-login',{email:value('email'),password:value('password'),otp:value('otp'),...captchaBody(node)});csrf=result.csrf;user=result.user;pendingKeys.clear();}
  else if (name === 'login' || name === 'register') {
    if(name==='register'&&value('password')!==value('confirmPassword'))throw new Error('兩次輸入的密碼不一致');
    const requested=page,result=await api(`/auth/${name}`,{email:value('email'),password:value('password'),...(name==='register'?{name:value('name'),...(value('storefrontVersion')?{storefrontVersion:Number(value('storefrontVersion')),acceptedPolicies:value('acceptedPolicies')==='on'?true:undefined}:{})}:{otp:value('otp')}),...captchaBody(node)});
    csrf=result.csrf;user=result.user;pendingKeys.clear();page=destinationAfterAuth(requested,name==='register');
    if(!/^#verify-email\/[a-f0-9]{64}$/.test(location.hash)){
      if(/^#invite\//.test(location.hash))history.replaceState(null,'','#'+page);else if(historyMode(location.hash,page)==='push')history.pushState(null,'','#'+page);
    }
    if(name==='register'){
      toast('帳戶已建立；信箱與手機尚未驗證');const invite=sessionStorage.getItem('invite');
      if(invite){try{await mutate('/me/referral',{code:invite});sessionStorage.removeItem('invite');}catch{toast('帳戶已建立；邀請碼尚未綁定，請至會員中心確認');}}
    }
  }
  else if (name === 'forgot') { await api('/auth/forgot',{email:value('email'),...captchaBody(node)}); toast('若帳號存在，我們將寄送重設連結。'); }
  else if (name === 'reset') { await api('/auth/reset',{token:id,password:value('password')}); history.replaceState(null,'','#home'); toast('密碼已更新，請重新登入'); }
  else if (name === 'new-pool') {
    const prizes = [...node.querySelectorAll<HTMLElement>('.prizeEditor')].map(p => { const val = (n: string) => (p.querySelector(`[name="${n}"]`) as HTMLInputElement).value; return {name:val('prizeName'),kind:val('prizeKind'),quantity:Number(val('prizeQuantity')),value:Number(val('prizeValue')),redeemPoints:Number(val('prizeRedeem')),image:(p.querySelector('input[type=hidden]') as HTMLInputElement).value}; });
    if (!prizes.length) throw new Error('請至少新增一個獎項');
    await mutate('/pools',{...content(),name:value('name'),kind:value('kind'),price:Number(value('price')),prizes}); page = 'creator'; toast('草稿已儲存，請在創作者中心送審');
  } else if (name === 'draw') {
    if (!user) { authForm(); return; }
    if(savedDraw()){await recoverPendingDraw();return;}
    const p=await api('/pools/'+id),quantity=Number(value('quantity'));
    if(!Number.isInteger(quantity)||quantity<1||quantity>Math.min(10,p.remaining))throw new Error('請選擇有效抽數');
    if(p.draw_mode==='weighted'&&Number(node.dataset.oddsVersion)!==p.odds_version)throw new Error('機率已更新，請重新開啟獎池');
    ticketSelection={id,name:p.name,price:p.price,testOnly:!!p.testOnly,quantity,selected:[],userId:user.id,key:crypto.randomUUID(),body:{quantity,...(p.draw_mode==='weighted'?{oddsVersion:p.odds_version}:{})}};
    modal('選擇你的紙籤',ticketSelectionView(quantity,p.remaining,false,!!p.testOnly),'ticketModal');return;
  } else if (name === 'edit-content') { await mutate(`/pools/${id}/content`,content()); toast('介紹已儲存或送審'); }
  else if (name === 'shipping') await mutate('/shipments',{itemIds:[id],name:value('name'),phone:value('phone'),address:value('address')});
  else if (name === 'ship-order') await mutate(`/shipments/${id}/ship`,{carrier:value('carrier'),tracking:value('tracking')});
  else if (name === 'ecpay') {
    const order = await mutate('/payments/ecpay',{amount:Number(value('amount'))});
    const expected = settings.ecpay.mode === 'stage' ? 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5' : 'https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5';
    if (order.action !== expected) throw new Error('付款網址驗證失敗');
    const checkout = document.createElement('form'); checkout.method = 'POST'; checkout.action = expected;
    for (const [name, value] of Object.entries(order.fields)) { const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = String(value); checkout.append(input); }
    document.body.append(checkout); checkout.submit(); return;
  }
  else if(name==='admin-search-members'){memberQuery=value('q');memberRole=value('role');memberPage=1;}
  else if(name==='admin-search-activity'){activityQuery=value('q');activityCategory=value('category');}
  else if(name==='admin-search-catalog'){catalogQuery=value('q');catalogPage=1;}
  else if(name==='admin-create-member'){await mutate('/admin/members',{name:value('name'),email:value('email'),password:value('password'),role:value('role')});toast('帳戶已建立');}
  else if(name==='draw-confirm'){if(!ticketSelection||ticketSelection.id!==id)throw new Error('選籤狀態已失效，請重新開啟獎池');ticketSelection.body.presentationSlots=[...ticketSelection.selected];await executeTicketDraw(ticketSelection);return;}
  else if(name==='admin-balance-preview'){
   const u=await api('/admin/members/'+id),amount=Number(value('amount')),expectedBalance=Number(value('expectedBalance')),direction=value('direction'),reason=value('reason').trim(),reference=value('reference').trim();
   if(!['credit','debit'].includes(direction)||!Number.isInteger(amount)||amount<1||amount>100000||reason.length<5||reason.length>500)throw new Error('請填整數點數及至少5字的原因');
   if(u.points!==expectedBalance)throw new Error('餘額已變更，請重新開啟調點視窗');
   const after=expectedBalance+(direction==='credit'?amount:-amount);if(after<0||after>1000000000)throw new Error('調整後餘額超出允許範圍');
   balanceDraft={id,key:crypto.randomUUID(),direction,amount,expectedBalance,reason,reference};
   modal('再次確認人工調點',notice('確認會員、方向與數量。此操作只改站內點數，不代表收款或退款。')+`<div class="balanceSummary"><b>${esc(u.name)} / ${esc(u.email)}</b><p>${esc(reason)} · ${esc(reference||'無參考碼')}</p><strong>${num(expectedBalance)} → ${num(after)} pt</strong><p>${direction==='credit'?'加點 +':'扣點 −'}${num(amount)} pt</p></div>`+form('admin-balance-confirm',field('目前管理員密碼','password','password','','required maxlength="128" autocomplete="current-password"')+(value('mfa')==='true'?field('驗證器碼／復原碼','otp','text','','required maxlength="32" autocomplete="one-time-code"'):''),'確認'+(direction==='credit'?'加點':'扣點'),id));return;
  }
  else if(name==='admin-balance-confirm'){
   const draft=balanceDraft;if(!draft||draft.id!==id)throw new Error('確認已失效，請重新開啟調點視窗');
   const {key,id:target,...safe}=draft;
   const r=await api('/admin/members/'+target+'/balance-adjustments',{...safe,password:value('password'),...(value('otp')?{otp:value('otp')}:{})},key);
   balanceDraft=null;await render();modal('人工調點完成',notice('已寫入不可覆寫的點數帳本與管理紀錄；不計正式實收或付費VIP。')+`<div class="balanceSummary"><strong>${num(r.before)} → ${num(r.after)} pt</strong><p>調整單號 ${esc(r.id)}</p><p>${esc(r.reason)}</p></div>`+button('查看該用戶調點紀錄','admin-balance',target));return;
  }
  else if(name==='admin-profile'){await mutate(`/admin/members/${id}/profile`,{name:value('name'),email:value('email')});toast('會員資料已儲存');}
  else if(name==='admin-odds'){
    const prizes=[...node.querySelectorAll<HTMLInputElement>('[data-odds-input]')].map(input=>({id:input.dataset.prizeId!,probabilityBps:Math.round(Number(input.value)*100)}));
    if(prizes.reduce((sum,p)=>sum+p.probabilityBps,0)!==10000)throw new Error('各物品機率合計必須為 100%');
    await mutate(`/admin/pools/${id}/odds`,{expectedVersion:Number(value('expectedVersion')),prizes});toast('機率已更新，伺服器已套用權重抽獎');
  }
  else if(name==='admin-prizes'){
    const prizes=[...node.querySelectorAll<HTMLElement>('.prizeEditor')].map(p=>{const val=(n:string)=>(p.querySelector(`[name="${n}"]`) as HTMLInputElement).value;return {name:val('prizeName'),kind:val('prizeKind'),quantity:Number(val('prizeQuantity')),value:Number(val('prizeValue')),redeemPoints:Number(val('prizeRedeem')),image:(p.querySelector('input[type=hidden]') as HTMLInputElement).value};});
    await mutate(`/admin/pools/${id}/prizes`,{prizes});toast('物品已儲存，請重新設定機率');
  }
  else if (name === 'topup') await mutate('/topups',{points:Number(value('points')),reference:value('reference')});
  else if (name === 'permissions') await mutate(`/admin/users/${id}`,{role:value('role'),disabled:data.has('disabled')});
  else if (name === 'service') await mutate(`/pools/${id}/service`,{verification:value('verification'),officialFulfillment:data.has('officialFulfillment'),note:value('note')});
  else if (name === 'approve-pool' || name === 'reject-pool') await mutate(`/admin/pools/${id}/review`,{approve:name === 'approve-pool',note:value('note')});
  else if (name === 'cancel-pool') await mutate(`/admin/pools/${id}/cancel`,{note:value('note')});
  dialog.close(); if((name==='register'||name==='login')&&sessionStorage.getItem('invite')){page='community';history.replaceState(null,'','#community');await render();await action('bind-referral','',root);return;} await render();if((name==='login'||name==='register')&&/^#verify-email\/[a-f0-9]{64}$/.test(location.hash))await routeIdentity();
}
document.addEventListener('click', async event => {
  if ((event.target as HTMLElement).closest('.skipLink')) { event.preventDefault(); document.getElementById('main-content')?.focus(); return; }
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-page],[data-action]'); if (!target) return;
  if (target instanceof HTMLButtonElement && target.disabled) return;
  if (target.dataset.page) { event.preventDefault();await navigateMember(parseMemberPage('#'+target.dataset.page));return; }
  if (target.dataset.action === 'go-collection') { dialog.close();await navigateMember('collection');return; }
  if (target instanceof HTMLButtonElement) target.disabled = true;
  try { await action(target.dataset.action!,target.dataset.id ?? '',target); }
  catch (error) { toast((error as Error).message); }
  finally { if (target instanceof HTMLButtonElement) target.disabled = false; }
});
document.addEventListener('submit', async event => {
  const node = event.target as HTMLFormElement; if (!node.dataset.form) return; event.preventDefault();
  if (node.dataset.busy) return;
  if (node.querySelector('[data-uploading]')) { node.querySelector('.formError')!.textContent = '請等待圖片上傳完成'; return; }
  node.dataset.busy = 'true'; const submit = node.querySelector('button[type=submit]') as HTMLButtonElement; submit.disabled = true; node.querySelector('.formError')!.textContent = '';
  try { await submitForm(node); } catch (error) { if(['admin-balance-confirm','refund-confirm','storefront-publication','practice-status'].includes(node.dataset.form??''))node.querySelectorAll<HTMLInputElement>('[name="password"],[name="otp"]').forEach(input=>input.value='');if((error as Error & {code?:string}).code==='MFA_REQUIRED'&&!node.querySelector('[name="otp"]')){node.querySelector('.formError')!.insertAdjacentHTML('beforebegin',mfaField());node.querySelector<HTMLInputElement>('[name="otp"]')?.focus();}node.querySelector('.formError')!.textContent = (error as Error).message; resetCaptcha(node);
    if((error as Error & {code?:string}).code==='POLICY_UPDATED'&&node.dataset.form==='register'){await authForm(true);toast('政策版本已更新，請重新閱讀並同意；密碼不保留。');} }
  finally { delete node.dataset.busy; submit.disabled = false; }
});
function filterPools() {
  const query = (document.getElementById('search') as HTMLInputElement | null)?.value.toLowerCase() ?? '';
  const filter = root.querySelector<HTMLElement>('[data-filter][aria-pressed="true"]')?.dataset.filter ?? 'all';
  let shown = 0;
  root.querySelectorAll<HTMLElement>('[data-search]').forEach(card => {
    const matches = filter === 'all' || (filter === 'live' && card.dataset.poolState === 'live') || (filter === 'free' && card.dataset.poolKind === 'free') || (filter === 'near' && card.dataset.nearEnd === 'true');
    card.hidden = !matches || !card.dataset.search!.includes(query); if (!card.hidden) shown++;
  });
  const empty = root.querySelector<HTMLElement>('.filterEmpty');
  if (empty) empty.hidden = shown > 0 || !root.querySelector('[data-search]');
}
document.addEventListener('click',event => {
  const filter = (event.target as HTMLElement).closest<HTMLElement>('[data-filter]'); if (!filter) return;
  root.querySelectorAll<HTMLElement>('[data-filter]').forEach(button => { button.setAttribute('aria-pressed',String(button === filter)); button.classList.toggle('selected',button === filter); });
  filterPools();
});
document.addEventListener('input',event => { if ((event.target as HTMLElement).id === 'search') filterPools(); });
document.addEventListener('change', async event => {
  const input = event.target as HTMLInputElement; if (!input.dataset.upload) return;
  const file = input.files?.[0]; if (!file) return;
  input.dataset.uploading = 'true'; input.disabled = true;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('檔案不可超過 5 MB');
    const response = await fetch(siteBase+'/api/uploads',{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type,'X-CSRF-Token':csrf},body:file}); const result = await response.json(); if (!response.ok) throw new Error(result.error);
    const container = input.closest('.field')!; (container.querySelector('input[type=hidden]') as HTMLInputElement).value = result.url; container.querySelector('[data-preview]')!.innerHTML = `<img class="preview" src="${esc(result.url)}" alt="已上傳圖片">`;
  } catch (error) { toast((error as Error).message); input.value = ''; }
  finally { delete input.dataset.uploading; input.disabled = false; }
});
async function routeIdentity(){
  if(adminPortal)return;
  const reset=/^#reset\/([a-f0-9]{64})$/.exec(location.hash);
  if(reset){if(!settings.passwordReset){modal('密碼重設尚未開通',notice('寄信服務尚未設定，目前不能完成密碼重設。請勿重複提交。'));return;}modal('設定新密碼',form('reset',field('新密碼','password','password','','required minlength="12" maxlength="128" autocomplete="new-password"'),'更新密碼',reset[1]));return;}
  const verify=/^#verify-email\/([a-f0-9]{64})$/.exec(location.hash),invite=/^#invite\/([a-f0-9]{24})$/.exec(location.hash);
  if(verify){if(!user){authForm();toast('先登入原帳號，再重新開啟驗證連結');}else modal('確認 Email 驗證',form('verify-email-confirm',notice('確認驗證目前登入帳號的信箱。'),'確認驗證',verify[1]));}
  if(invite){sessionStorage.setItem('invite',invite[1]);if(!user)authForm(true);else{page='community';await render();await action('bind-referral','',root);}}
  if(location.hash==='#google-error')toast('Google 登入未完成；若已有相同信箱帳號，請先登入再綁定。');
}
window.addEventListener('hashchange',()=>{page=parseMemberPage(location.hash);void render().then(routeIdentity).then(()=>window.scrollTo({top:0,behavior:'instant'}));});
async function boot() {
  settings = await api('/config'); settings.ecpay = await api('/payments/config'); settings.integrations=await api('/integrations/config');configureCaptcha(settings.integrations.captcha?settings.integrations.siteKey:'');await refreshLive();page = parseMemberPage(location.hash);
  if(settings.demo&&settings.basePath!==siteBase)throw new Error('體驗站路徑設定不符');
  await render();
  await routeIdentity();if(!adminPortal&&user&&savedDraw())await recoverPendingDraw();window.setInterval(()=>void refreshLive(),15000);if(adminPortal){window.setInterval(()=>void refreshAdminLive(),5000);void refreshAdminLive();}
}
installHoloInteractions();
boot().catch(error => { shell(`<h1>無法連線</h1>${notice(error.message)}${button('重新連線','refresh')}`); });

import { installHoloInteractions } from './holo.js';
import { shellView, homeView, collectionCardView, poolDetailView, drawResultView, revealView } from './visual.js';
type Row = Record<string, any>;
const root = document.getElementById('app')!;
const dialog = document.getElementById('dialog') as HTMLDialogElement;
let user: Row | null = null, csrf = '', settings: Row = {}, page = 'home', pools: Row[] = [];
let renderVersion = 0;
let nextPrizeIndex = 1;
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
function toast(message: string) { const node = document.getElementById('toast')!; node.textContent = message; setTimeout(() => { if (node.textContent === message) node.textContent = ''; }, 5500); }
async function api(url: string, body?: unknown, key?: string) {
  const response = await fetch(`/api${url}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, 'Idempotency-Key': key ?? crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '操作失敗') as Error & { status?: number }; error.status = response.status; throw error; }
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
let pendingReveal: Row[] | null = null;
function shell(content: string) { root.innerHTML = shellView(content,{user,page,registration:settings.registration}); }
function modal(title: string, body: string, kind = '') {
  window.clearTimeout(revealTimer); pendingReveal = null;
  dialog.className = kind;
  dialog.innerHTML = `<div class="dialogHead"><div><span class="dialogEyebrow">LUCKYBOX COLLECTION</span><h2 id="dialog-title">${esc(title)}</h2></div>${button('×','close','','aria-label="關閉"')}</div><div class="dialogBody">${body}</div>`;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function finishReveal() {
  if (!pendingReveal || !dialog.open) return;
  const results = pendingReveal;
  modal('抽獎結果',drawResultView(results),'resultModal');
}
function showDrawResults(results: Row[]) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { modal('抽獎結果',drawResultView(results),'resultModal'); return; }
  modal('抽獎結果',revealView(),'resultModal'); pendingReveal = results;
  revealTimer = window.setTimeout(finishReveal,1100);
}
dialog.addEventListener('close',() => { window.clearTimeout(revealTimer); pendingReveal = null; });
function form(name: string, contents: string, submit: string, id = '') { return `<form data-form="${name}" data-id="${esc(id)}">${contents}<div class="formError" role="alert"></div><button class="btn primary" type="submit">${esc(submit)}</button></form>`; }
function field(title: string, name: string, type = 'text', value = '', attrs = '') { return `<label class="field">${esc(title)}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`; }
function textArea(title: string, name: string, value = '') { return `<label class="field">${esc(title)}<textarea name="${name}" maxlength="12000">${esc(value)}</textarea></label>`; }
function upload(title: string, name: string, value = '') { return `<label class="field">${esc(title)}<input type="hidden" name="${name}" value="${esc(value)}"><input type="file" data-upload="${name}" accept="image/png,image/jpeg,image/webp"><span class="help">PNG / JPEG / WebP，每張不超過 5 MB</span><span data-preview="${name}">${value ? `<img class="preview" src="${esc(value)}" alt="已上傳圖片">` : ''}</span>${button('清除圖片','clear-image',name)}</label>`; }
function table(title: string, columns: string[], rows: string[][]) { return `<div class="tablewrap"><table class="table"><caption>${esc(title)}</caption><thead><tr>${columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${columns.length}">目前沒有資料</td></tr>`}</tbody></table></div>`; }
async function render() {
  const version = ++renderVersion;
  try {
    await session();
    let content = '';
    if (!user && !['home','free'].includes(page)) page = 'home';
    if (page === 'admin' && user?.role !== 'admin') page = 'home';
    if (page === 'home' || page === 'free') {
      pools = await api('/pools'); const list = page === 'free' ? pools.filter(p => p.kind === 'free') : pools;
      content = homeView(list,{user,page,registration:settings.registration});
    } else if (page === 'account') content = `<h1>我的帳戶</h1><section class="panel"><h2>${esc(user!.name)}</h2><p>${esc(user!.email)}</p>${status(user!.role)}<div class="actions">${button('登出','logout')}${settings.passwordReset ? button('重設密碼','forgot') : ''}${user!.role === 'admin' ? '<button type="button" class="btn light" data-page="admin">管理後台</button>' : ''}</div></section>`;
    else if (page === 'wallet') {
      const [ledger, topups] = await Promise.all([api('/me/ledger'), api('/me/topups')]);
      content = `<h1>點數錢包</h1><section class="panel"><p>可用點數</p><div class="balanceNumber">◈ ${num(user!.points)}</div><p class="help">點數不可提現。平台點數與新台幣、USDT 不相等。</p>${settings.manualTopups ? button('登記已完成的付款','topup') : notice('目前尚未開放儲值。')}</section>${table('儲值登記',['時間','點數','付款參考碼','狀態'],topups.map((t: Row) => [when(t.created_at),num(t.points),esc(t.reference),status(t.status)]))}${table('點數帳本（最近 200 筆）',['時間','類型','變動','餘額'],ledger.map((l: Row) => [when(l.created_at),esc(l.kind),`${l.delta > 0 ? '+' : ''}${num(l.delta)}`,num(l.balance_after)]))}`;
    } else if (page === 'collection') {
      const [items, shipments, draws] = await Promise.all([api('/me/collection'), api('/me/shipments'), api('/me/draws')]);
      content = `<h1>我的收藏</h1><div class="liveGrid">${items.map(collectionCardView).join('') || empty('還沒有收藏','參與獎池後，抽中的實體商品會保存在這裡。')}</div>${table('出貨進度',['收件人','狀態','物流 / 追蹤號碼','操作'],shipments.map((s: Row) => [esc(s.name),status(s.status),`${esc(s.carrier)} ${esc(s.tracking)}`,s.status === 'shipped' ? button('確認收貨','receive',s.id) : '—']))}${table('抽獎紀錄（最近 200 筆）',['時間','獎池','獎品','序號','花費'],draws.map((d: Row) => [when(d.created_at),esc(d.pool_name),esc(d.name),String(d.ordinal + 1),`${num(d.cost)} pt`]))}`;
    } else if (page === 'creator') {
      if (user!.role === 'player') content = `<h1>創作者中心</h1>${notice('申請通過後即可建立獎池。官方會檢查身分、商品與履約能力。')}${user!.creator_requested ? status('pending') : button('申請創作者權限','creator-request')}`;
      else {
        const [mine, settlements, shipping] = await Promise.all([api('/creator/pools'), api('/creator/settlements'), api('/fulfillment/shipments')]);
        content = `<div class="sectionhead"><h1>創作者中心</h1>${button('＋ 建立獎池','new-pool')}</div>${notice('點數獎及商品兌點須在送審時預存準備金。獎池全部抽完、商品履約完成且等待期結束後，可申請點數帳本結算；此功能不執行現金匯款。')}${poolManagement(mine,false)}${shippingTable(shipping)}${table('結算紀錄',['獎池','收入點數','平台費','準備金返還','狀態'],settlements.map((s: Row) => [esc(s.pool_id),num(s.gross_points),num(s.fee_points),num(s.reserve_returned),status(s.status)]))}`;
      }
    } else if (page === 'admin') {
      const [allPools, users, topups, settlements, shipping, audit] = await Promise.all([api('/admin/pools'),api('/admin/users'),api('/admin/topups'),api('/admin/settlements'),api('/fulfillment/shipments'),api('/admin/audit')]);
      content = `<h1>官方管理後台</h1>${notice('審核前請核實商品庫存、身分與收款。所有權限、審核與帳務操作都會記錄。不得審核自己的獎池、儲值或結算。')}${poolManagement(allPools,true)}${table('會員與權限',['會員','角色','點數','開池申請','操作'],users.map((u: Row) => [esc(u.email),`${status(u.role)} ${u.disabled ? '已停用' : ''}`,num(u.points),u.creator_requested ? '待審核' : '—',u.id !== user!.id ? button('修改權限','permissions',u.id) : '目前帳戶']))}${table('儲值覆核',['會員','點數','付款參考碼','狀態','操作'],topups.map((t: Row) => [esc(t.email),num(t.points),esc(t.reference),status(t.status),t.status === 'pending' ? button('確認入帳','topup-approve',t.id) + button('拒絕','topup-reject',t.id) : '—']))}${shippingTable(shipping)}${table('結算覆核',['獎池','收入','平台費','準備金','狀態','操作'],settlements.map((s: Row) => [esc(s.pool_id),num(s.gross_points),num(s.fee_points),num(s.reserve_returned),status(s.status),s.status === 'requested' ? button('核准點數結算','settlement-approve',s.id) : '—']))}${table('操作稽核（最近 300 筆）',['時間','操作','對象','內容'],audit.map((a: Row) => [when(a.created_at),esc(a.action),esc(a.target),esc(a.detail)]))}`;
    }
    if (version === renderVersion) shell(content);
  } catch (error) { if (version === renderVersion) shell(`<h1>暫時無法載入</h1>${notice((error as Error).message)}${button('重新連線','refresh')}`); }
}
function poolManagement(list: Row[], admin: boolean) {
  return table(admin ? '獎池審核與管理' : '我的獎池',['名稱 / 狀態','庫存 / 收入','介紹與服務','操作'],list.map(p => [
    `<b>${esc(p.name)}</b><p>${status(p.status)}</p><small>${esc(p.review_note)}</small>`, `${p.remaining}/${p.total}<br>${num(p.revenue_points)} pt`,
    `${p.verification === 'none' ? '未認證' : esc(label(p.verification))} / ${p.fulfillment === 'official' ? '官方出貨' : '創作者出貨'}<div class="actions">${button('修改介紹','edit-content',p.id)}${!admin ? button('申請認證 / 官方出貨','service',p.id) : ''}</div>${p.pendingContent ? '介紹修改待審核' : ''}${p.serviceRequest ? `<p>${esc(JSON.stringify(p.serviceRequest))}</p>` : ''}`,
    `<div class="actions">${button('查看','pool',p.id)}${['draft','rejected'].includes(p.status) && p.owner_id === user!.id ? button('送審','submit-pool',p.id) : ''}${p.status === 'approved' ? button('開放抽獎','open-pool',p.id) : ''}${p.status === 'sold_out' && p.owner_id === user!.id ? button('申請結算','settlement',p.id) : ''}${admin && p.status === 'pending' ? button('核准','approve-pool',p.id) + button('拒絕','reject-pool',p.id) : ''}${admin && p.pendingContent ? button('核准介紹','content-approve',p.id) + button('拒絕介紹','content-reject',p.id) : ''}${admin && p.serviceRequest ? button('核准服務','service-approve',p.id) + button('拒絕服務','service-reject',p.id) : ''}${admin ? button('抽獎稽核','draw-audit',p.id) : ''}${admin && p.remaining === p.total && !['cancelled','settled'].includes(p.status) ? button('取消獎池','cancel-pool',p.id) : ''}</div>`
  ]));
}
function shippingTable(rows: Row[]) { return table('出貨工作台',['收件資料','商品','狀態','物流','操作'],rows.map(s => [`${esc(s.name)}<br>${esc(s.phone)}<br>${esc(s.address)}`,s.items.map((i: Row) => esc(i.name)).join('<br>'),status(s.status),`${esc(s.carrier)} ${esc(s.tracking)}`,s.status === 'requested' ? button('登記出貨','ship-order',s.id) : '—'])); }
function authForm(register = false) {
  modal(register ? '加入 LUCKYBOX' : '登入 LUCKYBOX',form(register ? 'register' : 'login',`<div class="stack">${register ? field('暱稱','name','text','','required maxlength="60" autocomplete="nickname"') : ''}${field('Email','email','email','','required maxlength="254" autocomplete="email"')}${field('密碼','password','password','','required minlength="12" maxlength="128" autocomplete="' + (register ? 'new-password' : 'current-password') + '"')}<p class="help">密碼至少 12 個字元。</p></div>`,register ? '建立帳戶' : '登入') + `<div class="actions">${settings.registration ? button(register ? '已有帳戶，登入' : '註冊新帳戶',register ? 'login' : 'register') : ''}${settings.passwordReset ? button('忘記密碼','forgot') : ''}</div>`);
}
async function openPool(id: string) {
  const p = await api(`/pools/${id}`);
  modal(p.name,poolDetailView(p,p.creator ?? user?.name ?? 'LUCKYBOX'),'poolModal');
}
function prizeEditor(index: number) { return `<section class="prizeEditor"><h4>獎項 ${index + 1}</h4><div class="formgrid">${field('獎品名稱','prizeName','text','','required maxlength="120"')}<label class="field">類型<select name="prizeKind"><option value="physical">實體商品</option><option value="points">點數獎</option><option value="none">未中獎</option></select></label>${field('數量','prizeQuantity','number','1','required min="1" max="10000"')}${field('參考價值 / 點數獎額','prizeValue','number','0','required min="0" max="1000000"')}${field('實體商品兌點額','prizeRedeem','number','0','required min="0" max="1000000"')}${upload('獎品圖片',`prizeImage${index}`)}</div>${button('移除此獎项','remove-prize')}</section>`; }
function contentFields(p?: Row) { return `<div class="stack">${textArea('商品 / 活動介紹','description',p?.description ?? '')}${upload('獎池封面','cover',p?.cover ?? '')}<h3>介紹圖片（最多 12 張）</h3><div id="detail-upload-list">${(p?.descriptionImages ?? []).map((v: string, i: number) => upload(`介紹圖 ${i + 1}`,`detail${i}`,v)).join('')}</div>${button('新增介紹圖','add-detail')}</div>`; }
function newPool() {
  if (!user) { authForm(); return; }
  if (user.role === 'player') { page = 'creator'; dialog.close(); void render(); return; }
  nextPrizeIndex = 1;
  modal('建立獎池',notice('先儲存為草稿，再送交官方審核。點數獎額與商品兌點額的總和會在送審時凍結為準備金。') + form('new-pool',`<div class="formgrid">${field('獎池名稱','name','text','','required maxlength="120"')}<label class="field">獎池類型<select name="kind"><option value="free">免費抽</option><option value="paid">點數付費抽</option></select></label>${field('每抽點數（免費池填 0）','price','number','0','required min="0" max="100000"')}</div>${contentFields()}<h3>獎品清單</h3><p class="help">「點數獎」把獎額填在參考價值欄，兌點額填 0；「未中獎」兩者皆填 0。</p><div id="prize-list">${prizeEditor(0)}</div>${button('＋ 新增獎項','add-prize')}<br><br>`,'儲存草稿'));
}
async function action(name: string, id: string, target: HTMLElement) {
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
  if (name === 'close') dialog.close();
  else if (name === 'reveal-now') finishReveal();
  else if (name === 'browse') document.getElementById('pool-section')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  else if (name === 'login') authForm();
  else if (name === 'register') authForm(true);
  else if (name === 'logout') { await api('/auth/logout',{}); user = null; csrf = ''; pendingKeys.clear(); page = 'home'; await render(); }
  else if (name === 'refresh') await render();
  else if (name === 'forgot') modal('重設密碼',form('forgot',field('Email','email','email',user?.email ?? '','required'),'寄送重設連結'));
  else if (name === 'new-pool') newPool();
  else if (name === 'pool') await openPool(id);
  else if (name === 'proof') { const proof = await api(`/pools/${id}/proof`); modal('抽獎驗證資料',notice(proof.seed ? '獎池已結束，種子已公開。可使用隨附的驗證工具重建抽獎序列。' : '種子將於全部抽完後公開。可先保存承諾值與獎品清單，日後比對。') + `<pre class="code">${esc(JSON.stringify(proof,null,2))}</pre>`); }
  else if (name === 'edit-content') { const p = await api(`/pools/${id}`); modal('修改商品介紹',notice(user?.role === 'admin' ? '官方修改會立即更新公開介紹；獎品、數量、價格與機率不會被修改。' : '已送審或開放中的獎池，介紹修改須經官方核准；公開頁在核准前維持原內容。') + form('edit-content',contentFields(p),'儲存介紹',id)); }
  else if (name === 'add-detail') { const list = document.getElementById('detail-upload-list')!; const index = list.children.length; if (index < 12) list.insertAdjacentHTML('beforeend',upload(`介紹圖 ${index + 1}`,`detail${index}`)); else toast('最多 12 張介紹圖'); }
  else if (name === 'add-prize') { const list = document.getElementById('prize-list')!; const index = list.querySelectorAll('.prizeEditor').length; if (index < 30) list.insertAdjacentHTML('beforeend',prizeEditor(nextPrizeIndex++)); else toast('最多 30 個獎項'); }
  else if (name === 'remove-prize') target.closest('.prizeEditor')?.remove();
  else if (name === 'clear-image') { const container = target.closest('.field')!; (container.querySelector('input[type=hidden]') as HTMLInputElement).value = ''; container.querySelector('[data-preview]')!.innerHTML = ''; }
  else if (name === 'shipping') modal('申請出貨',notice('送出後，商品將不能再兌成點數。請確認收件資料正確。') + form('shipping',`<div class="stack">${field('收件人','name','text',user!.name,'required maxlength="80"')}${field('電話','phone','tel','','required minlength="7" maxlength="30"')}${field('完整收件地址','address','text','','required maxlength="500"')}</div>`,'送出出貨申請',id));
  else if (name === 'ship-order') modal('登記出貨',form('ship-order',`<div class="stack">${field('物流公司','carrier','text','','required maxlength="60"')}${field('追蹤號碼','tracking','text','','required minlength="4" maxlength="80"')}</div>`,'確認已交寄',id));
  else if (name === 'topup') modal('付款登記',notice('先依官方客服提供的付款方式完成付款，再登記付款參考碼與約定點數。送出後由官方核對入帳，本頁不會自動付款或立即增加餘額。') + form('topup',`<div class="stack">${field('與官方約定的點數','points','number','100','required min="1" max="100000"')}${field('唯一付款參考碼','reference','text','','required minlength="8" maxlength="100"')}</div>`,'送出付款登記'));
  else if (name === 'permissions') {
    const members: Row[] = await api('/admin/users'); const member = members.find(m => m.id === id); if (!member) throw new Error('找不到會員');
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
  if (name === 'login' || name === 'register') { const result = await api(`/auth/${name}`,{ email:value('email'),password:value('password'),...(name === 'register' ? {name:value('name')} : {}) }); csrf = result.csrf; user = result.user; pendingKeys.clear(); }
  else if (name === 'forgot') { await api('/auth/forgot',{email:value('email')}); toast('若帳號存在，我們將寄送重設連結。'); }
  else if (name === 'reset') { await api('/auth/reset',{token:id,password:value('password')}); history.replaceState(null,'','#home'); toast('密碼已更新，請重新登入'); }
  else if (name === 'new-pool') {
    const prizes = [...node.querySelectorAll<HTMLElement>('.prizeEditor')].map(p => { const val = (n: string) => (p.querySelector(`[name="${n}"]`) as HTMLInputElement).value; return {name:val('prizeName'),kind:val('prizeKind'),quantity:Number(val('prizeQuantity')),value:Number(val('prizeValue')),redeemPoints:Number(val('prizeRedeem')),image:(p.querySelector('input[type=hidden]') as HTMLInputElement).value}; });
    if (!prizes.length) throw new Error('請至少新增一個獎項');
    await mutate('/pools',{...content(),name:value('name'),kind:value('kind'),price:Number(value('price')),prizes}); page = 'creator'; toast('草稿已儲存，請在創作者中心送審');
  } else if (name === 'draw') {
    if (!user) { authForm(); return; }
    const result = await mutate(`/pools/${id}/draw`,{quantity:Number(value('quantity'))});
    showDrawResults(result.results); await render(); return;
  } else if (name === 'edit-content') { await mutate(`/pools/${id}/content`,content()); toast('介紹已儲存或送審'); }
  else if (name === 'shipping') await mutate('/shipments',{itemIds:[id],name:value('name'),phone:value('phone'),address:value('address')});
  else if (name === 'ship-order') await mutate(`/shipments/${id}/ship`,{carrier:value('carrier'),tracking:value('tracking')});
  else if (name === 'topup') await mutate('/topups',{points:Number(value('points')),reference:value('reference')});
  else if (name === 'permissions') await mutate(`/admin/users/${id}`,{role:value('role'),disabled:data.has('disabled')});
  else if (name === 'service') await mutate(`/pools/${id}/service`,{verification:value('verification'),officialFulfillment:data.has('officialFulfillment'),note:value('note')});
  else if (name === 'approve-pool' || name === 'reject-pool') await mutate(`/admin/pools/${id}/review`,{approve:name === 'approve-pool',note:value('note')});
  else if (name === 'cancel-pool') await mutate(`/admin/pools/${id}/cancel`,{note:value('note')});
  dialog.close(); await render();
}
document.addEventListener('click', async event => {
  if ((event.target as HTMLElement).closest('.skipLink')) { event.preventDefault(); document.getElementById('main-content')?.focus(); return; }
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-page],[data-action]'); if (!target) return;
  if (target instanceof HTMLButtonElement && target.disabled) return;
  if (target.dataset.page) { page = target.dataset.page; history.replaceState(null,'',`#${page}`); await render(); window.scrollTo({top:0,behavior:'instant'}); return; }
  if (target.dataset.action === 'go-collection') { dialog.close(); page = 'collection'; await render(); window.scrollTo({top:0,behavior:'instant'}); return; }
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
  try { await submitForm(node); } catch (error) { node.querySelector('.formError')!.textContent = (error as Error).message; }
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
    const response = await fetch('/api/uploads',{method:'POST',credentials:'same-origin',headers:{'Content-Type':file.type,'X-CSRF-Token':csrf},body:file}); const result = await response.json(); if (!response.ok) throw new Error(result.error);
    const container = input.closest('.field')!; (container.querySelector('input[type=hidden]') as HTMLInputElement).value = result.url; container.querySelector('[data-preview]')!.innerHTML = `<img class="preview" src="${esc(result.url)}" alt="已上傳圖片">`;
  } catch (error) { toast((error as Error).message); input.value = ''; }
  finally { delete input.dataset.uploading; input.disabled = false; }
});
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#reset/')) { page = location.hash.slice(1) || 'home'; void render().then(() => window.scrollTo({top:0,behavior:'instant'})); } });
async function boot() {
  settings = await api('/config'); page = location.hash.slice(1) || 'home';
  const reset = /^#reset\/([a-f0-9]{64})$/.exec(location.hash);
  if (reset) page = 'home'; await render();
  if (reset) modal('設定新密碼',form('reset',field('新密碼','password','password','','required minlength="12" maxlength="128" autocomplete="new-password"'),'更新密碼',reset[1]));
}
installHoloInteractions();
boot().catch(error => { shell(`<h1>無法連線</h1>${notice(error.message)}${button('重新連線','refresh')}`); });

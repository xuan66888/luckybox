import type {StorefrontContent} from './storefront-data.js';
type Row=Record<string,any>;
const esc=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export const informationSections=['contact','shipping','terms','privacy','returns'] as const;
export type InformationSection=typeof informationSections[number];
export const informationLabels={contact:'營運與客服',shipping:'配送說明',terms:'服務條款',privacy:'隱私權政策',returns:'退換貨與退款說明'};
const fields=[
 ['businessName','營業名稱',120],['businessId','統一編號／登記識別（選填）',40],['businessAddress','公開營業地址（選填）',300],
 ['supportEmail','客服 Email',254],['supportPhone','公開客服電話（選填）',40],['supportHours','客服服務時間',200],
 ['shippingRegions','配送地區',500],['shippingSchedule','備貨與配送時程',1000],['shippingFee','運費與配送方式',1000],
 ['terms','服務條款正文',12000],['privacy','隱私權政策正文',12000],['returns','退換貨與退款說明正文',12000]
] as const;
export const storefrontFieldKeys=fields.map(([key])=>key);
const required=new Set(['businessName','supportEmail','supportHours','shippingRegions','shippingSchedule','shippingFee','terms','privacy','returns']);
export function policyConsentView(version?:number){
 if(!version)return '';
 return `<div class="policyConsent"><input type="hidden" name="storefrontVersion" value="${version}"><label class="checkField"><input type="checkbox" name="acceptedPolicies" required> 我已閱讀並同意服務條款，並知悉隱私權政策</label><p class="help"><a href="/#info/terms/${version}" target="_blank" rel="noopener noreferrer">服務條款（版本 ${version}，另開分頁）</a> · <a href="/#info/privacy/${version}" target="_blank" rel="noopener noreferrer">隱私權政策（同版）</a></p></div>`;
}
export function publicInformationView(data:Row,section:InformationSection){
 const version=typeof data.version==='number'?data.version:null;
 const navigation=data.draft?'':`<nav class="informationNav" aria-label="網站資訊">${informationSections.map(s=>`<a class="btn light" href="#info/${s}${data.archived&&version?'/'+version:''}" ${section===s?'aria-current="page"':''}>${informationLabels[s]}</a>`).join('')}</nav>`;
 const header=`<div class="sectionhead"><div><span class="sectionKicker">LUCKYBOX INFORMATION</span><h1>${informationLabels[section]}</h1></div><a class="btn light" href="#home">返回首頁</a></div>`;
 if(!data.published||!data.content)return header+navigation+'<section class="panel informationEmpty"><h2>營運資訊尚未公布</h2><p>此頁尚無已公開內容。目前不提供可用的客服聯絡或配送／政策承諾，請勿將商品預告視為可交易庫存。</p><p class="help">資料確認並由營運者公開後，會顯示在這裡。</p></section>';
 const c=data.content as StorefrontContent;
 const pair=(label:string,value:string)=>`<div class="informationPair"><dt>${label}</dt><dd>${esc(value)||'未公開'}</dd></div>`;
 let body='';
 if(section==='contact')body=`<dl class="informationDetails">${pair('營業名稱',c.businessName)}${pair('統一編號／登記識別',c.businessId)}${pair('公開營業地址',c.businessAddress)}<div class="informationPair"><dt>客服 Email</dt><dd>${c.supportEmail?`<a href="mailto:${esc(c.supportEmail)}">${esc(c.supportEmail)}</a>`:'未公開'}</dd></div>${pair('公開客服電話',c.supportPhone)}${pair('客服服務時間',c.supportHours)}</dl>`;
 else if(section==='shipping')body=`<dl class="informationDetails">${pair('配送地區',c.shippingRegions)}${pair('備貨與配送時程',c.shippingSchedule)}${pair('運費與配送方式',c.shippingFee)}</dl>`;
 else body=`<div class="policyText">${esc(c[section])||'尚未填寫'}</div>`;
 const tag=data.draft?'<p class="notice">草稿預覽：只有目前管理頁看得到，尚未對外公開。</p>':data.archived?'<p class="notice">此為歷史公開版本，不代表目前適用內容。<a href="#info/'+section+'">查看目前版本</a></p>':'';
 return header+navigation+`<section class="panel informationContent">${tag}<p class="help">${data.draft?'未公開草稿':`公開版本 ${version} · ${new Date(data.publishedAt).toLocaleString('zh-TW')}`}</p>${body}</section>`;
}
export function storefrontAdminView(data:Row){
 const draft=data.draft as StorefrontContent;
 const issues=data.issues.map((k:string)=>fields.find(([key])=>key===k)?.[1]??k);
 return `<div class="adminSectionTitle"><div><h2>商家與政策</h2><p>草稿與公開版本分開；儲存不會自動公開。</p></div></div><section class="panel"><p><span class="status ${data.published?'ok':'wait'}">${data.published?'目前公開版本 '+data.published.version:'尚無公開版本'}</span> · 編輯版本 ${data.version}${data.hasUnpublishedChanges?' · 有尚未公開的草稿':''}</p><p class="help">只填寫你確認可以公開的營業／客服資料，以及你確認採用的正式政策。不要放密鑰、私人證件或客戶個資。欄位檢查不代表金流或政策審核通過。</p>${issues.length?`<p class="notice">公開前尚缺：${issues.map(esc).join('、')}</p>`:'<p class="notice">欄位已填齊；仍須營運者審閱並再次驗證，才會公開。</p>'}</section><form data-form="storefront-draft" class="storefrontEditor"><input type="hidden" name="expectedVersion" value="${data.version}"><section class="panel"><h3>營運、客服與配送</h3><div class="formgrid">${fields.filter(([, ,max])=>max<12000).map(([key,label,max])=>`<label class="field">${label}${required.has(key)?'（公開必填）':''}${max>300?`<textarea name="${key}" maxlength="${max}" rows="3">${esc(draft[key])}</textarea>`:`<input name="${key}" type="${key==='supportEmail'?'email':'text'}" maxlength="${max}" value="${esc(draft[key])}">`}</label>`).join('')}</div></section><section class="panel"><h3>公開政策正文</h3><p class="help">純文字呈現，不執行 HTML。尚未定案可留空並儲存草稿；不會代填條款。</p>${fields.filter(([, ,max])=>max===12000).map(([key,label,max])=>`<label class="field">${label}（公開必填）<textarea name="${key}" maxlength="${max}" rows="9">${esc(draft[key])}</textarea></label>`).join('')}</section><div class="formError" role="alert"></div><div class="actions"><button type="submit" class="btn primary">儲存草稿（不公開）</button><button type="button" class="btn light" data-action="storefront-preview">預覽目前填寫內容</button></div></form><section class="panel"><h3>公開控制</h3><p class="help">只會公開已儲存草稿；公開後可從用戶頁頁尾查看。歷史公開版本與新會員同意紀錄保留供追溯，撤下不會刪除已公開歷史或清除對方快取。</p><div class="actions"><button type="button" class="btn primary" data-action="storefront-publish" ${data.issues.length?'disabled':''}>審閱並公開已儲存草稿</button><button type="button" class="btn light" data-action="storefront-withdraw" ${data.published?'':'disabled'}>撤下目前公開資訊</button><a class="btn light" href="/#info/contact" target="_blank" rel="noopener noreferrer">查看用戶頁資訊</a></div></section>`;
}

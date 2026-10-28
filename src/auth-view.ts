import type {MemberPage} from './navigation.js';
import {policyConsentView} from './storefront-view.js';
const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const field=(title:string,name:string,type:string,attributes:string)=>`<label class="field">${esc(title)}<input name="${name}" type="${type}" ${attributes}></label>`;
function passwordField(kind:string,title:string,name:string,attributes:string){
 const id='auth-'+kind+'-'+name;
 return `<div class="field"><label for="${id}">${esc(title)}</label><div class="passwordControl"><input id="${id}" name="${name}" type="password" ${attributes}><button type="button" class="btn light passwordToggle" data-action="password-visibility" data-input-id="${id}" data-field-label="${esc(title)}" aria-controls="${id}" aria-label="顯示${esc(title)}" aria-pressed="false">顯示</button></div></div>`;
}
export function memberAccessView(page:MemberPage,registration:boolean){
 const titles:Record<string,string>={wallet:'點數錢包',collection:'我的收藏',community:'會員中心',account:'我的帳戶',creator:'創作者中心'},title=titles[page]??'會員功能';
 return `<section class="panel memberAccess"><span class="sectionKicker">MEMBER ACCESS</span><h1>登入後查看${title}</h1><p>此頁包含你的個人資料，請先登入。登入或註冊完成後會回到這一頁。</p><div class="actions"><button type="button" class="btn primary" data-action="login">登入</button>${registration?'<button type="button" class="btn light" data-action="register">註冊新帳戶</button>':''}<button type="button" class="btn light" data-page="home">返回首頁</button></div></section>`;
}
export function mfaField(){return `<div data-mfa-prompt>${field('驗證器碼／復原碼','otp','text','required maxlength="32" autocomplete="one-time-code" autocapitalize="off" spellcheck="false"')}<p class="help">此帳號已啟用兩步驗證，請輸入驗證器的 6 位碼，或一組尚未使用的復原碼。</p></div>`;}
export function authFields(kind:'register'|'member-login'|'admin-login',policyVersion?:number){
  const register=kind==='register',admin=kind==='admin-login';
  return `<div class="stack">${register?field('暱稱','name','text','required maxlength="60" autocomplete="nickname"'):''}${field(admin?'管理員 Email':'Email','email','email','required maxlength="254" autocomplete="username" autocapitalize="none" spellcheck="false"')}${passwordField(kind,admin?'管理員密碼':'密碼','password',`required ${register?'minlength="12" ':''}maxlength="128" autocomplete="${register?'new-password':'current-password'}"`)}${register?passwordField(kind,'再次輸入密碼','confirmPassword','required minlength="12" maxlength="128" autocomplete="new-password"')+'<p class="help">密碼至少 12 個字元。建立帳戶不代表信箱或手機已驗證；未開通的驗證服務不會顯示假成功。</p>'+policyConsentView(policyVersion):''}</div>`;
}

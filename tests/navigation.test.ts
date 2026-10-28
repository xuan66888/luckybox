import test from 'node:test';
import assert from 'node:assert/strict';
import {memberPages,memberPage,needsMemberLogin,destinationAfterAuth,historyMode,type MemberPage} from '../src/navigation.js';
import {authFields,memberAccessView} from '../src/auth-view.js';
import {fixture} from './helpers.js';

test('member routes whitelist member and public-information destinations and reject foreign URLs, admin names and malformed fragments',()=>{
 for(const page of memberPages){assert.equal(memberPage('#'+page),page);assert.equal(memberPage(page),page);}
 for(const hash of ['','#unknown','#admin','#https://evil.invalid','#//evil.invalid','#javascript:alert(1)','#wallet?next=admin','#wallet/extra','#%77allet','#Wallet','#<img src=x onerror=alert(1)>'])assert.equal(memberPage(hash),'home');
});
test('only exact well-formed identity links map to an account or invitation destination',()=>{
 assert.equal(memberPage('#verify-email/'+'a'.repeat(64)),'account');assert.equal(memberPage('#invite/'+'b'.repeat(24)),'community');
 for(const hash of ['#verify-email/'+'a'.repeat(63),'#invite/'+'b'.repeat(25),'#invite/'+'z'.repeat(24),'#verify-email/'+'a'.repeat(64)+'/other','#reset/'+'a'.repeat(64)])assert.equal(memberPage(hash),'home');
});
test('anonymous protected pages keep their destination and require a visible sign-in gate; public pages remain usable',()=>{
 for(const page of memberPages){assert.equal(needsMemberLogin(page,false),!['home','free','info'].includes(page));assert.equal(needsMemberLogin(page,true),false);}
 assert.equal(memberPage('#wallet'),'wallet');assert.equal(needsMemberLogin(memberPage('#wallet'),false),true);
});
test('successful sign-in and registration return to requested private destination instead of losing it to home',()=>{
 for(const page of memberPages.filter(p=>!['home','free','info'].includes(p))){assert.equal(destinationAfterAuth(page,false),page);assert.equal(destinationAfterAuth(page,true),page);}
 assert.equal(destinationAfterAuth('home',true),'community');assert.equal(destinationAfterAuth('free',true),'community');assert.equal(destinationAfterAuth('free',false),'free');
});
test('member navigation pushes distinct destinations while repeat selection does not grow history',()=>{
 for(const page of memberPages){assert.equal(historyMode('#'+page,page),'none');assert.equal(historyMode('#unknown',page),'push');}
 assert.equal(historyMode('#home','wallet'),'push');assert.equal(historyMode('#wallet','collection'),'push');
});
test('password visibility controls are non-submitting, separately labelled and scoped to unique form inputs; policy stays12',()=>{
 const all=['register','member-login','admin-login'] as const;
 for(const kind of all){const html=authFields(kind);assert.ok(html.includes('type="password"'));assert.ok(html.includes('data-action="password-visibility"'));assert.ok(html.includes('type="button"'));assert.ok(html.includes('aria-pressed="false"'));assert.ok(html.includes(`id="auth-${kind}-password"`));assert.ok(html.includes(`for="auth-${kind}-password"`));assert.ok(!html.includes('name="otp"'));assert.ok(html.includes('maxlength="128"'));}
 const register=authFields('register');assert.equal((register.match(/data-action="password-visibility"/g)??[]).length,2);assert.equal((register.match(/minlength="12"/g)??[]).length,2);assert.ok(register.includes('autocomplete="new-password"'));assert.ok(authFields('member-login').includes('autocomplete="current-password"'));
});
test('member gate names destination, returns to requested page, obeys signup switch and exposes no admin/provider promise',()=>{
 const html=memberAccessView('wallet',true);assert.ok(html.includes('登入後查看點數錢包'));assert.ok(html.includes('登入或註冊完成後會回到這一頁'));assert.ok(html.includes('data-action="register"'));assert.ok(!memberAccessView('collection',false).includes('data-action="register"'));assert.ok(!html.includes('/admin'));assert.ok(!html.includes('Google'));
 assert.ok(!memberAccessView('<script>' as MemberPage,true).includes('<script>'));
});
test('presentation routing does not weaken actual API authentication, role checks or disabled provider gates',async()=>{
 const f=await fixture({paidDraws:false,manualTopups:false});try{const anonymous=f.client();assert.equal((await anonymous.request('/api/me/wallet')).status,401);assert.equal((await anonymous.request('/api/me/community')).status,401);assert.equal((await f.player.request('/api/admin/members')).status,403);assert.equal((await f.player.request('/api/auth/google/start',{})).status,503);assert.equal((await f.player.request('/api/payments/ecpay',{amount:100})).status,503);assert.equal((await f.player.request('/api/auth/me')).data.user.points,10000);}finally{await f.close();}
});

import {z} from 'zod';
import {sha256} from './fairness.js';
import {HttpError,type Store} from './db.js';
const text=(max:number)=>z.string().trim().max(max);
export const storefrontContentSchema=z.object({
 businessName:text(120),businessId:text(40),businessAddress:text(300),
 supportEmail:z.union([z.literal(''),z.email().max(254)]),supportPhone:text(40),supportHours:text(200),
 shippingRegions:text(500),shippingSchedule:text(1000),shippingFee:text(1000),
 terms:text(12000),privacy:text(12000),returns:text(12000)
}).strict();
export type StorefrontContent=z.infer<typeof storefrontContentSchema>;
export const emptyStorefront:StorefrontContent={businessName:'',businessId:'',businessAddress:'',supportEmail:'',supportPhone:'',supportHours:'',shippingRegions:'',shippingSchedule:'',shippingFee:'',terms:'',privacy:'',returns:''};
export const requiredStorefrontFields=['businessName','supportEmail','supportHours','shippingRegions','shippingSchedule','shippingFee','terms','privacy','returns'] as const;
export function publicationIssues(content:StorefrontContent){return requiredStorefrontFields.filter(k=>!content[k].trim());}
export function storefrontState(store:Store){
 const row=store.one('SELECT * FROM storefront_settings WHERE id=1');
 const published=row?.published_version?store.one('SELECT * FROM storefront_publications WHERE version=?',row.published_version):undefined;
 const draft=storefrontContentSchema.parse(row?JSON.parse(row.draft):structuredClone(emptyStorefront));
 if(published&&sha256(published.content)!==published.content_hash)throw new HttpError(503,'公開資訊紀錄不一致，請聯絡管理員');
 return {version:row?.version??0,draft,published:published?{version:published.version,content:storefrontContentSchema.parse(JSON.parse(published.content)),contentHash:published.content_hash,publishedAt:published.published_at}:null,updatedAt:row?.updated_at??null,issues:publicationIssues(draft)};
}
export function publicStorefront(store:Store){
 const {published}=storefrontState(store);
 return published?{published:true,version:published.version,content:published.content,contentHash:published.contentHash,publishedAt:published.publishedAt}:{published:false,version:null,content:null,contentHash:null,publishedAt:null};
}
export function storefrontReady(store:Store){const p=storefrontState(store).published;return !!p&&publicationIssues(p.content).length===0;}
export function requirePublishedStorefront(store:Store){if(!storefrontReady(store))throw new HttpError(503,'商家／客服／配送與政策資訊尚未公開，暫不提供正式交易');}
export function registrationPolicy(store:Store){const p=storefrontState(store).published;return p?{version:p.version,contentHash:p.contentHash}:null;}
export function validateRegistrationPolicy(store:Store,input:{acceptedPolicies?:true;storefrontVersion?:number}){
 const p=registrationPolicy(store);
 if(!p)return null;
 if(input.acceptedPolicies!==true)throw new HttpError(400,'請先閱讀並同意服務條款與隱私權政策');
 if(input.storefrontVersion!==p.version)throw new HttpError(409,'公開資訊版本已更新，請重新開啟註冊並閱讀最新版本','POLICY_UPDATED');
 return p;
}
export function recordRegistrationConsent(store:Store,user:string,input:{acceptedPolicies?:true;storefrontVersion?:number}){
 const p=validateRegistrationPolicy(store,input);if(!p)return;
 store.run('INSERT INTO user_policy_consents VALUES(?,?,?,?)',user,p.version,p.contentHash,Date.now());
}

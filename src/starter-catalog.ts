import {randomUUID} from 'node:crypto';
import {requireRow,type Store} from './db.js';

// Private zero-stock prize drafts; public display uses credited official raster
// reference photos, never invented availability, competitor prices or descriptions.
export const starterProducts=[
 {code:'godzilla-2023',name:'哥吉拉（2023）MONSTERLISE 熱線放射 ver.',photoCredit:"BANDAI SPIRITS／一番くじONLINE",photoSource:"https://on-line.1kuji.com/Form/Product/ProductDetail.aspx?bid=IP00006383&pid=sap_0000008647",source:'https://kujiflip.tw/product/哥吉拉-怪獸亂舞-零之鼓動-9/3c2bef7f-ec93-46a0-8ad6-144c9982e794'},
 {code:'chiikawa-shisa',name:'吉伊卡哇 滿滿獅薩 超大娃娃（約50cm）',photoCredit:"Gray Parker Service 官方新聞稿",photoSource:"https://prtimes.jp/main/html/rd/p/000000079.000168561.html",source:'https://kujiflip.tw/product/一番賞-吉伊卡哇-滿滿獅薩-無最後賞-1/ba9eaf24-399e-451c-a4e7-b5b2373f1d65'},
 {code:'beyblade-bx52',name:'戰鬥陀螺 BX-52 光耀龍騎（日版）',photoCredit:"TAKARA TOMY",photoSource:"https://beyblade.takaratomy.co.jp/beyblade-x/lineup/bx52.html",source:'https://kujiflip.tw/product/戰鬥陀螺-bx-52-光耀龍騎-5/0047845c-31e7-4419-b456-beb0a17dfb1b'}
];
export function starterDrafts(store:Store,ownerId:string){
 requireRow(store.one("SELECT id FROM users WHERE id=? AND role='admin' AND disabled=0",ownerId));
 const ids:string[]=[];let created=0;
 for(const p of starterProducts){
  const previous=store.one('SELECT pool_id FROM starter_catalog WHERE code=?',p.code);
  if(previous){ids.push(previous.pool_id);continue;}
  const id=randomUUID(),now=Date.now();
  store.run("INSERT INTO pools(id,owner_id,name,description,status,kind,price,total,remaining,fee_bps,review_note,created_at,draw_mode,odds_version) VALUES(?,?,?,?,'draft','paid',0,1,0,0,?,?,'weighted',1)",id,ownerId,p.name,'實體商品備貨草稿。規格、商品實拍／圖片使用權、取得成本、抽獎價格、現貨數量與出貨方式待確認；尚未上架、不開抽。','只參考商品名稱，不代表已取得商品、授權或庫存。規劃1份，可抽0份。',now);
  store.run("INSERT INTO prizes(id,pool_id,name,kind,image,value,redeem_points,quantity,remaining,weight_bps) VALUES(?,?,?,'physical','',0,0,1,0,10000)",randomUUID(),id,p.name);
  store.run('INSERT INTO starter_catalog VALUES(?,?,?,?)',p.code,id,p.source,now);ids.push(id);created++;
 }
 if(created)store.audit(ownerId,'physical_drafts_created','starter-catalog',{quantity:created,note:'商品名稱參考；草稿、無可抽庫存、未開抽'});
 return {created,poolIds:ids,publiclyAvailable:false};
}

export function upcomingProducts(store:Store){
 return starterProducts.filter(p=>store.one("SELECT 1 FROM starter_catalog s JOIN pools p ON p.id=s.pool_id WHERE s.code=? AND p.status IN('draft','pending')",p.code)).map(p=>({code:p.code,name:p.name,image:'/assets/reference-'+p.code+'.svg',photoCredit:p.photoCredit,photoSource:p.photoSource,status:'coming_soon',drawEnabled:false}));
}

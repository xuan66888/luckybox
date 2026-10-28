// Presentation routing only. Server authentication and authorization remain mandatory.
export const memberPages=['home','free','wallet','collection','community','account','creator','info'] as const;
export type MemberPage=typeof memberPages[number];
const infoPattern=/^#?info\/(contact|shipping|terms|privacy|returns)(?:\/([1-9][0-9]{0,9}))?$/;
export function informationSection(hash:string):'contact'|'shipping'|'terms'|'privacy'|'returns'{return (infoPattern.exec(hash)?.[1] as ReturnType<typeof informationSection>)??'contact';}
export function informationVersion(hash:string){const n=Number(infoPattern.exec(hash)?.[2]);return Number.isSafeInteger(n)&&n>0&&n<=2147483647?n:null;}
export function memberPage(hash:string):MemberPage{
 const value=hash.startsWith('#')?hash.slice(1):hash;
 if(memberPages.includes(value as MemberPage))return value as MemberPage;
 const info=infoPattern.exec(value);if(info&&(!info[2]||informationVersion(value)))return 'info';
 if(/^verify-email\/[a-f0-9]{64}$/.test(value))return 'account';
 if(/^invite\/[a-f0-9]{24}$/.test(value))return 'community';
 return 'home';
}
export function needsMemberLogin(page:MemberPage,authenticated:boolean){return !authenticated&&page!=='home'&&page!=='free'&&page!=='info';}
export function destinationAfterAuth(requested:MemberPage,register:boolean):MemberPage{return needsMemberLogin(requested,false)?requested:register?'community':requested;}
export function historyMode(currentHash:string,next:MemberPage){return currentHash==='#'+next?'none':'push';}

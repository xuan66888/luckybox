type Widget={render:(node:HTMLElement,options:Record<string,unknown>)=>string;reset:(id:string)=>void;remove:(id:string)=>void};
declare global{interface Window{turnstile?:Widget;}}
let site='',load:Promise<void>|undefined;
const widgets=new Map<HTMLElement,string>();
export function configureCaptcha(key:string){site=key;}
export function captchaSlot(action:string){return site?`<div class="captchaSlot" data-captcha-action="${action}"></div>`:'';}
export async function mountCaptcha(container:ParentNode){
  if(!site)return;for(const[node,id]of widgets)if(!node.isConnected){window.turnstile?.remove(id);widgets.delete(node);}
  load??=new Promise<void>((resolve,reject)=>{const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.onload=()=>resolve();script.onerror=()=>reject(new Error('防機器人服務載入失敗，請重新整理'));document.head.append(script);});
  try{await load;for(const node of container.querySelectorAll<HTMLElement>('[data-captcha-action]'))if(node.isConnected&&!widgets.has(node)){const id=window.turnstile!.render(node,{sitekey:site,action:node.dataset.captchaAction,size:'flexible',callback:(token:string)=>{node.dataset.token=token;},'expired-callback':()=>{delete node.dataset.token;},'error-callback':()=>{delete node.dataset.token;}});widgets.set(node,id);}}catch(e){for(const node of container.querySelectorAll<HTMLElement>('[data-captcha-action]'))node.textContent=(e as Error).message;}
}
export function captchaBody(form:HTMLFormElement){const node=form.querySelector<HTMLElement>('[data-captcha-action]');if(!node)return{};if(!node.dataset.token)throw new Error('請先完成防機器人驗證');return{captchaToken:node.dataset.token};}
export function resetCaptcha(form:HTMLFormElement){const node=form.querySelector<HTMLElement>('[data-captcha-action]');if(node){delete node.dataset.token;const id=widgets.get(node);if(id)window.turnstile?.reset(id);}}

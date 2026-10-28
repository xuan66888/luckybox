import { randomInt } from 'node:crypto';
import { HttpError } from './db.js';

export function effectiveOdds(prizes:Record<string,any>[]) {
  const total=prizes.reduce((sum,p)=>sum+(p.remaining>0?p.weight_bps:0),0);
  return prizes.map(p=>({...p,effectiveProbability:p.remaining>0&&total>0?p.weight_bps/total:0}));
}
export function pickWeighted(prizes:Record<string,any>[], random:(max:number)=>number=randomInt) {
  const eligible=prizes.filter(p=>p.remaining>0&&p.weight_bps>0);
  const total=eligible.reduce((sum,p)=>sum+p.weight_bps,0);
  if(total<=0)throw new HttpError(409,'剩餘獎品的機率皆為 0，請聯絡管理員調整');
  let value=random(total);
  for(const prize of eligible){value-=prize.weight_bps;if(value<0)return prize;}
  throw new Error('Invalid random sample');
}

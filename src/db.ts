import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type PointSource={kind:string;reference:string};
export class Store {
  private transactionDepth=0;
  db: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.function('luckybox_point_protocol',()=>2);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  }
  one(sql: string, ...args: SQLInputValue[]): Record<string, any> | undefined { return this.db.prepare(sql).get(...args); }
  all<T extends object = Record<string, any>>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');this.transactionDepth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally {this.transactionDepth--;}
  }
  migrate(directory: string) {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT');
    for (const file of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
      this.tx(() => {
        if (this.one('SELECT name FROM schema_migrations WHERE name=?', file)) return;
        this.db.exec(readFileSync(path.join(directory, file), 'utf8'));
        this.run('INSERT INTO schema_migrations VALUES (?,?)', file, Date.now());
      });
    }
  }
  audit(actor: string | null, action: string, target: string, detail: unknown = {}) {
    this.run('INSERT INTO audit VALUES (?,?,?,?,?,?)', randomUUID(), actor, action, target, JSON.stringify(detail), Date.now());
  }
  pointHistoryIssues(user:string){
    const lots=Number(this.one(`SELECT COUNT(*) n FROM point_lots p LEFT JOIN ledger c ON c.id=p.credit_ledger_id WHERE p.user_id=? AND (p.issued<>p.remaining+COALESCE((SELECT SUM(a.points) FROM point_allocations a WHERE a.lot_id=p.id),0) OR (p.credit_ledger_id IS NOT NULL AND c.delta<>p.issued))`,user)!.n);
    const debits=Number(this.one(`SELECT COUNT(*) n FROM ledger l WHERE l.user_id=? AND l.delta<0 AND l.rowid>(SELECT legacy_ledger_rowid FROM point_accounting_state WHERE id=1) AND -l.delta<>COALESCE((SELECT SUM(a.points) FROM point_allocations a WHERE a.debit_ledger_id=l.id),0)`,user)!.n);
    return lots+debits;
  }
  sourceBalance(user:string,source:PointSource){return Number(this.one('SELECT COALESCE(SUM(remaining),0) points FROM point_lots WHERE user_id=? AND source_kind=? AND source_reference=?',user,source.kind,source.reference)!.points);}
  holdHistoryIssues(user:string,ignore='',ignoreRefund=''){
    return Number(this.one(`SELECT COUNT(*) n FROM wallet_holds h LEFT JOIN ledger l ON l.id=h.id JOIN refunds r ON r.id=h.refund_id WHERE h.user_id=? AND h.id<>? AND h.refund_id<>? AND (
     l.id IS NULL OR l.kind<>'refund_hold' OR l.delta<>-h.points OR l.reference<>h.id OR l.user_id<>h.user_id
     OR h.points<>COALESCE((SELECT SUM(a.points) FROM point_allocations a WHERE a.debit_ledger_id=h.id),0)
     OR EXISTS(SELECT 1 FROM point_allocations a JOIN point_lots p ON p.id=a.lot_id WHERE a.debit_ledger_id=h.id AND (p.source_kind<>h.source_kind OR p.source_reference<>h.source_reference))
     OR (h.state='active' AND (r.status NOT IN('requested','needs_review','processing') OR EXISTS(SELECT 1 FROM point_releases pr WHERE pr.hold_id=h.id)))
     OR (h.state='released' AND (r.status NOT IN('rejected','cancelled') OR h.points<>COALESCE((SELECT SUM(p.issued) FROM point_lots p WHERE p.reissue_hold_id=h.id),0)))
     OR (h.state='settled' AND (r.status<>'completed' OR EXISTS(SELECT 1 FROM point_releases pr WHERE pr.hold_id=h.id)))
    )`,user,ignore,ignoreRefund)!.n);
  }
  heldBalance(user:string){return Number(this.one("SELECT COALESCE(SUM(points),0) n FROM wallet_holds WHERE user_id=? AND state='active'",user)!.n);}
  reserveRefundHold(refund:string,user:string,points:number,source:PointSource,kind:'payment'|'referral'){
    if(!this.transactionDepth)throw new Error('Refund hold requires transaction');
    if(!Number.isSafeInteger(points)||points<=0)throw new Error('Invalid hold amount');
    const id=randomUUID();this.run("INSERT INTO wallet_holds VALUES(?,?,?,?,?,?,?,'active',?)",id,refund,user,points,source.kind,source.reference,kind,Date.now());
    this.balance(user,-points,'refund_hold',id,source);return id;
  }
  releaseRefundHold(id:string){
    if(!this.transactionDepth)throw new Error('Refund release requires transaction');
    const hold=requireRow(this.one("SELECT h.* FROM wallet_holds h JOIN refunds r ON r.id=h.refund_id WHERE h.id=? AND h.state='active' AND r.status IN('rejected','cancelled')",id));
    this.run("UPDATE wallet_holds SET state='released' WHERE id=?",id);
    this.run('INSERT INTO point_releases VALUES(?,?,?)',id,hold.user_id,Date.now());
    const lots=this.all('SELECT a.lot_id,a.points FROM point_allocations a WHERE a.debit_ledger_id=? ORDER BY a.lot_id',id);
    if(lots.reduce((n,a)=>n+Number(a.points),0)!==hold.points)throw new HttpError(409,'凍結分攤不符，停止解除');
    for(const lot of lots)this.balance(hold.user_id,Number(lot.points),'refund_release',id+':'+lot.lot_id,undefined,{holdId:id,lotId:lot.lot_id});
  }
  balance(user: string, delta: number, kind: string, reference: string, source?:PointSource,reissue?:{holdId:string;lotId:string}):void {
    if(!this.transactionDepth){this.tx(()=>this.balance(user,delta,kind,reference,source,reissue));return;}
    if (!Number.isSafeInteger(delta)) throw new Error('Non-integer ledger delta');
    if(source&&delta>=0)throw new HttpError(400,'指定來源僅能用於扣點');
    if(kind==='payment_refund'){
      if(delta!==0||!this.one("SELECT 1 FROM refunds WHERE id=? AND user_id=? AND status='processing'",reference,user))throw new HttpError(409,'退款完成只能結算已凍結點數，不可再次扣點');
    }
    let holdId:string|undefined;
    if(kind==='refund_hold'){
      const hold=this.one("SELECT h.* FROM wallet_holds h JOIN refunds r ON r.id=h.refund_id WHERE h.id=? AND h.user_id=? AND h.state='active' AND r.status IN('requested','needs_review')",reference,user);
      if(!hold||delta!==-hold.points||source?.kind!==hold.source_kind||source?.reference!==hold.source_reference)throw new HttpError(409,'退款凍結來源不符');holdId=hold.id;
    }
    let original:Record<string,any>|undefined;
    if(kind==='refund_release'||reissue){
      if(kind!=='refund_release'||!reissue||delta<=0||reference!==reissue.holdId+':'+reissue.lotId)throw new HttpError(409,'解除凍結來源不符');
      original=this.one("SELECT p.*,p.rowid original_rowid,h.refund_id reissue_refund,a.points release_points FROM point_allocations a JOIN point_lots p ON p.id=a.lot_id JOIN wallet_holds h ON h.id=a.debit_ledger_id JOIN point_releases pr ON pr.hold_id=h.id WHERE a.debit_ledger_id=? AND a.lot_id=? AND a.user_id=? AND h.state='released'",reissue.holdId,reissue.lotId,user);
      if(!original||delta!==original.release_points)throw new HttpError(409,'解除凍結分攤不符');
    }
    const before=Number(requireRow(this.one('SELECT points FROM users WHERE id=?',user)).points);
    const tracked=Number(this.one('SELECT COALESCE(SUM(remaining),0) points FROM point_lots WHERE user_id=?',user)!.points);
    const ledgerBefore=Number(this.one('SELECT COALESCE(SUM(delta),0) points FROM ledger WHERE user_id=?',user)!.points);
    if(before!==tracked||before!==ledgerBefore||this.pointHistoryIssues(user)||this.holdHistoryIssues(user,holdId??reissue?.holdId,original?.reissue_refund))throw new HttpError(409,'點數來源與餘額不一致，已停止異動並要求對帳');
    if(source&&this.sourceBalance(user,source)<-delta)throw new HttpError(409,'指定來源可用點數不足，不能拿其他點數抵扣');
    if(delta>0&&before+delta+this.heldBalance(user)>1000000000)throw new HttpError(409,'可用與凍結點數合計超出帳戶上限');
    const changed = this.run('UPDATE users SET points=points+? WHERE id=? AND points+? BETWEEN 0 AND 1000000000', delta, user, delta);
    if (!changed.changes) throw new HttpError(409, '點數不足或超出帳戶上限');
    const ledgerId=holdId??randomUUID(),now=Date.now();
    this.run('INSERT INTO ledger VALUES (?,?,?,?,?,?,?)', ledgerId, user, delta, before+delta,kind,reference,now);
    if(delta>0){
      let category='other';
      if(kind==='ecpay_topup'){
        const order=this.one("SELECT * FROM payment_orders WHERE order_no=? AND user_id=? AND status='paid'",reference,user);
        if(!order||order.points!==delta)throw new HttpError(409,'金流訂單與入點來源不符');
        category=order.environment==='production'?'paid':'stage';
      }else if(['community_reward','prize_points','prize_redeem'].includes(kind))category='reward';
      else if(['admin_adjustment','manual_topup'].includes(kind))category='adjustment';
      this.run('INSERT INTO point_lots(id,user_id,credit_ledger_id,category,source_kind,source_reference,issued,remaining,created_at,reissue_hold_id,reissue_lot_id,fifo_rank) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',ledgerId,user,ledgerId,original?.category??category,original?.source_kind??kind,original?.source_reference??reference,delta,delta,original?.created_at??now,reissue?.holdId??null,reissue?.lotId??null,original?(original.fifo_rank??original.original_rowid):null);
    }else if(delta<0){
      let remaining=-delta;
      const lots=source?this.all('SELECT id,remaining FROM point_lots WHERE user_id=? AND remaining>0 AND source_kind=? AND source_reference=? ORDER BY created_at,COALESCE(fifo_rank,rowid),rowid',user,source.kind,source.reference):this.all('SELECT id,remaining FROM point_lots WHERE user_id=? AND remaining>0 ORDER BY created_at,COALESCE(fifo_rank,rowid),rowid',user);
      for(const lot of lots){if(!remaining)break;const used=Math.min(remaining,Number(lot.remaining));
        const change=this.run('UPDATE point_lots SET remaining=remaining-? WHERE id=? AND user_id=? AND remaining>=?',used,lot.id,user,used);
        if(change.changes!==1)throw new HttpError(409,'點數來源異動衝突，請重新查詢');
        this.run('INSERT INTO point_allocations VALUES(?,?,?,?)',ledgerId,lot.id,user,used);remaining-=used;
      }
      if(remaining)throw new HttpError(409,'點數來源不足，已回復本次異動');
    }
    if(Number(this.one('SELECT COALESCE(SUM(remaining),0) points FROM point_lots WHERE user_id=?',user)!.points)!==before+delta)throw new Error('Point conservation failure');
  }
  close() { this.db.close(); }
}
export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
export function requireRow<T extends object>(value: T | undefined): T { if (!value) throw new HttpError(404, '找不到資料'); return value; }

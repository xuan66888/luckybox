import { createHash, createHmac } from 'node:crypto';
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Rejection sampling avoids modulo bias. Algorithm version: hmac-sha256-fisher-yates-v1.
export function ticketOrder(seed: string, manifest: { id: string; quantity: number }[]) {
  const tickets = manifest.flatMap(p => Array<string>(p.quantity).fill(p.id));
  let counter = 0;
  for (let i = tickets.length - 1; i > 0; i--) {
    const bound = i + 1, limit = Math.floor(0x100000000 / bound) * bound;
    let value: number;
    do { value = createHmac('sha256', seed).update(`luckybox-v1:${counter++}`).digest().readUInt32BE(0); } while (value >= limit);
    const j = value % bound;
    [tickets[i], tickets[j]] = [tickets[j], tickets[i]];
  }
  return tickets;
}

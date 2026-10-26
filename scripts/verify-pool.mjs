import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/verify-pool.mjs proof.json');
const proof = JSON.parse(await readFile(file,'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
if (!proof.seed) throw new Error('Seed is not public until all tickets are drawn');
if (proof.algorithm !== 'hmac-sha256-fisher-yates-v1') throw new Error('Unknown algorithm');
if (hash(proof.seed) !== proof.commitment || hash(proof.manifest) !== proof.manifestHash) throw new Error('Commitment or manifest hash mismatch');
const tickets = JSON.parse(proof.manifest).flatMap(p => Array(p.quantity).fill(p.id));
let counter = 0;
for (let i = tickets.length - 1; i > 0; i--) {
  const bound = i + 1, limit = Math.floor(0x100000000 / bound) * bound;
  let value;
  do { value = createHmac('sha256',proof.seed).update(`luckybox-v1:${counter++}`).digest().readUInt32BE(0); } while (value >= limit);
  const j = value % bound; [tickets[i],tickets[j]] = [tickets[j],tickets[i]];
}
if (proof.draws.length !== tickets.length || proof.draws.some((d,i) => d.ordinal !== i || d.prize_id !== tickets[i])) throw new Error('Draw sequence mismatch');
console.log(`VERIFIED: ${tickets.length} finite tickets, commitment, manifest and every draw match.`);

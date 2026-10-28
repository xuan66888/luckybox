# Refund hold lifecycle — manual provider handoff

- One TWD buys one point; refund requests reserve only unspent lots of the original order. Available and held balances are separate. Gifts/another order never substitute.
- requested / needs_review → processing (operator checks payment method/state eligibility, current password and enrolled MFA) → completed only with exact amount and a unique verifiable provider reference. Completion is explicitly **operator attestation**, not provider API verification. No refund HTTP call exists.
- Before processing, owner cancellation/admin rejection releases the exact original provenance and FIFO age. A processing case cannot timeout or be cancelled/rejected. Only an operator-attested confirmed-not-refunded outcome can release it. Unknown provider outcomes stay frozen.
- Partial/repeated completed amounts cannot exceed original amount. One open case per order; optimistic versions, immediate SQLite transaction and idempotency prevent duplicated holds or settlements. A settlement ledger marker has zero delta: reserved points are not debited twice.
- Original referral qualification threshold and original awarded ledger sources are used. If refund breaks qualification, unspent award points are held; spent awards create an explicit shortfall, never a debit of unrelated paid points. Completed reversal is terminal; no reward farming.
- `REFUND_LOSS_APPROVALS_ENABLED=false` by default. Any payment or reward shortfall blocks bank preparation even if an admin supplies loss acknowledgement. Owner approval/policy is required before enabling exceptions. UI offers rejection instead, not a bank-first instruction. Point shortfall is not a TWD bank loss amount.
- Old pending refunds migrate to legacy_review without invented paid provenance or retroactive holds. Old completed records remain. Legacy provenance requires separate manual reconciliation, not automatic refund approval.
- VIP/dashboard use production gross minus completed refund amounts, not whole-order exclusion. Time buckets subtract refunds on completion date; can be negative. Stage/manual credits never count as paid VIP. This still does not reconcile bank settlement.

## Rollback safety

Migration010 installs database point-write triggers requiring connection function `luckybox_point_protocol()` registered by this release. Earlier images cannot update user points or append ledger rows on a migrated database. This is a **fail-closed compatibility interlock**, not authorization and not an automatic downgrade. Reads remain available. Test verifies an old unregistered SQLite connection rejects point writes.

For runtime rollback: retain the financial database and backup; set ECPAY_ENABLED, ECPAY_LIVE_APPROVED, ALLOW_PAID_DRAWS, MANUAL_TOPUPS_ENABLED, ADMIN_BALANCE_ADJUSTMENTS_ENABLED, REFUND_LOSS_APPROVALS_ENABLED all false before restoring an older image. Do not restore a stale database over newer transactions or remove the interlock. Old pages may return a financial-write error; repair forward or deploy a protocol-compatible release before resuming financial writes.

The local ROLLBACK.sh restores source bytes only on a separately marked copy. It does not downgrade a live database.

## Provider constraints / remaining acceptance

Payment method and authorization/close state determine supported ECPay AIO actions; ordinary-card partial refunds are not a blanket promise for every method. Stage has no real authorization/refund acceptance. Owner must perform a real authorized payment/refund and check provider records before launch. Never mix the AIO API with the newer JSON Credit API.
Official references: https://developers.ecpay.com.tw/2885/ and https://support.ecpay.com.tw/7238/ .

Google/SMTP/SMS, ECPay merchant approval/credentials, real stock and product photos/policies, MFA enrollment and real devices remain launch gates. Refund automation is not implemented; off-host backup remains owner-deferred. Real collection/draw/reward flags remain off until accepted.

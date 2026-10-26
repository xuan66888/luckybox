# 安全設計與 API

## 信任邊界

- 瀏覽器只有顯示資料與提出請求的能力；伺服器不接受由客戶端提供的獎品結果、角色、價格、餘額或核驗 badge。
- 所有寫入需精確 `Origin`，登入後還需 `X-CSRF-Token`。不同 origin 不開放 CORS，無萬用 Access-Control-Allow-Origin。
- Session token 使用 32 隨機 bytes，資料庫只存 SHA-256；正式 cookie 使用 `__Host-`、Secure、HttpOnly、SameSite=Strict、Path=/，不設 Domain。
- scrypt N=32768,r=8,p=1，隨機 16-byte salt，64-byte derived key；密碼至少 12、最多 128 字元。
- 登入/註冊、忘記密碼、API、抽獎、圖片上傳分別限制頻率，計數落在 SQLite。只按 IP 或會員限速，不宣稱可阻止分散式攻擊或多真人帳戶詐領。
- HTML 文字/屬性輸出 escape；商品介紹視為純文字；不允許 remote/data/script URL。 CSP 禁止 inline JavaScript/style、外部連線、frame 與 object。
- JSON 限 128 KiB；上傳限 5 MiB、2,000 萬像素、單張 PNG/JPEG/WebP；重編碼為 WebP、移除額外 metadata；每帳戶最多 100 MiB / 500 個檔案，每小時 20 次。
- 上傳的商品圖片是公開資源，**不可上傳身分證件或私密資料**。UUID 檔名不可當成私密存取控制。

## 原子交易及重複請求

所有帳務/業務 mutation 需帶 `Idempotency-Key`（16–100 位英數、`_`、`-`）；以「userId + key」唯一約束保護。相同 key 和相同 method/path/body 回傳原結果；相同 key 用不同內容回應 409。記錄與業務交易一起提交，不做先查後寫的分離操作。瀏覽器網路失敗重試保留同一 key；頁面重新載入會清空瀏覽器暫存，重新操作前應先查看帳本/抽獎紀錄。

`BEGIN IMMEDIATE` 內同時檢查最新角色/停用狀態、池狀態/庫存、扣點、抽獎、獎品減量、收藏/點數發放、獎池準備金、審計、冪等回應。任一步驟失敗 rollback。

SQL 使用參數綁定；庫存/點數有 CHECK，draw ordinal / 付款參考碼 / 兌獎 collection / 結算 / 冪等鍵有 UNIQUE，外鍵啟用。帳本與 audit 有禁止 UPDATE/DELETE 的 trigger；正式 DB 管理員仍可改資料庫或移除 trigger，這不是對作業系統/DB 擁有者的不可竄改保證。

## 抽獎承諾

1. 官方核准時建立隨機 32-byte hex seed。
2. 儲存並公開 SHA256(seed)、固定序列化 manifest、SHA256(manifest)。manifest 固定各獎品 id、數量、點數、兌點額。
3. 使用 HMAC-SHA256(seed, `luckybox-v1:<counter>`) 產生 32-bit 值，拒絕超出整數倍範圍的值，Fisher–Yates shuffle，避免 modulo bias。
4. 按 ordinal 依序抽出，seed 與剩餘 ticket 順序永不提前回傳。
5. 售罄後公開 seed，下載 `/api/pools/:id/proof` 的 JSON，執行 `node scripts/verify-pool.mjs proof.json`。

可先保存核准時的 commitment/manifestHash，再與結束後結果比對。本機驗證能證明序列與承諾一致，**不能**證明營運者沒有在承諾前挑選 seed，也不能替代外部隨機信標、第三方見證、獎品實存或對營運者的信任。已有抽獎的獎池不允許刪除重開。

## API 索引

JSON 寫入統一使用 POST；錯誤格式 `{error, fields?}`；成功 mutation 回傳 JSON。下列 `:id` 均為 UUID。

| 路由 | 用途 / 權限 |
|---|---|
| GET /health/live, /health/ready | 存活、資料庫可用 |
| GET /api/config | 公開功能開關，不回傳密鑰 |
| GET /api/auth/me | 個人資訊及 CSRF token |
| POST /api/auth/register, login, logout | 真實帳號登入 |
| POST /api/auth/forgot, reset | 密碼重設 |
| GET /api/pools, /api/pools/:id | 已核准公開池；未核准只給本人/官方 |
| GET /api/pools/:id/proof | 公開承諾與不含個資的抽獎結果 |
| POST /api/creator/request | 玩家申請開池 |
| GET /api/creator/pools, /api/creator/settlements | 本人的開池/結算 |
| POST /api/pools | 建立池，創作者/官方 |
| POST /api/pools/:id/submit, open, content, service, settlement | 所有人或官方；各自驗證狀態 |
| POST /api/pools/:id/draw | 登入玩家/非該池創作者；官方不可抽 |
| GET /api/me/collection, draws, ledger, shipments, topups | 僅自己的資料 |
| POST /api/collection/:id/redeem | 僅未處理且屬於自己的商品 |
| POST /api/shipments | 自己可出貨的同單位商品 |
| GET /api/fulfillment/shipments | 官方或負責此單的創作者 |
| POST /api/shipments/:id/ship | 官方或負責此單的創作者 |
| POST /api/shipments/:id/receive | 此單玩家 |
| POST /api/topups | 開關啟用時，會員登記人工付款 |
| POST /api/uploads | 創作者/官方；raw image bytes；無需 Idempotency-Key |
| GET /api/admin/users, pools, topups, settlements, audit | 僅官方 |
| POST /api/admin/users/:id | 修改其他會員角色/停用；撤銷 sessions |
| POST /api/admin/pools/:id/review, content-review, service-review, cancel | 官方審核/取消 |
| GET /api/admin/pools/:id/draws | 官方含玩家資訊稽核 |
| POST /api/admin/topups/:id/review | 核實收款後人工入帳，不可審核自己 |
| POST /api/admin/settlements/:id/approve | 完成履約後點數結算，不可審核自己 |

登入/重設/檔案上傳以外的业务 POST 皆需 Idempotency-Key。詳細 request schema 以 `src/app.ts` 的 Zod 定義為準；`tests/integration.test.ts` 有可執行範例。一般會員與官方使用同一登入端點，由伺服器資料庫角色決定權限。

## 維運限制

限單台主機、持久本機磁碟，不具跨機 HA。備份/日誌/資料保留、侵害偵測、客服爭議、資料刪除請求、真人反濫用及 MFA 需依實際營運補足。health endpoint 不是外部支付、SMTP 或物流可用性保證。

參考：[Express 正式環境安全建議](https://expressjs.com/en/advanced/best-practice-security/)、[Node SQLite API](https://nodejs.org/api/sqlite.html)。

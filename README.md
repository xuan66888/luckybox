# LUCKYBOX

**2026-09-09 正常部署版**：首頁入口為 `/`，包含真實登入、開池／審核、伺服器抽獎、收藏、出貨與管理後台。部署包不包含投資人展示入口或示範抽獎。首次上線請依 [正常版部署操作](docs/NORMAL_DEPLOY.md) 進行；本次實測結果見 [驗證紀錄](docs/evidence/normal-validation.log)。

這是從 `LUCKYBOX_MVP_V16_25_POOL_REVIEW_GATE.zip` 的前端原型改建的完整前後端專案。原始檔只有 HTML / CSS / JavaScript，沒有後端；核心版本已接入伺服器 API、SQLite、真實登入、權限、有限庫存抽獎、收藏、出貨與點數帳本。

**2026-09-08 Neon 視覺版**：在可部署核心版本上整合黑紫霓虹與黑金收藏卡介面，包括首頁主視覺、導覽、獎池卡片、抽獎詳情、開獎收藏卡、手機底部導覽及全站深色表單／後台。新增原創 Holo 游標與觸控反光，支援減少動態效果；後端與資料庫 migration 保持相同。詳見 [本次變更與驗證](docs/NEON_RELEASE.md)、[視覺系統及素材](docs/DESIGN_SYSTEM.md)。

預覽截圖中的「NEON VAULT / GOLDEN HOUR / FREE DROP」及收藏晶體是隔離測試資料，正式 seed 不會建立这些獎池或點數。首頁品牌盒子插畫是裝飾素材；真實商品圖片由創作者上傳。

**可部署不等於已完成所有付費營運整合。** 本版適合單台伺服器、單一應用實例的核心流程封測；付費抽獎、人工儲值預設關閉。自動信用卡付款、USDT 收款、現金提領、代理現金分潤、社群任務驗證尚未實作，不能只填入金鑰就啟用。完整差異見 [功能範圍](docs/FEATURES.md)。

**2026-09-11 初始機率調整**：獎品百分比固定顯示滿池初始機率，頁面不顯示各獎項的動態剩餘數量。詳見 [顯示規則與驗證範圍](docs/INITIAL_ODDS.md)。


## 技術與目錄

- Node.js **24 LTS**、TypeScript strict、Express 5、Zod、Helmet。
- Node 內建 SQLite：WAL、外鍵、STRICT tables、`BEGIN IMMEDIATE` 原子交易；沒有雲端 DB URL 需求。
- 原生 TypeScript 瀏覽器介面，esbuild 打包；敏感資料不存入 localStorage。
- scrypt 密碼雜湊、隨機不透明 Session、HttpOnly / SameSite cookie、CSRF token。
- sharp 實際解碼與重新編碼圖片；本機持久磁碟儲存。
- `src/` 原始碼、`public/` 靜態資產、`migrations/` SQL、`tests/` 測試、`dist/` 已建置版本、`docs/` 部署與操作說明。
- `reference/ORIGINAL_PROTOTYPE.zip` 是原始檔備份，**不由伺服器公開、不作為部署入口**。

## 本機執行

先安装 Node.js 24，確認 `node --version` 是 `v24.*`；Node 16 / 18 / 20 無法執行本專案的 `node:sqlite` 實作。

```sh
npm ci
cp .env.example .env
npm run build
npm run migrate
```

Windows PowerShell 複製環境變數範本請使用 `Copy-Item .env.example .env`。

在 `.env` 填入自己的 `ADMIN_EMAIL` 與隨機強密碼 `ADMIN_PASSWORD`（至少 12 字元），再執行：

```sh
npm run seed
npm run dev
```

開啟 `http://localhost:3000`。`seed` 只建立指定的官方管理員；不預載假會員、假商品、假點數或預設密碼。重跑 seed 不會重設既有密碼或將一般會員升級。建立成功後移除 `.env` 的 `ADMIN_PASSWORD`。

`npm run dev` 會先建置，監看前端與後端變更。需要测试点数時，可在**開發環境**設定 `DEV_INITIAL_POINTS=10000`，只對之後註冊的會員生效；正式環境若設定非零值會拒絕啟動。密碼重設未設定 SMTP 時，開發郵件存於 `data/dev-mail/`，不會在網頁顯示或寄出。

## 正式環境：建議 Docker Compose + HTTPS

準備一台 Linux 主機、Docker Engine + Compose、網域 DNS 與可持久保存的磁碟。將網域 A/AAAA 指向主機，開放 80/443；**不要**公開應用的 3000 埠。

1. 解壓本專案，複製 `.env.example` 為 `.env`。
2. 修改至少以下設定。`PUBLIC_ORIGIN` 不可含結尾 `/`；主網域必須一致。

```dotenv
NODE_ENV=production
PUBLIC_ORIGIN=https://your-domain.example
SITE_HOST=your-domain.example
ADMIN_EMAIL=your-admin-address@example.com
ADMIN_PASSWORD=replace-with-your-own-long-random-password
DEV_INITIAL_POINTS=0
ALLOW_PAID_DRAWS=false
MANUAL_TOPUPS_ENABLED=false
```

範例密碼文字不可直接使用；請自行產生。SMTP 按實際服務填入，未設定時正式站會關閉忘記密碼功能。

3. 建置、初始化與啟動：

```sh
docker compose build
docker compose run --rm app node dist/cli.js migrate
docker compose run --rm app node dist/cli.js seed
# 從 .env 移除 ADMIN_PASSWORD 後再啟動長期服務
docker compose up -d
docker compose logs --tail=100 app
curl -f https://your-domain.example/health/ready
```

Caddy 負責 HTTPS；SQLite、圖片在 `luckybox-data` 持久卷中，憑證使用獨立持久卷。**不可執行 `docker compose down -v`，否則會刪除資料卷。** 升級使用 `docker compose up -d --build`，保留資料卷。

本交付環境無 Docker daemon，因此 Dockerfile / Compose 是附帶部署設定，沒有宣稱已在 Docker 或你的公網域實際啟動。Node 正式產物、正式環境啟動與資料持久化已另行實測，見 [驗證報告](docs/VALIDATION.md)。

## 不使用 Docker

```sh
npm ci
npm run build
npm run migrate
npm run seed
npm prune --omit=dev
npm start
```

正式 `.env` 使用 `NODE_ENV=production`、`PUBLIC_ORIGIN=https://你的網域`、`HOST=127.0.0.1`、固定 `DATA_DIR` 的絕對路徑。以 systemd 等程序管理器運行；讓 Nginx/Caddy 反向代理到本機 3000 埠。恰有一層可信代理且應用埠只允許該代理連線時，才設 `TRUST_PROXY_HOPS=1`。使用程序管理器的正式工作目錄必須為本專案根目錄。

`npm start` 使用已建置的 `dist/`，不需要開發依賴。開發和正式資料必須使用不同 `DATA_DIR`。**SQLite 不可放在網路磁碟/NFS；不可用無狀態 serverless、不持久的容器磁碟或多台主機共用檔案。** 需要多實例時，先將交易層改為 PostgreSQL 等服務型資料庫並重做並行測試；本版沒有聲稱支援任意 DB URL。

## 驗證

```sh
npm run lint
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run smoke
npm audit --omit=dev
```

已有 Edge 時可設定 `PLAYWRIGHT_CHANNEL=msedge`；PowerShell 為 `$env:PLAYWRIGHT_CHANNEL='msedge'`。端對端測試與 smoke 會使用臨時資料庫，不寫入正式資料。`npm run smoke` 測試 production 啟動、cookie、重啟、備份，經本機 HTTP 直接檢查應用層；公網 TLS 仍需部署後確認。

## 首次操作

1. 一般會員註冊後只有玩家權限；由創作者中心申請開池權限。
2. 官方登入後在管理後台授權創作者。改角色會撤銷該會員所有現有登入。
3. 創作者建立免費池或點數池，填寫各獎品數量、兌點額、介紹與圖片；草稿不公開。
4. 送審會凍結「點數獎額 × 數量 + 實體獎兌點額 × 數量」準備金，點數不足會拒絕。
5. 官方核實商品與供應能力後核准。核准時固定獎品清單與抽獎順序承諾；再由創作者開放。
6. 玩家抽獎；實體獎進入收藏，可選擇兌點或出貨，不能兩者都做。
7. 創作者自行出貨；已核准官方代出貨的池由官方操作。玩家確認收貨。
8. 全部抽完、所有商品已兌點/收貨，且結算等待期到期後，申請官方覆核。核准會把收入扣除平台點數費及未使用準備金返還至創作者點數錢包；**不是現金匯款**。

官方帳戶不能參加抽獎，也不能核准自己的獎池、儲值或結算。官方開池須由另一位管理員審核；第一位管理員可在後台授權第二位管理員。

全新正式站的餘額為 0。若尚未啟用人工儲值，第一個免費池請使用實體獎品、將「兌點額」設為 0，不加入點數獎；這樣無需點數準備金即可送審、開池與出貨。需提供點數獎或兌點額時，創作者必須先經實際核款取得足夠準備金。

## 外部資源及目前限制

| 項目 | 是否必需 | 本版狀態 |
|---|---|---|
| Node 24 主機、持久磁碟 | 必需 | SQLite + 本地圖片，無需 DB URL |
| 網域、DNS、HTTPS | 正式部署必需 | 附 Caddy 設定，須自行提供網域 |
| SMTP 寄信帳號 | 啟用密碼重設所需 | SMTP_HOST/PORT/SECURE/USER/PASS/FROM 已接入 |
| 獨立備份空間與監控服務 | 營運必需 | 有備份指令、健康端點、JSON 日誌；須自行設定異地保存與告警 |
| 商品庫存、實際物流及客服 | 實體商品必需 | 出貨單、權限、追蹤號碼已實作；交寄、收貨爭議須人工處理 |
| 銀行收款或支付後台 | 啟用人工儲值所需 | 唯一付款參考碼 + 官方覆核；不內建匯率或自動收款 |
| S3 / R2 | 非必需 | 本版未接入；不得只填 S3 金鑰便宣称已串接 |
| 信用卡金流、USDT RPC、錢包私鑰 | 本版不使用 | 自動支付/鏈上確認/退款/提款尚待獨立開發與沙盒驗收；不要把私鑰放進前端 |
| 社群 OAuth、社群平台 API | 本版不使用 | 假社群驗證、追蹤奖励、代理现金分潤等展示流程已停用 |

預設免費池「每帳戶一次」，並非每真人一次；公開獎勵活動若需要防止多帳戶，仍須接入適用的身分驗證/反濫用服務。沒有宣稱 KYC/AML、現金帳務或合規審核已完成。

## 備份、更新與故障處理

```sh
npm run backup
# Docker：
docker compose exec app node dist/cli.js backup
```

使用 SQLite backup API 取得一致快照；不要在運行中只複製 `.sqlite` 而遺漏 WAL。備份資料庫**及 uploads 目錄**到另一處安全儲存。還原時先停止服務，保存現況，再用備份還原資料庫與圖片；移走舊 WAL/SHM，重新啟動並檢查健康端點、登入、收藏與出貨單。備份包含會員與收件資料，必須限制讀取。

更新前備份，先在獨立 staging 資料副本執行 migration 與 smoke，最後更新正式服務。SQL migration 是前進式、啟動時自動補齊；不提供危險的自動資料刪除/降版操作。

查看 `/health/live`、`/health/ready` 與 JSON 日誌中的 requestId/status/durationMs。 API 回應不回傳堆疊、密碼雜湊或種子；不要把 `.env`、`data/`、原始 ZIP 設成網頁根目錄。

更多細節：[功能範圍](docs/FEATURES.md) · [安全與 API](docs/SECURITY_AND_API.md) · [修復紀錄](docs/REPAIR_REPORT.md) · [驗證報告](docs/VALIDATION.md)。

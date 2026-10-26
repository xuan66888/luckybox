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

開啟 `http://localhost:3000`。完整部署、權限、安全、備份與限制說明見 `docs/`。

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

已有 Edge 時可設定 `PLAYWRIGHT_CHANNEL=msedge`；PowerShell 為 `$env:PLAYWRIGHT_CHANNEL='msedge'`。端對端測試與 smoke 會使用臨時資料庫，不寫入正式資料。

## 重要限制

官方帳戶不能參加抽獎，也不能核准自己的獎池、儲值或結算。官方開池須由另一位管理員審核；第一位管理員可在後台授權第二位管理員。

本版尚未實作自動信用卡付款、USDT 收款、現金提領、代理現金分潤或社群任務驗證；不應把任何私鑰或正式憑證提交到版本庫。

更多細節：[功能範圍](docs/FEATURES.md) · [安全與 API](docs/SECURITY_AND_API.md) · [修復紀錄](docs/REPAIR_REPORT.md) · [驗證報告](docs/VALIDATION.md)。

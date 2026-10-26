# 最終交付驗證報告

日期：2026-09-07。環境：Windows、Node.js 24.19.0、npm 11.19.1、headless Microsoft Edge。

## 已實際執行

最終依賴與程式碼複製到一個全新目錄，起始沒有 node_modules、dist、.env 或資料庫，重新完成以下操作：

| 檢查 | 結果 |
|---|---|
| 原始 app.js `node --check` | 通過；原始包本身沒有其他建置/測試腳本 |
| `npm ci` | 成功；最終版無前一輪過期 ESLint 警告 |
| `npm run lint` | 通過，0 lint error |
| `npm run typecheck` | TypeScript strict 通過 |
| `npm test` | **29 通過，0 失敗，0 跳過** |
| `npm run build` | 成功產出 production server、CLI、前端、migration |
| `npm run test:e2e` | **1 個完整桌面/手機流程通過**；瀏覽器 error 清單為空 |
| `npm run smoke` | production 設定下 migration、seed、啟動、登入 cookie、重啟、備份與還原檢查通過 |
| `npm audit` | 0 已知漏洞，包含開發依賴 |
| `npm prune --omit=dev` | 成功，僅保留正式依賴，0 已知漏洞 |
| 移除開發依賴後再 `npm run smoke` | 通過，證實正式執行不依賴 tsx / TypeScript 等開發工具 |
| `npm run dev` | 實際啟動；首頁、app.js、health/ready 皆 HTTP 200；測試後停止 |
| 直接執行常駐 `npm start` | **環境自動審核拒絕，僅回覆 blocked by policy，未列為通過** |

production smoke 實際以短暫子程序執行 `node dist/server.js`，使用 `NODE_ENV=production`、HTTPS PUBLIC_ORIGIN、獨立臨時資料目錄；測試完終止程序並清除測試資料。驗證了 Secure/HttpOnly/__Host cookie 與 HSTS header，但連線為本機 HTTP，**沒有冒充為已驗證公網 HTTPS 憑證或 Docker 部署**。

## 交易、權限及安全測試涵蓋

- 真實註冊、密碼雜湊、Session、登出、停用與角色變動撤銷登入。
- 拒絕註冊時注入 admin、越權管理、越權修改池、查看他人資料。
- Origin / CSRF / Content-Type / JSON 驗證、登入限流與 Retry-After。
- 未審核/未開放不可抽；創作者不能抽自己的池；官方不能抽。
- 凍結準備金、拒絕送審或取消後精確返還、點數不足完整 rollback。
- 同一 key 的並行重送只扣點與抽獎一次；改 body 重用 key 被拒絕。
- 兩位玩家搶最後一抽只有一位成功。
- **兩個獨立伺服器程序並行提交 20 次請求搶 7 張票：7 次成功、13 次 409，無超抽、無多扣點。** 這是並行正確性測試，不是容量或多主機部署認證。
- 免費池每帳戶一次；獎品有限、點數獎消耗已預存準備金。
- 種子在售罄前不回傳；售罄後可完整重建序列、核對 commitment/manifest。
- 介紹修改覆核、價格與獎品不可由介紹更新 API 偷改。
- 出貨/兌點競爭互斥、出貨單所有權、官方代出貨地址不對創作者公開。
- 完成商品履約與等待期之前禁止結算；結算不會重複入帳。
- 儲值只能由官方核實後入帳；付款參考碼唯一；已處理單不重複入帳。
- 假圖、SVG、超大圖/JSON、remote image URL、跨人圖片引用被拒絕。
- 密碼重設單次使用、過期 token 拒絕、舊 session 全撤銷。
- migration 重跑、另一資料庫連線讀取、SQLite integrity/foreign_key 檢查。
- ledger/audit append-only trigger；正式靜態路徑不提供 .env 或 src。

## 瀏覽器完整操作

創作者登入 → 建立免費池與實體獎 → 送審 → 官方登入核准 → 創作者開池 → 玩家抽獎 → 玩家兌點 → 另一手機尺寸玩家抽獎/申請出貨 → 創作者登記物流 → 玩家確認收貨 → 創作者申請結算 → 官方核准。

含介紹中的 `<img ... onerror=...>` 文字安全顯示、手機寬度不水平溢出、瀏覽器無 JavaScript/CSP/圖片錯誤。截圖是自動化測試資料，僅作为介面驗證，不會匯入部署資料庫。

## 尚未驗證或不屬於完成範圍

- 沒有 Docker daemon；Docker Compose、Caddy 公網 HTTPS、Linux 主機部署需在目標環境實測。
- 未提供 SMTP 憑證；開發郵件、token 流程已測，實際郵件投遞未測。
- 自動金流、USDT、法幣提款、退款拒付、代理分潤、社群 OAuth/任務驗證等尚未實作；不會因通過上述測試而變成可用。
- 未做持續高負載、獨立滲透測試、營运規則/法規審核、硬體故障演練或外部儲存 HA。
- 只支援單台主機與本機持久磁碟；固定清單上限及尚未開發項目見 FEATURES.md。

## 隨附證據

`docs/evidence/` 內保存最終 clean install/check/e2e/smoke、移除開發依賴後 smoke 與 audit JSON；`docs/screenshots/` 為桌面/手機測試截圖。

原始 ZIP SHA-256：`F2C5103E05B65A728ECB31C8812A34D4899E178378469F83F7FF8BA5734E7703`。

此報告的通過範圍是可重現檢查結果，不代表「所有未知錯誤已消失」或「全平台付費營運已驗收」。

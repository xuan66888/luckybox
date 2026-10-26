# LUCKYBOX Neon 視覺版本

2026-09-08。基於已交付的 `LUCKYBOX_DEPLOY_READY` 核心版本，整合黑紫霓虹 Cyberpunk × 黑金 Jackpot 視覺。

## 本次變更

- 首頁：原創黑紫開箱主視覺、真實庫存統計、探索操作及創作者入口。
- 導覽：品牌圖示、錢包入口、桌機主要導覽、手機首頁／免費抽／開池／收藏／我的五項底部導覽。平板保留帳戶入口；管理員可從手機「我的」進入管理後台。
- 獎池卡片：商品實圖、原創 Foil 光澤、庫存進度、價格、審核狀態；新增前端搜尋與篩選。熱門順序依真實已抽數，沒有新增假玩家、假收入或假成交統計。
- 抽獎詳情：金屬卡框、商品／認證／履約資訊、滿池初始機率與目前剩餘庫存、介紹圖片及抽獎承諾資料。
- 開獎結果：API 成功後的短過場、立即揭曉、可觸控拖曳的全息收藏卡、多抽排版與收藏入口。
- 全站統一深色表單、按鈕、彈窗、收藏及後台表格。鍵盤跳到主要內容、焦點標示、減少動態效果、手機安全區支援。

## 保留範圍

`src/app.ts`、`auth.ts`、`config.ts`、`db.ts`、`fairness.ts`、`server.ts`、`cli.ts` 與 `migrations/001_initial.sql` 保持基線內容。登入、角色／帳戶停用、獎池建立／送審／開池、抽獎原子交易、防重複請求、圖片上傳驗證、介紹覆核、官方代出貨、收藏兌點、出貨與點數結算邏輯不變。

前端沒有新增業務 API、localStorage 餘額或本地亂數結果。現有 API 呼叫及交易鍵機制保留。新增動畫只呈現已確認结果，沒有第二次扣點。

## 使用與部署

完整指令見專案根目錄 `README.md`。Node.js 24 安裝依賴、建置，設定 `.env` 後 migrate / seed，最後使用已建置 `dist/` 啟動。也附有 Docker Compose + Caddy 範本。

已存在的部署升級此版前，先备份資料庫及 uploads，保持原本 `.env` 與持久 `DATA_DIR`，更新程式及 `dist/public` 後重新啟動。此版沒有新 SQL migration，不需重新建立帳戶或匯入測試資料。

正式部署需自行提供主機、持久磁碟、網域／DNS／HTTPS；密碼重設須提供 SMTP。此核心版本使用 SQLite 與本機圖片，無 DB URL 或 S3 需求。自動信用卡／USDT／現金提領仍未實作；付費抽與人工儲值維持預設關閉。此次視覺更新不改變這些既有範圍。

## 驗證資料

全新目錄起始沒有 `node_modules`、`dist`、`.env` 或資料庫。使用 Node.js 24.19.0、npm 11.19.1 與 headless Microsoft Edge 完成：

| 檢查 | 結果 |
|---|---|
| 乾淨 `npm ci` | 通過 |
| lint / TypeScript strict | 通過 |
| 後端、權限與並行交易測試 | 29 通過，0 失敗，0 跳過 |
| production build | 通過 |
| 原有完整瀏覽器流程 + 新版視覺回歸 | 2 通過，0 失敗，0 跳過 |
| 瀏覽器尺寸 | 1440 / 820 / 390 / 320 px |
| 瀏覽器 runtime / CSP 問題 | 0 |
| production migration、seed、啟動、重啟及備份 smoke | 通過；新版 CSS、Holo、主視覺亦可正常讀取 |
| 移除開發依賴後再啟動 production smoke | 通過 |
| `npm audit` | 0 已知漏洞（含開發依賴）；只保留正式依賴後亦為 0 |
| 保留後端與資料庫 | 7 個後端檔案 + migration 逐位元一致；lockfile 一致 |

依賴稽核第一次遇到本機 Node 信任鏈錯誤，改用 Node 的 `--use-system-ca` 讀取作業系統既有受信任憑證後通過；全程保留 TLS 驗證。沒有改套件、忽略漏洞或停用憑證驗證。

此次乾淨環境重建紀錄存於 `docs/evidence/neon-clean-validation.log`；前端視覺測試範圍见 `VISUAL_QA_NOTES.md`。原始核心版的 `VALIDATION.md` 為 2026-09-07 的歷史驗證，日期與範圍不要混用。

預覽見 `docs/screenshots/neon/`。所有示例會員、點數和商品由隔離測試建立，測試結束即移除；正式 seed 只建立自行設定的管理員。

Docker daemon 與公網 DNS/TLS 沒有在本機交付環境實際部署；production 啟動以短暫程序執行正式 `dist/server.js`，檢查完成後關閉。未宣稱已正式對外營運。

# 視覺回歸驗證

`tests/visual.e2e.ts` 使用 Playwright 開啟正式建置的前端，連線到真實後端與暫存 SQLite 資料庫。測試過程會以既有 API 上傳測試圖片、建立獎池、送審、核准及開池。測試帳號、餘額、三個展示獎池及原創幾何圖片只存在於自動清除的暫存測試環境，不會加入正式 seed。

## 驗證範圍

- 桌面 1440 × 1000：深色背景、首頁獎池卡片、隨滑鼠位置更新的 Holo 光線與傾斜。
- 平板 820 × 1000：頂部帳戶按鈕可見且可進入帳戶頁，首頁沒有水平溢出。
- 鍵盤「跳到主要內容」將焦點移至內容區，首頁仍正常顯示。
- 手機 390 × 844：Bottom Navigation，以及首頁、免費抽、收藏、創作者中心與帳戶入口。
- 窄螢幕 320 × 740：首頁和一次三抽的結果卡片排列，以及三抽只扣除對應的 300 點；對話框可捲到底端進入收藏，確認先前的一件與三抽獎品共四件均已保存。
- 手機管理員可從帳戶頁進入管理後台。
- 首頁、抽獎對話框、結果及後台沒有整頁水平溢出。
- 系統設定「減少動態效果」時，停止持續性的裝飾動畫，仍可完成抽獎。
- 搜尋關鍵字與免費獎池篩選可正確隱藏／恢復卡片。
- 抽獎後手動揭曉，再進入收藏；確認只有一次抽獎 POST、資料庫只有一筆抽獎紀錄，且僅扣除一次 100 點。
- 瀏覽器沒有執行錯誤或 Content Security Policy 違規。

原有 `tests/browser.e2e.ts` 繼續覆蓋建立獎池、審核、開池、抽獎、兌點、出貨、收貨與結算的完整操作流程。視覺測試不取代既有後端安全及交易測試。

## 執行方式

先以 Node.js 24 安裝依賴並執行 `npm run build`。在已安裝 Playwright Chromium 的環境執行：

```sh
node --import tsx --test --test-concurrency=1 tests/visual.e2e.ts
```

也可設定 `PLAYWRIGHT_CHANNEL=msedge` 使用本機 Microsoft Edge。截圖輸出在 `test-results/neon-*.png`，涵蓋桌面／手機首頁、抽獎、開獎結果、手機收藏與手機管理後台。

這些檢查包含實際瀏覽器與資料庫驗證，不代表所有手機型號、實體觸控裝置或輔助技術都已人工測試。Holo 不讀取裝置陀螺儀，也不要求感測器權限。

## 本次執行結果（2026-09-08）

在 Windows、Node.js 24.19.0、無介面 Microsoft Edge 環境，最終擴充視覺場景通過：1 個場景、0 失敗、約 27.2 秒。上述桌面、平板、手機及窄螢幕斷言全部通過，瀏覽器執行錯誤與 CSP 違規均為 0。測試檔 ESLint 及整個專案 TypeScript 檢查亦通過。

已實際檢視首頁、抽獎內容、金色結果卡、收藏、管理後台及 320 px 三抽上下區域的截圖。未發現整頁水平溢出、操作按鈕不可達或卡片文字截斷。多抽結果以對話框內垂直捲動呈現，底部收藏按鈕可正常操作。此視覺回歸沒有修改既有後端、migrations 或原有端到端測試；API、auth、config、DB、抽獎公平性、server、CLI、第一版 migration 與原瀏覽器流程測試的 SHA-256 均與前一版一致。

共輸出 12 張截圖：

- `neon-home-desktop.png`
- `neon-home-tablet-820.png`
- `neon-home-mobile.png`
- `neon-home-mobile-320.png`
- `neon-draw-desktop.png`
- `neon-draw-mobile.png`
- `neon-result-desktop.png`
- `neon-result-mobile.png`
- `neon-result-mobile-multi-320.png`
- `neon-result-mobile-multi-bottom-320.png`
- `neon-collection-mobile.png`
- `neon-admin-mobile.png`

首頁與管理頁使用整頁截圖；抽獎／結果對話框使用實際視窗範圍截圖，避免瀏覽器全頁截圖把遮罩下方的背景頁面一併展示。

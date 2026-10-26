# 實際修復紀錄

## 原始盤點

原始壓縮檔：`LUCKYBOX_MVP_V16_25_POOL_REVIEW_GATE.zip`，68,918 bytes。

| 原始檔 | 大小 | 結果 |
|---|---:|---|
| app.js | 199,876 bytes | 約 2,590 行，`node --check` 通過；業務資料由 localStorage 管理 |
| style.css | 49,839 bytes | 前端樣式；保留並另加響應式修正 |
| index.html | 440 bytes | 靜態展示入口 |
| README.txt | 17,756 bytes | 原型版本歷史，自述「前端 localStorage Prototype」 |

沒有 package.json、後端 API、schema、migration、密碼/登入服務、測試或正式 build/start，因此原始版本的 lint/typecheck/tests/build/start 並非存在但通過，而是根本未提供。

## 可重現缺陷與修正

| 缺陷 | 原始位置/行為 | 修正 |
|---|---|---|
| 任意官方登入 | `officialLogin` 直接把 isAdmin 設 true | 移除部署入口，伺服器 Session + role |
| 假登入與假 KYC | login/socialLogin/upgradeKyc 不驗證身分 | 真實密碼登入；KYC 不宣稱完成，僅官方核驗申請 |
| 餘額可任改 | 整份 state 在 localStorage | SQL wallet + 不可直接改的業務 API + ledger |
| 假充值成功 | confirmTopup 直接加點數 | 預設關閉支付；人工登記 + 官方核實後唯一入帳 |
| 客戶端可決定結果 | 多處 Math.random、修改 state | 伺服器承諾種子、固定有限票券、原子抽出 |
| 庫存與帳務不同步 | 各處分別加減陣列/數值 | 資料庫交易、UNIQUE/CHECK、重複請求防護 |
| 固定驗證碼 | 初始池寫死 poolHash/commit | 核准時計算真 hash，附驗證工具 |
| 只有 UI 權限 | 按鈕/路由檢查 isAdmin | 每一 API 查 role、owner、履約單位與狀態 |
| 不可信內容拼 HTML | 使用者文字直接嵌入 template | 所有動態文字/屬性 escape + CSP |
| 圖片變成瀏覽器大字串 | base64/FileReader 存 state | 大小/像素/格式/ownership/配額控制 + 重編碼存檔 |
| 出貨資料全站共用 | 單一 Demo state | 會員資料隔離、創作者與官方不同出貨範圍 |
| 結算成功只是 alert | 固定 18,500 示意餘額 | 實際點數帳務、準備金、履約檢查、等待期與覆核 |
| 未完成能力偽裝可用 | 假社群、分潤、錢包、流量 | 從正式入口停用，reference 保存，FEATURES 明列待開發 |

## 修復時實際遇到的錯誤

- 本機預設 Node 16 與新後端不相容；改用可用的 Node 24.19.0，使用現代 npm 重裝及乾淨驗證。交付要求已固定 Node 24。
- TypeScript 反映 SQLite 動態 row 推導與 scrypt callback 型別問題，已修正；strict typecheck 通過。SQL row 仍為動態型別，不能把此項描述為 schema 全靜態驗證；業務輸入使用 Zod、資料庫使用約束、流程使用整合測試。
- 初始依賴稽核發現 nodemailer/sharp 已知漏洞，更新至 nodemailer 10.0.0、sharp 0.35.4，重新稽核無已知漏洞。
- 瀏覽器測試找出手機版導覽被舊 CSS 隱藏，補上顯示規則。
- 瀏覽器測試找出 HTML pattern 與新瀏覽器 v 正則模式不相容，移除錯誤 client pattern，保留長度驗證與伺服器嚴格格式驗證。
- 補 favicon，避免正常開頁 404。
- 補上表單內非提交按鈕的 type=button、阻止上傳未完成提交、錯誤訊息、重複按鈕鎖定及頁面導覽捲動復位。

本報告沒有宣稱找出所有未知錯誤。可交付證據是實際修改後的程式、可重跑的測試與正式啟動結果；未接入服務及營運邊界已明列。

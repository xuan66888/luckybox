# 本機版本與上線依賴

## 本機已實作
- 同一個響應式網站：320/360/390/430/768/1280 寬度與橫向版面測試；不必另做手機網站。實機 Safari／Android、鍵盤與付款返回仍需上線前驗收。
- 每抽必中：新建只允許實體獎／正值點數獎。舊含空籤獎池禁止送審、核准、開池和抽獎，歷史資料保留。每池最多 100 個物品，機率獨立設定、版本檢查、庫存不足／全零權重不扣款。
- Google OAuth 程式串接：PKCE、nonce、一次性 state、瀏覽器綁定；現有同 Email 不自動合併，須登入後綁定。Google 不提供管理員密碼／MFA 的替代入口。
- Email 驗證、Twilio Verify 簡訊驗證、Turnstile 伺服器驗證。缺憑證不會顯示假成功；本機驗證信存 DATA_DIR/dev-mail，不是真的寄信。
- 管理員 TOTP／一次性復原碼，秘密 AES-256-GCM 加密；兩種密碼登入入口都驗證 MFA，管理資料只允許 admin。
- VIP 依正式付款淨額：草案 0／1,000／5,000／20,000 元，僅徽章、不改中獎率。測試金流／贈點不計；已完成退款扣除。
- 邀請：雙方信箱與手機驗證、新會員七天內綁定、首筆正式付款達 100 元；邀請人 50 點、新會員 20 點，每月十人。拒絕自邀、互邀及重複手機。仍需營運反作弊審查。
- 任務：信箱 10 點、手機 20 點、首次抽獎 10 點、每日簽到 1 點。伺服器判定條件、限領一次／每天一次。
- 後台修改 VIP、任務、邀請、公告與每日贈點上限（預設 1,000 點）。**所有活動贈點與邀請活動預設關閉**，開啟會真的發點。
- LIVE 使用真實抽獎資料、遮罩暱稱，15 秒輪詢；不製造假流水，支援暫停與減少動態效果。付款／獎勵站內通知。
- 儲值 1 元 1 點，簽章回調入帳及去重；會員退款申請、管理員人工退刷登記與帳本核對。只有未消費的全額訂單可自動扣回點數；涉及消費、邀請回收、部分退款必須人工處理。**本站未執行金流退款 API**。

## 你需要申請／準備
1. 網域、單一常駐伺服器（Node 24／SQLite 本機持久磁碟）、DNS／HTTPS；使用者網址與 /admin/ 分離，日後可限制管理域名或 VPN。伺服器不能用短生命週期無狀態函數直接跑 SQLite。
2. Google Cloud OAuth「網頁應用程式」Client ID／Secret。正式 redirect URI：`https://你的網域/auth/google/callback`。本機測試則填 `http://127.0.0.1:3000/auth/google/callback`。
3. 寄信服務（SMTP／交易郵件）與自己的寄件網域，設定 SPF／DKIM／DMARC；填 SMTP_HOST/PORT/USER/PASS/FROM。
4. Twilio Verify 帳號、服務 SID、Auth Token、台灣目的地發送許可及費用額度。也可另做台灣簡訊商 adapter，不能只換一把 API key。
5. Cloudflare Turnstile Site Key／Secret Key 和允許網域。
6. 綠界正式商店與此點數／抽獎商業模式的書面核准、正式 MerchantID／HashKey／HashIV。沒有核准、公開 HTTPS 通知地址與一次真實小額收款／退刷驗收，**不可開正式收款**。
7. 營業／客服資料、實際庫存、物流履約、退貨退款及消費條款、個資與第三方資料傳輸政策。這些需由營運及適用法律專業人士確認；每抽必中不等於自動合法。
8. 獨立加密備份空間、監控告警收件人、永久 AUTH_SECRET 與每位管理員的驗證器 App；不要將密鑰貼在聊天或 GitHub。

## 部署與驗收
- 憑證填伺服器環境變數，參考 `.env.example`。先保持 ECPAY_ENABLED=false、ALLOW_PAID_DRAWS=false、活動贈點=false。不得把本機測試帳密、資料庫與 dev-mail 放進正式站。
- 每位管理員先在「服務與安全」設定 TOTP 並離線保存復原碼，再啟用 ADMIN_MFA_REQUIRED=true。備份 AUTH_SECRET；遺失此鑰不能解密既有 TOTP。
- `node scripts/backup-restore.mjs`：一致性 DB 備份＋不可變上傳檔案，雜湊核對及隔離還原／完整性檢查。不會覆蓋運行資料庫。正式備份須另存主機外並定期實際演練。
- `node scripts/health-check.mjs`：存活／DB 就緒檢查，失敗 exit 非零；由選定的監控服務定時執行及告警。沒有伺服器前不宣稱已部署監控。
- 本機自動測試只能驗證程式和 mock provider adapter；正式 Google 授權、真實郵件／簡訊送達、Turnstile 真票、綠界真實付款與退款均待憑證和網域驗收。
- 付費點與贈點在帳本分種類，但尚無逐筆消費來源分攤；因此退款採保守人工流程，不能宣稱完整自動財務／退款系統。
- 原始設計／歷史驗證文件保留作追溯；若其「空籤」描述與本文件衝突，以本次每抽必中版本及測試為準。

## 官方參考
- Google：https://developers.google.com/identity/sign-in/web/backend-auth
- Twilio：https://www.twilio.com/docs/verify/api/verification 、 https://www.twilio.com/docs/verify/api/verification-check
- Turnstile：https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

## 尚不能替你完成的上線事項
供應商帳號申請／付款、商店或法律核准、未選定主機的部署、真機／正式外部流程驗收、實際物流與客服營運。PWA、LINE／Apple／原生 App 是選配，不是手機適配的必要條件。本次不是「已可直接收錢的正式站」。

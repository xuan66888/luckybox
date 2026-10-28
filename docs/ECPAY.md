# 綠界串接（2026-10-27）

本次新增信用卡一次付清儲值：NT$1＝1點、每單1～20000元。卡號由綠界付款頁收集，本站不處理卡號。
只完成本機串接與自動測試，不代表正式商家審核、外部回呼或收款已完成。

## 本機測試

Node 24、npm ci、npm run build；複製 .env.example 為 .env。
使用獨立 DATA_DIR=./data-ecpay-stage，NODE_ENV=development，
ECPAY_ENABLED=true，ECPAY_MODE=stage，保留範例中的官方公開測試 MerchantID/HashKey/HashIV。
初次使用 migrate、seed，再 npm start。註冊一般玩家，點數錢包會出現「綠界信用卡儲值」。
首次登入官方不會有玩家點數；使用另外的玩家帳戶測試。

建單 API 受到登入、Origin、CSRF、限流、Idempotency-Key 保護；金額與1:1點數在伺服器鎖定。
前端把已簽章表單以 POST 送到綠界 AioCheckOut/V5，不使用 iframe、不將 HashKey/HashIV 傳入前端。
手機或第三方瀏覽器返回後按「重新查詢付款與餘額」，不根據瀏覽器返回參數增加點數。

外部綠界伺服器無法回呼 localhost；沒有公開 HTTPS 測試站之前，只能做本機簽章/通知模擬測試。
不得為測試而暴露正式資料、原始管理頁或正式資料庫。使用 staging 主機與隔離測試資料。
部署後 ReturnURL 固定為 PUBLIC_ORIGIN/payments/ecpay/notify，需要可由公網以443連入。

## 已有防護

- 有效 SHA256 CheckMacValue；核對 MerchantID、商家訂單、綠界交易號、金額及訂單環境。
- 非成功、偽簽章、金額錯誤不入帳；SimulatePaid=1 一律忽略，不會增加點數。
- 同一訂單與成功通知重送只入帳一次；ledger 寫入與訂單更新是同一 SQLite 交易。
- stage 不允許使用 production 模式資料庫；正式設定不允許使用公用測試特店號。
- 正式付款、人工儲值與付費抽獎各有獨立開關，本次不自動開啟。
- 真實卡號與正式金鑰不進入 Git；.env 必須保密。

## 正式啟用前仍必需

1. 網域、固定 HTTPS 主機及正式持久資料／備份。完成實際公網回呼、重送與對帳驗收。
2. 在綠界廠商後台確認網站 API 串接資格與正式 MerchantID/HashKey/HashIV。
   ECShop 已能收款，不等於自建網站 API、第三方創作者代收、儲值／抽獎型態已被核准。
   必須如實揭露實際商品與業務型態取得綠界確認，不可把抽獎改名一般商品來繞過審核。
3. 合規與金流審查通過後，將 ECPAY_MODE=production、ECPAY_LIVE_APPROVED=true，
   使用自己的正式金鑰，NODE_ENV=production、PUBLIC_ORIGIN=https://正式網域。
4. 人工對帳與退款/拒付處理、客服和會計流程仍要建立；本次不自動退款、不替創作者匯款。
   本版沒有自動查單補單排程；通知遺漏時先由後台核對，不可憑玩家聲稱付款就補點。

## API

- GET /api/payments/config：非敏感功能與1:1比例。
- POST /api/payments/ecpay：{amount:100}，回傳簽章表單（不含金鑰）。
- GET /api/me/payments：只看本人的最近100筆。
- POST /payments/ecpay/notify：只接受 form-urlencoded 綠界驗簽通知；成功處理回應精確 1|OK。

## 官方規格

- 建單：https://developers.ecpay.com.tw/2862/
- 簽章與獨立測試向量：https://developers.ecpay.com.tw/2902/
- 通知：https://developers.ecpay.com.tw/2878/
- 公開測試憑證：https://developers.ecpay.com.tw/2856/
- 交易管理規章：https://support.ecpay.com.tw/10130/

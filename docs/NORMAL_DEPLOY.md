# 正常部署版：首次上線

本版提供實際帳戶、獎池審核、伺服器抽獎、點數帳本、收藏、出貨與後台。入口是網站根目錄 `/`。投資人展示頁不在此部署包中；全新資料庫不包含測試會員、點數、商品或預設管理員密碼。

## 準備

- 一台 Node.js 24 主機或支援 Docker Compose 的 Linux 主機，以及本機持久磁碟。本版使用 SQLite 與本地圖片，部署為單一應用實例。
- 網域、DNS 與 HTTPS；網域指向主機，開放 80、443，應用的 3000 埠不直接對外公開。
- 自己的管理員信箱及至少 12 字元的隨機強密碼。
- 啟用忘記密碼時另準備 SMTP；持久資料與 uploads 應定期備份到獨立空間。

目前不需要 DB URL、S3 或錢包私鑰。自動信用卡、電子支付、USDT、現金提款與社群登入尚未實作，不能只填金鑰就啟用。

## 部署指令

解壓 ZIP，在專案根目錄複製 `.env.example` 為 `.env`，修改以下欄位：

```dotenv
NODE_ENV=production
PUBLIC_ORIGIN=https://your-domain.example
SITE_HOST=your-domain.example
ADMIN_EMAIL=your-own-email@example.com
ADMIN_PASSWORD=replace-with-your-own-random-strong-password
DEV_INITIAL_POINTS=0
ALLOW_REGISTRATION=true
ALLOW_PAID_DRAWS=false
MANUAL_TOPUPS_ENABLED=false
```

使用自己的網域、信箱與密碼，範例不可照抄。設定 SMTP 時使用 `.env.example` 已列出的欄位。

```sh
docker compose build
docker compose run --rm app node dist/cli.js migrate
docker compose run --rm app node dist/cli.js seed
```

確認管理員建立後，從 `.env` 移除 `ADMIN_PASSWORD`，再啟動：

```sh
docker compose up -d
docker compose logs --tail=100 app
curl -f https://your-domain.example/health/ready
```

Caddy 會處理 HTTPS。SQLite 和圖片使用 `luckybox-data` 持久卷；更新前備份，不執行會刪除資料卷的 `docker compose down -v`。

不用 Docker 時，安裝 Node.js 24，執行 `npm ci`、`npm run build`、`npm run migrate`、`npm run seed`，移除環境中的 seed 密碼，再 `npm prune --omit=dev`、`npm start`。使用程序管理器維持服務，固定 `DATA_DIR` 絕對路徑，並設置 HTTPS 反向代理。完整代理與備份說明見 README。

## 第一次使用

1. 用自己設定的管理員登入。另註冊開池者與玩家帳戶，不使用開發測試帳密。
2. 開池者在創作者中心提出申請，管理員授予創作者權限。角色變更後重新登入。
3. 未接金流時先建立免費池：實體獎品的兌點額設為 0，不放點數獎。全新帳戶零餘額，任何點數獎或兌點額都需要相應準備金。
4. 上傳商品與介紹圖，送審；官方確認後核准，由創作者開池。
5. 玩家抽獎，結果保存至收藏；申請出貨，創作者或官方登記物流，玩家確認收貨。創作者不能抽自己的池，能參與其他創作者的池。

## 需要收款時

現有實作為人工核款儲值：經營者在網站以外提供自己的收款方式及點數兌換規則，玩家提交唯一付款參考碼與點數申請，另一個官方帳戶實際核對到帳後核准，才會加點。玩家填入參考碼本身不等於付款成功。

使用這個流程前，須準備可核對的商家收款管道，確認營運規則，設定 `MANUAL_TOPUPS_ENABLED=true`。只有在確定啟用收費獎池時才設定 `ALLOW_PAID_DRAWS=true`；更改後重新建立應用容器。官方不能核准自己的儲值單。自動收款通知、退款／拒付、現金結算仍需另行串接與驗收。

## 更新與驗證範圍

舊資料庫不需重置，本次沒有新增 migration。不要把本機預覽資料或測試 fixture 上傳至正式站。建置會清除並重建專案自身的 `dist`，移除舊版生成的展示資產；正式更新建議使用新目錄／容器建置，保留持久資料卷。

本次實測包含乾淨安裝、lint、typecheck、全部後端及瀏覽器測試、production 啟動、health、重啟與備份。Docker／公網 HTTPS 是否能在你的主機上運作，仍需在實際主機驗收；此次沒有替你購買主機、網域或開通金流。

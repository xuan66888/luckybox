# LuckyBox Neon 視覺系統

## 視覺方向

深黑背景、紫色主要操作、低強度粉紫反射、金色收藏卡。首頁與玩家頁偏向精品收藏展示；管理表格、驗證與出貨表單沿用相同配色並優先保留可讀性。

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#090811` | 全站底色 |
| `--surface` | `#12101d` | 面板底色 |
| `--ink` | `#f3efff` | 主要文字 |
| `--muted` | `#a59eb7` | 說明文字 |
| `--brand` | `#a475ff` | 紫色操作及焦點 |
| `--gold` | `#ecc786` | 收藏與開獎細節 |

字體使用系統本地字型（Segoe UI / Noto Sans TC / Microsoft JhengHei 等），數字及少量英文編號用等寬字體；沒有外部字型追蹤或 CDN 依賴。桌機寬版三欄、平板兩欄，手機兩欄收藏卡；手機導覽固定在安全區上方。表格以自身容器水平捲動，保留完整操作。

## 原創 Holo 元件

`src/holo.ts` 的 `installHoloInteractions()` 只需安裝一次，透過事件委派支援重新渲染的 DOM。將 `data-holo="foil|rainbow|gold|quiet"` 放在 `.cardArt` 或收藏結果卡上，再載入 `public/holo.css`。

- 游標位置驅動局部光源、反光漸層與最大約 4° / 6° 傾斜。
- 觸控橫向拖曳支援傾斜；保留垂直捲動與雙指縮放。結束、取消或離開後復原。
- 使用 requestAnimationFrame 整合更新；不訂閱裝置陀螺儀，也不索取額外權限。
- 系統開啟減少動態效果時，停用傾斜與開箱過場，直接顯示結果；鍵盤仍有可見焦點。
- 光澤樣式使用原創 CSS 漸層、混合模式和偽元素。`data-holo` 會占用該元素的 `::before` / `::after` 及 transform，卡框另以子元素處理。
- 嚴格 CSP 保持不變，沒有 `unsafe-inline`、外部腳本或內嵌事件 handler。

金色／彩虹材質屬於視覺呈現，不是新的稀有度或機率。沒有把獎品擅自標示為 SSR、UR 或保證中獎。各獎項顯示 API 回傳的名稱、種類與結果。百分比固定以獎项初始數量 / 滿池總抽數計算，明確標為「滿池初始機率」；目前剩餘數量另外顯示，包含剩餘 0 份。

## 開獎呈現

只有抽獎 API 成功且回傳結果，才開始約 1.1 秒的開箱動畫。「立即揭曉」只顯示記憶體中的既有結果，不會再呼叫抽獎或扣點 API。關閉視窗會取消計時器，避免關閉後再次彈出；收藏與抽獎紀錄仍由伺服器保存。

## 素材來源

- `public/assets/luckybox-hero.png`：2026-09-08 以 OpenAI ImageGen 生成的原創品牌概念圖，1536 × 1024 PNG；約 1.9 MB，隨網站本地部署。生成後直接保存，未經二次影像編輯。
- `public/favicon.svg`、`src/visual.ts` 內所有圖示：本次手寫 SVG 幾何圖形。
- 商品預覽中的晶體：測試用原創幾何 SVG 轉 PNG，僅存於端對端測試的臨時資料庫及截圖；沒有放入正式 seed。
- 参考網站：<https://poke-holo.simey.me/>、<https://github.com/simeydotme/pokemon-cards-css>、<https://poke-151.simey.me/>。本次從效果概念重新實作，未复制其程式碼、紋理或 Pokémon 圖像。

ImageGen 原始提示詞：

```text
Use case: stylized-concept. Asset type: high-end website hero artwork for an original collectible blind-box brand LUCKYBOX. Generate a cinematic premium 3D render, wide landscape 1536x1024. A levitating open obsidian metallic mystery cube with precision-cut beveled corners and a subtle geometric diamond insignia, dramatic amethyst light pouring from the lid, three floating abstract holographic collectible cards rising from it, one slim gold-edged foil card catching warm champagne reflections. Sleek cyberpunk luxury product photography, highly believable brushed black metal, glossy smoked acrylic and iridescent foil. A very thin luminous violet orbital ring around the cube and sparse tiny gold particles. Deep near-black midnight violet studio background (#090811), absolutely dark clean edges blending into a website background. Composition: main cube right-of-center occupying the right 65%, at a dynamic three-quarter angle with generous empty dark negative space on left 25%; object fully visible not cropped. Lighting: amethyst and electric magenta rim lights, restrained champagne-gold specular highlights, crisp premium rendering. No readable text, no numbers, no Pokémon or other recognizable characters, no brand logos, no watermark, no UI elements, no fake interface; this is decorative brand art, not an actual prize or a screenshot. Sophisticated, impactful, not cartoonish, no casino slots or playing card symbols.
```

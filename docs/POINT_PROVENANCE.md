# 點數來源分攤基礎（未部署，完整上市目標仍進行中）

- 每筆正值帳本事件建立一筆來源lot。正式金流、活動／獎項、人工調點、測試金流、其他及歷史未知來源分開。人工點數不會變成已付款。
- 扣點採依入點時間／插入順序FIFO，逐lot記錄不可覆寫的allocation；指定來源扣點不可挪用其他來源。每筆異動須同時更新餘額、帳本、lots及allocation；失敗全部回復。
- 舊帳戶保留既有餘額，標成legacy，不推測其儲值訂單來源、不重複入帳。來源總額不符帳戶餘額時拒絕新的異動，不能自動補平。
- 本人GET /api/me/wallet可查來源分類；後台GET /api/admin/reconciliation可核對帳戶餘額／帳本／來源。這不是銀行對帳，也不自動修數字。
- 仍待完成：退款先凍結來源、拒絕退回、分次／部分退款、邀請贈點回收及退刷受理到完成的狀態機。現有保守退款流程尚未被替代；不得宣稱完整財務系統或開啟正式金流。

## Lifecycle extension
Refund holds, exact-source releases, partial/cumulative manual settlements and referral qualification reversals are now implemented; see REFUND_LIFECYCLE.md. External bank/API acceptance remains pending and loss exceptions default off.

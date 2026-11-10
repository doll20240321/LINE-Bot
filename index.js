const express = require("express");
const line = require("@line/bot-sdk");
const { Pool } = require("pg");

// 從 Railway 的環境變數取得資料庫連線資訊。
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

const app = express();

// 用戶的點餐進度先暫存在這個 Map 裡。
// 這只是測試用：Railway 重啟後，尚未完成的訂單會消失。
const orderSessions = new Map();
const CANCELLATION_LIMIT_MINUTES = 30;

// LINE 用這個 Secret 驗證 webhook 請求。
const config = {
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// 這個 client 負責呼叫 LINE API 回覆訊息。
const lineClient = line.LineBotClient.fromChannelAccessToken({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// 宣告名叫「replyText」的函式：把要回覆的文字和可選按鈕，組成LINEapi的訊息格式並送出。
function replyText(replyToken, text, choices) {
    const message = {
        type: "text",
        text: text,
    };

    if (choices && choices.length > 0) {
        message.quickReply = {
            items: choices.map((choice) => ({
                type: "action",
                action: {
                    type: "message",
                    label: choice,
                    text: choice,
                },
            })),
        };
    }

    return lineClient.replyMessage({
        replyToken: replyToken,
        messages: [message],
    });
}
// 傳送 LINE 內建的日期時間選擇按鈕。
// 算出台灣時間的最早可取餐時間。
function getTaipeiMinimumTime(minimumMinutes) {
    const taipeiTime =
        Date.now() +
        minimumMinutes * 60 * 1000 +
        8 * 60 * 60 * 1000;

    // 日期選擇器需要 YYYY-MM-DDTHH:mm 格式。
    return new Date(taipeiTime).toISOString().slice(0, 16);
}

// 傳送 LINE 內建的日期時間選擇按鈕。
function replyWithPickupPicker(
    replyToken,
    minimumMinutes,
    prompt = "請選擇取餐日期和時間："
) {
    return lineClient.replyMessage({
        replyToken,
        messages: [
            {
                type: "text",
                text: prompt,
                quickReply: {
                    items: [
                        {
                            type: "action",
                            action: {
                                type: "datetimepicker",
                                label: "選取日期時間",
                                data: "action=choosePickupTime",
                                mode: "datetime",
                                min: getTaipeiMinimumTime(minimumMinutes),
                            },
                        },
                    ],
                },
            },
        ],
    });
}

function createCartSummary(order) {
    const itemLines = order.items.map((item) => {
        const itemTotal = item.unitPrice * item.quantity;

        return `${item.itemName} x ${item.quantity}：${itemTotal} 元`;
    });

    return (
        "目前暫存訂單：\n" +
        itemLines.join("\n") +
        `\n目前總金額：${order.total} 元\n` +
        "要繼續選餐點，還是確認訂單？"
    );
}

// 選完取餐時間後，整理訂單摘要。
function createOrderSummary(order) {
    order.step = "confirm";

    const itemLines = order.items.map((item) => {
        const itemTotal = item.unitPrice * item.quantity;

        return `${item.itemName} x ${item.quantity}：${itemTotal} 元`;
    });

    return (
        "訂單摘要\n" +
        itemLines.join("\n") +
        `\n取餐時間：${order.pickupAt.slice(0, 16).replace("T", " ")}\n` +
        `總金額：${order.total} 元\n` +
        "請確認這筆訂單："
    );
}

// 一般瀏覽器測試用。
app.get("/", (req, res) => {
    res.send("嗨，express正常運作中");
});
async function handleEvent(event) {
    const userId = event.source && event.source.userId;

    if (!userId) {
        return null;
    }

    let order = orderSessions.get(userId);

    // 日期時間選擇器回傳的是 postback 事件。
    if (
        event.type === "postback" &&
        event.postback.data === "action=choosePickupTime"
    ) {
        const selectedDateTime = event.postback.params.datetime;

        if (!order || order.step !== "pickupTime") {
            return null;
        }

        const minimumMinutes = order.quantity >= 3 ? 60 : 30;
        const selectedTime = new Date(`${selectedDateTime}+08:00`).getTime();
        const earliestAllowedTime =
            Date.now() + minimumMinutes * 60 * 1000;

        if (selectedTime < earliestAllowedTime) {
            return replyWithPickupPicker(
                event.replyToken,
                minimumMinutes,
                `這個數量需要至少提前 ${minimumMinutes} 分鐘預訂，請選更晚的時間。`
            );
        }

        // LINE 回傳的選擇沒有時區；這裡先依台灣時間（UTC+8）記錄。
        order.pickupAt = `${selectedDateTime}+08:00`;

        return replyText(
            event.replyToken,
            createOrderSummary(order),
            ["確認訂單", "取消訂單"]
        );
    }

    // 其他不是文字訊息的事件先略過。
    if (event.type !== "message" || event.message.type !== "text") {
        return null;
    }

    const text = event.message.text.trim();

    // 不管客人走到哪個點餐步驟，都先檢查是否要取消。
    if (text === "取消訂單") {
        // 若還在點餐途中，只取消 Map 裡的草稿。
        if (order) {
            orderSessions.delete(userId);
            return replyText(event.replyToken, "已取消目前這筆點餐。");
        }

        try {
            // 找出這位客人最近一筆已確認的訂單。
            const result = await pool.query(
                `SELECT id, pickup_at
             FROM orders
             WHERE line_user_id = $1 AND status = $2
             ORDER BY ordered_at DESC
             LIMIT 1`,
                [userId, "待處理訂單"]
            );

            const savedOrder = result.rows[0];

            if (!savedOrder) {
                return replyText(event.replyToken, "目前找不到已確認的訂單。");
            }

            const timeUntilPickup =
                new Date(savedOrder.pickup_at).getTime() - Date.now();

            // 少於 30 分鐘就不允許由機器人取消。
            if (timeUntilPickup < CANCELLATION_LIMIT_MINUTES * 60 * 1000) {
                return replyText(
                    event.replyToken,
                    "距離取餐時間不足 30 分鐘，請直接聯絡店家取消。"
                );
            }

            // 將訂單標記為已取消，保留歷史紀錄。
            await pool.query(
                `UPDATE orders
             SET status = $1
             WHERE id = $2 AND status = $3`,
                ["訂單已取消", savedOrder.id, "待處理訂單"]
            );

            return replyText(event.replyToken, "已取消這筆訂單。");
        } catch (error) {
            console.error("取消訂單時發生錯誤：", error);
            return replyText(event.replyToken, "目前無法取消訂單，請稍後再試。");
        }
    }

    // 客人輸入說明時，列出目前可以使用的指令。
    if (text === "說明" || text === "幫助") {
        return replyText(
            event.replyToken,
            "目前可用指令：\n" +
            "「我要點餐」：開始點餐\n" +
            "「取消訂單」：取消點餐；已確認訂單須在取餐前 30 分鐘以上取消\n" +
            "目前測試品項：原味蛋餅35元、乳酪絲蛋餅60元、泰式打拋豬肉炒飯90元、泰式酸辣豬肉炒飯90元"
        );
    }

    // 還沒開始點餐時，輸入「我要點餐」就開始。
    // 還沒開始點餐時，輸入「我要點餐」就開始。
    if (!order) {
        if (text === "我要點餐" || text === "點餐") {
            // 先建立一筆尚未選好餐點的草稿，從選大類別開始。
            order = {
                step: "category",
                items: [], // 暫存客人選過的餐點
                quantity: 0, // 所有餐點的總份數
                total: 0, // 所有餐點的總金額
            };

            orderSessions.set(userId, order);

            return replyText(
                event.replyToken,
                "請先選擇餐點類別：",
                ["蛋餅", "炒飯"]
            );
        }

        return replyText(
            event.replyToken,
            "我還不認識這個指令。輸入「說明」查看用法。"
        );
    }
    // 客人選好了大類別，接著列出這一類的品項。
    if (order.step === "category") {
        const choicesByCategory = {
            "蛋餅": ["原味蛋餅", "乳酪絲蛋餅"],
            "炒飯": ["泰式打拋豬肉炒飯", "泰式酸辣豬肉炒飯"],
        };

        if (!choicesByCategory[text]) {
            return replyText(
                event.replyToken,
                "請選擇餐點類別：",
                ["蛋餅", "炒飯"]
            );
        }

        order.category = text;
        order.step = "meal";

        return replyText(
            event.replyToken,
            `請選擇${order.category}品項：`,
            choicesByCategory[order.category]
        );
    }

    // 客人選好了品項，記下名稱和價格，再請客人選份數。
    if (order.step === "meal") {
        const menu = {
            "蛋餅": {
                "原味蛋餅": 35,
                "乳酪絲蛋餅": 60,
            },
            "炒飯": {
                "泰式打拋豬肉炒飯": 90,
                "泰式酸辣豬肉炒飯": 90,
            },
        };

        const categoryMenu = menu[order.category];
        const unitPrice = categoryMenu && categoryMenu[text];

        if (!unitPrice) {
            return replyText(
                event.replyToken,
                "請選擇下方的餐點品項：",
                Object.keys(categoryMenu)
            );
        }

        order.itemName = text;
        order.unitPrice = unitPrice;
        order.step = "quantity";

        return replyText(
            event.replyToken,
            `你選的是「${order.itemName}」，一份 ${order.unitPrice} 元。請選擇份數：`,
            ["1份", "2份", "3份"]
        );
    }

    // 客人選好份數後，把餐點放進暫存清單。
    if (order.step === "quantity") {
        const quantities = {
            "1份": 1,
            "2份": 2,
            "3份": 3,
        };

        if (!quantities[text]) {
            return replyText(
                event.replyToken,
                "請用下方按鈕選擇數量：",
                ["1份", "2份", "3份"]
            );
        }

        const selectedQuantity = quantities[text];

        // 如果清單已有同一道餐點，就增加份數；否則新增餐點。
        const existingItem = order.items.find(
            (item) => item.itemName === order.itemName
        );

        if (existingItem) {
            existingItem.quantity += selectedQuantity;
        } else {
            order.items.push({
                itemName: order.itemName,
                unitPrice: order.unitPrice,
                quantity: selectedQuantity,
            });
        }

        // 從清單重新計算總份數與總金額。
        order.quantity = order.items.reduce(
            (sum, item) => sum + item.quantity,
            0
        );

        order.total = order.items.reduce(
            (sum, item) => sum + item.unitPrice * item.quantity,
            0
        );

        order.step = "cartReview";

        return replyText(
            event.replyToken,
            createCartSummary(order),
            ["繼續選擇餐點", "確認訂單"]
        );
    }

    const selectedQuantity = quantities[text];

    // 找看看購物清單裡是否已經有同一道餐點。
    const existingItem = order.items.find(
        (item) => item.itemName === order.itemName
    );

    if (existingItem) {
        // 已經選過：把這次的份數加上去。
        existingItem.quantity += selectedQuantity;
    } else {
        // 第一次選：新增一筆餐點資料。
        order.items.push({
            itemName: order.itemName,
            unitPrice: order.unitPrice,
            quantity: selectedQuantity,
        });
    }

    // 重新計算所有餐點的總份數與總金額。
    order.quantity = order.items.reduce(
        (sum, item) => sum + item.quantity,
        0
    );

    order.total = order.items.reduce(
        (sum, item) => sum + item.unitPrice * item.quantity,
        0
    );

    order.step = "cartReview";

    return replyText(
        event.replyToken,
        createCartSummary(order),
        ["繼續選擇餐點", "確認訂單"]
    );
}

// 目前正在等客人選數量。
if (order.step === "quantity") {
    const quantities = {
        "1份": 1,
        "2份": 2,
        "3份": 3,
    };

    if (!quantities[text]) {
        return replyText(
            event.replyToken,
            "請用下方按鈕選擇數量：",
            ["1份", "2份", "3份"]
        );
    }

    order.quantity = quantities[text];
    order.total = order.quantity * order.unitPrice;
    order.step = "pickupTime";

    const minimumMinutes = order.quantity >= 3 ? 60 : 30;
    return replyWithPickupPicker(event.replyToken, minimumMinutes);
}

// 客人檢查目前的購物清單。
if (order.step === "cartReview") {
    if (text === "繼續選擇餐點") {
        // 回到選大類別，讓客人再選一道餐點。
        order.step = "category";

        return replyText(
            event.replyToken,
            "請再選擇一個餐點類別：",
            ["蛋餅", "炒飯"]
        );
    }

    if (text === "確認訂單") {
        // 購物清單確認後，才開始選取餐時間。
        order.step = "pickupTime";

        const minimumMinutes = order.quantity >= 3 ? 60 : 30;

        return replyWithPickupPicker(
            event.replyToken,
            minimumMinutes
        );
    }

    // 客人輸入其他文字時，再顯示清單和按鈕。
    return replyText(
        event.replyToken,
        createCartSummary(order),
        ["繼續選擇餐點", "確認訂單"]
    );
}

// 目前正在等客人選取餐時間。
// 等待日期時間選擇時，若客人傳了文字，就再顯示選擇器。
if (order.step === "pickupTime") {
    const minimumMinutes = order.quantity >= 3 ? 60 : 30;
    return replyWithPickupPicker(event.replyToken, minimumMinutes);
}

// 客人確認或取消測試訂單。
if (order.step === "confirm") {
    if (text === "確認訂單") {

        const orderItemsText = order.items
            .map((item) => `${item.itemName} x ${item.quantity}`)
            .join("、");

        try {
            await pool.query(
                `INSERT INTO orders
        (line_user_id, pickup_at, item_name, quantity, total_amount, deposit_amount, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    userId,             // $1
                    order.pickupAt,     // $2
                    orderItemsText,     // $3
                    order.quantity,     // $4
                    order.total,        // $5
                    0,                  // $6
                    "待處理訂單",       // $7
                ]
            );

            orderSessions.delete(userId);

            return replyText(
                event.replyToken,
                "訂單已確認並記錄！目前這個版本還不會真的收款。"
            );
        } catch (error) {
            console.error("儲存訂單時發生錯誤：", error);

            return replyText(
                event.replyToken,
                "訂單暫時無法保存，請稍後再試。"
            );
        }
    }

    if (text === "取消訂單") {
        orderSessions.delete(userId);

        return replyText(event.replyToken, "已取消這筆測試訂單。");
    }

    return replyText(
        event.replyToken,
        "請選擇確認或取消：",
        ["確認訂單", "取消訂單"]
    );
}

return null;

// LINE 會用 POST 把 webhook 事件送到 /webhook。
// middleware 先驗證請求；通過後，才交給 handleEvent 處理。
app.post("/webhook", line.middleware(config), async (req, res) => {
    try {
        const results = await Promise.all(
            req.body.events.map((event) => handleEvent(event))
        );

        // 告訴 LINE：這批 webhook 事件已經收到。
        res.status(200).json(results);
    } catch (error) {
        console.error("處理 LINE webhook 時發生錯誤：", error);
        res.sendStatus(500);
    }
});

const PORT = process.env.PORT || 3000;

async function createOrdersTable() {
    // 如果 orders 表還不存在，就建立它。
    await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            line_user_id TEXT NOT NULL,
            ordered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            pickup_at TIMESTAMPTZ NOT NULL,
            item_name TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            total_amount INTEGER NOT NULL,
            deposit_amount INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT '待處理訂單'
        )
    `);
}

// 先確認資料表建立成功，再讓伺服器開始接收訊息。
createOrdersTable()
    .then(() => {
        console.log("訂單資料表已準備好");

        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    })
    .catch((error) => {
        console.error("建立訂單資料表時發生錯誤：", error);
        process.exit(1);
    });

console.log("LINE Bot 運作中");
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

// LINE 用這個 Secret 驗證 webhook 請求。
const config = {
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// 這個 client 負責呼叫 LINE API 回覆訊息。
const lineClient = line.LineBotClient.fromChannelAccessToken({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// 回傳文字；有提供選項時，也把快速回覆按鈕附上。
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
async function replyWithPickupPicker(replyToken) {
    return lineClient.replyMessage({
        replyToken,
        messages: [
            {
                type: "text",
                text: "請選擇取餐日期和時間：",
                quickReply: {
                    items: [
                        {
                            type: "action",
                            action: {
                                type: "datetimepicker",
                                label: "選取日期時間",
                                data: "action=choosePickupTime",
                                mode: "datetime",
                            },
                        },
                    ],
                },
            },
        ],
    });
}

// 選完取餐時間後，整理訂單摘要。
function createOrderSummary(order) {
    order.deposit =
        order.total >= 300 ? Math.ceil(order.total / 2) : 0;

    order.step = "confirm";

    const depositText =
        order.deposit > 0
            ? `訂金：${order.deposit} 元（測試版只計算，不會收款）`
            : "訂金：0 元";

    return (
        `訂單摘要\n` +
        `${order.itemName} x ${order.quantity}\n` +
        `取餐時間：${order.pickupAt.slice(0, 16).replace("T", " ")}\n` +
        `總金額：${order.total} 元\n` +
        `${depositText}\n` +
        "請確認這筆測試訂單："
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
    // 刪除這位客人目前暫存的點餐進度。
    orderSessions.delete(userId);

    return replyText(event.replyToken, "已取消目前這筆點餐。");
}

    // 還沒開始點餐時，輸入「我要點餐」就開始。
    if (!order) {
        if (text === "我要點餐" || text === "點餐") {
            order = {
                step: "quantity",
                itemName: "測試便當",
                unitPrice: 150,
            };

            orderSessions.set(userId, order);

            return replyText(
                event.replyToken,
                "今天的測試餐點是「測試便當」，一份 150 元。請選數量：",
                ["1份", "2份", "3份"]
            );
        }

        // 尚未進入點餐流程時，維持原本的回音功能。
        return replyText(event.replyToken, text);
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

        return await replyWithPickupPicker(event.replyToken);
    }

    // 目前正在等客人選取餐時間。
    // 等待日期時間選擇時，若客人傳了文字，就再顯示選擇器。
if (order.step === "pickupTime") {
    return replyWithPickupPicker(event.replyToken);
}

    // 客人確認或取消測試訂單。
    if (order.step === "confirm") {
        if (text === "確認訂單") {
            orderSessions.delete(userId);

            return replyText(
                event.replyToken,
                "測試訂單流程完成！目前這版不會真的收款，也不會把訂單保存給店家。"
            );
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

    return null};

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
            status TEXT NOT NULL DEFAULT 'confirmed'
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
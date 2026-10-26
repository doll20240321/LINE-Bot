const express = require("express");
const line = require("@line/bot-sdk");

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

// 一般瀏覽器測試用。
app.get("/", (req, res) => {
    res.send("嗨，express正常運作中");
});

// 處理 LINE 送來的每個事件。
async function handleEvent(event) {
    // 目前只處理文字訊息，其他事件先略過。
    if (event.type !== "message" || event.message.type !== "text") {
        return null;
    }

    const userId = event.source && event.source.userId;

    // 測試流程先處理一對一聊天；沒有使用者 ID 的事件先略過。
    if (!userId) {
        return null;
    }

    const text = event.message.text.trim();
    let order = orderSessions.get(userId);

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

        return replyText(
            event.replyToken,
            "請選擇取餐時間：",
            ["12:00", "12:30", "13:00"]
        );
    }

    // 目前正在等客人選取餐時間。
    if (order.step === "pickupTime") {
        const pickupTimes = ["12:00", "12:30", "13:00"];

        if (!pickupTimes.includes(text)) {
            return replyText(
                event.replyToken,
                "請用下方按鈕選擇取餐時間：",
                pickupTimes
            );
        }

        order.pickupTime = text;

        // 滿 300 元收一半；有半元時無條件進位。
        order.deposit =
            order.total >= 300 ? Math.ceil(order.total / 2) : 0;

        order.step = "confirm";

        const depositText =
            order.deposit > 0
                ? `訂金：${order.deposit} 元（測試版只計算，不會收款）`
                : "訂金：0 元";

        const summary =
            `訂單摘要\n` +
            `${order.itemName} x ${order.quantity}\n` +
            `取餐時間：${order.pickupTime}\n` +
            `總金額：${order.total} 元\n` +
            `${depositText}\n` +
            "請確認這筆測試訂單：";

        return replyText(
            event.replyToken,
            summary,
            ["確認訂單", "取消訂單"]
        );
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

    return null;
}

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

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

console.log("LINE Bot 運作中");
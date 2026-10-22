const express = require("express");
const line = require("@line/bot-sdk");

const app = express();

// LINE 用這個 secret 確認 webhook 請求真的是 LINE 傳來的
const config = {
    channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// 這個 client 負責呼叫 LINE API 回覆訊息
const lineClient =
    line.LineBotClient.fromchannelAccessToken({
        channelAccessToken:
            process.env.LINE_CHANNEL_ACCESS_TOKEN,
    })

// 保留，一般瀏覽器測試用
app.get("/", (req, res) => {
    res.send("嗨，express正常運作中");
});

// LINE 會把 webhook 事件用 POST 送到這條路由
// middleware 會驗證簽章，並把 LINE 傳來的內容整理進 req.body
app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
    // 這裡的req.body.events是一個陣列，裡面可能有多個事件
    // LINE 一次可能送來多個事件，所以逐一處理
    try {
        const results = await Promise.all(
            req.body.events.map((event) => {
                // 目前只回覆文字訊息，其他事件先略過
            if (event.type !== "message" ||
                event.message.type !== "text") {
                    return Promise. resolve(null);
                }
                // 把收到的文字原樣傳回給使用者
                return lineClient.replyMessage({
                    replyToken: event.reply.Token,
                    messages: [
                        {
                            type: "text",
                            text: event.message.text,
                        },
                    ],
                });
            })
        );

         // 告訴 LINE：webhook 事件已收到並處理
         res.status(200).json(results);
    } catch (error) {
        console.error("回覆LINE訊息時發生錯誤！", error);
        res.sendStatus(500);
    }
         });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

console.log("LINE Bot 運作中");
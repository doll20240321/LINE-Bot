const express = require("express");
const app = express();

app.get("/", (req, res) => {
    res.send("嗨，express正常運作中");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT,() => {
    console.log(`Server is running on port ${PORT}`);
});

console.log("LINE Bot 運作中");

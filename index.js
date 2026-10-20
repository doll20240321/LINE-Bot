const express = require("express");
const app = express();

app.get("/", (req, res) => {
    res.send("嗨，express正常運作中");
});

console.log("LINE Bot 運作中");

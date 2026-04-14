const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// 駐車データを保存するメモリ（変数）
let parkingData = {};

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);

  const userId = event.source.userId;
  const text = event.message.text;
  const now = new Date();

  let replyText = '';

  if (text === '駐車開始') {
    parkingData[userId] = now;
    replyText = `駐車を開始しました！\n開始時刻: ${now.toLocaleTimeString('ja-JP')}`;
  } else if (text === '今の料金' || text === '駐車終了') {
    const startTime = parkingData[userId];
    if (!startTime) {
      replyText = '駐車データが見つかりません。「駐車開始」と送ってください。';
    } else {
      const diffMs = now - startTime;
      const diffMins = Math.ceil(diffMs / (1000 * 60));
      // 例: 30分100円の計算
      const price = Math.ceil(diffMins / 30) * 100;
      
      if (text === '今の料金') {
        replyText = `経過時間: ${diffMins}分\n現在の料金: ${price}円です。`;
      } else {
        delete parkingData[userId];
        replyText = `駐車を終了しました。\n合計時間: ${diffMins}分\nお疲れ様でした！`;
      }
    }
  } else {
    replyText = '「駐車開始」「今の料金」「駐車終了」のいずれかを送ってください。';
  }

  return client.replyMessage(event.replyToken, { type: 'text', text: replyText });
}

module.exports = app;
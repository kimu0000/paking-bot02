require('dotenv').config(); // これで.envを読み込みます
const express = require('express');
const line = require('@line/bot-sdk');

const config = {
  // process.env.XXX で、.envの中身を安全に呼び出します
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

const parkingData = {};

const RATE_PER_UNIT = 100;
const UNIT_MINUTES = 30;
const MAX_CHARGE = 1000;

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return null;

  const userId = event.source.userId;
  const text = event.message.text;

  if (text === '駐車開始') {
    parkingData[userId] = new Date();
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `計測を開始しました！\n開始時刻: ${parkingData[userId].toLocaleTimeString('ja-JP')}`
    });
  }

  if (text === '今の料金') {
    const startTime = parkingData[userId];
    if (!startTime) {
      return client.replyMessage(event.replyToken, { type: 'text', text: '計測が開始されていません。' });
    }

    const now = new Date();
    const diffMs = now - startTime;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    
    let charge = Math.ceil(diffMins / UNIT_MINUTES) * RATE_PER_UNIT;
    if (charge > MAX_CHARGE) charge = MAX_CHARGE;

    const nextIncrement = UNIT_MINUTES - (diffMins % UNIT_MINUTES);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `経過時間: ${diffMins}分\n現在の料金: ${charge}円\nあと${nextIncrement}分で次の加算が発生します。`
    });
  }

  if (text === '駐車終了') {
    delete parkingData[userId];
    return client.replyMessage(event.replyToken, { type: 'text', text: '計測を終了しました。' });
  }
}

// CodespacesやVercelで動くようにポート設定を柔軟に
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
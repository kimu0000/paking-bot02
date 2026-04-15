const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// ユーザーデータ保存（※本番はDB推奨）
let parkingData = {};

// =========================
// 料金計算
// =========================
function calculatePrice(data, now) {
  if (!data.startTime) return 0;

  const diffMs = now - new Date(data.startTime);
  let diffMins = Math.ceil(diffMs / (1000 * 60));

  // 無料時間
  if (diffMins <= data.freeMinutes) return 0;
  diffMins -= data.freeMinutes;

  let unitMinutes;

  if (data.unitType === 'hour') {
    unitMinutes = data.unitValue * 60;
  } else {
    unitMinutes = data.unitValue;
  }

  let price = Math.ceil(diffMins / unitMinutes) * data.ratePerUnit;

  if (data.maxPrice && price > data.maxPrice) {
    price = data.maxPrice;
  }

  return price;
}

// =========================
// メイン処理
// =========================
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const events = req.body.events;

  try {
    await Promise.all(events.map(handleEvent));
    res.status(200).send('OK');
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
};

// =========================
// イベント処理
// =========================
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text = event.message.text;

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
  );

  let replyText = '';

  // =========================
  // 料金設定
  // =========================
  if (text.startsWith('設定')) {
    const parts = text.split(' ');

    // 設定 分 30 100 800 0
    // 設定 時間 1 100 500 0
    if (parts.length < 6) {
      replyText =
        '設定方法:\n設定 [分/時間] [単位] [円] [最大料金] [無料分]\n\n例:\n設定 分 30 100 800 0\n設定 時間 1 100 500 0';
    } else {
      const [, type, unitValue, rate, maxPrice, freeMinutes] = parts;

      const unitType = type === '時間' ? 'hour' : 'minute';

      parkingData[userId] = {
        ...parkingData[userId],
        unitType,
        unitValue: Number(unitValue),
        ratePerUnit: Number(rate),
        maxPrice: Number(maxPrice),
        freeMinutes: Number(freeMinutes),
      };

      replyText =
        `✅ 設定完了\n` +
        `${unitValue}${type}ごとに${rate}円\n` +
        `最大${maxPrice}円\n無料${freeMinutes}分`;
    }
  }

  // =========================
  // 駐車開始
  // =========================
  else if (text === '駐車開始') {
    if (!parkingData[userId]?.ratePerUnit) {
      replyText = '先に料金設定してください\n例: 設定 分 30 100 800 0';
    } else {
      parkingData[userId].startTime = now;
      parkingData[userId].lastNotifiedPrice = 0;
      parkingData[userId].notifiedMax = false;

      replyText = `🚗 駐車開始\n${now.toLocaleTimeString('ja-JP')}`;
    }
  }

  // =========================
  // 現在料金 or 終了
  // =========================
  else if (text === '今の料金' || text === '駐車終了') {
    const data = parkingData[userId];

    if (!data || !data.startTime) {
      replyText = '駐車データがありません。「駐車開始」と送ってください。';
    } else {
      const price = calculatePrice(data, now);

      const diffMs = now - new Date(data.startTime);
      const diffMins = Math.ceil(diffMs / (1000 * 60));

      if (text === '今の料金') {
        replyText =
          `⏱ 経過: ${diffMins}分\n` +
          `💰 料金: ${price}円`;
      } else {
        delete parkingData[userId];

        replyText =
          `🏁 駐車終了\n` +
          `⏱ 合計: ${diffMins}分\n` +
          `💰 料金: ${price}円\n` +
          `お疲れ様でした！`;
      }
    }
  }

  // =========================
  // その他
  // =========================
  else {
    replyText =
      '使い方:\n' +
      '① 設定\n例: 設定 分 30 100 800 0\n\n' +
      '② 駐車開始\n' +
      '③ 今の料金\n' +
      '④ 駐車終了';
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

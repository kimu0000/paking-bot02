const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

let parkingData = {};

// =========================
// 全角→半角
// =========================
function normalizeText(text) {
  return text
    .replace(/[０-９]/g, s =>
      String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
    )
    .replace(/　/g, ' ');
}

// =========================
// Flexボタン（大きくて見やすい）
// =========================
function sendMainMenu(replyToken, text) {
  return client.replyMessage(replyToken, {
    type: 'flex',
    altText: 'メニュー',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'lg',
        contents: [
          { type: 'text', text: text, weight: 'bold', size: 'lg' },

          {
            type: 'button',
            style: 'primary',
            color: '#06C755',
            action: { type: 'message', label: '設定開始', text: '開始' }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#007BFF',
            action: { type: 'message', label: '駐車開始', text: '駐車開始' }
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'message', label: '現在の料金', text: '今の料金' }
          },
          {
            type: 'button',
            style: 'secondary',
            action: { type: 'message', label: '駐車終了', text: '駐車終了' }
          }
        ]
      }
    }
  });
}

// =========================
// 料金計算（24h最大）
// =========================
function calculatePrice(data, now) {
  const start = new Date(data.startTime);
  const diffMs = now - start;

  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const minutesPerDay = 1440;

  const days = Math.floor(totalMinutes / minutesPerDay);
  let remainingMinutes = totalMinutes % minutesPerDay;

  let unitMinutes =
    data.unitType === 'hour'
      ? data.unitValue * 60
      : data.unitValue;

  let totalPrice = 0;

  if (data.maxPrice) {
    totalPrice += days * data.maxPrice;
  }

  if (remainingMinutes <= data.freeMinutes) {
    return totalPrice;
  }

  remainingMinutes -= data.freeMinutes;

  let remainingPrice =
    Math.ceil(remainingMinutes / unitMinutes) * data.ratePerUnit;

  if (data.maxPrice && remainingPrice > data.maxPrice) {
    remainingPrice = data.maxPrice;
  }

  totalPrice += remainingPrice;

  return totalPrice;
}

// =========================
// メイン
// =========================
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send();

  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).send('OK');
  } catch (e) {
    console.error(e);
    res.status(500).end();
  }
};

// =========================
// イベント処理
// =========================
async function handleEvent(event) {
  if (event.type !== 'message') return;

  const userId = event.source.userId;
  let text = normalizeText(event.message.text);

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
  );

  if (!parkingData[userId]) {
    parkingData[userId] = { step: null, temp: {} };
  }

  // =========================
  // 初期メニュー
  // =========================
  if (text === 'メニュー') {
    return sendMainMenu(event.replyToken, '操作を選択してください');
  }

  // =========================
  // 設定開始（ボタン）
  // =========================
  if (text === '開始') {
    parkingData[userId] = { step: 'unitType', temp: {} };

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '単位は？（分 or 時間）',
    });
  }

  // =========================
  // ステップ入力
  // =========================
  if (parkingData[userId].step) {
    const state = parkingData[userId];

    switch (state.step) {

      case 'unitType':
        state.temp.unitType = text === '時間' ? 'hour' : 'minute';
        state.step = 'unitValue';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '何分（何時間）ごと？（数字）',
        });

      case 'unitValue':
        state.temp.unitValue = Number(text);
        state.step = 'rate';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '料金は？（円）',
        });

      case 'rate':
        state.temp.ratePerUnit = Number(text);
        state.step = 'max';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '24時間最大料金は？（なし or 数字）',
        });

      case 'max':
        state.temp.maxPrice =
          text === 'なし' ? null : Number(text);
        state.step = 'free';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '無料時間は？（分・数字）',
        });

      case 'free':
        state.temp.freeMinutes = Number(text);

        parkingData[userId] = {
          ...state.temp,
        };

        return sendMainMenu(event.replyToken, '✅ 設定完了');
    }
  }

  // =========================
  // 駐車開始
  // =========================
  if (text === '駐車開始') {
    const data = parkingData[userId];

    if (!data.ratePerUnit) {
      return sendMainMenu(event.replyToken, '先に設定してください');
    }

    data.startTime = now;

    return sendMainMenu(
      event.replyToken,
      `🚗 駐車開始\n${now.toLocaleTimeString('ja-JP')}`
    );
  }

  // =========================
  // 現在料金
  // =========================
  if (text === '今の料金') {
    const data = parkingData[userId];

    if (!data.startTime) {
      return sendMainMenu(event.replyToken, '駐車開始してください');
    }

    const price = calculatePrice(data, now);

    return sendMainMenu(
      event.replyToken,
      `💰 現在 ${price}円`
    );
  }

  // =========================
  // 駐車終了
  // =========================
  if (text === '駐車終了') {
    const data = parkingData[userId];

    if (!data.startTime) {
      return sendMainMenu(event.replyToken, '駐車開始してください');
    }

    const price = calculatePrice(data, now);

    const start = new Date(data.startTime)
      .toLocaleTimeString('ja-JP');
    const end = now.toLocaleTimeString('ja-JP');

    delete parkingData[userId];

    return sendMainMenu(
      event.replyToken,
      `🏁 駐車時間 ${start}〜${end}\n💰 ${price}円`
    );
  }

  return sendMainMenu(event.replyToken, 'メニューから選択してください');
}

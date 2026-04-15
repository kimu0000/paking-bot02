const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// =========================
// 仮データ
// =========================
let parkingData = {};

// =========================
// 安全数値変換
// =========================
function toNumberSafe(val) {
  const num = Number(val);
  return isNaN(num) ? null : num;
}

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
// メニューUI（ボタン）
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
          { type: 'text', text, weight: 'bold', size: 'lg' },

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
// 料金計算（24h最大対応）
// =========================
function calculatePrice(data, now) {
  if (!data?.startTime || !data?.unitValue || !data?.ratePerUnit) return 0;

  const start = new Date(data.startTime);
  const diffMs = now - start;

  if (diffMs <= 0) return 0;

  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const minutesPerDay = 1440;

  const days = Math.floor(totalMinutes / minutesPerDay);
  let remainingMinutes = totalMinutes % minutesPerDay;

  let unitMinutes =
    data.unitType === 'hour'
      ? data.unitValue * 60
      : data.unitValue;

  if (!unitMinutes || unitMinutes <= 0) return 0;

  let totalPrice = 0;

  // 1日最大
  if (data.maxPrice) {
    totalPrice += days * data.maxPrice;
  }

  // 無料時間
  const free = data.freeMinutes || 0;
  if (remainingMinutes <= free) return totalPrice;

  remainingMinutes -= free;

  let remainingPrice =
    Math.ceil(remainingMinutes / unitMinutes) * data.ratePerUnit;

  if (data.maxPrice && remainingPrice > data.maxPrice) {
    remainingPrice = data.maxPrice;
  }

  totalPrice += remainingPrice;

  return Math.max(0, Math.floor(totalPrice));
}

// =========================
// メイン処理
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
// イベント
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
  // メニュー
  // =========================
  if (text === 'メニュー') {
    return sendMainMenu(event.replyToken, 'メニュー');
  }

  // =========================
  // 設定開始
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
          text: '単位の数値は？（例：30）',
        });

      case 'unitValue': {
        const num = toNumberSafe(text);
        if (num === null || num <= 0) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '数字で入力してください🙏',
          });
        }
        state.temp.unitValue = num;
        state.step = 'rate';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '料金は？',
        });
      }

      case 'rate': {
        const num = toNumberSafe(text);
        if (num === null || num < 0) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '数字で入力してください🙏',
          });
        }
        state.temp.ratePerUnit = num;
        state.step = 'max';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '24時間最大料金（なし or 数字）',
        });
      }

      case 'max':
        state.temp.maxPrice =
          text === 'なし' ? null : toNumberSafe(text);

        if (text !== 'なし' && state.temp.maxPrice === null) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '「なし」か数字で入力してください🙏',
          });
        }

        state.step = 'free';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '無料時間（分）',
        });

      case 'free': {
        const num = toNumberSafe(text);
        if (num === null || num < 0) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '数字で入力してください🙏',
          });
        }

        state.temp.freeMinutes = num;

        parkingData[userId] = { ...state.temp };

        return sendMainMenu(event.replyToken, '設定完了');
      }
    }
  }

  // =========================
  // 駐車開始
  // =========================
  if (text === '駐車開始') {
    const data = parkingData[userId];

    if (!data?.ratePerUnit) {
      return sendMainMenu(event.replyToken, '先に設定してください');
    }

    data.startTime = now;

    return sendMainMenu(
      event.replyToken,
      `駐車開始\n${now.toLocaleTimeString('ja-JP')}`
    );
  }

  // =========================
  // 現在料金
  // =========================
  if (text === '今の料金') {
    const data = parkingData[userId];

    if (!data?.startTime) {
      return sendMainMenu(event.replyToken, '駐車開始してください');
    }

    const price = calculatePrice(data, now);

    return sendMainMenu(
      event.replyToken,
      `現在 ${price}円`
    );
  }

  // =========================
  // 駐車終了（テキスト表示分離）
  // =========================
  if (text === '駐車終了') {
    const data = parkingData[userId];

    if (!data?.startTime) {
      return sendMainMenu(event.replyToken, '駐車開始してください');
    }

    const price = calculatePrice(data, now);

    const start = new Date(data.startTime).toLocaleTimeString('ja-JP');
    const end = now.toLocaleTimeString('ja-JP');

    delete parkingData[userId];

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text:
        `駐車終了\n` +
        `駐車時間：${start}〜${end}\n` +
        `駐車料金：${price}円`,
    });
  }

  return sendMainMenu(event.replyToken, 'メニューから選択');
}

const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// =========================
// データ保存（簡易版）
// =========================
let parkingData = {};
let notifyTimers = {};

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
// 安全数値変換
// =========================
function toNumberSafe(val) {
  const num = Number(val);
  return isNaN(num) ? null : num;
}

// =========================
// 友だち追加メッセージ
// =========================
function sendWelcome(event) {
  return client.replyMessage(event.replyToken, [
    {
      type: 'text',
      text:
        '🚗 駐車料金自動計算Botです\n\n' +
        '▼できること\n' +
        '・駐車料金の自動計算\n' +
        '・24時間最大料金対応\n' +
        '・リアルタイム料金確認\n\n' +
        '👇「設定開始」を押してください'
    },
    {
      type: 'flex',
      altText: '開始',
      contents: {
        type: 'bubble',
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'button',
              style: 'primary',
              color: '#06C755',
              action: {
                type: 'message',
                label: '設定開始',
                text: '開始'
              }
            }
          ]
        }
      }
    }
  ]);
}

// =========================
// メニューUI
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
// 料金計算
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

  if (data.maxPrice) {
    totalPrice += days * data.maxPrice;
  }

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
// 通知機能（5分前＋無料終了）
// =========================
function scheduleNotify(userId, data) {
  const freeMs = (data.freeMinutes || 0) * 60 * 1000;
  if (!freeMs || freeMs <= 0) return;

  // 5分前通知
  const warnMs = freeMs - 5 * 60 * 1000;

  if (notifyTimers[userId]) {
    clearTimeout(notifyTimers[userId].warn);
    clearTimeout(notifyTimers[userId].end);
  }

  notifyTimers[userId] = {};

  if (warnMs > 0) {
    notifyTimers[userId].warn = setTimeout(() => {
      client.pushMessage(userId, {
        type: 'text',
        text: '⚠️ あと5分で無料時間が終了します（課金が発生します）',
      });
    }, warnMs);
  }

  notifyTimers[userId].end = setTimeout(() => {
    client.pushMessage(userId, {
      type: 'text',
      text: '💰 無料時間が終了しました（ここから課金開始）',
    });
  }, freeMs);
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
  if (event.type === 'follow') {
    return sendWelcome(event);
  }

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
  // ステップ
  // =========================
  if (parkingData[userId].step) {
    const state = parkingData[userId];

    switch (state.step) {

      case 'unitType':
        if (text === '分') state.temp.unitType = 'minute';
        else if (text === '時間') state.temp.unitType = 'hour';
        else {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '「分」か「時間」を選んでください',
          });
        }

        state.step = 'unitValue';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '単位の数値は？',
        });

      case 'unitValue': {
        const num = toNumberSafe(text);
        if (num === null || num <= 0) {
          return client.replyMessage(event.replyToken, {
            type: 'text',
            text: '数字で入力してください',
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
            text: '数字で入力してください',
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
            text: '数字で入力してください',
          });
        }

        state.temp.freeMinutes = num;
        parkingData[userId] = { ...state.temp };

        return client.replyMessage(event.replyToken, [
          {
            type: 'text',
            text:
              '✅ 設定完了しました\n「駐車開始」を押してください'
          },
          {
            type: 'flex',
            altText: '開始',
            contents: {
              type: 'bubble',
              body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                  {
                    type: 'button',
                    style: 'primary',
                    color: '#007BFF',
                    action: {
                      type: 'message',
                      label: '駐車開始',
                      text: '駐車開始'
                    }
                  }
                ]
              }
            }
          }
        ]);
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

    scheduleNotify(userId, data);

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

    return sendMainMenu(event.replyToken, `現在 ${price}円`);
  }

  // =========================
  // 駐車終了
  // =========================
  if (text === '駐車終了') {
    const data = parkingData[userId];

    if (notifyTimers[userId]) {
      clearTimeout(notifyTimers[userId].warn);
      clearTimeout(notifyTimers[userId].end);
      delete notifyTimers[userId];
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

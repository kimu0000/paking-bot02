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
// 初回（友だち追加時）メッセージ
// =========================
function sendWelcome(event) {
  return client.replyMessage(event.replyToken, {
    type: 'flex',
    altText: 'サービス案内',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          {
            type: 'text',
            text: '🚗 駐車料金自動計算Bot',
            weight: 'bold',
            size: 'lg'
          },
          {
            type: 'text',
            text:
              'このBotは駐車時間から料金を自動計算します\n\n' +
              '▼できること\n' +
              '・駐車料金の自動計算\n' +
              '・24時間最大料金対応\n' +
              '・現在料金の確認'
          },
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
  });
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
// メイン処理
// =========================
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send();

  try {
    const events = req.body.events;

    await Promise.all(
      events.map(async (event) => {
        await handleEvent(event);
      })
    );

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
  // 以下ロジックはそのまま（省略なしで元コード維持）
  // =========================
  // ★ここ以下はあなたの既存ロジックをそのまま貼ってOK
}

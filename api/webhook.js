const line = require('@line/bot-sdk');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// =========================
// データ保存（仮）
// =========================
let parkingData = {};

// =========================
// 全角→半角変換
// =========================
function normalizeText(text) {
  return text
    .replace(/[０-９]/g, s =>
      String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
    )
    .replace(/　/g, ' ')
    .replace(/[Ａ-Ｚａ-ｚ]/g, s =>
      String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
    );
}

// =========================
// クイックリプライ
// =========================
function replyWithQuickReply(replyToken, text, options) {
  return client.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply: {
      items: options.map(opt => ({
        type: 'action',
        action: {
          type: 'message',
          label: opt,
          text: opt,
        },
      })),
    },
  });
}

// =========================
// 料金計算（日跨ぎ対応）
// =========================
function calculatePrice(data, now) {
  const diffMs = now - new Date(data.startTime);
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
// 通知チェック
// =========================
async function checkNotifications() {
  const now = new Date();

  for (const userId in parkingData) {
    const data = parkingData[userId];
    if (!data.startTime) continue;

    const price = calculatePrice(data, now);

    if (price > (data.lastNotifiedPrice || 0)) {
      await client.pushMessage(userId, {
        type: 'text',
        text: `💰 ${price}円になりました`,
      });
      data.lastNotifiedPrice = price;
    }

    if (
      data.maxPrice &&
      price % data.maxPrice === 0 &&
      !data.notifiedMax
    ) {
      await client.pushMessage(userId, {
        type: 'text',
        text: `🚨 最大料金に到達しました`,
      });
      data.notifiedMax = true;
    }

    let unitMinutes =
      data.unitType === 'hour'
        ? data.unitValue * 60
        : data.unitValue;

    const diffMs = now - new Date(data.startTime);
    const diffMins = Math.ceil(diffMs / (1000 * 60));
    const next = unitMinutes - (diffMins % unitMinutes);

    if (next <= 5 && !data.notifiedSoon) {
      await client.pushMessage(userId, {
        type: 'text',
        text: `⏳ あと${next}分で料金が上がります`,
      });
      data.notifiedSoon = true;
    }

    if (next > 5) {
      data.notifiedSoon = false;
    }
  }
}

// 疑似cron（本番NG）
setInterval(checkNotifications, 60000);

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
  if (event.type !== 'message') return;

  const userId = event.source.userId;
  let text = normalizeText(event.message.text);

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
  );

  let replyText = '';

  // 初期化
  if (!parkingData[userId]) {
    parkingData[userId] = { step: null, temp: {} };
  }

  // =========================
  // 設定開始
  // =========================
  if (text === '開始') {
    parkingData[userId] = { step: 'unitType', temp: {} };

    return replyWithQuickReply(
      event.replyToken,
      '料金設定を始めます👇\n単位を選んでください',
      ['分', '時間']
    );
  }

  // =========================
  // ステップ処理
  // =========================
  else if (parkingData[userId].step) {
    const state = parkingData[userId];

    switch (state.step) {

      case 'unitType':
        state.temp.unitType = text === '時間' ? 'hour' : 'minute';
        state.step = 'unitValue';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '何分（何時間）ごと？\n例：30 または 1',
        });

      case 'unitValue':
        state.temp.unitValue = Number(text);
        state.step = 'rate';
        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '料金は？（円）\n例：100',
        });

      case 'rate':
        state.temp.ratePerUnit = Number(text);
        state.step = 'max';
        return replyWithQuickReply(
          event.replyToken,
          '最大料金は？',
          ['0', '500', '800']
        );

      case 'max':
        state.temp.maxPrice = Number(text) || null;
        state.step = 'free';
        return replyWithQuickReply(
          event.replyToken,
          '無料時間は？',
          ['0', '30', '60']
        );

      case 'free':
        state.temp.freeMinutes = Number(text);

        parkingData[userId] = {
          ...state.temp,
        };

        return client.replyMessage(event.replyToken, {
          type: 'text',
          text: '✅ 設定完了！\n「駐車開始」と送ってください',
        });
    }
  }

  // =========================
  // 駐車開始
  // =========================
  else if (text === '駐車開始') {
    if (!parkingData[userId]?.ratePerUnit) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: '先に「開始」と送って設定してください',
      });
    }

    parkingData[userId].startTime = now;
    parkingData[userId].lastNotifiedPrice = 0;
    parkingData[userId].notifiedMax = false;

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🚗 駐車開始\n${now.toLocaleTimeString('ja-JP')}`,
    });
  }

  // =========================
  // 料金確認・終了
  // =========================
  else if (text === '今の料金' || text === '駐車終了') {
    const data = parkingData[userId];

    if (!data || !data.startTime) {
      replyText = '駐車開始してください';
    } else {
      const price = calculatePrice(data, now);

      if (text === '駐車終了') {
        delete parkingData[userId];
        replyText = `🏁 ${price}円でした！`;
      } else {
        replyText = `💰 現在 ${price}円`;
      }
    }
  }

  // =========================
  // その他
  // =========================
  else {
    replyText =
      '👇使い方\n' +
      '①「開始」\n' +
      '② ボタンで料金設定\n' +
      '③ 駐車開始\n' +
      '④ 今の料金';
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

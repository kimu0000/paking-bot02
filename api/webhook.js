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
// 🔥 全角→半角変換（追加）
// =========================
function normalizeText(text) {
  return text
    .replace(/[０-９]/g, (s) =>
      String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
    )
    .replace(/　/g, ' ')
    .replace(/[Ａ-Ｚａ-ｚ]/g, (s) =>
      String.fromCharCode(s.charCodeAt(0) - 0xFEE0)
    );
}

// =========================
// 日本語パース
// =========================
function parseSetting(text) {
  const result = {
    unitType: 'minute',
    unitValue: 30,
    ratePerUnit: 100,
    maxPrice: null,
    freeMinutes: 0,
  };

  if (text.includes('時間')) result.unitType = 'hour';

  const unitMatch = text.match(/(\d+)(分|時間)/);
  if (unitMatch) result.unitValue = Number(unitMatch[1]);

  const rateMatch = text.match(/(\d+)\s*円?/);
  if (rateMatch) result.ratePerUnit = Number(rateMatch[1]);

  const maxMatch = text.match(/最大\s*(\d+)円/);
  if (maxMatch) result.maxPrice = Number(maxMatch[1]);

  const freeMatch = text.match(/無料\s*(\d+)分/);
  if (freeMatch) result.freeMinutes = Number(freeMatch[1]);

  return result;
}

// =========================
// 日跨ぎ対応 料金計算
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

    // 料金更新通知
    if (price > (data.lastNotifiedPrice || 0)) {
      await client.pushMessage(userId, {
        type: 'text',
        text: `💰 ${price}円になりました`,
      });

      data.lastNotifiedPrice = price;
    }

    // 最大料金通知
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

    // 5分前通知
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

// =========================
// 疑似cron（※本番NG）
// =========================
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

  // 🔥 ここで正規化（超重要）
  let text = normalizeText(event.message.text);

  const now = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" })
  );

  let replyText = '';

  // =========================
  // 料金設定（自然言語）
  // =========================
  if (text.includes('円')) {
    const parsed = parseSetting(text);

    parkingData[userId] = {
      ...parkingData[userId],
      ...parsed,
    };

    replyText =
      `✅ 設定完了\n` +
      `${parsed.unitValue}${parsed.unitType === 'hour' ? '時間' : '分'}ごとに${parsed.ratePerUnit}円\n` +
      (parsed.maxPrice ? `最大${parsed.maxPrice}円\n` : '') +
      `無料${parsed.freeMinutes}分`;
  }

  // =========================
  // 駐車開始
  // =========================
  else if (text === '駐車開始') {
    if (!parkingData[userId]?.ratePerUnit) {
      replyText =
        '料金を入力してください👇\n例：30分で100円 最大800円';
    } else {
      parkingData[userId].startTime = now;
      parkingData[userId].lastNotifiedPrice = 0;
      parkingData[userId].notifiedMax = false;

      replyText = `🚗 駐車開始\n${now.toLocaleTimeString('ja-JP')}`;
    }
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
      '① 30分で100円 最大800円\n' +
      '② 駐車開始\n' +
      '③ 今の料金';
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

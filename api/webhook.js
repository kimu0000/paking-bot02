const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

// Supabase接続（環境変数セットしておく）
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// JST変換関数（表示用）
function toJST(date) {
  return new Date(date).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
  });
}

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

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text = event.message.text;
  const now = new Date(); // UTCで取得

  let replyText = '';

  // ======================
  // 駐車開始
  // ======================
  if (text === '駐車開始') {
    const { error } = await supabase
      .from('paking-app01')
      .upsert([
        {
          user_id: userId,
          start_time: now.toISOString(), // UTC保存
        },
      ]);

    if (error) {
      console.error(error);
      replyText = 'エラーが発生しました。';
    } else {
      replyText = `駐車を開始しました！\n開始時刻: ${toJST(now)}`;
    }
  }

  // ======================
  // 今の料金 or 駐車終了
  // ======================
  else if (text === '今の料金' || text === '駐車終了') {
    const { data, error } = await supabase
      .from('paking-app01')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      replyText = '駐車データが見つかりません。「駐車開始」と送ってください。';
    } else {
      const startTime = new Date(data.start_time); // UTC取得
      const diffMs = now - startTime;
      const diffMins = Math.ceil(diffMs / (1000 * 60));
      const price = Math.ceil(diffMins / 30) * 100;

      // 今の料金
      if (text === '今の料金') {
        replyText =
          `開始時刻: ${toJST(startTime)}\n` +
          `経過時間: ${diffMins}分\n` +
          `現在の料金: ${price}円です。`;
      }

      // 駐車終了
      else {
        await supabase
          .from('paking-app01')
          .delete()
          .eq('user_id', userId);

        replyText =
          `駐車を終了しました。\n` +
          `開始時刻: ${toJST(startTime)}\n` +
          `合計時間: ${diffMins}分\n` +
          `お疲れ様でした！`;
      }
    }
  }

  // ======================
  // その他
  // ======================
  else {
    replyText = '「駐車開始」「今の料金」「駐車終了」のいずれかを送ってください。';
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

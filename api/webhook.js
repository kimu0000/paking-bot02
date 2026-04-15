const line = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.Client(config);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  console.log('body:', req.body);

  const events = req.body?.events || [];

  if (!events.length) {
    console.log('イベントなし');
    return res.status(200).send('OK');
  }

  try {
    await Promise.all(events.map(handleEvent));
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook全体エラー:', err);
    res.status(500).end();
  }
};

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userId = event.source.userId;
  const text = event.message.text;
  const now = new Date();

  let replyText = '';

  try {
    // 🟢 駐車開始
    if (text === '駐車開始') {
      const { error } = await supabase.from('sessions').insert({
        user_id: userId,
        start_time: now,
        status: 'active',
      });

      if (error) {
        console.error('INSERTエラー:', error);
        replyText = '駐車開始時にエラーが発生しました';
      } else {
        replyText = `駐車を開始しました！\n開始時刻: ${now.toLocaleString('ja-JP', {
          timeZone: 'Asia/Tokyo'
        })}`;
      }
    }

    // 🟡 今の料金 or 終了
    else if (text === '今の料金' || text === '駐車終了') {
      const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('start_time', { ascending: false })
        .limit(1);

      if (error) {
        console.error('SELECTエラー:', error);
        replyText = 'データ取得時にエラーが発生しました';
      } else {
        const session = data?.[0];

        if (!session) {
          replyText = '駐車データが見つかりません。「駐車開始」と送ってください。';
        } else {
          const startTime = new Date(session.start_time);
          const diffMins = Math.ceil((now - startTime) / (1000 * 60));
          const price = Math.ceil(diffMins / 30) * 100;

          const startTimeJST = startTime.toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo'
          });

          if (text === '今の料金') {
            replyText = `開始時刻: ${startTimeJST}\n経過時間: ${diffMins}分\n現在の料金: ${price}円です。`;
          } else {
            const { error: updateError } = await supabase
              .from('sessions')
              .update({
                end_time: now,
                status: 'completed',
                fee: price,
              })
              .eq('id', session.id);

            if (updateError) {
              console.error('UPDATEエラー:', updateError);
              replyText = '駐車終了時にエラーが発生しました';
            } else {
              replyText = `駐車終了！\n開始時刻: ${startTimeJST}\n時間: ${diffMins}分\n料金: ${price}円`;
            }
          }
        }
      }
    }

    else {
      replyText = '「駐車開始」「今の料金」「駐車終了」と送ってください。';
    }

  } catch (err) {
    console.error('handleEventエラー:', err);
    replyText = '予期せぬエラーが発生しました';
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

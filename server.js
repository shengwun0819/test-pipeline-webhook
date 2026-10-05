require('./config');

const express = require('express');

const healthRoute = require('./routes/health');
const webhookRoute = require('./routes/webhook');

const app = express();
app.disable('x-powered-by');

app.use(
  express.json({
    // 把尚未被解析的原始 bytes 存到 req.rawBody，供 lib/github.js 的
    // verifyGithubSignature 計算 HMAC 用——GitHub 的簽章公式是對「原始 body」
    // 做雜湊，用解析完的 JSON 物件重新 stringify 回去會因為欄位順序/空白
    // 差異對不上簽章，所以一定要在這裡攔截 buf。
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(healthRoute);
app.use(webhookRoute);

const PORT = process.env.PORT || 8000;

app.listen(PORT, async () => {
  console.log(`✅ Server running on :${PORT}`);

  if (process.env.NGROK_AUTHTOKEN) {
    const ngrok = require('@ngrok/ngrok');
    try {
      const listener = await ngrok.forward({
        addr: PORT,
        domain: process.env.NGROK_DOMAIN || undefined,
        authtoken: process.env.NGROK_AUTHTOKEN,
      });
      console.log(`✅ Public URL: ${listener.url()}/webhook/github`);
      console.log('   把這個網址填進 repo → Settings → Webhooks → Payload URL');
    } catch (err) {
      console.error('❌ ngrok 啟動失敗:', err.message);
      console.error('   server 仍會在本機 port 上運行，只是沒有對外網址。');
    }
  } else {
    console.log('ℹ️  未設定 NGROK_AUTHTOKEN，跳過自動建立 tunnel。');
    console.log('   本機測試可自行用 ngrok / smee.io 建立對外連線，或部署到有公開網址的主機。');
  }
});

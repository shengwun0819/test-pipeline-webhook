const crypto = require('crypto');

const config = require('../config');

const API_BASE = 'https://api.github.com';

function authHeaders() {
  return {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/**
 * Express middleware：驗證 GitHub 送來的 webhook 簽章。
 * GitHub 的格式是 header `X-Hub-Signature-256: sha256=<hex>`，演算法為
 * HMAC-SHA256(GITHUB_WEBHOOK_SECRET, rawBody)。必須掛在 express.json({ verify })
 * 已經把原始 bytes 存進 req.rawBody 之後才能運作——簽章是對「原始 body」算的，
 * 用解析完的 JSON 物件重新 stringify 回去會對不上（欄位順序、空白都可能不同）。
 */
function verifyGithubSignature(req, res, next) {
  const signature = req.get('X-Hub-Signature-256');
  if (!signature || !signature.startsWith('sha256=')) {
    console.warn('❌ [webhook] 缺少或格式錯誤的 X-Hub-Signature-256 header');
    return res.sendStatus(401);
  }

  const expected = `sha256=${crypto
    .createHmac('sha256', config.githubWebhookSecret)
    .update(req.rawBody)
    .digest('hex')}`;

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    console.warn('❌ [webhook] 簽章不符，拒絕請求');
    return res.sendStatus(401);
  }

  next();
}

/** 取得一個 issue 的標題與內文，供 prompt 組裝用。 */
async function fetchIssue(issueNumber) {
  const res = await fetch(
    `${API_BASE}/repos/${config.githubOwner}/${config.githubRepo}/issues/${issueNumber}`,
    { headers: authHeaders() },
  );
  if (!res.ok) {
    throw new Error(`GitHub API 取得 issue #${issueNumber} 失敗：${res.status}`);
  }
  const data = await res.json();
  return { title: data.title, body: data.body || '' };
}

/** 在指定 issue 下留言。TEST_MODE 下只印 log，不實際呼叫 API。 */
async function postComment(issueNumber, body) {
  if (config.testMode) {
    console.log(`[TEST MODE] 應留言在 #${issueNumber}：\n${body}`);
    return;
  }
  const res = await fetch(
    `${API_BASE}/repos/${config.githubOwner}/${config.githubRepo}/issues/${issueNumber}/comments`,
    {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API 留言失敗（#${issueNumber}）：${res.status} ${text.slice(0, 200)}`);
  }
}

module.exports = { verifyGithubSignature, fetchIssue, postComment };

// 啟動期設定載入與驗證：讀取環境變數、確認必要項目齊全後才讓 server 繼續啟動。
// 被 server.js 第一行 require('./config') 引入，純粹是副作用式執行。
require('dotenv').config();

const REQUIRED_ENV_VARS = ['GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_WEBHOOK_SECRET'];

const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ 缺少必要環境變數：${missing.join(', ')}`);
  console.error('   請確認 .env 已正確設定（可從 .env.example 複製）。');
  process.exit(1);
}

const [owner, repo] = process.env.GITHUB_REPO.split('/');
if (!owner || !repo) {
  console.error(`❌ GITHUB_REPO 格式錯誤：「${process.env.GITHUB_REPO}」，應為 owner/repo`);
  process.exit(1);
}

module.exports = {
  githubToken: process.env.GITHUB_TOKEN,
  githubOwner: owner,
  githubRepo: repo,
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  triggerLabel: process.env.TRIGGER_LABEL || 'ready-for-test',
  idleTimeoutMin: Number(process.env.IDLE_TIMEOUT_MIN) > 0 ? Number(process.env.IDLE_TIMEOUT_MIN) : 5,
  startupTimeoutSec:
    Number(process.env.STARTUP_TIMEOUT_SEC) > 0 ? Number(process.env.STARTUP_TIMEOUT_SEC) : 120,
  claudePathOverride: process.env.CLAUDE_PATH_OVERRIDE || null,
  testMode: process.env.TEST_MODE === '1',
};

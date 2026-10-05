const express = require('express');

const config = require('../config');
const { verifyGithubSignature } = require('../lib/github');
const { runGenerateTestPlan } = require('../lib/claude-runner');

const router = express.Router();

// 進入點：GitHub 會把這個 repo 裡所有 issue 事件都 POST 到這裡，
// 所以只有「issues 事件」+「labeled 動作」+「label 名稱符合 TRIGGER_LABEL」
// 三個條件同時成立時才觸發後面的測試計畫產出，其餘一律快速 200 掉。
router.post('/webhook/github', verifyGithubSignature, (req, res) => {
  const event = req.get('X-GitHub-Event');
  const body = req.body;

  if (event !== 'issues' || body.action !== 'labeled') {
    return res.sendStatus(200);
  }

  if (body.label?.name !== config.triggerLabel) {
    return res.sendStatus(200);
  }

  const issueNumber = body.issue?.number;
  if (!issueNumber) {
    return res.sendStatus(200);
  }

  // 先回 200 再執行：GitHub 的 webhook 送達有秒級逾時，若等整個 claude 流程
  // （可能長達數分鐘）跑完才回應會被判定逾時，GitHub 會重送同一個事件。
  res.sendStatus(200);
  runGenerateTestPlan(issueNumber);
});

module.exports = router;

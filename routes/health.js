const express = require('express');

const router = express.Router();

// Health check endpoint：回傳 200 代表 server process 本身還活著。
router.get('/health', (req, res) => {
  res.json({ ok: true });
});

module.exports = router;

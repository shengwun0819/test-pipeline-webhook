# GitHub Issue → AI 測試計畫 Bot

一支小型 webhook server：監看 GitHub repo 上某個特定的 issue label，當 issue 被貼上這個 label 時，請 Claude Code 根據 issue 內容產出一份結構化的 QA 測試計畫，並把結果以留言形式寫回該 issue——全程無人值守，從觸發到回報一條龍完成。

```
GitHub Issue（貼上 "ready-for-test" label）
        │  POST /webhook/github  (X-Hub-Signature-256)
        ▼
webhook-server (Express)
        │  驗證簽章 → 讀取 issue 內容（GitHub REST API）
        ▼
script -q /dev/null  claude --print   ← 真正的 PTY，不是 pipe
        │  逐行即時輸出
        ▼
webhook-server
        │  POST 留言回寫到該 issue
        ▼
GitHub Issue（測試計畫以留言形式出現）
```

這是我在工作上建置的一套內部 QA 自動化工具的**獨立、從零重寫版本**（整體概念相同：chat-ops 風格觸發 → spawn 一個 AI CLI → 把結果寫回團隊的追蹤系統）。這裡沒有重用那個專案的任何程式碼、票卡或內部識別資訊——這個 repo 把內部票卡系統換成 GitHub Issues，每一個環節都是從頭重新設計與實作，所以可以放心從頭讀到尾、也可以直接跑起來。

## 為什麼不能只是「spawn claude 然後讀 stdout」

`claude --print` 文件上寫的是非互動模式，但它內部仍然會檢查自己的 `stdout` 是不是接到一個真正的終端機（TTY）。如果用 Node 原生的 `child_process.spawn` 啟動它，`stdout` 會是一條 pipe，不是 TTY——claude 偵測到這點後，會切換成整批緩衝（block buffering）：原本該逐行印出的內容全部先堆在記憶體裡，等內部緩衝區滿了、或進程結束才一次吐出來。

實驗後，請 claude 從 1 數到 30（這個回應大約要 9 秒才能生成完）、透過一般的 pipe：

```
[chunk 1 @ 8856ms, 81 bytes]
closed 0 totalChunks 1
```

只有一個 chunk，而且是在最後才出現。對一個長時間執行的任務來說（這裡真正要處理的任務可能跑好幾分鐘），這代表 server 完全無法分辨「還在正常工作」跟「已經悄悄掛掉」，直到整個流程結束為止——這樣就不可能設計出合理的逾時機制。

解法是讓子進程接到一個真正的偽終端機（PTY）而不是 pipe，讓它以為自己在跟一個真實終端機對話，因而維持正常的逐行緩衝行為。這個專案用的是 macOS/BSD 內建的 `script` 指令來做這件事——`script -q /dev/null <command> [args...]` 底層會呼叫 `forkpty()`，把包起來的指令的 stdout 接到一個 PTY slave。不需要額外安裝任何東西，也不需要原生編譯的 Node 模組。同樣的測量方式，這次包一層 `script`：

```
[chunk 1 @ 24ms, 4 bytes]
[chunk 2 @ 9931ms, 71 bytes]
[chunk 3 @ 10765ms, 6 bytes]
closed 0 totalChunks 3
```

多個 chunk 隨著進程執行陸續到達，不是結尾才噴出一個。這也是為什麼 `lib/claude-runner.js` 裡的 idle-timeout 邏輯會有意義：每收到一個 chunk 就重置一次計時器，所以「N 分鐘沒有輸出」才能可靠地代表「真的卡住了」，而不是「緩衝機制剛好還沒吐資料」。

我一開始用的其實是 [`node-pty`](https://www.npmjs.com/package/node-pty)（VS Code、Hyper 內建終端機背後用的套件），程式碼換回去用它一樣能跑——但它需要原生編譯步驟（`node-gyp` + 平台建置工具），而這件事 `script(1)` 在 macOS 上已經免費內建做好了。兩個方案都值得知道；不需要支援 Windows 的話，`script` 是更簡單的選擇。

**可攜性備註：** 這裡用的 `script` 語法是 BSD／macOS 版本。GNU/Linux 的 `script`（util-linux）語法不同——是 `script -qefc "<整串指令字串>" /dev/null`——要在 Linux 上直接跑，需要加一個簡單的平台判斷。

## Webhook 簽章驗證

`/webhook/github` 只接受 `X-Hub-Signature-256` header 是「對**原始** request body 算出的合法 HMAC-SHA256」的請求，演算法用的共享密鑰（`GITHUB_WEBHOOK_SECRET`）只有這支 server 跟 GitHub webhook 設定知道。這裡有三個細節很重要，也都很容易不小心做錯：

- **必須是原始 body，不能用解析完的版本。** Express 的 `express.json()` 會把 body 解析成 JS 物件；拿解析完的物件重新序列化回去算簽章，可能會跟 GitHub 當初雜湊的內容悄悄對不上（欄位順序、空白都可能不同）。`server.js` 用 `express.json({ verify })` 在解析**之前**先把 `req.rawBody` 擷取成一個 `Buffer`，就是為了讓 `lib/github.js` 裡的簽章檢查可以用完全沒被動過的原始位元組。
- **比對必須是常數時間。** 單純用 `===` 比對兩個字串，理論上會洩漏「前面比對到第幾個 byte 才不一樣」的時間差異，讓攻擊者有機會一個 byte 一個 byte 反推出合法簽章。`verifyGithubSignature` 改用 `crypto.timingSafeEqual` 來比對。
- **每次都實際驗證過，不是憑空假設。** 下面這兩個 curl 指令就是我實際用來確認這件事的指令：錯誤的簽章回傳 `401`，正確算出來的簽章則會通過。

```bash
# 錯誤簽章 → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8000/webhook/github \
  -H "Content-Type: application/json" -H "X-GitHub-Event: issues" \
  -H "X-Hub-Signature-256: sha256=deadbeef" \
  -d '{"action":"labeled","label":{"name":"ready-for-test"},"issue":{"number":42}}'

# 正確簽章 → 200，觸發整條 pipeline
BODY='{"action":"labeled","label":{"name":"ready-for-test"},"issue":{"number":42}}'
SIG=$(node -e "console.log('sha256='+require('crypto').createHmac('sha256',process.env.GITHUB_WEBHOOK_SECRET).update(process.argv[1]).digest('hex'))" "$BODY")
curl -s -X POST http://localhost:8000/webhook/github \
  -H "Content-Type: application/json" -H "X-GitHub-Event: issues" \
  -H "X-Hub-Signature-256: $SIG" -d "$BODY"
```

## 其他值得一提的設計重點

- **去重鎖，不是全域佇列。** `lib/claude-runner.js` 裡的 `runningIssues`（一個 `Set`）只會擋下「同一個 issue」的第二次觸發（當它已經在執行中時），不會限制「不同 issue」能同時跑幾個——每個 issue 都有自己獨立的 child process。
- **先回應 webhook，之後才真正執行工作。** `routes/webhook.js` 會在呼叫 `runGenerateTestPlan` **之前**就先回 `200` 給 GitHub。GitHub 的 webhook 送達本身有一個不長的逾時；如果等一個可能跑好幾分鐘的 claude 流程做完才回應，GitHub 會認為這次送達失敗而重送，導致同一件事被觸發第二次。
- **兩階段逾時。** `STARTUP_TIMEOUT_SEC` 涵蓋「claude 還沒產生任何輸出」的情況（plugin／模型暖機可能要一段時間）；`IDLE_TIMEOUT_MIN` 涵蓋「本來有輸出、後來停了」的情況——兩者各自獨立計時，任一個先觸發都會終止該 process 並回報失敗。
- **設定缺漏就直接啟動失敗。** `config.js` 在啟動時就檢查必要的環境變數是否齊全，缺任何一個就立刻結束，而不是讓 server 帶著不完整的設定啟動、等到第一次真正收到請求時才莫名其妙地失敗。

## 安裝與啟動

```bash
npm install
cp .env.example .env   # 填入 GITHUB_TOKEN / GITHUB_REPO / GITHUB_WEBHOOK_SECRET
npm start
```

接著到目標 GitHub repo：**Settings → Webhooks → Add webhook**，把 Payload URL 指向 `<你的公開網址>/webhook/github`，Content type 選 `application/json`，Secret 填跟 `GITHUB_WEBHOOK_SECRET` 相同的值，並訂閱 **Issues** 事件。如果你手邊還沒有公開網址，可以在 `.env` 裡設定 `NGROK_AUTHTOKEN`（可選 `NGROK_DOMAIN`），server 啟動時會自動建立 tunnel 並印出可用的網址。

把某個 issue 貼上 `ready-for-test` label（或你在 `TRIGGER_LABEL` 設定的名稱），觀察 server 的 log——產生的測試計畫應該很快就會以留言的形式出現在該 issue 下。

設定 `TEST_MODE=1` 可以跳過實際呼叫 GitHub 留言 API，改成只印出「原本會留言的內容」，方便在不干擾真實 repo 的情況下本機迭代測試。

## 專案結構

```
server.js               — 進入點：建立 express app、掛載 middleware、選擇性啟動 ngrok tunnel
config.js                — 載入環境變數、啟動時 fail-fast 檢查必填項目
lib/github.js            — webhook 簽章驗證、讀取 issue 內容、寫入留言
lib/claude-runner.js      — 透過 PTY spawn claude、兩階段逾時、去重鎖
routes/health.js          — GET /health
routes/webhook.js         — POST /webhook/github
```

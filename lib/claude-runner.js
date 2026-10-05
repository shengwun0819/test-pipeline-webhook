const { execSync, spawn } = require('child_process');

const config = require('../config');
const { fetchIssue, postComment } = require('./github');

// 同一個 issue 不能有兩個產生流程同時跑（會重複留言），用這個 Set 做互斥鎖；
// 不同 issue 之間不互相限制，可以併發各自跑一次。
const runningIssues = new Set();

function resolveClaudePath() {
  if (config.claudePathOverride) return config.claudePathOverride;
  try {
    return execSync('which claude', { encoding: 'utf8' }).trim();
  } catch {
    console.error('❌ 找不到 claude CLI，請確認已安裝並在 PATH 中，或設定 CLAUDE_PATH_OVERRIDE');
    process.exit(1);
  }
}

const CLAUDE_PATH = resolveClaudePath();

function buildPrompt(title, body) {
  return [
    '你是一位資深 QA 工程師。根據以下 GitHub issue 的標題與內文，產出一份結構化的手動測試計畫，',
    '使用 Markdown 格式，需包含：正向案例、反向案例、邊界案例三個區塊，每個案例至少包含步驟與預期結果。',
    '只輸出測試計畫本身，不要輸出其他說明文字。',
    '',
    '## Issue 標題',
    title,
    '',
    '## Issue 內文',
    body || '（無內文）',
  ].join('\n');
}

/**
 * 核心執行者：針對單一 issue 跑一次「讀取內容 → claude 產出測試計畫 → 留言回報」。
 * @param {number} issueNumber
 */
async function runGenerateTestPlan(issueNumber) {
  if (runningIssues.has(issueNumber)) {
    console.warn(`🔁 [#${issueNumber}] 已有執行中的流程，略過重複觸發`);
    return;
  }
  runningIssues.add(issueNumber);

  try {
    const { title, body } = await fetchIssue(issueNumber);
    const prompt = buildPrompt(title, body);

    console.log(`▶ [#${issueNumber}] 觸發測試計畫產出：${title}`);

    const output = await spawnClaude(prompt, issueNumber);

    const comment = ['## 🤖 自動產出的測試計畫', '', output.trim()].join('\n');
    await postComment(issueNumber, comment);
    console.log(`✅ [#${issueNumber}] 測試計畫已留言回報`);
  } catch (err) {
    console.error(`❌ [#${issueNumber}] 失敗：${err.message}`);
    await postComment(issueNumber, `## 🤖 自動產出測試計畫失敗\n\n\`${err.message}\``).catch(() => {});
  } finally {
    runningIssues.delete(issueNumber);
  }
}

/**
 * claude 以 `--print`（非互動）模式執行時，仍會檢查自己的 stdout 是不是接到
 * 一個真正的終端機（TTY）；如果直接用 child_process.spawn 啟動，stdout 會是
 * 一條 pipe，不是 TTY，claude 偵測到後會切換成整批緩衝——所有輸出堆到記憶體
 * 緩衝區，等進程結束才一次吐出來，不是逐行即時輸出（可用
 * `node -e "spawn claude --print '數到 20'"` 實測驗證：約 9 秒的生成過程，
 * stdout 只會在最後一刻收到唯一一個 chunk）。
 *
 * macOS／BSD 內建的 `script` 指令可以解決這個問題：`script -q /dev/null <cmd>`
 * 會用 forkpty() 替 <cmd> 分配一個真正的 PTY slave 當作它的 stdout，讓 claude
 * 認為自己連著終端機，因而逐行即時 flush。這是作業系統內建工具，不需要額外安裝
 * Expect/Tcl，也不需要原生編譯的 Node 模組。
 *
 * 注意：這裡用的是 BSD 版 `script`（macOS 內建）的語法：
 * `script -q /dev/null <command> [args...]`。GNU/Linux 的 `script`（util-linux）
 * 語法不同，是 `script -qefc "<command string>" /dev/null`，若要跨平台執行需另外
 * 判斷並組出對應的參數。
 */
function spawnClaude(prompt, issueNumber) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'script',
      ['-q', '/dev/null', CLAUDE_PATH, '--print', '--dangerously-skip-permissions', prompt],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let output = '';
    let settled = false;
    let firstChunk = true;
    let idleTimer = null;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      if (err) return reject(err);
      resolve(result);
    };

    const resetIdleTimer = (ms) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const label = firstChunk ? '啟動逾時仍無輸出' : '輸出中途逾時';
        console.warn(`[#${issueNumber}] ${label}，強制終止 claude`);
        child.kill('SIGTERM');
        finish(new Error(label));
      }, ms);
    };

    child.stdout.on('data', (chunk) => {
      if (firstChunk) {
        console.log(`[#${issueNumber}] claude 開始輸出`);
        firstChunk = false;
      }
      output += chunk;
      resetIdleTimer(config.idleTimeoutMin * 60 * 1000);
    });

    child.stderr.on('data', () => {
      // script 包出來的 stderr 大多是終端機控制序列，不需要轉發，只用來避免 backpressure。
    });

    child.on('error', (err) => finish(err));

    child.on('close', (code) => {
      if (code !== 0) {
        return finish(new Error(`claude 結束碼非 0（${code}）`));
      }
      finish(null, output);
    });

    resetIdleTimer(config.startupTimeoutSec * 1000);
  });
}

module.exports = { runGenerateTestPlan };

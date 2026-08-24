import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RelayInjector } from '../inject.mjs';
import { loadEnvFile } from '../utils.mjs';

const SAMPLE_BASE64 = '5pys5p2h5Y+q5YGa5rWL6K+V77yM5L2G5piv5LiN55So6K6w5b2V44CCCgrmiJHlvoXkvJropoHosIPmlbTkuIDkuIvmiJHnmoTpgqPkuKpHWDEw5LiK6Z2i55qE6L+Z5Liq5bel5L2c5Y+w77yM6L+Z5bel5L2c5Y+w5ZGi77yM6IO95aSf5pyJ5Yeg5Liq5oyJ6ZKu77yM6IO95aSf5b+r6YCf55qE6K6p5oiR5YiH5o2i5qih5Z6L55qE77yaCjEuIOS4gOmUruWIh+aNouWIsOWNg+mXrjI3QgoyLiDliIfmjaLliLBEZWVwU2Vla+WPjOacugozLiBNaW5pTWF46L+Z56eN5Y+M5py655qE54mI5pysCgrmjInnhafmiJHnmoTkvb/nlKjlnLrmma/vvIzkvaDopoHluK7miJHop4TliJLlpb3vvIznhLblkI7nnIvnnIvlk6rkuIDkupvmmK/lj6/ku6XlkIzml7bluLjpqbvjgILlkIzml7blnKjkuI3lvbHlk410b2tlbui+k+WHuueahOaDheWGteS4i+mdou+8jOiDveWkn+W4uOmpu+eahOaooeWei++8jOeEtuWQjuaKiui/meS6m+aooeWei+WBmuaIkOW8gOWFs++8jOaWueS+v+aIkeeCueWHu+S4gOS4i+WwseiDveWKoOi9veOAggoK5ZCM5pe26IO95aSf55yL5Yiw5a6M5pW055qE5Yqg6L296L+b5bqm44CC5Zu+5b2i5LiK6Z2i55qE6K+d77yM5Lmf6KaB5pyJ55u45bqU55qE5Zu+5b2i6K6p5oiR55yL5Yiw5Yqg6L295a6M5oiQ77yM6YKj5oiR5Y+v5Lul55u05o6l6LCD55So44CC54S25ZCO6LCD55So55qE6L+Z5LqbQVBJ5Lmf6ZyA6KaB5Zyo5Yqg6L295a6M5oiQ5Lul5ZCO5pi+56S65Ye65p2l77yM5pa55L6/5oiR5b+r6YCf6LS057uZ5oiR55qEQWdlbnTljrvkvb/nlKg=';
const SAMPLE_BYTES = Buffer.from(SAMPLE_BASE64, 'base64');
const SAMPLE_TEXT = SAMPLE_BYTES.toString('utf8');
const EXPECTED_SHA256 = '9362c435ddc41b67a537b57a7171aab0b123398821fa464db393165486d0fd48';
const ITERATIONS = Number.parseInt(process.env.INJECT_ITERATIONS || '1', 10);

assert.equal(SAMPLE_BYTES.length, 773, '控制样本必须保持黑匣子原始 773 字节');
assert.equal(createHash('sha256').update(SAMPLE_BYTES).digest('hex'), EXPECTED_SHA256);
assert.ok(Number.isInteger(ITERATIONS) && ITERATIONS > 0 && ITERATIONS <= 20, 'INJECT_ITERATIONS 必须为 1..20');

const bridgeDir = join(import.meta.dirname, '..');
loadEnvFile(join(bridgeDir, '.env'));
assert.ok(process.env.RELAY_URL, '缺少 RELAY_URL');
assert.ok(process.env.MAC_ID, '缺少 MAC_ID');

function appleScript(source) {
  return execFileSync('/usr/bin/osascript', ['-e', source], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function stripOsaScriptTerminator(output) {
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

function resetTextEditDocument() {
  appleScript('tell application "TextEdit" to activate');
  appleScript(`
    tell application "System Events"
      tell process "TextEdit"
        set frontmost to true
        set {windowX, windowY} to position of front window
        set {windowWidth, windowHeight} to size of front window
        click at {windowX + (windowWidth div 2), windowY + (windowHeight div 2)}
        keystroke "a" using command down
        key code 51
      end tell
    end tell
    delay 0.35
  `);
  const frontmost = stripOsaScriptTerminator(appleScript(
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ));
  assert.equal(frontmost, 'TextEdit', `注入前台不是 TextEdit，而是 ${frontmost}`);
}

function readTextEditDocument() {
  return stripOsaScriptTerminator(
    appleScript('tell application "TextEdit" to get text of document 1'),
  );
}

appleScript(`
  tell application "TextEdit"
    activate
    make new document
  end tell
  delay 0.5
`);
resetTextEditDocument();
appleScript('tell application "System Events" to keystroke "x"');
await delay(150);
assert.equal(readTextEditDocument(), 'x', 'TextEdit 测试文档没有获得真实键盘焦点');

const injector = new RelayInjector({
  url: process.env.RELAY_URL,
  macId: process.env.MAC_ID,
  name: 'cc-bridge TextEdit 注入顺序真测',
  dir: bridgeDir,
  log: { info: () => {}, warn: (...args) => console.error(...args) },
});

const results = [];
try {
  for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
    resetTextEditDocument();
    assert.equal(readTextEditDocument(), '', `第 ${iteration} 次测试前文档未清空`);
    const ack = await injector.injectText(SAMPLE_TEXT, {
      postprocess: false,
      waitMs: 12_000,
      ackMs: 12_000,
    });
    assert.equal(ack?.ok, true, `第 ${iteration} 次注入未成功 ACK`);
    assert.equal(ack?.unconfirmed, undefined, `第 ${iteration} 次只有发送、没有 App ACK`);
    assert.equal(ack?.mode, 'type', `第 ${iteration} 次 App 未走真实注入路径`);
    await delay(800);

    const actualText = readTextEditDocument();
    const actualBytes = Buffer.from(actualText, 'utf8');
    const actualSha256 = createHash('sha256').update(actualBytes).digest('hex');
    assert.deepEqual(actualBytes, SAMPLE_BYTES, [
      `第 ${iteration} 次逐字节 diff 失败`,
      `expected bytes=${SAMPLE_BYTES.length} sha256=${EXPECTED_SHA256}`,
      `actual bytes=${actualBytes.length} sha256=${actualSha256}`,
      `actual suffix=${JSON.stringify(actualText.slice(-40))}`,
    ].join('\n'));
    for (const fragment of ['会要', '1. 一键', 'DeepSeek', '按照我的', '能够看到完整']) {
      assert.ok(actualText.includes(fragment), `第 ${iteration} 次缺少原位关键片段：${fragment}`);
    }
    assert.ok(!actualText.endsWith('看到\n按\nD1会要'), `第 ${iteration} 次末尾出现倒序碎片签名`);
    results.push({ iteration, bytes: actualBytes.length, sha256: actualSha256, mode: ack.mode });
  }
  console.log(JSON.stringify({ ok: true, iterations: results }, null, 2));
} finally {
  injector.close();
  // ws.close() 会等待对端关闭握手，测试进程可能因此残留；断言完成后直接终止测试连接。
  try { injector.ws?.terminate(); } catch {}
  try {
    appleScript('tell application "TextEdit" to quit saving no');
  } catch {}
}

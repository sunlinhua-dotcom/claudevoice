// shared/speech.cjs 的回归测试。
// 这层过去在 server.js / worker.js / hook.js 各存一份、彼此漂移且零测试；合并成一份后由本文件守住。
// 跑：npm test（即 node --test test/*.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const speech = require('../shared/speech.cjs');
const {
  VOICE_POOL, VOICE_GENDER, assignVoice, hashStr,
  humanizeName, spaceCJK, sayTool, speakCapsRun,
  isMostlyChinese, cleanForSpeech, pickSummary, capSpeech,
  buildAlertSpeak, doneFallback, doneWithSummary, buildStyle, extractTool,
  baseName, clip,
} = speech;

const WHO = ['布莱特'];

test('音色池只含中文音色，男女都有', () => {
  assert.equal(VOICE_POOL.length, 4);
  for (const v of VOICE_POOL) {
    assert.match(v.name, /^[一-鿿]+$/, '英文音色读中文会乱码，池子里不许有');
    assert.ok(v.gender === 'f' || v.gender === 'm');
    assert.equal(VOICE_GENDER[v.name], v.gender);
  }
});

test('assignVoice：同一项目永远同一个音色', () => {
  const a = assignVoice('CLAUDEVOICE');
  for (let i = 0; i < 5; i++) assert.deepEqual(assignVoice('CLAUDEVOICE'), a);
  assert.ok(VOICE_POOL.some((v) => v.name === a.name));
});

test('assignVoice：override 一律照收，未知音色按女声处理', () => {
  // 曾经的漂移点：worker.js 静默丢弃不在内置池里的 override，
  // 同一份 projects.json 本地念一个音色、云端念另一个。云端由 resolveVoiceEdge 兜底，认下来是安全的。
  assert.deepEqual(assignVoice('X', '白桦'), { name: '白桦', gender: 'm' });
  assert.deepEqual(assignVoice('X', 'zh-CN-YunjianNeural'), { name: 'zh-CN-YunjianNeural', gender: 'f' });
});

test('assignVoice / hashStr：空 key 不抛异常', () => {
  assert.ok(assignVoice('').name);
  assert.ok(assignVoice(null).name);
  assert.equal(hashStr(''), 0);
});

test('spaceCJK：中英文之间补空格，null 不抛', () => {
  // 曾经的漂移点：worker.js 那份没有 String() 兜底，传 null 直接 TypeError。
  assert.equal(spaceCJK('测试ABC项目'), '测试 ABC 项目');
  assert.equal(spaceCJK(null), '');
  assert.equal(spaceCJK(undefined), '');
});

test('humanizeName：驼峰 / 分隔符 / 数字边界都拆得开', () => {
  assert.equal(humanizeName('WebFetch'), 'Web Fetch');
  assert.equal(humanizeName('my_cool-project'), 'my cool project');
  assert.equal(humanizeName('claude4'), 'claude 4');
  assert.equal(humanizeName('研究计划'), '研究计划');
  assert.equal(humanizeName(''), '');
});

test('humanizeName：全大写连写按词典切开', () => {
  assert.equal(humanizeName('DEVGX10'), 'Dev G X 10');
  assert.equal(speakCapsRun('CLOUDDEMO'), 'Cloud Demo');
  assert.equal(speakCapsRun('API'), 'A P I');   // 缩写逐字母念
  assert.equal(speakCapsRun('VIDEO'), 'Video'); // 词典词按词念
});

test('sayTool 与 humanizeName 同源', () => {
  assert.equal(sayTool('WebSearch'), humanizeName('WebSearch'));
  assert.equal(sayTool(''), '');
});

test('isMostlyChinese：短英文不算中文', () => {
  assert.ok(isMostlyChinese('这一轮改完了，已经跑过测试。'));
  assert.ok(!isMostlyChinese('Refactored the speech layer and added tests.'));
  assert.ok(!isMostlyChinese(''));
});

test('cleanForSpeech：去掉代码块和 markdown 记号', () => {
  const out = cleanForSpeech('# 标题\n```js\nconst a = 1;\n```\n- 改好了 `foo` 这个函数。', 200);
  assert.ok(!out.includes('```'));
  assert.ok(!out.includes('#'));
  assert.ok(out.includes('改好了'));
});

test('pickSummary：在句子边界收尾，不切半句', () => {
  const sum = pickSummary('第一句改完了。第二句跑过测试了。第三句部署完成了。', 150);
  assert.ok(sum.endsWith('。'));
  assert.ok(sum.startsWith('第一句改完了。'));
});

test('pickSummary：需要定夺的那句一定念到', () => {
  const long = '这是一段很长的说明。'.repeat(12) + '要不要现在部署？';
  const sum = pickSummary(long, 60);
  assert.ok(sum.includes('要不要现在部署？'), '结尾的提问被吞掉了');
});

test('capSpeech：超长在标点处收尾并加省略号', () => {
  assert.equal(capSpeech('短句。', 50), '短句。');
  const out = capSpeech('第一段内容比较长。第二段内容也不短。第三段还有。', 20);
  assert.ok(out.endsWith('……'));
  assert.ok(out.length <= 22);
});

test('buildAlertSpeak：四种事件都带称呼和目录名', () => {
  for (const kind of ['waiting', 'permission', 'subagent', 'notification']) {
    const s = buildAlertSpeak(kind, WHO, '克劳德语音', 'Bash');
    assert.ok(s.startsWith('布莱特，'), kind + ' 没带称呼：' + s);
    assert.ok(s.includes('克劳德语音'), kind + ' 没带目录名：' + s);
  }
});

test('buildAlertSpeak：permission 带工具名时要念出来，没有就退回泛化句', () => {
  assert.ok(buildAlertSpeak('permission', WHO, '项目', 'Bash').includes('Bash'));
  assert.ok(buildAlertSpeak('permission', WHO, '项目', '').includes('确认'));
});

test('buildAlertSpeak：未知 kind 退回普通消息而不是崩', () => {
  assert.ok(buildAlertSpeak('zzz', WHO, '项目', '').includes('项目'));
});

test('done 播报：无摘要用定型句，有摘要念内容', () => {
  const f = doneFallback(WHO, '克劳德语音');
  assert.ok(f.startsWith('布莱特，') && f.includes('克劳德语音'));
  assert.equal(doneWithSummary(WHO, '克劳德语音', '改完了。'),
    '布莱特，目录 克劳德语音 的任务完成了。具体是，改完了。');
});

test('buildStyle：短指令，避免被 TTS 当内容念', () => {
  const s = buildStyle('done');
  assert.ok(s.length <= 12 && s.endsWith('。'));
});

test('extractTool：从权限提示里抠工具名', () => {
  assert.equal(extractTool('Claude needs your permission to use Bash'), 'Bash');
  assert.equal(extractTool('Claude needs your permission to use Web Fetch.'), 'Web Fetch');
  assert.equal(extractTool('随便一句话'), '');
});

test('baseName / clip', () => {
  assert.equal(baseName('/a/b/CLAUDEVOICE/'), 'CLAUDEVOICE');
  assert.equal(baseName(''), '');
  assert.equal(clip('abcdef', 3), 'abc…');
  assert.equal(clip(null, 3), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildImagePrompt, extractOutputFiles, MediaStore, parseImageMessage } from '../media.mjs';

test('解析 image 与 post 图文混排，保留文字顺序和图片 key', () => {
  assert.deepEqual(parseImageMessage({ message_type: 'image', content: JSON.stringify({ image_key: 'img-one' }) }), {
    text: '', imageKeys: ['img-one'],
  });
  const post = {
    zh_cn: {
      title: '标题',
      content: [
        [{ tag: 'text', text: '请分析' }, { tag: 'img', image_key: 'img-a' }],
        [{ tag: 'text', text: '重点看配色' }, { tag: 'img', image_key: 'img-b' }],
      ],
    },
  };
  assert.deepEqual(parseImageMessage({ message_type: 'post', content: JSON.stringify(post) }), {
    text: '标题\n请分析\n重点看配色', imageKeys: ['img-a', 'img-b'],
  });
  assert.deepEqual(parseImageMessage({ message_type: 'post', content: JSON.stringify(post.zh_cn) }), {
    text: '标题\n请分析\n重点看配色', imageKeys: ['img-a', 'img-b'],
  });
});

test('下载飞书图片到独立运行目录、按文件头命名并构造 Claude prompt', async () => {
  const root = await mkdtemp(join(import.meta.dirname, 'media-store-'));
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const client = { im: { messageResource: { get: async ({ path, params }) => {
    assert.equal(path.message_id, 'm-image');
    assert.equal(path.file_key, 'img-key');
    assert.equal(params.type, 'image');
    return { writeFile: async (file) => writeFile(file, png), headers: { 'content-type': 'image/png' } };
  } } } };
  const store = new MediaStore({ client, root });
  await store.init();
  const prepared = await store.prepareImageMessage({ message_id: 'm-image', message_type: 'image', content: JSON.stringify({ image_key: 'img-key' }) });
  assert.equal(prepared.paths.length, 1);
  assert.match(prepared.paths[0], /m-image[/\\].+\.png$/);
  assert.equal(existsSync(prepared.paths[0]), true);
  assert.match(prepared.prompt, /描述\/分析这张图片/);
  assert.match(prepared.prompt, /请先读取该图片/);
  assert.match(prepared.prompt, new RegExp(prepared.paths[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await rm(root, { recursive: true, force: true });
});

test('图配文字使用文字为任务，多图路径逐行附加', () => {
  const prompt = buildImagePrompt('比较两张图', ['/tmp/a.png', '/tmp/b.jpg']);
  assert.match(prompt, /^比较两张图/);
  assert.match(prompt, /请先读取这些图片/);
  assert.match(prompt, /\/tmp\/a\.png[\s\S]*\/tmp\/b\.jpg/);
});

test('启动清理 24 小时前的旧附件目录，保留新目录', async () => {
  const root = await mkdtemp(join(import.meta.dirname, 'media-clean-'));
  const oldDir = join(root, 'old');
  const freshDir = join(root, 'fresh');
  await mkdir(oldDir); await mkdir(freshDir);
  await writeFile(join(oldDir, 'a.png'), 'x');
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(oldDir, old, old);
  const store = new MediaStore({ client: {}, root, maxAgeMs: 24 * 60 * 60 * 1000 });
  const removed = await store.init();
  assert.equal(removed, 1);
  assert.equal(existsSync(oldDir), false);
  assert.equal(existsSync(freshDir), true);
  await rm(root, { recursive: true, force: true });
});

test('产物路径只接受项目内或 /tmp 的真实文件，拒绝越界和 symlink，去重取前三个', async () => {
  const project = await mkdtemp(join(import.meta.dirname, 'media-project-'));
  const outside = await mkdtemp(join(import.meta.dirname, 'media-outside-'));
  const tempAllowed = `/tmp/cc-bridge-output-${process.pid}.txt`;
  const image = join(project, 'out.png');
  const report = join(project, 'reports', 'report.pdf');
  const secret = join(outside, 'secret.txt');
  const linked = join(project, 'linked.txt');
  await mkdir(join(project, 'reports'));
  await writeFile(image, 'png'); await writeFile(report, 'pdf'); await writeFile(secret, 'secret'); await writeFile(tempAllowed, 'tmp');
  await symlink(secret, linked);
  const result = [
    '`out.png`', '`reports/report.pdf`', `\`${tempAllowed}\``, `\`${secret}\``, '`linked.txt`', '`out.png`',
  ].join('\n');
  assert.deepEqual(extractOutputFiles(result, { projectDir: project }), [image, report, tempAllowed]);
  await rm(project, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(tempAllowed, { force: true });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayInjector, writeAttachmentsToClipboard } from '../inject.mjs';
import { loadEnvFile } from '../utils.mjs';

loadEnvFile(join(import.meta.dirname, '..', '.env'));
if (!process.env.RELAY_URL || !process.env.MAC_ID) throw new Error('缺少 RELAY_URL / MAC_ID');

const dir = await mkdtemp(join(tmpdir(), 'cc-attachment-paste-'));
const pdf = join(dir, 'paste-button-test.pdf');
const delivery = {
  id: 'attachment-paste-smoke', sourceMessageId: 'local-smoke', project: 'claudevoice',
  prompt: '本地粘贴按钮测试',
  attachments: [{ path: pdf, name: 'paste-button-test.pdf', mime: 'application/pdf', size: 0, resourceType: 'file' }],
};
const injector = new RelayInjector({
  url: process.env.RELAY_URL, macId: process.env.MAC_ID,
  name: 'cc-bridge 附件粘贴测试', dir: join(import.meta.dirname, '..'), log: console,
});

try {
  await writeFile(pdf, '%PDF-1.4\n% cc-bridge paste smoke\n%%EOF\n');
  delivery.attachments[0].size = Buffer.byteLength(await import('node:fs/promises').then(({ readFile }) => readFile(pdf)));
  await writeAttachmentsToClipboard(delivery.attachments);
  const result = await injector.injectKey('paste');
  console.log(JSON.stringify({ action: 'cc.attachment.paste', relayResult: result }));
} finally {
  injector.close();
  await rm(dir, { recursive: true, force: true });
}

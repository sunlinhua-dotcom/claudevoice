import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAttachmentsToClipboard } from '../inject.mjs';

const dir = await mkdtemp(join(tmpdir(), 'cc-attachment-clipboard-'));
const pdf = join(dir, 'clipboard-test.pdf');
const png = join(dir, 'clipboard-test.png');

try {
  await writeFile(pdf, '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  await writeFile(png, Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xql8WQAAAABJRU5ErkJggg==',
    'base64',
  ));
  const pdfResult = await writeAttachmentsToClipboard([
    { path: pdf, name: 'clipboard-test.pdf', mime: 'application/pdf' },
  ]);
  console.log(JSON.stringify({ case: 'pdf', ...pdfResult }));
  const pngResult = await writeAttachmentsToClipboard([
    { path: png, name: 'clipboard-test.png', mime: 'image/png' },
  ]);
  console.log(JSON.stringify({ case: 'png', ...pngResult }));
} finally {
  await rm(dir, { recursive: true, force: true });
}

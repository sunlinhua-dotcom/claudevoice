#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [iconset, output] = process.argv.slice(2);
if (!iconset || !output) {
  console.error('用法：node pack-icns.mjs <AppIcon.iconset> <AppIcon.icns>');
  process.exit(2);
}

// Apple 的现代 ICNS 类型均可直接承载 PNG；这与 iconutil 生成的大图条目格式一致。
const entries = [
  ['icp4', 'icon_16x16.png'],
  ['ic11', 'icon_16x16@2x.png'],
  ['icp5', 'icon_32x32.png'],
  ['ic12', 'icon_32x32@2x.png'],
  ['ic07', 'icon_128x128.png'],
  ['ic13', 'icon_128x128@2x.png'],
  ['ic08', 'icon_256x256.png'],
  ['ic14', 'icon_256x256@2x.png'],
  ['ic09', 'icon_512x512.png'],
  ['ic10', 'icon_512x512@2x.png'],
];

const chunks = [];
for (const [type, filename] of entries) {
  const png = await readFile(join(iconset, filename));
  if (png.subarray(1, 4).toString('ascii') !== 'PNG') throw new Error(`${filename} 不是 PNG`);
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(png.length + 8, 4);
  chunks.push(header, png);
}

const body = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(body.length + 8, 4);
await writeFile(output, Buffer.concat([header, body]));
console.log(`已写入 ${entries.length} 个尺寸条目`);

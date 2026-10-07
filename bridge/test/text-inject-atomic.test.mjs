import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const injectorSource = readFileSync(
  join(import.meta.dirname, '..', '..', 'mac-app', 'TextInjector.swift'),
  'utf8',
);

test('文字自动注入只使用一次 Cmd+V，不保留 Unicode 分块打字路径', () => {
  assert.doesNotMatch(
    injectorSource,
    /keyboardSetUnicodeString|chunkedScalars|cgType\(/,
    '分块 CGEvent Unicode 注入会与异步受控输入框竞争光标位置，必须移除',
  );
  assert.match(injectorSource, /virtualKey:\s*9/, '必须生成 V 键事件');
  assert.match(injectorSource, /\.maskCommand/, '必须为 V 键事件带 Command 修饰符');
});

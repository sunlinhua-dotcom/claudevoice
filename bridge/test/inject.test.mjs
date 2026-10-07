import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAnnouncePaired } from '../inject.mjs';

test('同一连接重复收到 paired 帧时只记录第一次状态跃迁', () => {
  assert.equal(shouldAnnouncePaired(false), true);
  assert.equal(shouldAnnouncePaired(true), false);
});

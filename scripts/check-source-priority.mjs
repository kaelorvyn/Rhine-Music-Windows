// Unit contract for the smart-switching source priority: the fallback lookup
// order honours user ordering, drops disabled/excluded sources and defaults to
// free catalogs first. Pure logic — no UI, no network, synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLookupOrder, defaultSourcePriority, DEFAULT_SOURCE_PRIORITY } from '../src/source-fallback.ts';

const available = ['netease', 'qq', 'bodian', 'kugou', 'kuwo', 'joox'];

test('source priority defaults to free catalogs first and excludes the failed source', () => {
  assert.equal(DEFAULT_SOURCE_PRIORITY[0], 'kuwo', '酷我免费曲库排最前');
  assert.equal(DEFAULT_SOURCE_PRIORITY[1], 'kugou');
  assert.deepEqual(resolveLookupOrder(null, available, 'netease'),
    ['kuwo', 'kugou', 'bodian', 'qq', 'joox'], '默认顺序生效且失败来源被排除');
});

test('user order wins, disabled sources never queried, order is stable and deduped', () => {
  assert.deepEqual(resolveLookupOrder({ order: ['qq', 'netease'], disabled: ['joox'] }, available),
    ['qq', 'netease', 'kuwo', 'kugou', 'bodian'], '用户顺序优先，缺位按默认补齐，禁用丢弃');
  assert.deepEqual(resolveLookupOrder({ order: ['joox', 'joox', 'qq'], disabled: [] }, available),
    ['joox', 'qq', 'kuwo', 'kugou', 'bodian', 'netease'], '重复项去重且保序');
  assert.deepEqual(resolveLookupOrder(defaultSourcePriority(), ['kuwo', 'kugou']),
    ['kuwo', 'kugou'], '只查询可用来源');
  assert.deepEqual(resolveLookupOrder({ order: [], disabled: ['netease', 'qq', 'bodian', 'kugou', 'joox'] }, available),
    ['kuwo'], '空顺序回落默认，全禁用只余可用项');
});

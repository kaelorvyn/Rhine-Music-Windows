// scripts/check-lyrics.mjs —— 歌词匹配与协议契约（合成夹具，无真网络）。
// 覆盖：LDDC 思路匹配、酷我歌词协议编解码（KuwoMusicLRC_API 协议）、
// 网易云/酷狗歌词口、跨源解析管线（本源优先→跨源匹配→如实全败）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import {
  unifiedSymbol, textDifference, titleScore, artistScore, matchScore, pickBestMatch,
  encodeKuwoParams, decodeKuwoLyrics, convertKuwoLrc,
  kuwoLyrics, neteaseLyrics, kugouLyrics, resolveLyrics,
} from './lyrics.mjs';

const XOR_KEY = Buffer.from('yeelion');
const xor = input => Buffer.from(input.map((byte, i) => byte ^ XOR_KEY[i % XOR_KEY.length]));

test('匹配基础：符号统一、相似度、标题评分', () => {
  assert.equal(unifiedSymbol('青花瓷（Live）'), '青花瓷(Live)');
  assert.equal(textDifference('abc', 'abc'), 1);
  assert.equal(textDifference('abcd', 'abce'), 0.75);
  assert.equal(titleScore('青花瓷', '青花瓷'), 100);
  const liveScore = titleScore('青花瓷 (Live)', '青花瓷');
  assert.ok(liveScore > 40 && liveScore < 100, `同名带版本标签折算得分（实际 ${liveScore}）`);
  assert.ok(titleScore('七里香', '青花瓷') < 30, '不相关标题得低分');
});

test('歌手列表配对与加权评分、时长淘汰、弱标题扣分', () => {
  assert.equal(artistScore('周杰伦', '周杰伦'), 100);
  assert.ok(artistScore('周杰伦/费玉清', '费玉清/周杰伦') === 100, '列表顺序无关的最大配对');
  const query = { title: '青花瓷', artist: '周杰伦', album: '我很忙', duration: 200 };
  assert.ok(matchScore(query, { title: '青花瓷', artist: '周杰伦', album: '我很忙', duration: 201 }) > 95);
  assert.equal(matchScore(query, { title: '青花瓷', artist: '周杰伦', duration: 300 }), -1, '时长差>4s 淘汰');
  assert.ok(matchScore({ title: 'abc', artist: '', duration: 0 }, { title: '青花瓷', artist: '周杰伦', duration: 0 }) < 30);
  const best = pickBestMatch(query, [
    { title: '青花瓷', artist: '周杰伦', duration: 203 },
    { title: '青花瓷 (Live)', artist: '周杰伦', duration: 200 },
    { title: '青花瓷', artist: '某翻唱', duration: 200 },
  ]);
  assert.equal(best.candidate.artist, '周杰伦');
  assert.ok(best.score >= 60);
  assert.equal(pickBestMatch(query, [{ title: '不相关', artist: '无关', duration: 200 }]), null);
});

test('酷我歌词协议：参数编码与响应解码回环', () => {
 // XOR(yeelion) 对称性：加密两次还原明文
  const plain = 'user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_65633689&lrcx=1';
  assert.equal(xor(xor(Buffer.from(plain))).toString(), plain, 'XOR(yeelion) 对称');
  assert.ok(Buffer.from(encodeKuwoParams('65633689'), 'base64').length > 0, '参数产出非空密文');
 // 非 lrcx：tp=content + deflate(明文 LRC)
  const lrc = '[00:01.00]first line';
  const raw = Buffer.concat([Buffer.from('tp=content\r\n\r\n'), deflateSync(Buffer.from(lrc))]);
  assert.equal(decodeKuwoLyrics(raw, false), lrc);
 // lrcx：deflate(base64(XOR(gb18030 明文)))
  const lrcxBytes = Buffer.concat([Buffer.from('[00:01.000]<0,0>'), Buffer.from([0xb4, 0xca])]);
  const rawX = Buffer.concat([Buffer.from('tp=content\r\n\r\n'), deflateSync(xor(lrcxBytes).toString('base64'))]);
  assert.equal(decodeKuwoLyrics(rawX, true), '[00:01.000]<0,0>词');
  assert.equal(decodeKuwoLyrics(Buffer.from('not-lyrics'), true), '', '格式不符如实返回空');
});

test('酷我逐字 LRCX 转标准 LRC 对（含翻译行）', () => {
  const pair = convertKuwoLrc([
    '[kuwo:11]',
    '[00:12.000]<1,2>青花瓷<3,4>副歌',
    '[00:12.000]<0,0>blue and white porcelain',
    '[00:20.000]<0,0>第二句原文',
    '[00:20.000]<0,0>第二句翻译',
  ].join('\n'));
  assert.match(pair.original, /^\[00:12\.000\]青花瓷副歌/m);
  assert.match(pair.original, /^\[00:20\.000\]第二句原文/m);
  assert.match(pair.translated, /^\[00:12\.000\]blue and white porcelain/m);
  assert.match(pair.translated, /^\[00:20\.000\]第二句翻译/m);
});

test('各平台歌词口（合成响应）', async () => {
 // 真实协议载荷为 gb18030 字节（词 = b4 ca），夹具按真实字节构造
  const kwInner = xor(Buffer.concat([Buffer.from('[00:01.000]<1,2>'), Buffer.from([0xb4, 0xca])])).toString('base64');
  const kuwoPayload = Buffer.concat([Buffer.from('tp=content\r\n\r\n'), deflateSync(Buffer.from(kwInner))]);
  const kuwo = await kuwoLyrics('65633689', { fetchImpl: async () => ({ ok: true, arrayBuffer: async () => kuwoPayload.buffer.slice(kuwoPayload.byteOffset, kuwoPayload.byteOffset + kuwoPayload.byteLength) }) });
  assert.match(kuwo.original, /\[00:01\.000\]词/);
  const netease = await neteaseLyrics('186016', { fetchImpl: async () => ({ ok: true, json: async () => ({ code: 200, lrc: { lyric: '[00:01]歌词' }, tlyric: { lyric: '[00:01]译' } }) }) });
  assert.equal(netease.original, '[00:01]歌词');
  assert.equal(netease.translated, '[00:01]译');
  const kugou = await kugouLyrics('HASH123', 200000, { fetchImpl: async url => ({ ok: true, text: async () => String(url).includes('timelength=200000') ? '[id:$00000000]\n[00:01.00]第一句' : '' }) });
  assert.match(kugou.original, /第一句/);
});

test('跨源解析管线：本源优先、跨源匹配、如实全败', async () => {
 // 本源有歌词 → 直接返回，不触发跨源
  const own = await resolveLyrics(
    { title: '青花瓷', artist: '周杰伦', duration: 200, provider: 'netease', id: '186016' },
    { catalogs: { netease: { songInfo: async () => ({ lyrics: { original: '[00:01]本源歌词', translated: '', instrumental: false, unavailable: false } }) }, kuwo: { search: async () => { throw new Error('不应触发跨源'); } } } },
  );
  assert.equal(own.source, 'netease');
  assert.equal(own.original, '[00:01]本源歌词');

 // 本源无歌词 → 跨源按 歌名+歌手+时长 匹配酷我变体并取到歌词
  const kwCrossInner = xor(Buffer.concat([Buffer.from('[00:01.000]<1,2>'), Buffer.from([0xbf, 0xe7, 0xd4, 0xb4, 0xb8, 0xe8, 0xb4, 0xca])])).toString('base64');
  const kuwoPayload = Buffer.concat([Buffer.from('tp=content\r\n\r\n'), deflateSync(Buffer.from(kwCrossInner))]);
  const crossed = await resolveLyrics(
    { title: '青花瓷', artist: '周杰伦', duration: 200, provider: 'qq', id: '9' },
    {
      catalogs: {
        qq: { songInfo: async () => ({ lyrics: { original: '', translated: '', instrumental: false, unavailable: true } }) },
        kuwo: {
          search: async () => ({
            tracks: [
              { id: '7001', title: '青花瓷', artist: '周杰伦', duration: 300, onlineSource: { provider: 'kuwo', id: '7001', albumTitle: '依然范特西' } },
              { id: '5001', title: '青花瓷', artist: '周杰伦', duration: 201, onlineSource: { provider: 'kuwo', id: '5001', albumTitle: '我很忙' } },
            ],
          }),
        },
      },
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => kuwoPayload.buffer.slice(kuwoPayload.byteOffset, kuwoPayload.byteOffset + kuwoPayload.byteLength) }),
    },
  );
  assert.equal(crossed.source, 'kuwo');
  assert.match(crossed.original, /跨源歌词/);
  assert.ok(crossed.score >= 60);

 // 全败 → 如实 unavailable，不编造
  const none = await resolveLyrics(
    { title: '不存在的歌', artist: '无此人', duration: 100, provider: 'qq', id: '9' },
    { catalogs: { qq: { songInfo: async () => ({ lyrics: { original: '', translated: '', instrumental: false, unavailable: true } }) }, kuwo: { search: async () => ({ tracks: [{ id: '1', title: '完全无关', artist: '无关', duration: 500, onlineSource: { provider: 'kuwo', id: '1' } }] }) } } },
  );
  assert.equal(none.unavailable, true);
  assert.equal(none.original, '');
});

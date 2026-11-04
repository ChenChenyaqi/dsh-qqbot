import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractStickerMarks,
  normalizeStickerName,
  StickerRegistry,
  planStickerDelivery,
  StickerDeliverer,
  resolveStickerDir,
} from './stickers.ts';
import type { ImQQBotConfig, StickersConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('extractStickerMarks', () => {
  it('提取标记并剥离出干净文本', () => {
    const { cleanText, marks } = extractStickerMarks('在[表情:问号]\n\n又熬夜？[表情:得意]');
    expect(cleanText).toBe('在\n\n又熬夜？');
    expect(marks).toHaveLength(2);
    expect(marks[0]).toEqual({ raw: '问号', offset: 1 });   // “在”之后
    expect(marks[1]).toEqual({ raw: '得意', offset: 7 });   // “又熬夜？”之后（含 \n\n）
  });

  it('支持全角冒号与名字两侧空格', () => {
    const { marks } = extractStickerMarks('[表情： 摸鱼 ]');
    expect(marks).toEqual([{ raw: '摸鱼', offset: 0 }]);
  });

  it('无标记时原样返回', () => {
    const { cleanText, marks } = extractStickerMarks('普通回复');
    expect(cleanText).toBe('普通回复');
    expect(marks).toEqual([]);
  });

  it('名字含方括号或换行不匹配（防误吞结构化文本）', () => {
    const { cleanText, marks } = extractStickerMarks('[表情:a[b]\n[表情:c\nd]');
    expect(marks).toEqual([]);
    expect(cleanText).toBe('[表情:a[b]\n[表情:c\nd]');
  });
});

describe('normalizeStickerName', () => {
  it('去空白 + 小写', () => {
    expect(normalizeStickerName('  摸鱼 ')).toBe('摸鱼');
    expect(normalizeStickerName('OK')).toBe('ok');
  });
});

describe('StickerRegistry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stickers-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('扫描图片文件，文件名去扩展名为规范名', () => {
    writeFileSync(join(dir, '摸鱼.gif'), 'x');
    writeFileSync(join(dir, '得意.PNG'), 'x');
    writeFileSync(join(dir, 'readme.txt'), 'x');       // 非图片忽略
    mkdirSync(join(dir, 'subdir'));                     // 目录忽略

    const registry = new StickerRegistry(dir, createLogger());
    expect(registry.names()).toEqual(['得意', '摸鱼']);
    expect(registry.resolve('摸鱼')).toBe(join(dir, '摸鱼.gif'));
    expect(registry.resolve('  得意 ')).toBe(join(dir, '得意.PNG'));  // 大小写/空白容错
    expect(registry.resolve('不存在')).toBeUndefined();
  });

  it('目录不存在 → 空列表 + 一次性 warn', () => {
    const logger = createLogger();
    const registry = new StickerRegistry(join(dir, 'nope'), logger);
    expect(registry.names()).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    registry.names();
    expect(logger.warn).toHaveBeenCalledTimes(1);  // 不重复 warn
  });
});

describe('planStickerDelivery', () => {
  const files = new Map([
    ['问号', '/s/问号.png'],
    ['得意', '/s/得意.png'],
    ['摸鱼', '/s/摸鱼.gif'],
  ]);
  const splitOn = { enabled: true, minParagraph: 0, maxMessages: 4 };

  it('表情紧跟所属段落之后（标记位置 = 表情位置）', () => {
    const { items } = planStickerDelivery('在[表情:问号]\n\n又熬夜？[表情:得意]', files, {
      limit: 4500, split: splitOn, maxPerTurn: 1, budget: 4,
    });
    expect(items).toEqual([
      { kind: 'text', content: '在' },
      { kind: 'sticker', name: '问号', path: '/s/问号.png' },
      { kind: 'text', content: '又熬夜？' },
    ]);
  });

  it('maxPerTurn=1：多个标记只保留第一个', () => {
    const { items } = planStickerDelivery('在[表情:问号]\n\n又熬夜？[表情:得意]', files, {
      limit: 4500, split: splitOn, maxPerTurn: 1, budget: 4,
    });
    expect(items.filter((i) => i.kind === 'sticker')).toHaveLength(1);
  });

  it('maxPerTurn=2：可保留两个', () => {
    const { items } = planStickerDelivery('一[表情:问号]\n\n二[表情:得意]', files, {
      limit: 4500, split: splitOn, maxPerTurn: 2, budget: 4,
    });
    expect(items.filter((i) => i.kind === 'sticker')).toHaveLength(2);
    expect(items.map((i) => i.kind)).toEqual(['text', 'sticker', 'text', 'sticker']);
  });

  it('名字未命中表情库 → 忽略标记（不裸露给用户）', () => {
    const { items, cleanText } = planStickerDelivery('好的[表情:不存在的]', files, {
      limit: 4500, split: splitOn, maxPerTurn: 1, budget: 4,
    });
    expect(cleanText).toBe('好的');
    expect(items).toEqual([{ kind: 'text', content: '好的' }]);
  });

  it('预算裁剪：文本+表情超预算时丢表情保文本', () => {
    // 4 段文本 + 1 表情 = 5 > budget 4 → 表情被丢
    const { items } = planStickerDelivery('一\n\n二\n\n三[表情:摸鱼]\n\n四', files, {
      limit: 4500, split: splitOn, maxPerTurn: 1, budget: 4,
    });
    expect(items).toHaveLength(4);
    expect(items.every((i) => i.kind === 'text')).toBe(true);
  });

  it('预算内：表情占用名额但仍发出（3 文本 + 1 表情 = 4）', () => {
    const { items } = planStickerDelivery('一\n\n二\n\n三[表情:摸鱼]', files, {
      limit: 4500, split: splitOn, maxPerTurn: 1, budget: 4,
    });
    expect(items).toHaveLength(4);
    expect(items[3]).toEqual({ kind: 'sticker', name: '摸鱼', path: '/s/摸鱼.gif' });
  });

  it('split 未启用：表情降级跟在全部文本后', () => {
    const { items } = planStickerDelivery('一句[表情:问号]', files, {
      limit: 4500, maxPerTurn: 1, budget: 4,
    });
    expect(items).toEqual([
      { kind: 'text', content: '一句' },
      { kind: 'sticker', name: '问号', path: '/s/问号.png' },
    ]);
  });

  it('纯表情消息：无文本时表情独立发出（不在找块时丢弃）', () => {
    const { items, cleanText } = planStickerDelivery('[表情:摸鱼]', files, {
      limit: 4500, split: splitOn, maxPerTurn: 1, budget: 4,
    });
    expect(cleanText).toBe('');
    expect(items).toEqual([{ kind: 'sticker', name: '摸鱼', path: '/s/摸鱼.gif' }]);
  });

  it('纯表情但名字不存在：全部静默丢弃，不发任何消息', () => {
    const { items } = planStickerDelivery('[表情:幻觉]', files, {
      limit: 4500, split: splitOn, maxPerTurn: 1, budget: 4,
    });
    expect(items).toEqual([]);
  });

  it('标记带尾随空白：剥离后无文本，表情仍独立发出', () => {
    const { items } = planStickerDelivery('[表情:摸鱼]\n\n', files, {
      limit: 4500, split: splitOn, maxPerTurn: 1, budget: 4,
    });
    expect(items).toEqual([{ kind: 'sticker', name: '摸鱼', path: '/s/摸鱼.gif' }]);
  });

  it('无标记时纯文本计划（与分段行为一致）', () => {
    const { items } = planStickerDelivery('一\n\n二', files, {
      limit: 4500, split: splitOn, maxPerTurn: 1, budget: 4,
    });
    expect(items).toEqual([
      { kind: 'text', content: '一' },
      { kind: 'text', content: '二' },
    ]);
  });
});

describe('StickerDeliverer', () => {
  const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };

  function createDeliverer(stickers: StickersConfig, withFiles = true): {
    deliverer: StickerDeliverer;
    sendMarkdown: ReturnType<typeof vi.fn>;
    sendImage: ReturnType<typeof vi.fn>;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'stickers-'));
    if (withFiles) {
      writeFileSync(join(dir, '摸鱼.gif'), 'x');
      writeFileSync(join(dir, '问号.png'), 'x');
    }
    const config = {
      textChunkLimit: 4500,
      splitMessages: { enabled: true, minParagraph: 0, maxMessages: 4 },
      stickers,
    } as unknown as ImQQBotConfig;
    const sendImage = vi.fn().mockResolvedValue({ upload: { file_uuid: 'u' } });
    const mediaSender = { sendImage, sendVideo: vi.fn(), sendVoice: vi.fn(), sendFile: vi.fn() };
    const deliverer = new StickerDeliverer(
      new StickerRegistry(dir, createLogger()),
      mediaSender as never,
      config,
      createLogger(),
    );
    return { deliverer, sendMarkdown: vi.fn().mockResolvedValue(undefined), sendImage };
  }

  afterEach(() => {
    // mkdtempSync 在各用例内创建，交由系统 tmp 清理；无需显式删除
  });

  it('plan + deliver：文本与表情按序发送', async () => {
    const { deliverer, sendMarkdown, sendImage } = createDeliverer(
      { enabled: true, dir: '', maxPerTurn: 1 },
    );
    const items = deliverer.plan('在[表情:问号]\n\n又熬夜？');
    const bot = { sendMarkdown };

    await deliverer.deliver(c2cTarget, items, bot as never);

    expect(sendMarkdown).toHaveBeenNthCalledWith(1, c2cTarget, '在');
    expect(sendImage).toHaveBeenNthCalledWith(1, c2cTarget, { localPath: expect.stringContaining('问号.png') });
    expect(sendMarkdown).toHaveBeenNthCalledWith(2, c2cTarget, '又熬夜？');
  });

  it('表情发送失败不中断后续文本', async () => {
    const { deliverer, sendMarkdown, sendImage } = createDeliverer(
      { enabled: true, dir: '', maxPerTurn: 1 },
    );
    sendImage.mockRejectedValue(new Error('upload failed'));
    const items = deliverer.plan('在[表情:问号]\n\n又熬夜？');

    await deliverer.deliver(c2cTarget, items, { sendMarkdown } as never);

    expect(sendMarkdown).toHaveBeenCalledTimes(2);  // 表情失败，两条文本照发
  });

  it('enabled=false：plan 退化为纯文本切分', () => {
    const { deliverer } = createDeliverer({ enabled: false, dir: '', maxPerTurn: 1 });
    expect(deliverer.enabled).toBe(false);
    expect(deliverer.plan('一\n\n二')).toEqual([{ kind: 'text', content: '一\n\n二' }]);
  });
});

describe('resolveStickerDir', () => {
  it('空配置 → 默认 ~/.dsh-qqbot/stickers', () => {
    expect(resolveStickerDir('')).toMatch(/\.dsh-qqbot\/stickers$/);
    expect(resolveStickerDir(undefined)).toBe(resolveStickerDir(''));
  });

  it('显式配置优先', () => {
    expect(resolveStickerDir('/data/stickers')).toBe('/data/stickers');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OutboundBuffer } from './outbound-buffer.ts';
import type { QQBotSender, StreamSessionLike } from './outbound-buffer.ts';
import type { Logger, ReplyTarget } from '../types.ts';

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createSession(): StreamSessionLike {
  return { update: vi.fn().mockResolvedValue(undefined), complete: vi.fn().mockResolvedValue(undefined) };
}

function createBot(openStreamImpl?: () => StreamSessionLike): QQBotSender {
  return {
    sendMarkdown: vi.fn().mockResolvedValue(undefined),
    openStream: vi.fn(openStreamImpl ?? (() => createSession())),
  };
}

const c2cTarget: ReplyTarget = { scope: 'c2c', targetId: 'user1', msgId: 'msg1' };

describe('OutboundBuffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('流式开启：append + flush → openStream + update + complete', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const buffer = new OutboundBuffer(c2cTarget, bot, 4500, createLogger(), true);

    buffer.append('hello');
    await buffer.flush();

    expect(bot.openStream).toHaveBeenCalledTimes(1);
    expect(session.update).toHaveBeenCalledWith('hello');
    expect(session.complete).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).not.toHaveBeenCalled();
  });

  it('流式关闭：append + flush → 静态 sendMarkdown', async () => {
    const bot = createBot();
    const buffer = new OutboundBuffer(c2cTarget, bot, 4500, createLogger(), false);

    buffer.append('hello');
    await buffer.flush();

    expect(bot.openStream).not.toHaveBeenCalled();
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, 'hello');
  });

  it('流式开启但 openStream 失败 → 降级静态 sendMarkdown', async () => {
    const bot = createBot(() => {
      throw new Error('open failed');
    });
    const buffer = new OutboundBuffer(c2cTarget, bot, 4500, createLogger(), true);

    buffer.append('hello');
    await vi.advanceTimersByTimeAsync(200);
    await buffer.flush();

    // 流式从未成功发送 → 降级静态
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, 'hello');
  });

  it('cancel → abort 关闭会话', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const buffer = new OutboundBuffer(c2cTarget, bot, 4500, createLogger(), true);

    buffer.append('hello');
    await vi.advanceTimersByTimeAsync(200);
    buffer.cancel();
    await vi.runAllTimersAsync();

    expect(session.complete).toHaveBeenCalledTimes(1);
  });

  it('reset 清空累积文本并保留流式会话', async () => {
    const session = createSession();
    const bot = createBot(() => session);
    const buffer = new OutboundBuffer(c2cTarget, bot, 4500, createLogger(), true);

    buffer.append('old');
    await vi.advanceTimersByTimeAsync(200);
    expect(session.update).toHaveBeenCalledWith('old');

    buffer.reset();
    expect(buffer.text).toBe('');

    buffer.append('new');
    await buffer.flush();

    expect(bot.openStream).toHaveBeenCalledTimes(1); // 会话复用
    expect(session.update).toHaveBeenNthCalledWith(2, 'new'); // 全量替换
    expect(session.complete).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).not.toHaveBeenCalled(); // 不降级静态
  });

  it('分段启用：flush 静态发送时按段落拆多条', async () => {
    const bot = createBot();
    const buffer = new OutboundBuffer(c2cTarget, bot, 4500, createLogger(), false, {
      enabled: true,
      minParagraph: 0,
      maxMessages: 4,
    });

    buffer.append('第一句。\n\n第二句。\n\n第三句。');
    await buffer.flush();

    expect(bot.sendMarkdown).toHaveBeenCalledTimes(3);
    expect(bot.sendMarkdown).toHaveBeenNthCalledWith(1, c2cTarget, '第一句。');
    expect(bot.sendMarkdown).toHaveBeenNthCalledWith(2, c2cTarget, '第二句。');
    expect(bot.sendMarkdown).toHaveBeenNthCalledWith(3, c2cTarget, '第三句。');
  });

  it('分段未启用（split.enabled=false）：维持单条发送', async () => {
    const bot = createBot();
    const buffer = new OutboundBuffer(c2cTarget, bot, 4500, createLogger(), false, {
      enabled: false,
      minParagraph: 0,
      maxMessages: 4,
    });

    buffer.append('第一句。\n\n第二句。');
    await buffer.flush();

    expect(bot.sendMarkdown).toHaveBeenCalledTimes(1);
    expect(bot.sendMarkdown).toHaveBeenCalledWith(c2cTarget, '第一句。\n\n第二句。');
  });
});

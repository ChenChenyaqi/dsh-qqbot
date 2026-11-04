/**
 * 表情包（stickers）— 模型驱动的表情发送
 *
 * 流程：prompt 注入表情文件名列表 → 模型在回复文本中插入 [表情:名字] 标记 →
 * 出站层解析标记、剥离出干净文本、按段落生成投递计划（表情紧跟所属段落之后）→
 * 统一执行器按序发送（文本 sendMarkdown / 表情 sendImage）。
 *
 * 名额预算：表情与文本共享被动回复限额（文本+表情 ≤ budget，默认 4），
 * 超预算丢表情保文本；maxPerTurn 限制每轮表情数（默认 1，只发 0 或 1 张）。
 */
import { readdirSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { PLUGIN_HOME } from '../shared/dirs.ts';
import type { ImQQBotConfig } from '../config.ts';
import type { Logger, ReplyTarget } from '../types.ts';
import type { MediaSenderLike } from '../media/send-media.ts';
import type { QQBotSender } from './outbound-buffer.ts';
import { chunkMarkdownText, splitMarkdownParagraphs, type SplitMessagesOptions } from './chunker.ts';

/** 表情图片支持的扩展名（与 send-media 的 IMAGE_EXTS 对齐） */
const STICKER_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/** 标记语法：[表情:名字]（全角/半角冒号均可，名字内不能有换行与方括号） */
const STICKER_MARK_RE = /\[表情[:：]\s*([^\[\]\n]+?)\s*\]/g;

/** prompt 中列出的表情名上限（防表情库过大撑爆 prompt） */
const PROMPT_NAME_LIMIT = 100;

/** 与 bootstrap 的 ReplyLimiter({ limit: 4 }) 对齐：一轮文本+表情的总条数预算 */
export const PASSIVE_REPLY_BUDGET = 4;

/** 表情包目录：显式配置优先，缺省 ~/.dsh-qqbot/stickers */
export function resolveStickerDir(dirConfig: string | undefined): string {
  return dirConfig || resolve(PLUGIN_HOME, 'stickers');
}

/** 名字规范化：去首尾空白 + 小写（文件名匹配容错） */
export function normalizeStickerName(name: string): string {
  return name.trim().toLowerCase();
}

export interface StickerMark {
  /** 模型写的名字原文 */
  raw: string;
  /** 标记前面文本在 cleanText 中的结束位置（表情归属该位置的段落） */
  offset: number;
}

/**
 * 提取文本中的表情标记，返回剥离标记后的干净文本与标记位置。
 * 不做名字校验（是否命中表情库由投递计划决定）。
 */
export function extractStickerMarks(text: string): { cleanText: string; marks: StickerMark[] } {
  const marks: StickerMark[] = [];
  let cleanText = '';
  let last = 0;
  for (const m of text.matchAll(STICKER_MARK_RE)) {
    cleanText += text.slice(last, m.index);
    marks.push({ raw: m[1] ?? '', offset: cleanText.length });
    last = m.index + m[0].length;
  }
  cleanText += text.slice(last);
  return { cleanText, marks };
}

/**
 * 表情库注册表：扫描目录（TTL 缓存），文件名去扩展名为规范名。
 *
 * 同步接口（readdirSync）：prompt section 的 text 是同步函数，目录小、
 * 有 TTL 缓存，同步读开销可忽略。目录不存在/不可读 → 空表 + 一次性 warn。
 */
export class StickerRegistry {
  private cache: Map<string, string> | null = null;
  private expiresAt = 0;
  private warned = false;

  public constructor(
    private readonly dir: string,
    private readonly logger: Logger,
    private readonly ttlMs = 30_000,
  ) {}

  /** 规范名 → 绝对路径 映射（TTL 缓存） */
  private entries(): Map<string, string> {
    const now = Date.now();
    if (this.cache !== null && now < this.expiresAt) return this.cache;

    const map = new Map<string, string>();
    try {
      for (const dirent of readdirSync(this.dir, { withFileTypes: true })) {
        if (!dirent.isFile()) continue;
        const ext = extname(dirent.name).toLowerCase();
        if (!STICKER_EXTS.has(ext)) continue;
        const norm = normalizeStickerName(basename(dirent.name, extname(dirent.name)));
        if (norm !== '' && !map.has(norm)) map.set(norm, join(this.dir, dirent.name));
      }
      this.warned = false;
    } catch (err) {
      if (!this.warned) {
        this.logger.warn(
          `im-qqbot: sticker dir unreadable (${this.dir}): ${err instanceof Error ? err.message : String(err)}`,
        );
        this.warned = true;
      }
    }
    this.cache = map;
    this.expiresAt = now + this.ttlMs;
    return map;
  }

  /** 可用表情名列表（按文件名排序，注入 prompt 用） */
  public names(): string[] {
    return [...this.entries().keys()].sort().slice(0, PROMPT_NAME_LIMIT);
  }

  /** 名字（原文或规范形式）→ 绝对路径；未命中返回 undefined */
  public resolve(rawName: string): string | undefined {
    return this.entries().get(normalizeStickerName(rawName));
  }

  /** 规范名 → 路径 映射的浅拷贝（投递计划用） */
  public asMap(): Map<string, string> {
    return new Map(this.entries());
  }

  /** 测试用：丢弃缓存强制下次重扫 */
  public invalidate(): void {
    this.cache = null;
    this.expiresAt = 0;
  }
}

/** 投递计划条目：文本消息或表情图片 */
export type DeliveryItem =
  | { kind: 'text'; content: string }
  | { kind: 'sticker'; name: string; path: string };

interface StickerPlacement {
  /** 插在该文本条目（含）之后 */
  afterIndex: number;
  name: string;
  path: string;
}

/**
 * 生成文本+表情投递计划。
 *
 * - split 启用：cleanText 按段落拆分（复用 splitMarkdownParagraphs），每个标记
 *   归属其 offset 所在段落，表情紧跟该段文本之后发出（标记位置 = 表情位置）
 * - split 未启用：文本按 chunkMarkdownText 单条/超长切分，表情降级为
 *   跟在全部文本之后（无分段则无法保留位置语义）
 *
 * 裁剪规则（优先级从高到低）：
 * 1. 名字未命中表情库 / 所属块 oversized（会被二次切分）→ 忽略该标记
 * 2. 每轮最多 maxPerTurn 张（按出现顺序保留）
 * 3. 文本条数 + 表情数 ≤ budget（被动回复限额）：丢末尾的表情保文本
 */
export function planStickerDelivery(
  text: string,
  files: Map<string, string>,
  opts: { limit: number; split?: SplitMessagesOptions; maxPerTurn: number; budget: number },
): { items: DeliveryItem[]; cleanText: string } {
  const { limit, split, maxPerTurn, budget } = opts;
  const { cleanText, marks } = extractStickerMarks(text);

  if (split?.enabled) {
    const blocks = splitMarkdownParagraphs(cleanText, {
      limit,
      minParagraph: split.minParagraph,
      maxMessages: split.maxMessages,
    });

    // 文本条目（oversized 块内部二次切分，条数会增多）
    const textItems: Array<{ kind: 'text'; content: string }> = [];
    const blockSpans: Array<{ start: number; end: number; firstIndex: number; lastIndex: number; oversized: boolean }> = [];
    for (const block of blocks) {
      const firstIndex = textItems.length;
      if (block.oversized) {
        for (const chunk of chunkMarkdownText(block.text, limit)) {
          textItems.push({ kind: 'text', content: chunk });
        }
      } else {
        textItems.push({ kind: 'text', content: block.text });
      }
      blockSpans.push({
        start: block.start,
        end: block.end,
        firstIndex,
        lastIndex: textItems.length - 1,
        oversized: block.oversized,
      });
    }

    // 有效标记：名字命中 + 归属块非 oversized；offset == 前块 end 时归前块（标记物理位置在块尾）
    const placements: StickerPlacement[] = [];
    for (const mark of marks) {
      const path = files.get(normalizeStickerName(mark.raw));
      if (path === undefined) continue;
      const span = blockSpans.find((s) => mark.offset >= s.start && mark.offset <= s.end);
      if (span === undefined || span.oversized) continue;
      placements.push({ afterIndex: span.lastIndex, name: mark.raw, path });
    }

    // maxPerTurn 与预算裁剪：超预算时丢末尾表情保文本
    let kept = placements.slice(0, Math.max(0, maxPerTurn));
    while (kept.length > 0 && textItems.length + kept.length > budget) {
      kept = kept.slice(0, -1);
    }

    // 交织组装：文本 … 表情 文本 …
    const items: DeliveryItem[] = [];
    let cursor = 0;
    for (const sticker of kept) {
      items.push(...textItems.slice(cursor, sticker.afterIndex + 1));
      items.push({ kind: 'sticker', name: sticker.name, path: sticker.path });
      cursor = sticker.afterIndex + 1;
    }
    items.push(...textItems.slice(cursor));
    return { items, cleanText };
  }

  // split 未启用：无分段语义，表情降级跟在全部文本后（仅第一张）
  const items: DeliveryItem[] = chunkMarkdownText(cleanText, limit)
    .map((content) => ({ kind: 'text' as const, content }));
  if (maxPerTurn > 0 && items.length + 1 <= budget) {
    for (const mark of marks) {
      const path = files.get(normalizeStickerName(mark.raw));
      if (path !== undefined) {
        items.push({ kind: 'sticker', name: mark.raw, path });
        break;
      }
    }
  }
  return { items, cleanText };
}

/**
 * 表情投递器：计划生成 + 统一执行。
 *
 * 出站两条文本路径（OutboundRouter 静态发送、OutboundBuffer flush 降级）
 * 共用本执行器，保证表情标记在这两条路径下都能解析并按序发送。
 */
export class StickerDeliverer {
  public constructor(
    private readonly registry: StickerRegistry,
    private readonly mediaSender: MediaSenderLike,
    private readonly config: ImQQBotConfig,
    private readonly logger: Logger,
  ) {}

  public get enabled(): boolean {
    return this.config.stickers?.enabled === true;
  }

  /** 生成投递计划（表情库未命中时退化为纯文本条目） */
  public plan(text: string): DeliveryItem[] {
    const stickers = this.config.stickers;
    if (stickers === undefined || !stickers.enabled) {
      return chunkMarkdownText(text, this.config.textChunkLimit)
        .map((content) => ({ kind: 'text' as const, content }));
    }
    const { items } = planStickerDelivery(text, this.registry.asMap(), {
      limit: this.config.textChunkLimit,
      split: this.config.splitMessages as SplitMessagesOptions | undefined,
      maxPerTurn: stickers.maxPerTurn,
      budget: PASSIVE_REPLY_BUDGET,
    });
    return items;
  }

  /** 按序执行：文本 sendMarkdown（错误吞掉记日志），表情 sendImage（失败仅 warn 不中断） */
  public async deliver(target: ReplyTarget, items: DeliveryItem[], bot: QQBotSender): Promise<void> {
    for (const item of items) {
      if (item.kind === 'text') {
        if (!item.content.trim()) continue;
        try {
          await bot.sendMarkdown(target, item.content);
        } catch (err) {
          this.logger.error(`im-qqbot: sticker delivery text failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      try {
        await this.mediaSender.sendImage(target, { localPath: item.path });
      } catch (err) {
        this.logger.warn(`im-qqbot: send sticker "${item.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

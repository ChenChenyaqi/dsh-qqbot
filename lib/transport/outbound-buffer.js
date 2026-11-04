import { planTextChunks } from "./chunker.js";
import { StreamingWriter } from "./streaming-writer.js";
/** 流式输出节流间隔(ms)：连续 chunk 累积后停顿该间隔才推送 */
const STREAM_THROTTLE_MS = 200;
export class OutboundBuffer {
    buffer = '';
    flushing = false;
    writer;
    bot;
    limit;
    logger;
    /** 段落分条发送选项（undefined = 维持单条切分行为） */
    split;
    /** 表情投递器（undefined = 纯文本路径）；流式成功时不走此路径 */
    stickerDeliverer;
    /** 构造时拍下的发送目标，本缓冲生命周期内不跟随会话 replyTarget 变化 */
    target;
    constructor(target, bot, limit, logger, streamingEnabled, split, stickerDeliverer) {
        this.bot = bot;
        this.limit = limit;
        this.logger = logger;
        this.target = target;
        this.split = split?.enabled ? split : undefined;
        this.stickerDeliverer = stickerDeliverer?.enabled ? stickerDeliverer : undefined;
        this.writer = streamingEnabled
            ? new StreamingWriter({ bot, target: this.target, logger, throttleMs: STREAM_THROTTLE_MS })
            : null;
    }
    /** 追加文本增量 */
    append(text) {
        this.buffer += text;
        this.writer?.append(text);
    }
    /** 获取当前累积文本 */
    get text() {
        return this.buffer;
    }
    /** 重置累积文本（LLM 重试的新 attempt），流式会话保留由全量 update 重写 */
    reset() {
        this.buffer = '';
        this.writer?.reset();
    }
    /** 发送所有累积文本：流式优先，降级静态 */
    async flush() {
        if (this.flushing || !this.buffer.trim())
            return;
        this.flushing = true;
        try {
            if (this.writer) {
                await this.writer.finish();
                // 流式成功（未降级）→ 直接返回
                if (!this.writer.shouldFallback)
                    return;
            }
            // 降级：静态发送（writer 不存在 or 流式失败）；启用分段时按段落拆多条，
            // 启用表情时解析 [表情:名字] 标记并按序投递（文本+表情）
            if (this.stickerDeliverer !== undefined) {
                const items = this.stickerDeliverer.plan(this.buffer);
                await this.stickerDeliverer.deliver(this.target, items, this.bot);
            }
            else {
                const chunks = planTextChunks(this.buffer, this.limit, this.split);
                for (const chunk of chunks) {
                    await this.bot.sendMarkdown(this.target, chunk);
                }
            }
        }
        catch (err) {
            this.logger.error(`im-qqbot: flush failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        finally {
            this.buffer = '';
            this.flushing = false;
        }
    }
    /** 取消（异常/丢弃），中止流式并清空缓冲 */
    cancel() {
        this.writer?.abort();
        this.buffer = '';
    }
}
//# sourceMappingURL=outbound-buffer.js.map
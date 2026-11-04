/**
 * Markdown 文本切分器
 *
 * QQ 单条消息有字符数限制（约 5000），需要在合适边界切分，
 * 并保持 GFM 表格、代码块的完整性。
 */
const CODE_FENCE_OPEN = /^```/;
const GFM_TABLE_LINE = /^\|.+\|$/;
/**
 * 按 Markdown 段落（空行边界）拆分文本为多个消息块。
 *
 * 保护规则：
 * - 代码块（``` fence）内的空行不作为段落边界
 * - GFM 表格行与紧邻的正文保持在同一块（表格整体不拆）
 *
 * 合并规则：
 * - minParagraph > 0 时，累积长度不足该阈值的块贪心吸收下一段（合并后不超 limit）
 * - maxMessages > 0 时，超出条数的块全部并入最后一条（被动回复有限额，多拆发不出去）
 */
export function splitMarkdownParagraphs(text, opts) {
    const { limit, minParagraph = 0, maxMessages = 0 } = opts;
    // ── 1. 逐行扫描，空行分块（fence 内空行不算分隔）──
    const lines = text.split('\n');
    const blocks = [];
    let current = [];
    let inCodeBlock = false;
    let lineOffset = 0;
    let blockStart = 0;
    let blockEnd = 0;
    const flushBlock = () => {
        if (current.length === 0)
            return;
        blocks.push({ text: current.join('\n'), start: blockStart, end: blockEnd });
        current = [];
    };
    for (const line of lines) {
        if (CODE_FENCE_OPEN.test(line)) {
            inCodeBlock = !inCodeBlock;
            if (current.length === 0)
                blockStart = lineOffset;
            current.push(line);
            blockEnd = lineOffset + line.length;
        }
        else if (inCodeBlock) {
            current.push(line);
            blockEnd = lineOffset + line.length;
        }
        else if (line.trim() === '') {
            flushBlock();
        }
        else {
            if (current.length === 0)
                blockStart = lineOffset;
            current.push(line);
            blockEnd = lineOffset + line.length;
        }
        lineOffset += line.length + 1;
    }
    flushBlock();
    if (blocks.length <= 1) {
        return blocks.map(toBlock);
    }
    const mergeBlocks = (list, sep) => ({
        text: list.map((b) => b.text).join(sep),
        start: list[0].start,
        end: list[list.length - 1].end,
    });
    // ── 2. 短段合并：累积不足 minParagraph 时贪心吸收下一段（保持原文 \n\n 连接）──
    if (minParagraph > 0) {
        const merged = [];
        let acc = null;
        for (const block of blocks) {
            if (acc === null) {
                acc = block;
            }
            else if (acc.text.length < minParagraph && acc.text.length + 2 + block.text.length <= limit) {
                acc = mergeBlocks([acc, block], '\n\n');
            }
            else {
                merged.push(acc);
                acc = block;
            }
        }
        if (acc !== null)
            merged.push(acc);
        blocks.length = 0;
        blocks.push(...merged);
    }
    // ── 3. 条数上限：超出的块并入最后一条 ──
    if (maxMessages > 0 && blocks.length > maxMessages) {
        const head = blocks.slice(0, maxMessages - 1);
        const tail = mergeBlocks(blocks.slice(maxMessages - 1), '\n\n');
        blocks.length = 0;
        blocks.push(...head, tail);
    }
    return blocks.map(toBlock);
    function toBlock(block) {
        return { text: block.text, oversized: block.text.length > limit, start: block.start, end: block.end };
    }
}
/**
 * 统一投递规划：决定一段回复文本按几条消息发出。
 *
 * - split 未启用：维持现状，仅超长时按 chunkMarkdownText 切分（<=limit 时单条原样发送）
 * - split 启用：先按段落拆分（保护代码块/表格、短段合并、条数上限），
 *   超长块内部再按 chunkMarkdownText 兜底切分，保证内容不丢
 */
export function planTextChunks(text, limit, split) {
    if (split === undefined || !split.enabled) {
        return chunkMarkdownText(text, limit);
    }
    const blocks = splitMarkdownParagraphs(text, {
        limit,
        minParagraph: split.minParagraph,
        maxMessages: split.maxMessages,
    });
    return blocks.flatMap((block) => block.oversized ? chunkMarkdownText(block.text, limit) : [block.text]);
}
/**
 * 按换行边界切分 Markdown 文本
 * - 不在代码块中间断开
 * - 不在 GFM 表格中间断开
 * - 优先在空行处断开
 */
export function chunkMarkdownText(text, limit) {
    if (text.length <= limit)
        return [text];
    const lines = text.split('\n');
    const chunks = [];
    let current = '';
    let inCodeBlock = false;
    let tableBuffer = [];
    const flushTable = () => {
        if (tableBuffer.length === 0)
            return;
        const block = tableBuffer.join('\n');
        tableBuffer = [];
        if (!current) {
            current = block;
            return;
        }
        const candidate = `${current}\n${block}`;
        if (candidate.length > limit) {
            chunks.push(current);
            current = block;
        }
        else {
            current = candidate;
        }
    };
    const appendLine = (line) => {
        if (!current) {
            current = line;
            return;
        }
        const candidate = `${current}\n${line}`;
        if (candidate.length > limit) {
            chunks.push(current);
            current = line;
        }
        else {
            current = candidate;
        }
    };
    for (const line of lines) {
        if (CODE_FENCE_OPEN.test(line)) {
            flushTable();
            inCodeBlock = !inCodeBlock;
            appendLine(line);
            continue;
        }
        if (inCodeBlock) {
            appendLine(line);
            continue;
        }
        if (GFM_TABLE_LINE.test(line)) {
            tableBuffer.push(line);
            continue;
        }
        flushTable();
        appendLine(line);
    }
    flushTable();
    if (current)
        chunks.push(current);
    return chunks.length > 0 ? chunks : [text];
}
//# sourceMappingURL=chunker.js.map
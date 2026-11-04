/**
 * 表情包 prompt section — 告知模型可用表情列表与标记语法
 *
 * 惰性注入：每次 prompt 组装时现读表情库（TTL 缓存），目录增删图片即时生效。
 * 表情库为空时返回空文本，section 自动被丢弃（模型不知道有表情功能）。
 */
export const STICKERS_SECTION_NAME = 'qqbot:stickers';
export const STICKERS_ORDER = 480;
/** prompt 中列出的表情名上限（与 StickerRegistry.names 的截断一致） */
const PROMPT_NAME_LIMIT = 100;
export function stickersSectionText(names, maxPerTurn) {
    if (names.length === 0)
        return '';
    const list = names.slice(0, PROMPT_NAME_LIMIT).join('、');
    return [
        '【表情包】',
        '你可以发 QQ 表情包（本地收藏的表情图）。想发的时候，在回复文本里那个位置插入标记：[表情:名字]',
        `名字只能从这些里选（不带扩展名）：${list}`,
        `少用，一轮最多 ${maxPerTurn} 张，没有合适的就不用，名字不能自己编。`,
    ].join('\n');
}
//# sourceMappingURL=stickers.js.map
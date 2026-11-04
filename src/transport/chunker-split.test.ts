import { describe, it, expect } from 'vitest';
import { planTextChunks, splitMarkdownParagraphs } from './chunker.ts';

const texts = (blocks: { text: string }[]): string[] => blocks.map((b) => b.text);

describe('splitMarkdownParagraphs', () => {
  it('三段文本拆为三条消息', () => {
    const input = '第一句话。\n\n第二句话。\n\n第三句话。';
    const blocks = splitMarkdownParagraphs(input, { limit: 4500 });
    expect(texts(blocks)).toEqual(['第一句话。', '第二句话。', '第三句话。']);
  });

  it('连续多个空行视为单个段落边界', () => {
    const input = '段落一。\n\n\n\n段落二。';
    const blocks = splitMarkdownParagraphs(input, { limit: 4500 });
    expect(texts(blocks)).toEqual(['段落一。', '段落二。']);
  });

  it('代码块内的空行不作为段落边界', () => {
    const input = '说明文字。\n\n```python\ndef f():\n\n    return 1\n\n```\n\n结尾文字。';
    const blocks = splitMarkdownParagraphs(input, { limit: 4500 });
    expect(texts(blocks)).toHaveLength(3);
    expect(blocks[1].text).toContain('def f():');
    expect(blocks[1].text).toContain('```');
  });

  it('GFM 表格整体保持在同一块', () => {
    const input = '表如下：\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\n结束。';
    const blocks = splitMarkdownParagraphs(input, { limit: 4500 });
    expect(texts(blocks)).toEqual(['表如下：', '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |', '结束。']);
  });

  it('单段/空文本返回单块', () => {
    expect(texts(splitMarkdownParagraphs('只有一段', { limit: 4500 }))).toEqual(['只有一段']);
    expect(texts(splitMarkdownParagraphs('', { limit: 4500 }))).toEqual([]);
  });

  it('minParagraph：短段贪心并入下一段', () => {
    const input = '好的。\n\n这是详细分析的结果，内容比较长。\n\n结论如下。';
    const blocks = splitMarkdownParagraphs(input, { limit: 4500, minParagraph: 10 });
    expect(texts(blocks)).toEqual([
      '好的。\n\n这是详细分析的结果，内容比较长。',
      '结论如下。',
    ]);
  });

  it('minParagraph 合并受 limit 约束：超限不合并', () => {
    const long1 = 'a'.repeat(200);
    const long2 = 'b'.repeat(200);
    const input = `${long1}\n\n${long2}`;
    const blocks = splitMarkdownParagraphs(input, { limit: 300, minParagraph: 150 });
    expect(texts(blocks)).toEqual([long1, long2]);
  });

  it('minParagraph=0 不合并', () => {
    const input = '好\n\n的';
    const blocks = splitMarkdownParagraphs(input, { limit: 4500, minParagraph: 0 });
    expect(texts(blocks)).toEqual(['好', '的']);
  });

  it('maxMessages：超出条数并入最后一条', () => {
    const input = '一\n\n二\n\n三\n\n四\n\n五';
    const blocks = splitMarkdownParagraphs(input, { limit: 4500, maxMessages: 3 });
    expect(texts(blocks)).toEqual(['一', '二', '三\n\n四\n\n五']);
  });

  it('maxMessages=0 不限制条数', () => {
    const input = '一\n\n二\n\n三\n\n四\n\n五';
    const blocks = splitMarkdownParagraphs(input, { limit: 4500, maxMessages: 0 });
    expect(blocks).toHaveLength(5);
  });

  it('超长段落标记 oversized（供二次切分）', () => {
    const long = 'x'.repeat(6000);
    const blocks = splitMarkdownParagraphs(`${long}\n\n短段`, { limit: 4500 });
    expect(blocks[0].oversized).toBe(true);
    expect(blocks[1].oversized).toBe(false);
  });
});

describe('planTextChunks', () => {
  it('split 未启用：维持现状（短文本单条原样返回）', () => {
    const input = '第一句。\n\n第二句。';
    expect(planTextChunks(input, 4500)).toEqual([input]);
    expect(planTextChunks(input, 4500, { enabled: false, minParagraph: 0, maxMessages: 4 })).toEqual([input]);
  });

  it('split 启用：按段落拆分多条', () => {
    const input = '第一句话。\n\n第二句话。\n\n第三句话。';
    const chunks = planTextChunks(input, 4500, { enabled: true, minParagraph: 0, maxMessages: 4 });
    expect(chunks).toEqual(['第一句话。', '第二句话。', '第三句话。']);
  });

  it('split 启用：超长段落内部按 chunkMarkdownText 二次切分，内容不丢', () => {
    // 多行段落（单行不会被 chunkMarkdownText 拆开，需多行才能触发切分）
    const long = Array.from({ length: 300 }, (_, i) => `line-${i}-xxxxxxxxxxxx`).join('\n');
    const input = `开头。\n\n${long}\n\n结尾。`;
    const chunks = planTextChunks(input, 4500, { enabled: true, minParagraph: 0, maxMessages: 0 });
    expect(chunks).toHaveLength(4); // 开头 + long 两片 + 结尾
    expect(chunks[0]).toBe('开头。');
    expect(chunks[3]).toBe('结尾。');
    expect(chunks.slice(1, 3).join('\n')).toBe(long); // 超长段切分内容不丢
  });

  it('split 启用：条数上限与二次切分叠加时内容不丢', () => {
    const long = Array.from({ length: 300 }, (_, i) => `line-${i}-xxxxxxxxxxxx`).join('\n');
    const input = `开头。\n\n${long}\n\n结尾。`;
    // maxMessages=2：开头为第一条，long+结尾 并入最后一条（其内部再切）
    const chunks = planTextChunks(input, 4500, { enabled: true, minParagraph: 0, maxMessages: 2 });
    expect(chunks[0]).toBe('开头。');
    expect(chunks.slice(1).join('\n')).toBe(`${long}\n\n结尾。`);
  });
});

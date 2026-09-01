/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chunkText,
  stripTelegramHtml,
  toPlainText,
  toTelegramHtml,
} from '@google/adk-gateway';
import {describe, expect, it} from 'vitest';

describe('chunkText', () => {
  it('leaves text that already fits alone', () => {
    expect(chunkText('short', 100)).toEqual(['short']);
  });

  it('drops text that is only whitespace', () => {
    expect(chunkText('   ', 100)).toEqual([]);
  });

  it('keeps every chunk within the limit', () => {
    const text = Array.from({length: 200}, (_, i) => `line ${i}`).join('\n');
    for (const chunk of chunkText(text, 100)) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it('loses nothing when it splits', () => {
    const text = Array.from({length: 50}, (_, i) => `line ${i}`).join('\n');
    expect(chunkText(text, 80).join('\n')).toBe(text);
  });

  it('prefers to break between lines', () => {
    const text = 'alpha\nbeta\ngamma\ndelta';
    expect(chunkText(text, 12)).toEqual(['alpha\nbeta', 'gamma\ndelta']);
  });

  it('breaks a single over-long line at a word boundary', () => {
    const text = `${'word '.repeat(40)}end`;
    for (const chunk of chunkText(text, 50)) {
      expect(chunk.length).toBeLessThanOrEqual(50);
      expect(chunk).not.toMatch(/wor$|or$/);
    }
  });

  it('breaks an unbroken run of characters rather than giving up', () => {
    const chunks = chunkText('x'.repeat(250), 100);
    expect(chunks).toHaveLength(3);
    expect(chunks.join('')).toBe('x'.repeat(250));
  });

  describe('code fences', () => {
    it('closes and reopens a fence that straddles a split', () => {
      const code = Array.from({length: 30}, (_, i) => `  line ${i};`).join(
        '\n',
      );
      const text = '```ts\n' + code + '\n```';

      const chunks = chunkText(text, 120);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        // Every chunk must have balanced fences or it renders as broken markup
        // — half a code block swallows the rest of the message.
        const fences = chunk.match(/```/g) ?? [];
        expect(fences.length % 2).toBe(0);
      }
    });

    it('reopens with the original language tag', () => {
      const code = Array.from({length: 30}, (_, i) => `  line ${i};`).join(
        '\n',
      );
      const chunks = chunkText('```python\n' + code + '\n```', 120);
      expect(chunks[1]).toMatch(/^```python/);
    });
  });
});

describe('toTelegramHtml', () => {
  it('escapes the three characters Telegram treats as markup', () => {
    expect(toTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('converts bold and italic', () => {
    expect(toTelegramHtml('**bold** and *italic*')).toBe(
      '<b>bold</b> and <i>italic</i>',
    );
  });

  it('converts strikethrough', () => {
    expect(toTelegramHtml('~~gone~~')).toBe('<s>gone</s>');
  });

  it('leaves snake_case alone', () => {
    // The classic underscore-italics bug: `some_var_name` must not turn into
    // `some<i>var</i>name`.
    expect(toTelegramHtml('call some_var_name now')).toBe(
      'call some_var_name now',
    );
  });

  it('still italicises a standalone underscore pair', () => {
    expect(toTelegramHtml('this is _emphatic_ here')).toBe(
      'this is <i>emphatic</i> here',
    );
  });

  it('converts inline code and escapes inside it', () => {
    expect(toTelegramHtml('use `a < b`')).toBe('use <code>a &lt; b</code>');
  });

  it('does not treat markup inside code as markup', () => {
    expect(toTelegramHtml('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('converts a fenced block with its language', () => {
    expect(toTelegramHtml('```ts\nconst a = 1;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1;</code></pre>',
    );
  });

  it('converts a fenced block without one', () => {
    expect(toTelegramHtml('```\nplain\n```')).toBe('<pre>plain</pre>');
  });

  it('turns headings into bold, since Telegram has none', () => {
    expect(toTelegramHtml('## Section')).toBe('<b>Section</b>');
  });

  it('turns list markers into bullets', () => {
    expect(toTelegramHtml('- one\n- two')).toBe('• one\n• two');
  });

  it('does not read a list marker as emphasis', () => {
    expect(toTelegramHtml('* one\n* two')).toBe('• one\n• two');
  });

  it('converts links', () => {
    expect(toTelegramHtml('[docs](https://example.com)')).toBe(
      '<a href="https://example.com">docs</a>',
    );
  });

  it('leaves a bare URL as text', () => {
    expect(toTelegramHtml('see https://example.com')).toBe(
      'see https://example.com',
    );
  });
});

describe('toPlainText', () => {
  it('strips formatting but keeps the words', () => {
    expect(toPlainText('**bold** and *italic* and `code`')).toBe(
      'bold and italic and code',
    );
  });

  it('keeps a link and its target', () => {
    expect(toPlainText('[docs](https://example.com)')).toBe(
      'docs (https://example.com)',
    );
  });

  it('keeps the body of a code block', () => {
    expect(toPlainText('```ts\nconst a = 1;\n```')).toBe('const a = 1;\n');
  });
});

describe('stripTelegramHtml', () => {
  it('undoes the conversion for a plain-text retry', () => {
    // Sending unformatted is the fallback when Telegram rejects the markup:
    // losing the bold beats losing the answer.
    expect(stripTelegramHtml('<b>bold</b> and <i>italic</i>')).toBe(
      'bold and italic',
    );
  });

  it('restores escaped characters', () => {
    expect(stripTelegramHtml('a &lt; b &amp; c')).toBe('a < b & c');
  });
});

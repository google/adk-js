/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converting the markdown a model emits into what a channel will render.
 *
 * **Why HTML rather than MarkdownV2 for Telegram.** MarkdownV2 requires
 * escaping eighteen characters (``_*[]()~`>#+-=|{}.!``) *everywhere they are
 * not markup*, and a single missed one makes Telegram reject the whole message.
 * Model output is full of them — decimal points, hyphens, parentheses — and it
 * is not reliably well-formed markdown to begin with. Telegram's HTML mode
 * needs three characters escaped (`&`, `<`, `>`) and accepts a small fixed tag
 * set, which is far harder to get wrong.
 *
 * Either way the renderer keeps a plain-text retry: losing the bold is a much
 * better failure than losing the answer.
 */

/** A private-use sentinel, so placeholders cannot collide with content. */
const MARK = '\u0000';

/** Escapes the three characters Telegram's HTML mode treats as markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Converts model markdown to the HTML subset Telegram accepts.
 *
 * Unsupported constructs degrade to text rather than being dropped: headings
 * become bold, bullets become `•`, and anything unrecognized is escaped and
 * passes through as written.
 */
export function toTelegramHtml(markdown: string): string {
  const held: string[] = [];
  const hold = (html: string): string => {
    held.push(html);
    return `${MARK}${held.length - 1}${MARK}`;
  };

  let text = markdown;

  // Code first, and held aside: its contents must not be treated as markup.
  text = text.replace(
    /```([\w+-]*)\r?\n?([\s\S]*?)```/g,
    (_match, language: string, body: string) => {
      const escaped = escapeHtml(body.replace(/\n$/, ''));
      return hold(
        language
          ? `<pre><code class="language-${language}">${escaped}</code></pre>`
          : `<pre>${escaped}</pre>`,
      );
    },
  );
  text = text.replace(/`([^`\n]+)`/g, (_match, body: string) =>
    hold(`<code>${escapeHtml(body)}</code>`),
  );

  text = escapeHtml(text);

  // Bullets before italics: a leading `* ` is a list marker, not emphasis.
  text = text.replace(/^(\s*)[-*+][ \t]+/gm, '$1• ');
  text = text.replace(/^\s*#{1,6}[ \t]+(.+)$/gm, '<b>$1</b>');

  text = text.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^\n]+?)__/g, '<b>$1</b>');
  text = text.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
  text = text.replace(/\*([^*\n]+?)\*/g, '<i>$1</i>');
  // Underscore italics only at word boundaries, so snake_case survives intact.
  text = text.replace(
    /(^|[\s(])_([^_\n]+?)_(?=[\s).,!?:;]|$)/gm,
    '$1<i>$2</i>',
  );

  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_match, label: string, href: string) =>
      `<a href="${href.replace(/"/g, '&quot;')}">${label}</a>`,
  );

  return text.replace(
    new RegExp(`${MARK}(\\d+)${MARK}`, 'g'),
    (_m, i: string) => held[Number(i)],
  );
}

/**
 * Flattens markdown to readable plain text.
 *
 * The universal fallback: every channel accepts it, and it is what the renderer
 * retries with when a channel rejects formatted text.
 */
export function toPlainText(markdown: string): string {
  let text = markdown;

  text = text.replace(/```[\w+-]*\r?\n?([\s\S]*?)```/g, '$1');
  text = text.replace(/`([^`\n]+)`/g, '$1');
  text = text.replace(/^(\s*)[-*+][ \t]+/gm, '$1• ');
  text = text.replace(/^\s*#{1,6}[ \t]+(.+)$/gm, '$1');
  text = text.replace(/\*\*([^\n]+?)\*\*/g, '$1');
  text = text.replace(/__([^\n]+?)__/g, '$1');
  text = text.replace(/~~([^\n]+?)~~/g, '$1');
  text = text.replace(/\*([^*\n]+?)\*/g, '$1');
  text = text.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,!?:;]|$)/gm, '$1$2');
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)');

  return text;
}

/** Strips the HTML tags this module emits, for the plain-text retry. */
export function stripTelegramHtml(html: string): string {
  return html
    .replace(/<\/?(?:b|i|s|u|code|pre|a|blockquote)(?:\s[^>]*)?>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

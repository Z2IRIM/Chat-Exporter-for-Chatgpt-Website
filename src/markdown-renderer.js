(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.markdownRenderer) return;

  /** Escape untrusted Markdown text before producing printable HTML. */
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Render inline Markdown while keeping raw HTML inert. */
  function renderInline(value) {
    const codeTokens = [];
    let text = escapeHtml(value);
    text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
      const token = `\u0000CODE${codeTokens.length}\u0000`;
      codeTokens.push(`<code>${code}</code>`);
      return token;
    });
    text = text
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    for (let index = 0; index < codeTokens.length; index += 1) {
      text = text.replace(`\u0000CODE${index}\u0000`, codeTokens[index]);
    }
    return text;
  }

  /** Parse a Markdown table row into escaped cell content. */
  function tableCells(line) {
    return String(line || '')
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => renderInline(cell.trim()));
  }

  /** Return true when a line is a Markdown table alignment separator. */
  function isTableSeparator(line) {
    const cells = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
    return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
  }

  /** Return true when a line begins a block that should end a paragraph. */
  function isBlockStart(line, nextLine = '') {
    const value = String(line || '');
    return /^\s*$/.test(value)
      || /^```|^~~~/.test(value)
      || /^#{1,6}\s+/.test(value)
      || /^>\s?/.test(value)
      || /^\s*[-+*]\s+/.test(value)
      || /^\s*\d+[.)]\s+/.test(value)
      || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(value)
      || (value.includes('|') && isTableSeparator(nextLine));
  }

  /** Render Markdown to safe semantic HTML for the print document. */
  function render(markdown) {
    const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^\s*(```|~~~)\s*([^\s]*)\s*$/);
      if (fence) {
        const marker = fence[1];
        const language = String(fence[2] || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const code = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index])) {
          code.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const className = language ? ` class="language-${language}"` : '';
        out.push(`<pre><code${className}>${escapeHtml(code.join('\n'))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        out.push('<hr>');
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) {
          quote.push(lines[index].replace(/^>\s?/, ''));
          index += 1;
        }
        out.push(`<blockquote>${render(quote.join('\n'))}</blockquote>`);
        continue;
      }

      const unordered = line.match(/^\s*[-+*]\s+(.+)/);
      if (unordered) {
        const items = [];
        while (index < lines.length) {
          const match = lines[index].match(/^\s*[-+*]\s+(.+)/);
          if (!match) break;
          items.push(`<li>${renderInline(match[1])}</li>`);
          index += 1;
        }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      const ordered = line.match(/^\s*\d+[.)]\s+(.+)/);
      if (ordered) {
        const items = [];
        while (index < lines.length) {
          const match = lines[index].match(/^\s*\d+[.)]\s+(.+)/);
          if (!match) break;
          items.push(`<li>${renderInline(match[1])}</li>`);
          index += 1;
        }
        out.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
        const headers = tableCells(line);
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          rows.push(tableCells(lines[index]));
          index += 1;
        }
        const headHtml = headers.map((cell) => `<th>${cell}</th>`).join('');
        const bodyHtml = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('');
        out.push(`<div class="table-wrap"><table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
        continue;
      }

      const paragraph = [line.trim()];
      index += 1;
      while (index < lines.length && !isBlockStart(lines[index], lines[index + 1] || '')) {
        paragraph.push(lines[index].trim());
        index += 1;
      }
      out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    }

    return out.join('\n');
  }

  ns.markdownRenderer = { escapeHtml, renderInline, render };
})();

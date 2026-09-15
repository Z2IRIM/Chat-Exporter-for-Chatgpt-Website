(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.print) return;

  /** Escape arbitrary conversation text before inserting it into a printable HTML document. */
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Remove internal ChatGPT image placeholders from printable message text. */
  function stripImageReferences(markdown) {
    return String(markdown || '')
      .replace(/!\[[^\]]*\]\(chatgpt-file:\/\/[^)]+\)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** Resolve a stable image key without depending on the assets module at test/runtime boundaries. */
  function imageKey(image) {
    return image?.fileId ? `file:${image.fileId}` : String(image?.fetchSrc || image?.src || '');
  }

  /** Render printable message Markdown through the shared semantic renderer. */
  function renderMessageMarkdown(markdown) {
    const source = stripImageReferences(markdown);
    if (ns.markdownRenderer?.render) return ns.markdownRenderer.render(source);
    if (!source) return '';
    return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
  }

  /** Build a self-contained HTML document for the browser print engine. */
  function buildPrintHtml({ title = 'ChatGPT Conversation', messages = [], imageDataBySource = new Map(), includeImages = true, includeModelMetadata = false, modelLabels = {} } = {}) {
    const sources = typeof imageDataBySource?.get === 'function'
      ? imageDataBySource
      : new Map(Object.entries(imageDataBySource || {}));

    const messageHtml = messages.map((message) => {
      const role = message?.role === 'user' ? 'User' : 'Assistant';
      const body = renderMessageMarkdown(message?.markdown || message?.text || '');
      const images = includeImages
        ? (message?.images || []).map((image) => {
            const dataUri = sources.get(imageKey(image));
            if (!dataUri) return '';
            return `<figure><img src="${escapeHtml(dataUri)}" alt="${escapeHtml(image?.alt || image?.originalName || 'image')}"></figure>`;
          }).join('')
        : '';
      const attachments = (message?.attachments || []).length
        ? `<div class="attachments">${(message.attachments || []).map((item) => `<div>📎 ${escapeHtml(item?.name || 'attachment')}</div>`).join('')}</div>`
        : '';
      const modelMetadata = includeModelMetadata && role === 'Assistant'
        ? `<div class="model-meta"><span>${escapeHtml(modelLabels.selectedModel || 'Selected model')}: ${escapeHtml(message?.model_slug || '—')}</span><span>${escapeHtml(modelLabels.resolvedModel || 'Resolved model')}: ${escapeHtml(message?.resolved_model_slug || '—')}</span><span>${escapeHtml(modelLabels.thinkingEffort || 'Thinking effort')}: ${escapeHtml(message?.thinking_effort || '—')}</span></div>`
        : '';
      return `<section class="message ${role.toLowerCase()}"><h2>${role}</h2>${modelMetadata}<div class="message-body">${body}</div>${images}${attachments}</section>`;
    }).join('\n');

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { color: #171717; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "Noto Sans CJK SC", "Noto Sans JP", "Noto Sans KR", Arial, sans-serif; font-size: 11.5pt; line-height: 1.58; }
  main { max-width: 900px; margin: 0 auto; padding: 28px 34px 48px; }
  h1 { margin: 0 0 24px; font-size: 24px; line-height: 1.25; }
  .message { padding: 16px 0 20px; border-top: 1px solid #ddd; }
  .message:first-of-type { border-top: 0; }
  .message > h2 { margin: 0 0 7px; font-size: 14px; line-height: 1.3; }
  .model-meta { display: flex; flex-wrap: wrap; gap: 5px 12px; margin: 0 0 10px; color: #666; font-size: 9.5pt; line-height: 1.4; }
  .message-body { overflow-wrap: anywhere; }
  .message-body > :first-child { margin-top: 0; }
  .message-body > :last-child { margin-bottom: 0; }
  .message-body p { margin: 0 0 10px; }
  .message-body h1, .message-body h2, .message-body h3, .message-body h4, .message-body h5, .message-body h6 { break-after: avoid; page-break-after: avoid; margin: 16px 0 8px; line-height: 1.35; }
  .message-body h1 { font-size: 20px; } .message-body h2 { font-size: 18px; } .message-body h3 { font-size: 16px; }
  .message-body ul, .message-body ol { margin: 8px 0 10px 22px; padding: 0; }
  .message-body li { margin: 3px 0; }
  .message-body blockquote { margin: 10px 0; padding: 5px 12px; border-left: 3px solid #c8c8c8; color: #4b4b4b; }
  .message-body code { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .92em; background: #f2f2f2; border-radius: 4px; padding: 1px 4px; }
  .message-body pre { margin: 10px 0; padding: 10px 12px; background: #f5f5f5; border: 1px solid #ddd; border-radius: 7px; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: auto; page-break-inside: auto; }
  .message-body pre code { background: transparent; padding: 0; border-radius: 0; }
  .message-body a { color: #215ea8; text-decoration: underline; word-break: break-all; }
  .table-wrap { overflow: visible; margin: 10px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 10pt; }
  th, td { border: 1px solid #d4d4d4; padding: 5px 7px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #f3f3f3; }
  figure { margin: 14px 0 4px; break-inside: avoid; page-break-inside: avoid; text-align: center; }
  figure img { display: block; max-width: 100%; max-height: 230mm; width: auto; height: auto; object-fit: contain; margin: 0 auto; break-inside: avoid; page-break-inside: avoid; }
  .attachments { margin-top: 12px; font-size: 10pt; color: #555; break-inside: avoid; }
  @page { size: A4 portrait; margin: 14mm; }
  @media print {
    main { max-width: none; padding: 0; }
    .message { break-inside: auto; }
    figure { break-inside: avoid; page-break-inside: avoid; }
    figure img { max-height: 230mm; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${messageHtml}</main></body>
</html>`;
  }

  ns.print = { escapeHtml, stripImageReferences, renderMessageMarkdown, buildPrintHtml };
})();

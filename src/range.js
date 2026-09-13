(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.range) return;

  /** Build selectable points for every visible User/Assistant turn. */
  function getMessageOptions(messages, previewLength = 96) {
    return (messages || []).map((message, index) => {
      const source = String(message?.text || message?.markdown || '').replace(/\s+/g, ' ').trim();
      const preview = source.length > previewLength
        ? `${source.slice(0, Math.max(1, previewLength - 1))}…`
        : source || '[图片或附件消息]';
      const role = message?.role === 'assistant' ? 'assistant' : 'user';
      const roleLabel = role === 'assistant' ? 'Assistant' : 'User';
      return {
        key: message?.key,
        messagePosition: index + 1,
        role,
        preview,
        label: `#${index + 1} ${roleLabel} · ${preview}`,
      };
    });
  }

  /** Backward-compatible User-only selector used by older callers. */
  function getUserStartOptions(messages, previewLength = 96) {
    let userOrdinal = 0;
    return getMessageOptions(messages, previewLength).flatMap((item) => {
      if (item.role !== 'user') return [];
      userOrdinal += 1;
      return [{ ...item, userOrdinal, label: `#${userOrdinal} ${item.preview}` }];
    });
  }

  /** Clone export-facing message records so range operations never mutate the cached full branch. */
  function cloneMessages(messages) {
    return (messages || []).map((message) => ({
      ...message,
      attachments: (message?.attachments || []).map((attachment) => ({ ...attachment })),
      images: (message?.images || []).map((image) => ({ ...image })),
      sourceMessageIds: Array.isArray(message?.sourceMessageIds) ? [...message.sourceMessageIds] : message?.sourceMessageIds,
    }));
  }

  /** Apply an inclusive export range without mutating the complete branch message list. */
  function applyExportRange(messages, range = { mode: 'full' }) {
    const source = Array.isArray(messages) ? messages : [];
    const mode = range?.mode === 'partial' ? 'partial' : 'full';

    if (mode === 'full') {
      return {
        messages: cloneMessages(source),
        metadata: {
          exportScope: 'full',
          startMessageKey: null, startMessageId: null, startMessagePosition: null, startUserOrdinal: null,
          endMessageKey: null, endMessageId: null, endMessagePosition: null,
          originalMessageCount: source.length, exportedMessageCount: source.length,
        },
      };
    }

    const startIndex = source.findIndex((message) => message?.key === range?.startMessageKey);
    if (startIndex < 0) throw new Error('未找到部分导出的起始消息。');
    const effectiveEndKey = range?.endMessageKey || source.at(-1)?.key;
    const endIndex = source.findIndex((message) => message?.key === effectiveEndKey);
    if (endIndex < 0) throw new Error('未找到部分导出的截止消息。');
    if (endIndex < startIndex) throw new Error('部分导出的截止点不能早于起始点。');

    const selected = cloneMessages(source.slice(startIndex, endIndex + 1));
    const start = source[startIndex];
    const end = source[endIndex];
    return {
      messages: selected,
      metadata: {
        exportScope: 'partial',
        startMessageKey: start?.key || null,
        startMessageId: start?.turnId || start?.key || null,
        startMessagePosition: startIndex + 1,
        startUserOrdinal: start?.role === 'user' ? source.slice(0, startIndex + 1).filter((m) => m?.role === 'user').length : null,
        endMessageKey: end?.key || null,
        endMessageId: end?.turnId || end?.key || null,
        endMessagePosition: endIndex + 1,
        originalMessageCount: source.length,
        exportedMessageCount: selected.length,
      },
    };
  }

  ns.range = { getMessageOptions, getUserStartOptions, applyExportRange };
})();

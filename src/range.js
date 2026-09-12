(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.range) return;

  /**
   * Return compact selectable start points for every user message in the current branch.
   */
  function getUserStartOptions(messages, previewLength = 96) {
    let userOrdinal = 0;
    return (messages || []).flatMap((message, index) => {
      if (message?.role !== 'user') return [];
      userOrdinal += 1;
      const source = String(message.text || message.markdown || '')
        .replace(/\s+/g, ' ')
        .trim();
      const preview = source.length > previewLength
        ? `${source.slice(0, Math.max(1, previewLength - 1))}…`
        : source || '[图片或附件消息]';
      return [{
        key: message.key,
        messagePosition: index + 1,
        userOrdinal,
        preview,
        label: `#${userOrdinal} ${preview}`,
      }];
    });
  }


  /**
   * Clone export-facing message records so range operations never mutate the cached full branch.
   */
  function cloneMessages(messages) {
    return (messages || []).map((message) => ({
      ...message,
      attachments: (message?.attachments || []).map((attachment) => ({ ...attachment })),
      images: (message?.images || []).map((image) => ({ ...image })),
      sourceMessageIds: Array.isArray(message?.sourceMessageIds)
        ? [...message.sourceMessageIds]
        : message?.sourceMessageIds,
    }));
  }

  /**
   * Apply an export range without mutating the complete branch message list.
   */
  function applyExportRange(messages, range = { mode: 'full' }) {
    const source = Array.isArray(messages) ? messages : [];
    const mode = range?.mode === 'partial' ? 'partial' : 'full';

    if (mode === 'full') {
      return {
        messages: cloneMessages(source),
        metadata: {
          exportScope: 'full',
          startMessageKey: null,
          startMessageId: null,
          startMessagePosition: null,
          startUserOrdinal: null,
          originalMessageCount: source.length,
          exportedMessageCount: source.length,
        },
      };
    }

    const startMessageKey = range?.startMessageKey;
    const startIndex = source.findIndex((message) => message?.key === startMessageKey);
    if (startIndex < 0) throw new Error('未找到部分导出的起始消息。');
    if (source[startIndex]?.role !== 'user') {
      throw new Error('部分导出的起始点必须是 User 消息。');
    }

    const selected = cloneMessages(source.slice(startIndex));
    return {
      messages: selected,
      metadata: {
        exportScope: 'partial',
        startMessageKey,
        startMessageId: source[startIndex]?.turnId || source[startIndex]?.key || null,
        startMessagePosition: startIndex + 1,
        startUserOrdinal: source.slice(0, startIndex + 1).filter((message) => message?.role === 'user').length,
        originalMessageCount: source.length,
        exportedMessageCount: selected.length,
      },
    };
  }

  ns.range = {
    getUserStartOptions,
    applyExportRange,
  };
})();

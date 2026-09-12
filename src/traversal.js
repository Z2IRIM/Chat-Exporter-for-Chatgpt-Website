(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.traversal) return;

  const CURRENT_TURN_SELECTOR = '#thread section[data-turn-id][data-turn]';
  const EXPORTABLE_ROLES = new Set(['user', 'assistant']);

  /**
   * Return ChatGPT's stable turn shells, including virtualized turns whose message body is not mounted yet.
   */
  function getTurnShells(root = document) {
    return [...root.querySelectorAll(CURRENT_TURN_SELECTOR)].filter((turn) =>
      EXPORTABLE_ROLES.has(turn.dataset?.turn),
    );
  }

  /**
   * Hydrate every indexed turn shell by scrolling it into view and capturing it once its body is mounted.
   */
  async function hydrateTurnShells({
    shells,
    extract,
    waitForMessage,
    onProgress,
    retryPasses = 2,
  }) {
    const messages = new Map();
    const total = shells.length;

    for (let pass = 0; pass <= retryPasses; pass += 1) {
      for (let index = 0; index < shells.length; index += 1) {
        if (messages.has(index)) continue;

        const shell = shells[index];
        shell.scrollIntoView?.({ block: 'center', behavior: 'instant' });

        let message = extract(shell);
        if (!message) message = await waitForMessage(shell);
        if (message) messages.set(index, { ...message, index });

        onProgress?.({
          phase: pass === 0 ? '加载完整对话' : `重试缺失消息 ${pass}/${retryPasses}`,
          completed: messages.size,
          total,
        });
      }

      if (messages.size === total) break;
    }

    return {
      messages: [...messages.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, message]) => message),
      total,
      missing: total - messages.size,
    };
  }

  ns.traversal = {
    getTurnShells,
    hydrateTurnShells,
  };
})();

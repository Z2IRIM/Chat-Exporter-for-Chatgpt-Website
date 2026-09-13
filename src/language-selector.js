(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.languageSelector) return;

  /** Return the next wrapped option index for keyboard navigation. */
  function nextIndex(currentIndex, delta, count) {
    const size = Math.max(0, Number(count) || 0);
    if (!size) return -1;
    const current = Number.isFinite(Number(currentIndex)) ? Number(currentIndex) : 0;
    return ((current + Number(delta || 0)) % size + size) % size;
  }

  ns.languageSelector = { nextIndex };
})();

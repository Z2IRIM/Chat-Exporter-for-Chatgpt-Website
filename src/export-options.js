(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.exportOptions) return;

  const STORAGE_KEY = 'chatgptConversationExporter.options';
  const DEFAULTS = Object.freeze({ includeToolDetails: false, includeImages: true });

  /**
   * Normalize persisted or caller-provided export options to the supported contract.
   */
  function normalize(value = {}) {
    return {
      includeToolDetails: value?.includeToolDetails === true,
      includeImages: value?.includeImages !== false,
    };
  }

  /**
   * Load persisted export options without failing the exporter when storage is unavailable.
   */
  async function load() {
    try {
      if (!chrome?.storage?.local?.get) return normalize(DEFAULTS);
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return normalize(result?.[STORAGE_KEY]);
    } catch {
      return normalize(DEFAULTS);
    }
  }

  /**
   * Persist the supported export options and return the normalized value.
   */
  async function save(value) {
    const normalized = normalize(value);
    try {
      await chrome?.storage?.local?.set?.({ [STORAGE_KEY]: normalized });
    } catch {
      // Export remains usable even when extension storage is unavailable.
    }
    return normalized;
  }

  ns.exportOptions = { DEFAULTS, normalize, load, save };
})();

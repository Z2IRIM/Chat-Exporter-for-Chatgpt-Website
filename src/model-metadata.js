(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.modelMetadata) return;

  const FIELD_NAMES = Object.freeze(['model_slug', 'resolved_model_slug', 'thinking_effort']);

  /** Normalize raw metadata values while preserving ChatGPT's original string values. */
  function normalizeValue(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
  }

  /** Merge the last non-empty model metadata values from one raw message metadata object. */
  function mergeInto(target, metadata = {}) {
    const output = target || {};
    for (const field of FIELD_NAMES) {
      const value = normalizeValue(metadata?.[field]);
      if (value !== null) output[field] = value;
    }
    return output;
  }

  /** Return the three original metadata fields only when the export option is enabled. */
  function toExportFields(message, enabled) {
    if (enabled !== true || message?.role !== 'assistant') return {};
    return Object.fromEntries(FIELD_NAMES.map((field) => [field, normalizeValue(message?.[field])]).filter(([, value]) => value !== null));
  }

  /** Read detector values from the newest Assistant reply only. */
  function getLatestAssistantInfo(messages = []) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'assistant') continue;
      return {
        resolved_model_slug: normalizeValue(message?.resolved_model_slug),
        thinking_effort: normalizeValue(message?.thinking_effort),
      };
    }
    return { resolved_model_slug: null, thinking_effort: null };
  }

  ns.modelMetadata = { FIELD_NAMES, normalizeValue, mergeInto, toExportFields, getLatestAssistantInfo };
})();

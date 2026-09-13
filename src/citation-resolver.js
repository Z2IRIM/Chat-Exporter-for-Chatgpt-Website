(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.citations) return;

  const INTERNAL_CITE_RE = /\uE200cite\uE202[^\uE201]+\uE201/g;

  /** Escape Markdown link labels without changing the visible source title. */
  function escapeLabel(value) {
    return String(value || '').replace(/([\\\[\]])/g, '\\$1').trim();
  }

  /** Produce a readable fallback label for a URL. */
  function labelFromUrl(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '') || url;
    } catch {
      return url;
    }
  }

  /** Collect unique external sources from one ChatGPT content_reference record. */
  function collectSources(reference) {
    const candidates = [];
    const push = (entry) => {
      const url = String(entry?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return;
      candidates.push({ url, title: String(entry?.title || '').trim() });
    };

    for (const entry of reference?.items || []) push(entry);
    for (const entry of reference?.sources || []) push(entry);
    for (const entry of reference?.supporting_websites || []) push(entry);

    const titleByUrl = new Map(candidates.map((entry) => [entry.url, entry.title]));
    for (const url of reference?.safe_urls || []) {
      const value = String(url || '').trim();
      if (/^https?:\/\//i.test(value)) candidates.push({ url: value, title: titleByUrl.get(value) || '' });
    }

    if (/^https?:\/\//i.test(String(reference?.url || ''))) push(reference);

    const seen = new Set();
    return candidates.filter((entry) => {
      if (!entry.url || seen.has(entry.url)) return false;
      seen.add(entry.url);
      return true;
    });
  }

  /** Convert one citation reference into Markdown links. */
  function renderReference(reference) {
    const sources = collectSources(reference);
    if (!sources.length) return '';
    return sources.map((source) => {
      const label = escapeLabel(source.title || labelFromUrl(source.url));
      return `[${label}](${source.url})`;
    }).join(' ');
  }

  /** Resolve ChatGPT private citation markers into durable external Markdown links. */
  function resolveMarkdown(markdown, metadata = {}) {
    let output = String(markdown || '');
    const references = Array.isArray(metadata?.content_references) ? metadata.content_references : [];

    for (const reference of references) {
      const marker = String(reference?.matched_text || '');
      if (!marker || !marker.includes('cite') || !output.includes(marker)) continue;
      output = output.split(marker).join(renderReference(reference));
    }

    output = output.replace(INTERNAL_CITE_RE, '');
    return output
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([,.;:!?，。；：！？])/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  ns.citations = { collectSources, renderReference, resolveMarkdown };
})();

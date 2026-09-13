(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.contentInitialized) return;
  ns.contentInitialized = true;

  const CONFIG = {
    topLoadWaitMs: 420,
    scanWaitMs: 120,
    settleWaitMs: 320,
    topStableRounds: 3,
    bottomStableRounds: 2,
    maxTopPasses: 120,
    maxScanPasses: 8000,
    scanStepRatio: 0.58,
    turnHydrateWaitMs: 3000,
    imageFetchTimeoutMs: 15000,
    maxImageBytes: 20 * 1024 * 1024,
  };

  const FILE_NAME_PATTERN = /([^\\/\n<>:"|?*]{1,140}\.(?:zip|7z|rar|pdf|docx?|xlsx?|pptx?|csv|tsv|json|ya?ml|md|txt|jsx?|tsx?|mjs|cjs|css|scss|less|html?|xml|sql|py|java|go|rs|c|cpp|h|hpp|ino|log|png|jpe?g|webp|gif|svg|mp4|mov|mp3|wav))/i;
  const UI_ROOT_ID = 'cgpt-conversation-exporter-root';
  let exportInProgress = false;
  let firstSeenSequence = 0;
  let exportRangeSelection = { mode: 'full', startMessageKey: null, startLabel: null, endMessageKey: null, endLabel: null, url: null };
  let exportSettings = ns.exportOptions?.normalize?.() || { includeToolDetails: false, includeImages: true };
  let currentLocale = ns.i18n?.DEFAULT_LOCALE || 'zh-CN';
  let partialScanCache = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Translate one exporter UI/metadata key using the currently selected locale.
   */
  function tr(key, variables = {}) {
    return ns.i18n?.t?.(currentLocale, key, variables) || key;
  }

  /**
   * Normalize whitespace without destroying paragraph boundaries.
   */
  function normalizeText(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Sanitize text for use as a Windows/macOS/Linux compatible filename.
   */
  function sanitizeFileName(name) {
    return String(name || 'ChatGPT Conversation')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '')
      .slice(0, 120) || 'ChatGPT Conversation';
  }

  /**
   * Return a compact local timestamp suitable for filenames.
   */
  function formatFileTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  }

  /**
   * Best-effort extraction of the current conversation title.
   */
  function getConversationTitle() {
    const heading = document.querySelector('main h1');
    const headingText = normalizeText(heading?.innerText);
    if (headingText && headingText.length <= 160) return headingText;

    return normalizeText(document.title)
      .replace(/\s*[|\-–—]\s*ChatGPT\s*$/i, '')
      .replace(/\s*[|\-–—]\s*OpenAI\s*$/i, '') || 'ChatGPT Conversation';
  }

  /**
   * Extract a conversation id from common ChatGPT URL layouts when available.
   */
  function getConversationId() {
    const match = location.pathname.match(/\/(?:c|conversation)\/([a-z0-9-]+)/i);
    return match?.[1] || null;
  }

  /**
   * Resolve relative links while preserving blob/data URLs as-is.
   */
  function resolveUrl(value) {
    if (!value) return null;
    try {
      return new URL(value, location.href).href;
    } catch {
      return value;
    }
  }

  /**
   * Find the scroll container that owns the conversation timeline.
   */
  function findScrollContainer() {
    const probe =
      document.querySelector('article[data-testid^="conversation-turn-"]') ||
      document.querySelector('[data-message-author-role]');

    if (probe) {
      let element = probe.parentElement;
      while (element && element !== document.body) {
        const style = getComputedStyle(element);
        if (
          /(auto|scroll|overlay)/i.test(style.overflowY) &&
          element.scrollHeight > element.clientHeight + 80
        ) {
          return element;
        }
        element = element.parentElement;
      }
    }

    const candidates = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...document.querySelectorAll('main, [class*="overflow-y-auto"], [class*="overflow-auto"]'),
    ].filter(Boolean);

    return candidates
      .filter((element) => element.scrollHeight > element.clientHeight + 80)
      .sort(
        (a, b) =>
          b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight),
      )[0] || document.scrollingElement || document.documentElement;
  }

  /**
   * Return currently rendered conversation turns with nested fallbacks deduplicated.
   */
  function getTurnNodes() {
    const articles = [
      ...document.querySelectorAll('article[data-testid^="conversation-turn-"]'),
    ];
    if (articles.length) return articles;

    const roleNodes = [...document.querySelectorAll('[data-message-author-role]')];
    const roots = [];
    for (const node of roleNodes) {
      if (roots.some((root) => root.contains(node))) continue;
      roots.push(node);
    }
    return roots;
  }

  /**
   * Stable, non-cryptographic hash for fallback message identity.
   */
  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * Remove ChatGPT interaction controls while retaining the message body.
   */
  function cleanMessageClone(node) {
    const clone = node.cloneNode(true);
    clone
      .querySelectorAll([
        `#${UI_ROOT_ID}`,
        'script',
        'style',
        'noscript',
        'iframe',
        'form',
        'input',
        'textarea',
        'select',
        'button',
        'svg',
        '[role="toolbar"]',
        '[data-testid*="copy"]',
        '[data-testid*="feedback"]',
        '[data-testid*="regenerate"]',
      ].join(','))
      .forEach((element) => element.remove());
    return clone;
  }

  /**
   * Extract LaTeX source from KaTeX/MathML markup when ChatGPT rendered it.
   */
  function getLatex(node) {
    const annotation = node.querySelector?.('annotation[encoding="application/x-tex"]');
    return normalizeText(annotation?.textContent);
  }

  /**
   * Convert a DOM subtree to readable Markdown using only browser primitives.
   */
  function nodeToMarkdown(node, depth = 0) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const element = /** @type {Element} */ (node);
    const tag = element.tagName.toLowerCase();
    const children = () =>
      [...element.childNodes].map((child) => nodeToMarkdown(child, depth + 1)).join('');

    if (element.classList.contains('katex-display')) {
      const latex = getLatex(element);
      if (latex) return `\n$$\n${latex}\n$$\n\n`;
    }
    if (element.classList.contains('katex')) {
      const latex = getLatex(element);
      if (latex) return `$${latex}$`;
    }

    switch (tag) {
      case 'br':
        return '\n';
      case 'p':
        return `${children().trim()}\n\n`;
      case 'strong':
      case 'b':
        return `**${children()}**`;
      case 'em':
      case 'i':
        return `*${children()}*`;
      case 'del':
      case 's':
        return `~~${children()}~~`;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number(tag.slice(1));
        return `${'#'.repeat(level)} ${children().trim()}\n\n`;
      }
      case 'hr':
        return '\n---\n\n';
      case 'code': {
        if (element.parentElement?.tagName.toLowerCase() === 'pre') {
          return element.textContent || '';
        }
        const code = String(element.textContent || '').replace(/`/g, '\\`');
        return `\`${code}\``;
      }
      case 'pre': {
        const code = element.querySelector('code');
        const languageClass = [...(code?.classList || [])].find((item) =>
          item.startsWith('language-'),
        );
        const dataLanguage =
          element.getAttribute('data-language') || code?.getAttribute('data-language') || '';
        const language = languageClass?.replace('language-', '') || dataLanguage;
        const content = (code?.textContent ?? element.textContent ?? '').replace(/\n$/, '');
        return `\n\`\`\`${language}\n${content}\n\`\`\`\n\n`;
      }
      case 'a': {
        const href = resolveUrl(element.getAttribute('href'));
        const label = children().trim() || href || '';
        return href ? `[${label}](${href})` : label;
      }
      case 'img': {
        const src = resolveUrl(element.getAttribute('src'));
        const alt = normalizeText(element.getAttribute('alt')) || 'image';
        return src ? `![${alt}](${src})` : `[Image: ${alt}]`;
      }
      case 'blockquote': {
        const body = children().trim();
        return `${body.split('\n').map((line) => `> ${line}`).join('\n')}\n\n`;
      }
      case 'ul':
      case 'ol':
        return `${children()}\n`;
      case 'li': {
        const parentTag = element.parentElement?.tagName.toLowerCase();
        let marker = '- ';
        if (parentTag === 'ol') {
          const siblings = [...element.parentElement.children].filter(
            (item) => item.tagName.toLowerCase() === 'li',
          );
          marker = `${siblings.indexOf(element) + 1}. `;
        }
        const indent = '  '.repeat(Math.max(0, depth - 2));
        return `${indent}${marker}${children().trim()}\n`;
      }
      case 'table': {
        const rows = [...element.querySelectorAll('tr')].map((row) =>
          [...row.querySelectorAll(':scope > th, :scope > td')].map((cell) =>
            normalizeText(cell.innerText).replace(/\n+/g, ' '),
          ),
        );
        if (!rows.length) return '';
        const width = Math.max(...rows.map((row) => row.length));
        const normalized = rows.map((row) => [
          ...row,
          ...Array(Math.max(0, width - row.length)).fill(''),
        ]);
        const escapeCell = (value) => String(value).replace(/\|/g, '\\|');
        const header = normalized[0].map(escapeCell);
        return [
          `| ${header.join(' | ')} |`,
          `| ${header.map(() => '---').join(' | ')} |`,
          ...normalized.slice(1).map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
          '',
          '',
        ].join('\n');
      }
      default:
        return children();
    }
  }

  /**
   * Collect visible attachment metadata without attempting authenticated binary downloads.
   */
  function extractAttachments(turn) {
    const items = new Map();
    const candidates = turn.querySelectorAll(
      'a[href], button, [data-testid*="file" i], [data-testid*="attachment" i]',
    );

    for (const element of candidates) {
      const text = normalizeText(element.innerText || element.getAttribute('aria-label'));
      const match = text.match(FILE_NAME_PATTERN);
      if (!match) continue;
      const name = match[1].trim();
      const href = element.tagName.toLowerCase() === 'a'
        ? resolveUrl(element.getAttribute('href'))
        : null;
      const key = `${name}|${href || ''}`;
      items.set(key, { name, url: href });
    }

    return [...items.values()];
  }

  /**
   * Collect message image metadata, skipping tiny UI icons/avatars.
   */
  function extractImages(turn) {
    const images = [];
    const seen = new Set();
    for (const image of turn.querySelectorAll('img[src]')) {
      const src = resolveUrl(image.getAttribute('src'));
      const fetchSrc = resolveUrl(image.currentSrc || image.getAttribute('src'));
      if (!src || seen.has(src)) continue;
      const width = image.naturalWidth || image.width || 0;
      const height = image.naturalHeight || image.height || 0;
      const alt = normalizeText(image.getAttribute('alt'));
      if (width && height && width <= 48 && height <= 48) continue;
      seen.add(src);
      images.push({
        src,
        fetchSrc: fetchSrc || src,
        alt: alt || null,
        width: width || null,
        height: height || null,
      });
    }
    return images;
  }

  /**
   * Parse one currently-rendered conversation turn into a structured message record.
   */
  function extractTurn(turn) {
    const roleNode = turn.matches?.('[data-message-author-role]')
      ? turn
      : turn.querySelector('[data-message-author-role]');
    if (!roleNode) return null;

    const role = roleNode.getAttribute('data-message-author-role');
    if (role !== 'user' && role !== 'assistant') return null;

    const attachments = extractAttachments(turn);
    const images = extractImages(turn);
    const cleaned = cleanMessageClone(roleNode);
    const text = normalizeText(cleaned.innerText || cleaned.textContent);
    let markdown = normalizeText(nodeToMarkdown(cleaned));
    if (!markdown) markdown = text;
    if (!markdown && !attachments.length && !images.length) return null;

    const testId = turn.getAttribute?.('data-testid') || '';
    const turnId = turn.dataset?.turnId || turn.getAttribute?.('data-turn-id') || '';
    const indexMatch = testId.match(/conversation-turn-(\d+)/i);
    const index = indexMatch ? Number(indexMatch[1]) : null;
    const fallbackFingerprint = `${role}|${text.slice(0, 3000)}|${attachments.map((item) => item.name).join('|')}`;
    const key = turnId || testId || `${role}-${hashString(fallbackFingerprint)}`;

    return {
      key,
      turnId: turnId || null,
      index,
      firstSeen: firstSeenSequence++,
      role,
      text,
      markdown,
      html: cleaned.innerHTML,
      attachments,
      images,
    };
  }

  /**
   * Wait until ChatGPT mounts the message body for one virtualized turn shell.
   */
  async function waitForTurnMessage(turn) {
    const deadline = Date.now() + CONFIG.turnHydrateWaitMs;
    while (Date.now() < deadline) {
      const message = extractTurn(turn);
      if (message) return message;
      await sleep(80);
    }
    return null;
  }

  /**
   * Scan current ChatGPT turn shells, which expose the complete turn count before bodies are hydrated.
   */
  async function scanIndexedConversation(shells, onProgress) {
    if (!ns.traversal?.hydrateTurnShells) {
      throw new Error(tr('error.traversalModule'));
    }

    const scrollRoot = document.querySelector('[data-scroll-root]') || findScrollContainer();
    const originalScrollTop = scrollRoot?.scrollTop || 0;
    onProgress?.({ phase: tr('progress.index'), count: 0, total: shells.length });

    let result;
    try {
      result = await ns.traversal.hydrateTurnShells({
        shells,
        extract: extractTurn,
        waitForMessage: waitForTurnMessage,
        onProgress: (progress) => onProgress?.({
          phase: progress.phase,
          count: progress.completed,
          total: progress.total,
        }),
        retryPasses: 2,
      });
    } finally {
      if (scrollRoot) {
        scrollRoot.scrollTo?.({ top: originalScrollTop, behavior: 'instant' });
        if (typeof scrollRoot.scrollTo !== 'function') scrollRoot.scrollTop = originalScrollTop;
      }
    }

    if (result.missing > 0) {
      throw new Error(
        tr('error.incompleteIndex', { total: result.total, missing: result.missing }),
      );
    }

    return result.messages;
  }

  /**
   * Scan the full rendered history, actively traversing long/virtualized conversations.
   */
  async function scanConversationLegacy(onProgress) {
    const scroller = findScrollContainer();
    if (!scroller) throw new Error(tr('error.noScroller'));

    const originalScrollTop = scroller.scrollTop;
    const messages = new Map();

    const harvest = () => {
      for (const turn of getTurnNodes()) {
        const message = extractTurn(turn);
        if (!message) continue;
        const existing = messages.get(message.key);
        if (!existing || message.text.length > existing.text.length) {
          messages.set(message.key, existing ? { ...message, firstSeen: existing.firstSeen } : message);
        }
      }
      onProgress?.({ phase: tr('progress.scan'), count: messages.size });
    };

    try {
      harvest();

      let topStable = 0;
      let previousHeight = -1;
      let previousCount = -1;
      onProgress?.({ phase: tr('progress.loadOlder'), count: messages.size });

      for (let pass = 0; pass < CONFIG.maxTopPasses; pass += 1) {
        scroller.scrollTop = 0;
        await sleep(CONFIG.topLoadWaitMs);
        harvest();

        const height = scroller.scrollHeight;
        const atTop = scroller.scrollTop <= 4;
        if (atTop && height === previousHeight && messages.size === previousCount) {
          topStable += 1;
        } else {
          topStable = 0;
        }
        previousHeight = height;
        previousCount = messages.size;
        if (topStable >= CONFIG.topStableRounds) break;
      }

      scroller.scrollTop = 0;
      await sleep(CONFIG.settleWaitMs);
      harvest();
      onProgress?.({ phase: tr('progress.walk'), count: messages.size });

      let bottomStable = 0;
      let previousBottomHeight = -1;
      let previousBottomCount = -1;

      for (let pass = 0; pass < CONFIG.maxScanPasses; pass += 1) {
        harvest();
        const viewport = Math.max(scroller.clientHeight, 400);
        const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const current = scroller.scrollTop;

        if (current >= maxScroll - 4) {
          scroller.scrollTop = scroller.scrollHeight;
          await sleep(CONFIG.settleWaitMs);
          harvest();

          const height = scroller.scrollHeight;
          if (height === previousBottomHeight && messages.size === previousBottomCount) {
            bottomStable += 1;
          } else {
            bottomStable = 0;
          }
          previousBottomHeight = height;
          previousBottomCount = messages.size;
          if (bottomStable >= CONFIG.bottomStableRounds) break;
          continue;
        }

        scroller.scrollTop = Math.min(
          current + Math.max(220, viewport * CONFIG.scanStepRatio),
          maxScroll,
        );
        await sleep(CONFIG.scanWaitMs);
      }

      harvest();
    } finally {
      scroller.scrollTop = Math.min(originalScrollTop, scroller.scrollHeight - scroller.clientHeight);
    }

    const result = [...messages.values()].sort((a, b) => {
      if (a.index !== null && b.index !== null) return a.index - b.index;
      if (a.index !== null) return -1;
      if (b.index !== null) return 1;
      return a.firstSeen - b.firstSeen;
    });

    if (!result.length) {
      throw new Error(tr('error.noMessages'));
    }
    return result;
  }


  /**
   * Read the complete current conversation. Prefer ChatGPT's own conversation tree API so
   * virtualized first/last turns cannot be lost; retain DOM traversal as a compatibility fallback.
   */
  async function scanConversation(onProgress, options = exportSettings) {
    if (ns.remote?.fetchCurrentConversation) {
      try {
        onProgress?.({ phase: tr('progress.readApi'), count: 0 });
        const remote = await ns.remote.fetchCurrentConversation(location, options);
        if (remote?.messages?.length) {
          onProgress?.({
            phase: tr('progress.readApi'),
            count: remote.messages.length,
            total: remote.messages.length,
          });
          return {
            messages: remote.messages,
            source: 'api',
            title: remote.title || null,
            remoteContext: {
              conversationId: remote.conversationId,
              accessToken: remote.accessToken,
            },
          };
        }
      } catch (error) {
        console.warn('[ChatGPT Conversation Exporter] API extraction unavailable; using DOM fallback.', error);
        onProgress?.({ phase: tr('progress.apiFallback'), count: 0 });
      }
    }

    const shells = ns.traversal?.getTurnShells?.(document) || [];
    const messages = shells.length
      ? await scanIndexedConversation(shells, onProgress)
      : await scanConversationLegacy(onProgress);
    return { messages, source: 'dom', title: null, remoteContext: null };
  }

  /**
   * Decode a base64 payload returned by the extension service worker.
   */
  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  /**
   * Fetch one image in the page first, then fall back to the extension service worker for OpenAI CDN URLs.
   */
  async function fetchImageBytes(src, accessToken = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.imageFetchTimeoutMs);

    try {
      try {
        const response = await fetch(src, {
          credentials: 'include',
          cache: 'force-cache',
          headers: ns.assets?.createAssetRequestHeaders?.(accessToken) || {},
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > CONFIG.maxImageBytes) throw new Error(tr('error.imageTooLarge'));
        return {
          bytes,
          mimeType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
        };
      } catch (pageError) {
        if (!chrome.runtime?.sendMessage) throw pageError;
        const response = await chrome.runtime.sendMessage({
          type: 'CGPT_FETCH_ASSET',
          url: src,
          accessToken: accessToken || null,
        });
        if (!response?.ok) throw new Error(response?.error || pageError.message || tr('error.imageDownload'));
        const bytes = base64ToBytes(response.base64);
        if (bytes.length > CONFIG.maxImageBytes) throw new Error(tr('error.imageTooLarge'));
        return {
          bytes,
          mimeType: response.contentType || 'application/octet-stream',
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Download conversation images once and prepare compressed archive files plus reusable bytes for PDF printing.
   */
  async function archiveConversationImages(messages, onProgress, remoteContext = null) {
    if (
      !ns.assets?.resolveImageType ||
      !ns.assets?.compressImageForEmbedding ||
      !ns.assets?.createImageAssetPath ||
      !ns.assets?.getImageSourceKey
    ) {
      throw new Error(tr('error.imageModule'));
    }

    const uniqueSources = new Set();
    for (const message of messages) {
      for (const image of message.images || []) {
        const sourceKey = ns.assets.getImageSourceKey(image);
        if (sourceKey) uniqueSources.add(sourceKey);
      }
    }

    const pathBySource = new Map();
    const binaryBySource = new Map();
    const files = [];
    let archived = 0;
    let failed = 0;
    let processed = 0;
    let sourceByteLength = 0;
    let archivedByteLength = 0;
    let compressed = 0;
    const failures = [];

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      for (let imageIndex = 0; imageIndex < (message.images || []).length; imageIndex += 1) {
        const image = message.images[imageIndex];
        const sourceKey = ns.assets.getImageSourceKey(image);
        if (!sourceKey || pathBySource.has(sourceKey) || failures.some((item) => item.sourceKey === sourceKey)) {
          continue;
        }

        processed += 1;
        try {
          let fetchSource = image.fetchSrc || image.src;
          let assetAccessToken = null;
          let sourceName = image.originalName || null;
          if (image.fileId && remoteContext && ns.remote?.resolveFileDownload) {
            const resolved = await ns.remote.resolveFileDownload({
              fileId: image.fileId,
              conversationId: remoteContext.conversationId,
              accessToken: remoteContext.accessToken,
            });
            fetchSource = resolved.download_url;
            assetAccessToken = remoteContext.accessToken || null;
            sourceName ||= resolved.file_name || null;
          }
          if (!fetchSource || fetchSource.startsWith('chatgpt-file://')) {
            throw new Error(tr('error.imageUrl'));
          }

          const asset = await fetchImageBytes(fetchSource, assetAccessToken);
          if (!sourceName) {
            try {
              sourceName = decodeURIComponent(new URL(fetchSource, location.href).pathname.split('/').pop() || '') || null;
            } catch {
              sourceName = null;
            }
          }
          const imageType = ns.assets.resolveImageType({
            httpMimeType: asset.mimeType,
            originalName: sourceName,
            messageMimeType: image.mimeType,
            bytes: asset.bytes,
          });
          if (!String(imageType.mimeType || '').startsWith('image/')) {
            throw new Error(tr('error.imageDownload'));
          }

          const prepared = await ns.assets.compressImageForEmbedding({
            bytes: asset.bytes,
            mimeType: imageType.mimeType,
          });
          const localPath = ns.assets.createImageAssetPath(
            messageIndex + 1,
            imageIndex + 1,
            prepared.mimeType,
          );
          pathBySource.set(sourceKey, localPath);
          binaryBySource.set(sourceKey, { bytes: prepared.bytes, mimeType: prepared.mimeType, localPath });
          files.push({ name: localPath, data: prepared.bytes });
          archived += 1;
          sourceByteLength += asset.bytes.length;
          archivedByteLength += prepared.bytes.length;
          if (prepared.compressed) compressed += 1;
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          failures.push({
            sourceKey,
            fileId: image.fileId || null,
            source: image.fetchSrc || image.src || null,
            error: messageText,
          });
          failed += 1;
        }

        onProgress?.({
          phase: tr('progress.archiveImages'),
          count: processed,
          total: uniqueSources.size,
        });
      }
    }

    return {
      pathBySource,
      binaryBySource,
      files,
      stats: {
        total: uniqueSources.size,
        archived,
        failed,
        compressed,
        sourceByteLength,
        archivedByteLength,
        failures,
      },
    };
  }

  /**
   * Create Markdown and JSON representations from scanned messages.
   */
  function buildExport(messages, imageArchive = null, scanInfo = null, rangeMetadata = null, options = exportSettings, resolvedImageSources = new Map()) {
    const title = scanInfo?.title || getConversationTitle();
    const exportedAt = new Date();
    const userCount = messages.filter((item) => item.role === 'user').length;
    const assistantCount = messages.filter((item) => item.role === 'assistant').length;

    const metadata = {
      schemaVersion: 8,
      source: 'ChatGPT',
      title,
      conversationId: scanInfo?.remoteContext?.conversationId || getConversationId(),
      url: location.href,
      exportedAt: exportedAt.toISOString(),
      branch: 'current-visible-branch',
      messageCount: messages.length,
      counts: { user: userCount, assistant: assistantCount },
      imageArchive,
      extractionMode: scanInfo?.source || 'dom',
      exportScope: rangeMetadata?.exportScope || 'full',
      startMessageKey: rangeMetadata?.startMessageKey || null,
      startMessageId: rangeMetadata?.startMessageId || null,
      startMessagePosition: rangeMetadata?.startMessagePosition || null,
      startUserOrdinal: rangeMetadata?.startUserOrdinal || null,
      endMessageKey: rangeMetadata?.endMessageKey || null,
      endMessageId: rangeMetadata?.endMessageId || null,
      endMessagePosition: rangeMetadata?.endMessagePosition || null,
      originalMessageCount: rangeMetadata?.originalMessageCount ?? messages.length,
      exportedMessageCount: rangeMetadata?.exportedMessageCount ?? messages.length,
      includeToolDetails: options?.includeToolDetails === true,
      includeImages: options?.includeImages !== false,
      uiLocale: currentLocale,
    };

    const rangeLabel = metadata.exportScope === 'partial'
      ? tr('md.partialRange', { start: metadata.startMessagePosition, end: metadata.endMessagePosition || metadata.originalMessageCount, total: metadata.originalMessageCount })
      : tr('md.fullRange');
    const imageLabel = metadata.includeImages
      ? (imageArchive
        ? `${imageArchive.archived}/${imageArchive.total}${imageArchive.failed ? tr('md.imageFailed', { failed: imageArchive.failed }) : ''}`
        : tr('md.included'))
      : tr('md.imageNotArchived');

    const separator = currentLocale === 'zh-CN' ? '：' : ': ';
    const messageCountLabel = currentLocale === 'zh-CN'
      ? `${messages.length}（User ${userCount} / Assistant ${assistantCount}）`
      : `${messages.length} (User ${userCount} / Assistant ${assistantCount})`;
    const markdownParts = [
      `# ${title}`,
      '',
      `- ${tr('md.exportedAt')}${separator}${exportedAt.toLocaleString(currentLocale)}`,
      `- ${tr('md.source')}${separator}${location.href}`,
      `- ${tr('md.messageCount')}${separator}${messageCountLabel}`,
      `- ${tr('md.range')}${separator}${rangeLabel}`,
      `- ${tr('md.imageArchive')}${separator}${imageLabel}`,
      `- ${tr('md.toolDetails')}${separator}${metadata.includeToolDetails ? tr('md.included') : tr('md.excluded')}`,
      `- ${tr('md.branch')}${separator}${tr('md.currentBranch')}`,
      '',
      '---',
      '',
    ];

    messages.forEach((message, position) => {
      markdownParts.push(`## ${message.role === 'user' ? 'User' : 'Assistant'}`, '');
      const renderedMarkdown = ns.assets?.renderMarkdownImages
        ? ns.assets.renderMarkdownImages(message.markdown, message.images, resolvedImageSources, metadata.includeImages)
        : message.markdown;
      if (renderedMarkdown) markdownParts.push(renderedMarkdown, '');
      if (message.attachments.length) {
        markdownParts.push(`**${tr('md.attachments')}**`, '');
        for (const attachment of message.attachments) {
          markdownParts.push(
            attachment.url
              ? `- [${attachment.name}](${attachment.url})`
              : `- \`${attachment.name}\``,
          );
        }
        markdownParts.push('');
      }
      markdownParts.push(`<!-- message:${position + 1} role:${message.role} -->`, '', '---', '');
    });

    const json = {
      ...metadata,
      messages: messages.map(({ key, firstSeen, ...message }, position) => ({
        position: position + 1,
        ...message,
      })),
    };

    return {
      metadata,
      markdown: markdownParts.join('\n'),
      json: JSON.stringify(json, null, 2),
      baseName: `${sanitizeFileName(title)}_${formatFileTimestamp(exportedAt)}`,
    };
  }

  /**
   * Trigger a local browser download for a Blob without sending data off-device.
   */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function downloadText(text, filename, mimeType) {
    downloadBlob(new Blob([text], { type: `${mimeType};charset=utf-8` }), filename);
  }

  /** Package Markdown and its relative image assets into one portable ZIP archive. */
  function createMarkdownImagePackage(markdown, imageFiles) {
    if (!ns.zip?.createZip) throw new Error(tr('error.zipModule'));
    const assetFiles = (imageFiles || []).filter((file) => String(file?.name || '').startsWith('assets/images/'));
    return ns.zip.createZip([
      { name: 'conversation.md', data: markdown },
      ...assetFiles,
    ]);
  }

  /** Convert archived image bytes to data URIs only for the browser print/PDF path. */
  function createPrintableImageData(binaryBySource) {
    const output = new Map();
    if (!ns.assets?.bytesToDataUri) return output;
    for (const [sourceKey, asset] of binaryBySource || []) {
      output.set(sourceKey, ns.assets.bytesToDataUri(asset.bytes, asset.mimeType));
    }
    return output;
  }

  /** Print a self-contained HTML document in an isolated iframe using the browser's system print dialog. */
  async function printDocument(html) {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.position = 'fixed';
    frame.style.right = '0';
    frame.style.bottom = '0';
    frame.style.width = '1px';
    frame.style.height = '1px';
    frame.style.opacity = '0';
    frame.style.pointerEvents = 'none';
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(tr('error.printFailed'))), 10000);
      frame.addEventListener('load', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    frame.srcdoc = html;
    document.documentElement.appendChild(frame);

    try {
      await loaded;
      const printWindow = frame.contentWindow;
      const printDocumentRef = frame.contentDocument;
      if (!printWindow || !printDocumentRef) throw new Error(tr('error.printFailed'));
      await printDocumentRef.fonts?.ready;
      await Promise.all([...printDocumentRef.images].map((image) => image.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true });
            image.addEventListener('error', resolve, { once: true });
          })));
      printWindow.addEventListener('afterprint', () => frame.remove(), { once: true });
      printWindow.focus();
      printWindow.print();
      setTimeout(() => frame.remove(), 120000);
    } catch (error) {
      frame.remove();
      throw error;
    }
  }

  /**
   * Export the current conversation in the requested format.
   */
  async function exportConversation(format = 'zip', range = exportRangeSelection) {
    if (exportInProgress) {
      showToast(tr('toast.running'), 'warning');
      return;
    }
    exportInProgress = true;
    setUiBusy(true);

    try {
      if (range?.mode === 'partial' && range?.url && range.url !== location.href) {
        throw new Error(tr('error.rangeChanged'));
      }

      let scanInfo = null;
      if (
        range?.mode === 'partial' &&
        partialScanCache?.url === location.href &&
        partialScanCache?.includeToolDetails === exportSettings.includeToolDetails &&
        partialScanCache?.scanInfo?.messages?.length
      ) {
        scanInfo = partialScanCache.scanInfo;
      } else {
        scanInfo = await scanConversation(({ phase, count, total }) => {
          updateProgress(total ? `${phase} · ${count}/${total}` : `${phase}${count ? ` · ${count}` : ''}`);
        }, exportSettings);
      }

      if (!ns.range?.applyExportRange) throw new Error(tr('error.rangeModule'));
      const ranged = ns.range.applyExportRange(scanInfo.messages, range);
      const messages = ranged.messages;

      let imageArchive = null;
      let pathBySource = new Map();
      let binaryBySource = new Map();
      let imageFiles = [];
      if ((format === 'md' || format === 'zip' || format === 'pdf') && exportSettings.includeImages) {
        const archived = await archiveConversationImages(messages, ({ phase, count, total }) => {
          updateProgress(`${phase} · ${count}/${total}`);
        }, scanInfo.remoteContext);
        imageArchive = archived.stats;
        pathBySource = archived.pathBySource;
        binaryBySource = archived.binaryBySource;
        imageFiles = archived.files;
      }

      updateProgress(tr('progress.generate'));
      const output = buildExport(messages, imageArchive, scanInfo, ranged.metadata, exportSettings, pathBySource);

      if (format === 'md') {
        if (exportSettings.includeImages) {
          const packageBlob = createMarkdownImagePackage(output.markdown, imageFiles);
          downloadBlob(packageBlob, `${output.baseName}_markdown.zip`);
        } else {
          downloadText(output.markdown, `${output.baseName}.md`, 'text/markdown');
        }
      } else if (format === 'json') {
        downloadText(output.json, `${output.baseName}.json`, 'application/json');
      } else if (format === 'pdf') {
        if (!ns.print?.buildPrintHtml) throw new Error(tr('error.printModule'));
        updateProgress(tr('progress.preparePdf'));
        const imageDataBySource = exportSettings.includeImages ? createPrintableImageData(binaryBySource) : new Map();
        const html = ns.print.buildPrintHtml({
          title: output.metadata.title,
          messages,
          imageDataBySource,
          includeImages: exportSettings.includeImages,
        });
        await printDocument(html);
      } else {
        if (!ns.zip?.createZip) throw new Error(tr('error.zipModule'));
        const zipBlob = ns.zip.createZip([
          { name: 'conversation.md', data: output.markdown },
          { name: 'conversation.json', data: output.json },
          ...imageFiles,
        ]);
        downloadBlob(zipBlob, `${output.baseName}.zip`);
      }

      const imageSummary = imageArchive
        ? tr('images.summary', { archived: imageArchive.archived, total: imageArchive.total }) + (imageArchive.failed ? tr('images.failed', { failed: imageArchive.failed }) : '')
        : '';
      const sourceSummary = output.metadata.extractionMode === 'api' ? tr('source.api') : tr('source.dom');
      if (format === 'pdf') {
        showToast(
          tr('toast.printOpened'),
          imageArchive?.failed ? 'warning' : 'success',
          7000,
        );
      } else {
        showToast(
          tr('toast.complete', {
            count: output.metadata.messageCount,
            user: output.metadata.counts.user,
            assistant: output.metadata.counts.assistant,
            scope: output.metadata.exportScope === 'partial' ? tr('scope.partial') : tr('scope.full'),
            source: sourceSummary,
            images: imageSummary,
          }),
          imageArchive?.failed ? 'warning' : 'success',
          imageArchive?.failed ? 7000 : 4500,
        );
      }
      chrome.runtime?.sendMessage?.({
        type: 'CGPT_EXPORT_COMPLETE',
        messageCount: output.metadata.messageCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showToast(tr('toast.failed', { message }), 'error', 7000);
      chrome.runtime?.sendMessage?.({ type: 'CGPT_EXPORT_FAILED', error: message });
      console.error('[ChatGPT Conversation Exporter]', error);
    } finally {
      exportInProgress = false;
      setUiBusy(false);
      updateProgress('');
    }
  }

  let ui = null;

  /**
   * Update the selected export scope and reflect it in the export menu.
   */
  function setExportRangeSelection(selection) {
    exportRangeSelection = selection?.mode === 'partial'
      ? {
          mode: 'partial',
          startMessageKey: selection.startMessageKey,
          startLabel: selection.startLabel || null,
          endMessageKey: selection.endMessageKey || null,
          endLabel: selection.endLabel || null,
          url: selection.url || location.href,
        }
      : { mode: 'full', startMessageKey: null, startLabel: null, endMessageKey: null, endLabel: null, url: null };
    updateRangeUi();
  }

  /**
   * Render the current full/partial range selection without rebuilding the menu.
   */
  function updateRangeUi() {
    if (!ui) return;
    for (const button of ui.rangeButtons) {
      button.classList.toggle('active', button.dataset.rangeMode === exportRangeSelection.mode);
    }
    ui.rangeSummary.textContent = exportRangeSelection.mode === 'partial'
      ? tr('menu.partialSummary', {
          start: exportRangeSelection.startLabel || tr('menu.partialFallback'),
          end: exportRangeSelection.endLabel || tr('picker.last'),
        })
      : tr('menu.fullSummary');
  }

  /**
   * Close the partial-export start picker and return to the export menu.
   */
  function closePartialPicker({ reopenMenu = false } = {}) {
    const current = ensureUi();
    current.pickerBackdrop.classList.remove('open');
    current.pickerPanel?.classList.remove('loading');
    current.pickerSpinner?.setAttribute('hidden', 'hidden');
    if (reopenMenu) current.menu.classList.add('open');
  }


  /**
   * Render loading placeholders so partial-range scanning never appears frozen.
   */
  function renderPickerLoadingState(current, statusText) {
    current.pickerPanel?.classList.add('loading');
    current.pickerSpinner?.removeAttribute('hidden');
    current.pickerStatus.textContent = statusText || tr('picker.loading');
    current.pickerList.replaceChildren();
    const loader = document.createElement('div');
    loader.className = 'picker-list-loader';
    loader.setAttribute('aria-hidden', 'true');
    const loaderGlow = document.createElement('div');
    loaderGlow.className = 'picker-list-loader-glow';
    loader.appendChild(loaderGlow);
    current.pickerList.appendChild(loader);
  }

  /**
   * Clear the partial-range loading state once the message list is ready.
   */
  function clearPickerLoadingState(current) {
    current.pickerPanel?.classList.remove('loading');
    current.pickerSpinner?.setAttribute('hidden', 'hidden');
  }

  /**
   * Load the complete branch and let the user choose a User message as the partial-export start point.
   */
  async function openPartialPicker() {
    const current = ensureUi();
    current.menu.classList.remove('open');
    current.pickerBackdrop.classList.add('open');
    renderPickerLoadingState(current, tr('picker.loading'));

    try {
      let scanInfo = partialScanCache?.url === location.href && partialScanCache?.includeToolDetails === exportSettings.includeToolDetails ? partialScanCache.scanInfo : null;
      if (!scanInfo?.messages?.length) {
        scanInfo = await scanConversation(({ phase, count, total }) => {
          renderPickerLoadingState(current, total ? `${phase} · ${count}/${total}` : `${phase}${count ? ` · ${count}` : ''}`);
        }, exportSettings);
        partialScanCache = { url: location.href, includeToolDetails: exportSettings.includeToolDetails, scanInfo };
      }

      if (!ns.range?.getMessageOptions) throw new Error(tr('error.rangeModule'));
      const options = ns.range.getMessageOptions(scanInfo.messages);
      if (!options.length) throw new Error(tr('error.noMessages'));

      const byKey = new Map(options.map((option) => [option.key, option]));
      let startOption = byKey.get(exportRangeSelection.startMessageKey) || options[0];
      let endOption = byKey.get(exportRangeSelection.endMessageKey) || options.at(-1);
      if (endOption.messagePosition < startOption.messagePosition) endOption = options.at(-1);
      let boundary = 'start';

      const render = () => {
        clearPickerLoadingState(current);
        current.pickerStart.textContent = `${tr('picker.start')}: ${startOption.label}`;
        current.pickerEnd.textContent = `${tr('picker.end')}: ${endOption.label}`;
        current.pickerStart.classList.toggle('active', boundary === 'start');
        current.pickerEnd.classList.toggle('active', boundary === 'end');
        current.pickerStatus.textContent = tr('picker.choose', { boundary: boundary === 'start' ? tr('picker.start') : tr('picker.end'), count: options.length });
        current.pickerList.replaceChildren();
        const fragment = document.createDocumentFragment();
        const startPosition = startOption.messagePosition;
        const endPosition = endOption.messagePosition;
        for (const option of options) {
          const invalidEnd = boundary === 'end' && option.messagePosition < startPosition;
          const button = document.createElement('button');
          const isStart = option.key === startOption.key;
          const isEnd = option.key === endOption.key;
          const inRange = option.messagePosition >= startPosition && option.messagePosition <= endPosition;
          const isActiveSelection = (boundary === 'start' && isStart) || (boundary === 'end' && isEnd);
          button.type = 'button';
          button.className = 'start-item';
          button.dataset.messageKey = option.key;
          button.disabled = invalidEnd;
          if (isStart) button.classList.add('is-start');
          if (isEnd) button.classList.add('is-end');
          if (inRange) button.classList.add('in-range');
          if (isActiveSelection) button.classList.add('selected');

          const text = document.createElement('div');
          text.className = 'start-item-text';
          text.textContent = option.label;
          button.appendChild(text);

          if (isStart || isEnd) {
            const badges = document.createElement('div');
            badges.className = 'start-item-badges';
            if (isStart) {
              const badge = document.createElement('span');
              badge.className = 'start-item-badge start';
              badge.textContent = tr('picker.start');
              badges.appendChild(badge);
            }
            if (isEnd) {
              const badge = document.createElement('span');
              badge.className = 'start-item-badge end';
              badge.textContent = tr('picker.end');
              badges.appendChild(badge);
            }
            button.appendChild(badges);
          }

          button.addEventListener('click', () => {
            if (boundary === 'start') {
              startOption = option;
              if (endOption.messagePosition < startOption.messagePosition) endOption = options.at(-1);
              boundary = 'end';
            } else {
              endOption = option;
            }
            render();
          });
          fragment.appendChild(button);
        }
        current.pickerList.appendChild(fragment);
      };

      current.pickerStart.onclick = () => { boundary = 'start'; render(); };
      current.pickerEnd.onclick = () => { boundary = 'end'; render(); };
      current.pickerConfirm.onclick = () => {
        setExportRangeSelection({
          mode: 'partial',
          startMessageKey: startOption.key,
          startLabel: startOption.label,
          endMessageKey: endOption.key,
          endLabel: endOption.label,
          url: location.href,
        });
        closePartialPicker({ reopenMenu: true });
      };
      render();
    } catch (error) {
      clearPickerLoadingState(current);
      current.pickerList.replaceChildren();
      const message = error instanceof Error ? error.message : String(error);
      current.pickerStatus.textContent = tr('picker.failed', { message });
    }
  }

  /**
   * Re-render fixed UI labels after a locale change without rebuilding the Shadow DOM.
   */
  function applyUiLanguage() {
    if (!ui) return;
    ui.button.textContent = exportInProgress ? tr('export.busy') : tr('export.button');
    ui.rangeTitle.textContent = tr('menu.rangeTitle');
    ui.rangeButtons.find((button) => button.dataset.rangeMode === 'full').textContent = tr('menu.full');
    ui.rangeButtons.find((button) => button.dataset.rangeMode === 'partial').textContent = tr('menu.partial');
    ui.optionsTitle.textContent = tr('menu.optionsTitle');
    ui.toolDetailsLabel.textContent = tr('menu.toolDetails');
    ui.toolDetailsHint.textContent = tr('menu.toolDetailsHint');
    ui.imagesLabel.textContent = tr('menu.images');
    ui.imagesHint.textContent = tr('menu.imagesHint');
    ui.languageTitle.textContent = tr('menu.languageTitle');
    ui.menuHint.textContent = tr('menu.hint');
    ui.formatZip.textContent = tr('menu.zip');
    ui.formatMd.textContent = tr('menu.md');
    ui.formatPdf.textContent = tr('menu.pdf');
    ui.formatJson.textContent = tr('menu.json');
    ui.pickerTitle.textContent = tr('picker.title');
    ui.pickerStart.textContent = tr('picker.start');
    ui.pickerEnd.textContent = tr('picker.end');
    ui.pickerConfirm.textContent = tr('picker.confirm');
    ui.pickerClose.setAttribute('aria-label', tr('picker.close'));
    ui.pickerBackdrop.querySelector('.picker')?.setAttribute('aria-label', tr('picker.title'));
    updateLanguagePickerUi();
    updateRangeUi();
  }

  /**
   * Persist the tool-detail option and invalidate cached normalized API messages.
   */
  async function setIncludeToolDetails(enabled) {
    exportSettings = ns.exportOptions?.normalize?.({ ...exportSettings, includeToolDetails: enabled }) || { includeToolDetails: enabled === true, includeImages: exportSettings.includeImages !== false };
    partialScanCache = null;
    if (ui) ui.toolDetailsInput.checked = exportSettings.includeToolDetails;
    await ns.exportOptions?.save?.(exportSettings);
  }

  /**
   * Persist whether exports should download conversation images.
   */
  async function setIncludeImages(enabled) {
    exportSettings = ns.exportOptions?.normalize?.({ ...exportSettings, includeImages: enabled }) || {
      includeToolDetails: exportSettings.includeToolDetails === true,
      includeImages: enabled !== false,
    };
    if (ui) ui.imagesInput.checked = exportSettings.includeImages;
    await ns.exportOptions?.save?.(exportSettings);
  }

  /** Update the custom language listbox to reflect the active locale. */
  function updateLanguagePickerUi() {
    if (!ui) return;
    const labels = ns.i18n?.LOCALE_LABELS || {};
    ui.languageCurrent.textContent = labels[currentLocale] || currentLocale;
    for (const option of ui.languageOptions || []) {
      const selected = option.dataset.locale === currentLocale;
      option.setAttribute('aria-selected', selected ? 'true' : 'false');
      option.tabIndex = selected ? 0 : -1;
    }
  }

  /**
   * Switch and persist the exporter UI language.
   */
  async function setLocale(locale) {
    currentLocale = ns.i18n?.normalizeLocale?.(locale) || 'zh-CN';
    applyUiLanguage();
    await ns.i18n?.saveLocale?.(currentLocale);
  }

  /**
   * Load persisted preferences after the initial Chinese-first UI has mounted.
   */
  async function initializePreferences() {
    const [loadedOptions, loadedLocale] = await Promise.all([
      ns.exportOptions?.load?.() || Promise.resolve(exportSettings),
      ns.i18n?.loadLocale?.() || Promise.resolve(currentLocale),
    ]);
    exportSettings = ns.exportOptions?.normalize?.(loadedOptions) || exportSettings;
    currentLocale = ns.i18n?.normalizeLocale?.(loadedLocale) || currentLocale;
    if (ui) {
      ui.toolDetailsInput.checked = exportSettings.includeToolDetails;
      ui.imagesInput.checked = exportSettings.includeImages;
      updateLanguagePickerUi();
    }
    applyUiLanguage();
  }

  /**
   * Inject a small isolated export control into ChatGPT without depending on its CSS classes.
   */
  function ensureUi() {
    if (ui && document.contains(ui.host)) return ui;
    document.getElementById(UI_ROOT_ID)?.remove();

    const host = document.createElement('div');
    host.id = UI_ROOT_ID;
    host.setAttribute('data-chatgpt-exporter', 'true');
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; right: 18px; bottom: 86px; z-index: 2147483646; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .button { border: 1px solid rgba(127,127,127,.32); background: rgba(30,30,30,.92); color: #fff; border-radius: 999px; padding: 9px 13px; font-size: 13px; font-weight: 650; line-height: 1; cursor: pointer; box-shadow: 0 8px 26px rgba(0,0,0,.22); backdrop-filter: blur(12px); }
        .button:hover { transform: translateY(-1px); }
        .button:disabled { opacity: .55; cursor: progress; transform: none; }
        .menu { position: absolute; right: 0; bottom: 44px; width: 292px; display: none; padding: 8px; border-radius: 14px; border: 1px solid rgba(127,127,127,.25); background: rgba(28,28,28,.96); color: #fff; box-shadow: 0 14px 34px rgba(0,0,0,.3); backdrop-filter: blur(16px); }
        .menu.open { display: grid; gap: 6px; }
        .item { all: unset; box-sizing: border-box; cursor: pointer; border-radius: 8px; padding: 9px 10px; font-size: 13px; line-height: 1.25; }
        .item:hover { background: rgba(255,255,255,.1); }
        .section-title { color: rgba(255,255,255,.74); font-size: 11px; font-weight: 700; padding: 3px 4px 0; }
        .range-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .range-option { all: unset; box-sizing: border-box; cursor: pointer; border-radius: 9px; border: 1px solid rgba(255,255,255,.11); padding: 8px 9px; text-align: center; font-size: 12px; color: rgba(255,255,255,.78); }
        .range-option:hover { background: rgba(255,255,255,.07); }
        .range-option.active { background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.28); color: #fff; }
        .range-summary { min-height: 28px; color: rgba(255,255,255,.58); font-size: 11px; line-height: 1.4; padding: 2px 4px 5px; overflow-wrap: anywhere; }
        .option-row { display: flex; align-items: flex-start; gap: 8px; padding: 7px 5px; border-radius: 9px; }
        .option-row:hover { background: rgba(255,255,255,.05); }
        .option-row input { margin: 2px 0 0; accent-color: #fff; }
        .option-copy { display: grid; gap: 2px; min-width: 0; }
        .option-label { font-size: 12px; line-height: 1.35; color: rgba(255,255,255,.9); }
        .option-hint { font-size: 10px; line-height: 1.35; color: rgba(255,255,255,.48); }
        .language-picker { position: relative; }
        .language-trigger { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid rgba(255,255,255,.13); border-radius: 9px; padding: 8px 10px; background: rgba(255,255,255,.07); color: #fff; font: inherit; font-size: 12px; line-height: 1.3; cursor: pointer; outline: none; text-align: left; }
        .language-trigger:hover, .language-trigger:focus-visible { background: rgba(255,255,255,.11); border-color: rgba(255,255,255,.24); }
        .language-chevron { color: rgba(255,255,255,.5); font-size: 10px; transition: transform .14s ease; }
        .language-picker.open .language-chevron { transform: rotate(180deg); }
        .language-list { position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 5; display: none; max-height: 260px; overflow: auto; padding: 5px; border: 1px solid rgba(255,255,255,.14); border-radius: 11px; background: rgba(35,35,35,.995); box-shadow: 0 16px 38px rgba(0,0,0,.34); backdrop-filter: blur(18px); outline: none; }
        .language-picker.open .language-list { display: grid; gap: 2px; }
        .language-option { all: unset; box-sizing: border-box; display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; border-radius: 7px; padding: 8px 9px; color: rgba(255,255,255,.82); font-size: 12px; line-height: 1.25; }
        .language-option:hover, .language-option:focus-visible { background: rgba(255,255,255,.09); color: #fff; }
        .language-option[aria-selected="true"] { background: rgba(255,255,255,.13); color: #fff; }
        .language-check { opacity: 0; color: rgba(255,255,255,.82); }
        .language-option[aria-selected="true"] .language-check { opacity: 1; }
        .divider { height: 1px; background: rgba(255,255,255,.08); margin: 1px 0; }
        .hint { color: rgba(255,255,255,.58); font-size: 11px; padding: 3px 4px 2px; }
        .picker-backdrop { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,.46); font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .picker-backdrop.open { display: flex; }
        .picker { width: min(760px, calc(100vw - 32px)); max-height: min(80vh, 800px); display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; overflow: hidden; border-radius: 16px; border: 1px solid rgba(127,127,127,.28); background: rgba(28,28,28,.985); color: #fff; box-shadow: 0 24px 80px rgba(0,0,0,.42); }
        .picker-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 9px; }
        .picker-title { font-size: 14px; font-weight: 720; }
        .picker-close { all: unset; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: rgba(255,255,255,.68); font-size: 18px; }
        .picker-close:hover { background: rgba(255,255,255,.08); color: #fff; }
        .picker-status-row { display:flex; align-items:center; gap:10px; min-height: 18px; padding: 0 16px 10px; }
        .picker-status { color: rgba(255,255,255,.58); font-size: 11px; min-width: 0; }
        .picker-spinner { width: 14px; height: 14px; border-radius: 999px; border: 2px solid rgba(255,255,255,.18); border-top-color: rgba(255,255,255,.88); animation: cgpt-export-spin .8s linear infinite; flex: 0 0 auto; }
        .picker-spinner[hidden] { display: none; }
        .picker-list { min-height: 110px; overflow: auto; padding: 0 8px 10px; display: grid; gap: 8px; align-content: start; }
        .picker-list-loader { position: relative; min-height: 380px; border-radius: 12px; border: 1px solid rgba(255,255,255,.07); background: linear-gradient(180deg, rgba(255,255,255,.04), rgba(255,255,255,.02)); overflow: hidden; box-shadow: inset 0 1px 0 rgba(255,255,255,.03); }
        .picker-list-loader::before { content: ''; position: absolute; inset: 0; background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,0)); }
        .picker-list-loader-glow { position: absolute; inset: -20% -30%; background: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.06) 28%, rgba(255,255,255,.16) 50%, rgba(255,255,255,.06) 72%, rgba(255,255,255,0) 100%); transform: translateX(-55%); animation: cgpt-export-panel-shimmer 1.35s ease-in-out infinite; }
        .start-item { all: unset; box-sizing: border-box; display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: start; gap: 10px; width: 100%; cursor: pointer; border-radius: 9px; padding: 11px 12px; color: rgba(255,255,255,.86); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; border: 1px solid rgba(255,255,255,.055); background: rgba(255,255,255,.035); text-align: left; }
        .start-item:hover { background: rgba(255,255,255,.09); }
        .start-item.selected { border-color: rgba(255,255,255,.28); box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); color: #fff; }
        .start-item.in-range:not(.is-start):not(.is-end) { background: rgba(255,255,255,.05); }
        .start-item.is-start { border-color: rgba(94, 180, 255, .56); background: rgba(94, 180, 255, .11); }
        .start-item.is-end { border-color: rgba(255, 196, 94, .56); background: rgba(255, 196, 94, .11); }
        .start-item.is-start.is-end { border-color: rgba(190, 171, 255, .56); background: rgba(190, 171, 255, .11); }
        .start-item:disabled { opacity: .3; cursor: not-allowed; }
        .start-item-text { min-width: 0; text-align: left; }
        .start-item-badges { display:flex; flex-wrap: wrap; justify-content:flex-end; gap: 6px; }
        .start-item-badge { display:inline-flex; align-items:center; padding: 2px 7px; border-radius: 999px; font-size: 10px; line-height: 1.2; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.08); color: rgba(255,255,255,.92); }
        .start-item-badge.start { border-color: rgba(94, 180, 255, .34); background: rgba(94, 180, 255, .18); }
        .start-item-badge.end { border-color: rgba(255, 196, 94, .34); background: rgba(255, 196, 94, .18); }
        .picker-boundaries { display:grid; grid-template-columns:1fr 1fr; gap:8px; padding:0 16px 10px; }
        .picker-boundary { all:unset; box-sizing:border-box; cursor:pointer; border:1px solid rgba(255,255,255,.12); border-radius:9px; padding:9px 10px; font-size:11px; line-height:1.35; color:rgba(255,255,255,.75); overflow-wrap:anywhere; }
        .picker-boundary.active { background:rgba(255,255,255,.12); border-color:rgba(255,255,255,.28); color:#fff; }
        .picker-actions { display:flex; justify-content:flex-end; padding:10px 16px 14px; border-top:1px solid rgba(255,255,255,.08); }
        .picker-confirm { all:unset; cursor:pointer; border-radius:9px; padding:8px 13px; background:#fff; color:#111; font-size:12px; font-weight:700; }
        @keyframes cgpt-export-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes cgpt-export-panel-shimmer { 0% { transform: translateX(-55%); } 100% { transform: translateX(55%); } }
        .progress { display: none; position: absolute; right: 0; bottom: -34px; width: max-content; max-width: 320px; color: rgba(255,255,255,.86); background: rgba(28,28,28,.92); border: 1px solid rgba(127,127,127,.22); border-radius: 8px; padding: 6px 9px; font-size: 11px; box-shadow: 0 7px 20px rgba(0,0,0,.18); }
        .progress.visible { display: block; }
        .toast { position: fixed; right: 18px; bottom: 24px; max-width: min(420px, calc(100vw - 36px)); padding: 10px 12px; border-radius: 10px; background: rgba(28,28,28,.96); color: white; border: 1px solid rgba(127,127,127,.28); font-size: 13px; line-height: 1.45; box-shadow: 0 14px 34px rgba(0,0,0,.28); opacity: 0; transform: translateY(7px); pointer-events: none; transition: opacity .16s ease, transform .16s ease; }
        .toast.show { opacity: 1; transform: translateY(0); }
        .toast.success { border-color: rgba(70,190,120,.6); }
        .toast.error { border-color: rgba(235,90,90,.65); }
        .toast.warning { border-color: rgba(225,170,70,.65); }
      </style>
      <div class="wrap">
        <div class="menu" role="menu">
          <div class="section-title range-title">导出范围</div>
          <div class="range-row">
            <button class="range-option active" data-range-mode="full" type="button">全量导出</button>
            <button class="range-option" data-range-mode="partial" type="button">部分导出</button>
          </div>
          <div class="range-summary">导出当前分支的全部对话内容</div>
          <div class="divider"></div>
          <div class="section-title options-title">导出选项</div>
          <label class="option-row">
            <input class="tool-details-input" type="checkbox">
            <span class="option-copy">
              <span class="option-label tool-details-label">包含 GPT 工具调用详情</span>
              <span class="option-hint tool-details-hint">关闭后不导出工具调用参数与工具文本结果</span>
            </span>
          </label>
          <label class="option-row">
            <input class="images-input" type="checkbox" checked>
            <span class="option-copy">
              <span class="option-label images-label">拉取对话图片</span>
              <span class="option-hint images-hint">Markdown 使用 MD + 图片资源包；PDF 会将图片嵌入打印文档</span>
            </span>
          </label>
          <div class="section-title language-title">🌐 语言 / Language</div>
          <div class="language-picker">
            <button class="language-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
              <span class="language-current">简体中文</span>
              <span class="language-chevron" aria-hidden="true">▼</span>
            </button>
            <div class="language-list" role="listbox" tabindex="-1" aria-label="Language">
              <button class="language-option" type="button" role="option" data-locale="zh-CN" aria-selected="true"><span>简体中文</span><span class="language-check">✓</span></button>
              <button class="language-option" type="button" role="option" data-locale="en" aria-selected="false"><span>English</span><span class="language-check">✓</span></button>
              <button class="language-option" type="button" role="option" data-locale="ja" aria-selected="false"><span>日本語</span><span class="language-check">✓</span></button>
              <button class="language-option" type="button" role="option" data-locale="ko" aria-selected="false"><span>한국어</span><span class="language-check">✓</span></button>
              <button class="language-option" type="button" role="option" data-locale="de" aria-selected="false"><span>Deutsch</span><span class="language-check">✓</span></button>
              <button class="language-option" type="button" role="option" data-locale="es" aria-selected="false"><span>Español</span><span class="language-check">✓</span></button>
              <button class="language-option" type="button" role="option" data-locale="fr" aria-selected="false"><span>Français</span><span class="language-check">✓</span></button>
              <button class="language-option" type="button" role="option" data-locale="ru" aria-selected="false"><span>Русский</span><span class="language-check">✓</span></button>
              <button class="language-option" type="button" role="option" data-locale="uk" aria-selected="false"><span>Українська</span><span class="language-check">✓</span></button>
            </div>
          </div>
          <div class="divider"></div>
          <div class="hint menu-hint">部分导出从选定 User 消息开始直到当前末尾；JSON 仅保存图片元数据</div>
          <button class="item format-zip" data-format="zip">导出 ZIP（Markdown + JSON）</button>
          <button class="item format-md" data-format="md">导出 Markdown</button>
          <button class="item format-pdf" data-format="pdf">导出 PDF</button>
          <button class="item format-json" data-format="json">仅导出 JSON</button>
        </div>
        <button class="button" type="button">↓ 导出</button>
        <div class="progress"></div>
      </div>
      <div class="picker-backdrop" aria-hidden="true">
        <div class="picker" role="dialog" aria-modal="true" aria-label="选择部分导出起始点">
          <div class="picker-header">
            <div class="picker-title">选择部分导出的起始消息</div>
            <button class="picker-close" type="button" aria-label="关闭">×</button>
          </div>
          <div class="picker-status-row"><div class="picker-spinner" aria-hidden="true" hidden></div><div class="picker-status">正在读取完整对话…</div></div>
          <div class="picker-boundaries"><button class="picker-boundary picker-start" type="button">起始点</button><button class="picker-boundary picker-end" type="button">截止点</button></div>
          <div class="picker-list"></div>
          <div class="picker-actions"><button class="picker-confirm" type="button">使用此范围</button></div>
        </div>
      </div>
      <div class="toast"></div>
    `;

    const button = shadow.querySelector('.button');
    const menu = shadow.querySelector('.menu');
    const progress = shadow.querySelector('.progress');
    const toast = shadow.querySelector('.toast');
    const rangeButtons = [...shadow.querySelectorAll('[data-range-mode]')];
    const rangeSummary = shadow.querySelector('.range-summary');
    const pickerBackdrop = shadow.querySelector('.picker-backdrop');
    const pickerPanel = shadow.querySelector('.picker');
    const pickerSpinner = shadow.querySelector('.picker-spinner');
    const pickerStatus = shadow.querySelector('.picker-status');
    const pickerList = shadow.querySelector('.picker-list');
    const pickerClose = shadow.querySelector('.picker-close');
    const rangeTitle = shadow.querySelector('.range-title');
    const optionsTitle = shadow.querySelector('.options-title');
    const toolDetailsInput = shadow.querySelector('.tool-details-input');
    const toolDetailsLabel = shadow.querySelector('.tool-details-label');
    const toolDetailsHint = shadow.querySelector('.tool-details-hint');
    const imagesInput = shadow.querySelector('.images-input');
    const imagesLabel = shadow.querySelector('.images-label');
    const imagesHint = shadow.querySelector('.images-hint');
    const languageTitle = shadow.querySelector('.language-title');
    const languagePicker = shadow.querySelector('.language-picker');
    const languageTrigger = shadow.querySelector('.language-trigger');
    const languageCurrent = shadow.querySelector('.language-current');
    const languageList = shadow.querySelector('.language-list');
    const languageOptions = [...shadow.querySelectorAll('.language-option')];
    const menuHint = shadow.querySelector('.menu-hint');
    const formatZip = shadow.querySelector('.format-zip');
    const formatMd = shadow.querySelector('.format-md');
    const formatPdf = shadow.querySelector('.format-pdf');
    const formatJson = shadow.querySelector('.format-json');
    const pickerTitle = shadow.querySelector('.picker-title');
    const pickerStart = shadow.querySelector('.picker-start');
    const pickerEnd = shadow.querySelector('.picker-end');
    const pickerConfirm = shadow.querySelector('.picker-confirm');

    button.addEventListener('click', () => {
      if (exportInProgress) return;
      if (menu.classList.contains('open')) {
        menu.classList.remove('open');
        languagePicker.classList.remove('open');
        languageTrigger.setAttribute('aria-expanded', 'false');
      } else {
        menu.classList.add('open');
      }
    });
    for (const rangeButton of rangeButtons) {
      rangeButton.addEventListener('click', () => {
        if (rangeButton.dataset.rangeMode === 'full') {
          setExportRangeSelection({ mode: 'full' });
          return;
        }
        openPartialPicker();
      });
    }
    toolDetailsInput.checked = exportSettings.includeToolDetails;
    toolDetailsInput.addEventListener('change', () => {
      setIncludeToolDetails(toolDetailsInput.checked);
    });
    imagesInput.checked = exportSettings.includeImages;
    imagesInput.addEventListener('change', () => {
      setIncludeImages(imagesInput.checked);
    });
    function closeLanguagePicker({ focusTrigger = false } = {}) {
      languagePicker.classList.remove('open');
      languageTrigger.setAttribute('aria-expanded', 'false');
      if (focusTrigger) languageTrigger.focus();
    }
    function openLanguagePicker({ focusSelected = false } = {}) {
      languagePicker.classList.add('open');
      languageTrigger.setAttribute('aria-expanded', 'true');
      if (focusSelected) {
        const selected = languageOptions.find((option) => option.dataset.locale === currentLocale) || languageOptions[0];
        selected?.focus();
      }
    }
    async function chooseLanguage(option) {
      if (!option?.dataset?.locale) return;
      await setLocale(option.dataset.locale);
      closeLanguagePicker({ focusTrigger: true });
    }
    languageTrigger.addEventListener('click', () => {
      if (languagePicker.classList.contains('open')) closeLanguagePicker();
      else openLanguagePicker();
    });
    languageTrigger.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      openLanguagePicker({ focusSelected: true });
    });
    languageList.addEventListener('click', (event) => {
      const option = event.target.closest('[role="option"]');
      if (option) chooseLanguage(option);
    });
    languageList.addEventListener('keydown', (event) => {
      const currentOption = event.target.closest('[role="option"]');
      if (!currentOption) return;
      const currentIndex = languageOptions.indexOf(currentOption);
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLanguagePicker({ focusTrigger: true });
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        chooseLanguage(currentOption);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = ns.languageSelector?.nextIndex?.(currentIndex, delta, languageOptions.length) ?? currentIndex;
      languageOptions[next]?.focus();
    });
    menu.addEventListener('click', (event) => {
      const target = event.target.closest('[data-format]');
      if (!target) return;
      const format = target.dataset.format;
      if (format === 'pdf' && !window.confirm(tr('pdf.confirm'))) return;
      menu.classList.remove('open');
      closeLanguagePicker();
      if (format === 'pdf') {
        exportConversation('pdf', { ...exportRangeSelection });
      } else {
        exportConversation(format, { ...exportRangeSelection });
      }
    });
    pickerClose.addEventListener('click', () => closePartialPicker({ reopenMenu: true }));
    pickerBackdrop.addEventListener('click', (event) => {
      if (event.target === pickerBackdrop) closePartialPicker({ reopenMenu: true });
    });
    shadow.addEventListener('click', (event) => {
      if (!event.target.closest('.language-picker')) closeLanguagePicker();
    });
    document.addEventListener('click', (event) => {
      if (!host.contains(event.target)) {
        menu.classList.remove('open');
        closeLanguagePicker();
      }
    }, true);

    ui = {
      host, shadow, button, menu, progress, toast, toastTimer: null,
      rangeButtons, rangeSummary, pickerBackdrop, pickerPanel, pickerSpinner, pickerStatus, pickerList, pickerClose,
      rangeTitle, optionsTitle, toolDetailsInput, toolDetailsLabel, toolDetailsHint,
      imagesInput, imagesLabel, imagesHint, languageTitle, languagePicker, languageTrigger, languageCurrent, languageList, languageOptions, menuHint, formatZip, formatMd, formatPdf, formatJson, pickerTitle, pickerStart, pickerEnd, pickerConfirm,
    };
    applyUiLanguage();
    return ui;
  }

  function setUiBusy(busy) {
    const current = ensureUi();
    current.button.disabled = busy;
    current.button.textContent = busy ? tr('export.busy') : tr('export.button');
    current.menu.classList.remove('open');
  }

  function updateProgress(text) {
    const current = ensureUi();
    current.progress.textContent = text;
    current.progress.classList.toggle('visible', Boolean(text));
  }

  function showToast(message, type = 'success', duration = 4500) {
    const current = ensureUi();
    clearTimeout(current.toastTimer);
    current.toast.textContent = message;
    current.toast.className = `toast ${type} show`;
    current.toastTimer = setTimeout(() => {
      current.toast.classList.remove('show');
    }, duration);
  }

  chrome.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CGPT_EXPORT_OPEN_MENU') {
      const current = ensureUi();
      if (!exportInProgress) current.menu.classList.add('open');
      sendResponse({ ok: !exportInProgress });
      return false;
    }

    if (message?.type !== 'CGPT_EXPORT_START') return undefined;
    if (exportInProgress) {
      sendResponse({ ok: false, error: 'export-in-progress' });
      return false;
    }
    sendResponse({ ok: true });
    exportConversation(message.format || 'zip', { ...exportRangeSelection });
    return false;
  });

  ensureUi();
  initializePreferences();
  ns.exportConversation = exportConversation;
  ns.scanConversation = scanConversation;
  ns.buildExport = buildExport;
})();

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
  let exportRangeSelection = { mode: 'full', startMessageKey: null, startLabel: null, url: null };
  let exportSettings = ns.exportOptions?.normalize?.() || { includeToolDetails: false };
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
   * Download conversation images and rewrite message Markdown to ZIP-local asset paths.
   */
  async function archiveConversationImages(messages, onProgress, remoteContext = null) {
    if (
      !ns.assets?.createImageAssetPath ||
      !ns.assets?.rewriteMarkdownImageSources ||
      !ns.assets?.appendMissingImageReferences
    ) {
      throw new Error(tr('error.imageModule'));
    }

    const uniqueSources = new Set();
    for (const message of messages) {
      for (const image of message.images || []) {
        uniqueSources.add(image.fileId ? `file:${image.fileId}` : (image.fetchSrc || image.src));
      }
    }

    const files = [];
    const bySource = new Map();
    let archived = 0;
    let failed = 0;
    let processed = 0;
    let byteLength = 0;
    const failures = [];

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      for (let imageIndex = 0; imageIndex < (message.images || []).length; imageIndex += 1) {
        const image = message.images[imageIndex];
        const sourceKey = image.fileId ? `file:${image.fileId}` : (image.fetchSrc || image.src);
        const existing = bySource.get(sourceKey);

        if (existing) {
          Object.assign(image, existing);
          continue;
        }

        processed += 1;
        try {
          let fetchSource = image.fetchSrc || image.src;
          let assetAccessToken = null;
          if (image.fileId && remoteContext && ns.remote?.resolveFileDownload) {
            const resolved = await ns.remote.resolveFileDownload({
              fileId: image.fileId,
              conversationId: remoteContext.conversationId,
              accessToken: remoteContext.accessToken,
            });
            fetchSource = resolved.download_url;
            assetAccessToken = remoteContext.accessToken || null;
            image.originalName ||= resolved.file_name || null;
          }
          if (!fetchSource || fetchSource.startsWith('chatgpt-file://')) {
            throw new Error(tr('error.imageUrl'));
          }
          const asset = await fetchImageBytes(fetchSource, assetAccessToken);
          let sourceName = image.originalName || null;
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
          const localPath = ns.assets.createImageAssetPath(
            messageIndex + 1,
            imageIndex + 1,
            imageType.mimeType,
            imageType.extension,
          );
          const metadata = {
            localPath,
            mimeType: imageType.mimeType,
            typeSource: imageType.source,
            originalName: image.originalName || sourceName,
            byteLength: asset.bytes.length,
            archived: true,
          };
          bySource.set(sourceKey, metadata);
          Object.assign(image, metadata);
          files.push({ name: localPath, data: asset.bytes });
          archived += 1;
          byteLength += asset.bytes.length;
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          const metadata = { archived: false, archiveError: messageText };
          bySource.set(sourceKey, metadata);
          Object.assign(image, metadata);
          failures.push({
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

      message.markdown = ns.assets.rewriteMarkdownImageSources(message.markdown, message.images);
      message.markdown = ns.assets.appendMissingImageReferences(message.markdown, message.images);
    }

    return {
      files,
      stats: {
        total: uniqueSources.size,
        archived,
        failed,
        byteLength,
        failures,
      },
    };
  }

  /**
   * Create Markdown and JSON representations from scanned messages.
   */
  function buildExport(messages, imageArchive = null, scanInfo = null, rangeMetadata = null, options = exportSettings) {
    const title = scanInfo?.title || getConversationTitle();
    const exportedAt = new Date();
    const userCount = messages.filter((item) => item.role === 'user').length;
    const assistantCount = messages.filter((item) => item.role === 'assistant').length;

    const metadata = {
      schemaVersion: 5,
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
      originalMessageCount: rangeMetadata?.originalMessageCount ?? messages.length,
      exportedMessageCount: rangeMetadata?.exportedMessageCount ?? messages.length,
      includeToolDetails: options?.includeToolDetails === true,
      uiLocale: currentLocale,
    };

    const rangeLabel = metadata.exportScope === 'partial'
      ? tr('md.partialRange', { start: metadata.startMessagePosition, total: metadata.originalMessageCount })
      : tr('md.fullRange');
    const imageLabel = imageArchive
      ? `${imageArchive.archived}/${imageArchive.total}${imageArchive.failed ? tr('md.imageFailed', { failed: imageArchive.failed }) : ''}`
      : tr('md.imageNotArchived');

    const separator = currentLocale === 'en' ? ': ' : '：';
    const messageCountLabel = currentLocale === 'en'
      ? `${messages.length} (User ${userCount} / Assistant ${assistantCount})`
      : `${messages.length}（User ${userCount} / Assistant ${assistantCount}）`;
    const markdownParts = [
      `# ${title}`,
      '',
      `- ${tr('md.exportedAt')}${separator}${exportedAt.toLocaleString(currentLocale === 'en' ? 'en' : 'zh-CN')}`,
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
      if (message.markdown) markdownParts.push(message.markdown, '');
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
      let imageFiles = [];
      if (format === 'zip') {
        const archived = await archiveConversationImages(messages, ({ phase, count, total }) => {
          updateProgress(`${phase} · ${count}/${total}`);
        }, scanInfo.remoteContext);
        imageArchive = archived.stats;
        imageFiles = archived.files;
      }

      updateProgress(tr('progress.generate'));
      const output = buildExport(messages, imageArchive, scanInfo, ranged.metadata, exportSettings);

      if (format === 'md') {
        downloadText(output.markdown, `${output.baseName}.md`, 'text/markdown');
      } else if (format === 'json') {
        downloadText(output.json, `${output.baseName}.json`, 'application/json');
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
          url: selection.url || location.href,
        }
      : { mode: 'full', startMessageKey: null, startLabel: null, url: null };
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
      ? tr('menu.partialSummary', { label: exportRangeSelection.startLabel || tr('menu.partialFallback') })
      : tr('menu.fullSummary');
  }

  /**
   * Close the partial-export start picker and return to the export menu.
   */
  function closePartialPicker({ reopenMenu = false } = {}) {
    const current = ensureUi();
    current.pickerBackdrop.classList.remove('open');
    if (reopenMenu) current.menu.classList.add('open');
  }

  /**
   * Load the complete branch and let the user choose a User message as the partial-export start point.
   */
  async function openPartialPicker() {
    const current = ensureUi();
    current.menu.classList.remove('open');
    current.pickerBackdrop.classList.add('open');
    current.pickerStatus.textContent = tr('picker.loading');
    current.pickerList.replaceChildren();

    try {
      let scanInfo = partialScanCache?.url === location.href && partialScanCache?.includeToolDetails === exportSettings.includeToolDetails ? partialScanCache.scanInfo : null;
      if (!scanInfo?.messages?.length) {
        scanInfo = await scanConversation(({ phase, count, total }) => {
          current.pickerStatus.textContent = total
            ? `${phase} · ${count}/${total}`
            : `${phase}${count ? ` · ${count}` : ''}`;
        }, exportSettings);
        partialScanCache = { url: location.href, includeToolDetails: exportSettings.includeToolDetails, scanInfo };
      }

      if (!ns.range?.getUserStartOptions) throw new Error(tr('error.rangeModule'));
      const options = ns.range.getUserStartOptions(scanInfo.messages);
      if (!options.length) throw new Error(tr('error.noUserStart'));

      current.pickerStatus.textContent = tr('picker.choose', { count: options.length });
      const fragment = document.createDocumentFragment();
      for (const option of options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'start-item';
        button.dataset.startKey = option.key;
        button.textContent = option.label;
        button.addEventListener('click', () => {
          setExportRangeSelection({
            mode: 'partial',
            startMessageKey: option.key,
            startLabel: option.label,
            url: location.href,
          });
          closePartialPicker({ reopenMenu: true });
        });
        fragment.appendChild(button);
      }
      current.pickerList.appendChild(fragment);
    } catch (error) {
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
    ui.languageTitle.textContent = tr('menu.languageTitle');
    ui.menuHint.textContent = tr('menu.hint');
    ui.formatZip.textContent = tr('menu.zip');
    ui.formatMd.textContent = tr('menu.md');
    ui.formatJson.textContent = tr('menu.json');
    ui.pickerTitle.textContent = tr('picker.title');
    ui.pickerClose.setAttribute('aria-label', tr('picker.close'));
    ui.pickerBackdrop.querySelector('.picker')?.setAttribute('aria-label', tr('picker.title'));
    for (const button of ui.languageButtons) {
      button.classList.toggle('active', button.dataset.locale === currentLocale);
    }
    updateRangeUi();
  }

  /**
   * Persist the tool-detail option and invalidate cached normalized API messages.
   */
  async function setIncludeToolDetails(enabled) {
    exportSettings = ns.exportOptions?.normalize?.({ ...exportSettings, includeToolDetails: enabled }) || { includeToolDetails: enabled === true };
    partialScanCache = null;
    if (ui) ui.toolDetailsInput.checked = exportSettings.includeToolDetails;
    await ns.exportOptions?.save?.(exportSettings);
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
    if (ui) ui.toolDetailsInput.checked = exportSettings.includeToolDetails;
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
        .language-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
        .lang-option { all: unset; box-sizing: border-box; cursor: pointer; border-radius: 8px; border: 1px solid rgba(255,255,255,.11); padding: 7px 8px; text-align: center; font-size: 11px; color: rgba(255,255,255,.72); }
        .lang-option:hover { background: rgba(255,255,255,.07); }
        .lang-option.active { background: rgba(255,255,255,.14); border-color: rgba(255,255,255,.28); color: #fff; }
        .divider { height: 1px; background: rgba(255,255,255,.08); margin: 1px 0; }
        .hint { color: rgba(255,255,255,.58); font-size: 11px; padding: 3px 4px 2px; }
        .picker-backdrop { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,.46); font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .picker-backdrop.open { display: flex; }
        .picker { width: min(680px, calc(100vw - 32px)); max-height: min(76vh, 760px); display: grid; grid-template-rows: auto auto minmax(0, 1fr); overflow: hidden; border-radius: 16px; border: 1px solid rgba(127,127,127,.28); background: rgba(28,28,28,.985); color: #fff; box-shadow: 0 24px 80px rgba(0,0,0,.42); }
        .picker-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px 9px; }
        .picker-title { font-size: 14px; font-weight: 720; }
        .picker-close { all: unset; cursor: pointer; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: rgba(255,255,255,.68); font-size: 18px; }
        .picker-close:hover { background: rgba(255,255,255,.08); color: #fff; }
        .picker-status { color: rgba(255,255,255,.58); font-size: 11px; padding: 0 16px 10px; }
        .picker-list { min-height: 110px; overflow: auto; padding: 0 8px 10px; }
        .start-item { all: unset; box-sizing: border-box; display: block; width: 100%; cursor: pointer; border-radius: 9px; padding: 10px 11px; color: rgba(255,255,255,.86); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
        .start-item:hover { background: rgba(255,255,255,.09); }
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
              <span class="option-hint tool-details-hint">关闭后仍保留工具生成的可见图片</span>
            </span>
          </label>
          <div class="section-title language-title">语言</div>
          <div class="language-row">
            <button class="lang-option active" data-locale="zh-CN" type="button">简体中文</button>
            <button class="lang-option" data-locale="en" type="button">English</button>
          </div>
          <div class="divider"></div>
          <div class="hint menu-hint">ZIP 会归档可下载图片；部分导出从选定 User 消息开始直到当前末尾</div>
          <button class="item format-zip" data-format="zip">导出 ZIP（Markdown + JSON + 图片）</button>
          <button class="item format-md" data-format="md">仅导出 Markdown</button>
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
          <div class="picker-status">正在读取完整对话…</div>
          <div class="picker-list"></div>
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
    const pickerStatus = shadow.querySelector('.picker-status');
    const pickerList = shadow.querySelector('.picker-list');
    const pickerClose = shadow.querySelector('.picker-close');
    const rangeTitle = shadow.querySelector('.range-title');
    const optionsTitle = shadow.querySelector('.options-title');
    const toolDetailsInput = shadow.querySelector('.tool-details-input');
    const toolDetailsLabel = shadow.querySelector('.tool-details-label');
    const toolDetailsHint = shadow.querySelector('.tool-details-hint');
    const languageTitle = shadow.querySelector('.language-title');
    const languageButtons = [...shadow.querySelectorAll('[data-locale]')];
    const menuHint = shadow.querySelector('.menu-hint');
    const formatZip = shadow.querySelector('.format-zip');
    const formatMd = shadow.querySelector('.format-md');
    const formatJson = shadow.querySelector('.format-json');
    const pickerTitle = shadow.querySelector('.picker-title');

    button.addEventListener('click', () => {
      if (exportInProgress) return;
      menu.classList.toggle('open');
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
    for (const languageButton of languageButtons) {
      languageButton.addEventListener('click', () => setLocale(languageButton.dataset.locale));
    }
    menu.addEventListener('click', (event) => {
      const target = event.target.closest('[data-format]');
      if (!target) return;
      menu.classList.remove('open');
      exportConversation(target.dataset.format, { ...exportRangeSelection });
    });
    pickerClose.addEventListener('click', () => closePartialPicker({ reopenMenu: true }));
    pickerBackdrop.addEventListener('click', (event) => {
      if (event.target === pickerBackdrop) closePartialPicker({ reopenMenu: true });
    });
    document.addEventListener('click', (event) => {
      if (!host.contains(event.target)) menu.classList.remove('open');
    }, true);

    ui = {
      host, shadow, button, menu, progress, toast, toastTimer: null,
      rangeButtons, rangeSummary, pickerBackdrop, pickerStatus, pickerList, pickerClose,
      rangeTitle, optionsTitle, toolDetailsInput, toolDetailsLabel, toolDetailsHint,
      languageTitle, languageButtons, menuHint, formatZip, formatMd, formatJson, pickerTitle,
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

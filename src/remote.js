(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.remote) return;

  const CONVERSATION_ID_PATTERN = /\/(?:c|conversation)\/([a-z0-9-]+)(?:[/?#]|$)/i;

  /**
   * Resolve the active visible branch by walking current_node through parent links.
   */
  function linearizeActiveBranch(data) {
    const chain = [];
    let nodeId = data?.current_node || null;
    let guard = 0;

    while (nodeId && guard < 10000) {
      guard += 1;
      const node = data?.mapping?.[nodeId];
      if (!node) break;
      if (node.message) chain.push(node.message);
      nodeId = node.parent || null;
    }

    return chain.reverse();
  }

  /**
   * Convert a ChatGPT asset pointer into its backend file id.
   */
  function getFileId(assetPointer) {
    const match = String(assetPointer || '').match(/^(?:sediment|file-service):\/\/(.+)$/i);
    return match?.[1] || null;
  }

  /**
   * Convert an image pointer or URL into a normalized export image record.
   */
  function createImageRecord(pointer, attachmentById, details = {}) {
    const source = String(pointer || '').trim();
    if (!source) return null;
    const fileId = getFileId(source);
    const attachment = fileId ? attachmentById.get(fileId) : null;
    const alt = attachment?.name || details.alt || details.prompt || 'image';
    const placeholder = fileId ? `chatgpt-file://${fileId}` : source;
    return {
      fileId,
      assetPointer: fileId ? source : null,
      src: placeholder,
      fetchSrc: fileId ? null : source,
      alt,
      width: details.width || null,
      height: details.height || null,
      mimeType: attachment?.mime_type || details.mimeType || null,
      originalName: attachment?.name || details.originalName || null,
    };
  }

  /**
   * Read visible text, code and image pointers from one backend message.
   */
  function parseMessageContent(message) {
    const content = message?.content || {};
    const markdownParts = [];
    const textParts = [];
    const images = [];
    const attachmentById = new Map(
      (message?.metadata?.attachments || [])
        .filter((attachment) => attachment?.id)
        .map((attachment) => [attachment.id, attachment]),
    );

    const addImage = (pointer, details = {}) => {
      const image = createImageRecord(pointer, attachmentById, details);
      if (!image) return;
      const key = image.fileId || image.src;
      if (images.some((candidate) => (candidate.fileId || candidate.src) === key)) return;
      images.push(image);
      const alt = String(image.alt || 'image').replace(/\]/g, '\\]');
      markdownParts.push(`![${alt}](${image.src})`);
    };

    if (content.content_type === 'text' || content.content_type === 'multimodal_text') {
      for (const part of content.parts || []) {
        if (typeof part === 'string') {
          const value = part.trim();
          if (value) {
            markdownParts.push(value);
            textParts.push(value);
          }
          continue;
        }

        if (part?.content_type !== 'image_asset_pointer') continue;
        addImage(part.asset_pointer, {
          prompt: part?.metadata?.dalle?.prompt,
          width: part.width || part?.metadata?.generation?.width || null,
          height: part.height || part?.metadata?.generation?.height || null,
        });
      }
    } else if (content.content_type === 'code') {
      const code = String(content.text || '').trimEnd();
      if (code) {
        const language = content.language && content.language !== 'unknown' ? content.language : '';
        const fenced = `\`\`\`${language}\n${code}\n\`\`\``;
        markdownParts.push(fenced);
        textParts.push(code);
      }
    }

    const aggregate = content.aggregate_result || message?.metadata?.aggregate_result;
    for (const entry of aggregate?.messages || []) {
      if (entry?.message_type === 'image' && entry.image_url) {
        addImage(entry.image_url, {
          width: entry.width || null,
          height: entry.height || null,
          alt: 'tool image',
        });
        continue;
      }
      if (entry?.message_type === 'stream' && entry.text) {
        const value = String(entry.text).trim();
        if (value) {
          markdownParts.push(value);
          textParts.push(value);
        }
      }
    }

    const imageIds = new Set(images.map((image) => image.fileId).filter(Boolean));
    const attachments = (message?.metadata?.attachments || [])
      .filter((attachment) => attachment?.name && !imageIds.has(attachment.id))
      .map((attachment) => ({
        id: attachment.id || null,
        name: attachment.name,
        url: null,
        mimeType: attachment.mime_type || null,
        size: attachment.size || null,
      }));

    const rawMarkdown = markdownParts.join('\n\n').trim();
    const rawText = textParts.join('\n\n').trim();
    const resolvedMarkdown = ns.citations?.resolveMarkdown
      ? ns.citations.resolveMarkdown(rawMarkdown, message?.metadata || {})
      : rawMarkdown;
    const resolvedText = ns.citations?.resolveMarkdown
      ? ns.citations.resolveMarkdown(rawText, message?.metadata || {}).replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1 ($2)')
      : rawText;

    return {
      markdown: resolvedMarkdown,
      text: resolvedText,
      images,
      attachments,
    };
  }

  function mergeUniqueImages(target, additions) {
    const seen = new Set(target.map((image) => image.fileId || image.src));
    for (const image of additions || []) {
      const key = image.fileId || image.src;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      target.push(image);
    }
  }

  function mergeUniqueAttachments(target, additions) {
    const seen = new Set(target.map((attachment) => attachment.id || attachment.name));
    for (const attachment of additions || []) {
      const key = attachment.id || attachment.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      target.push(attachment);
    }
  }

  /**
   * Resolve a stable human-readable name for one tool call or tool result node.
   */
  function getToolName(message) {
    return message?.recipient || message?.author?.name || message?.metadata?.invoked_plugin?.namespace || 'tool';
  }

  /**
   * Create the accumulator used to merge consecutive assistant/tool nodes into one visible turn.
   */
  function createPendingAssistant(message, sequence) {
    return {
      key: message?.id || `remote-assistant-${sequence}`,
      turnId: message?.id || null,
      textParts: [],
      markdownParts: [],
      attachments: [],
      images: [],
      sourceMessageIds: [],
    };
  }

  /**
   * Preserve user-visible tool images without requiring tool text details to be exported.
   */
  function appendToolImages(pendingAssistant, parsed) {
    mergeUniqueImages(pendingAssistant.images, parsed.images);
    for (const image of parsed.images) {
      if (!pendingAssistant.markdownParts.some((part) => part.includes(image.src))) {
        const alt = String(image.alt || 'image').replace(/\]/g, '\\]');
        pendingAssistant.markdownParts.push(`![${alt}](${image.src})`);
      }
    }
  }

  /**
   * Normalize the backend conversation tree into the exporter's user/assistant turn model.
   * Tool text is opt-in, while user-visible images produced by tools are always preserved.
   */
  function normalizeConversation(data, conversationId, options = {}) {
    const includeToolDetails = options?.includeToolDetails === true;
    const messages = [];
    let pendingAssistant = null;
    let sequence = 0;

    const ensureAssistant = (message) => {
      if (!pendingAssistant) pendingAssistant = createPendingAssistant(message, sequence);
      return pendingAssistant;
    };

    const flushAssistant = () => {
      if (!pendingAssistant) return;
      if (pendingAssistant.markdownParts.length || pendingAssistant.images.length || pendingAssistant.attachments.length) {
        messages.push({
          key: pendingAssistant.key,
          turnId: pendingAssistant.turnId,
          index: null,
          firstSeen: sequence++,
          role: 'assistant',
          text: pendingAssistant.textParts.join('\n\n').trim(),
          markdown: pendingAssistant.markdownParts.join('\n\n').trim(),
          html: '',
          attachments: pendingAssistant.attachments,
          images: pendingAssistant.images,
          sourceMessageIds: pendingAssistant.sourceMessageIds,
        });
      }
      pendingAssistant = null;
    };

    for (const message of linearizeActiveBranch(data)) {
      const role = message?.author?.role;
      const hidden = Boolean(message?.metadata?.is_visually_hidden_from_conversation);
      if (hidden) continue;
      const parsed = parseMessageContent(message);

      if (role === 'user') {
        flushAssistant();
        if (!parsed.markdown && !parsed.images.length && !parsed.attachments.length) continue;
        messages.push({
          key: message.id || `remote-user-${sequence}`,
          turnId: message.id || null,
          index: null,
          firstSeen: sequence++,
          role: 'user',
          text: parsed.text,
          markdown: parsed.markdown || parsed.text,
          html: '',
          attachments: parsed.attachments,
          images: parsed.images,
          sourceMessageIds: message.id ? [message.id] : [],
        });
        continue;
      }

      if (role === 'assistant') {
        const pending = ensureAssistant(message);
        if (message.id) pending.sourceMessageIds.push(message.id);
        mergeUniqueAttachments(pending.attachments, parsed.attachments);

        const recipient = String(message?.recipient || 'all');
        const toolLike = recipient !== 'all' || message?.content?.content_type === 'execution_output';
        if (toolLike && !includeToolDetails) {
          appendToolImages(pending, parsed);
          continue;
        }

        mergeUniqueImages(pending.images, parsed.images);
        if (toolLike && includeToolDetails) {
          const toolName = getToolName(message);
          if (parsed.markdown) pending.markdownParts.push(`**Tool call: ${toolName}**\n\n${parsed.markdown}`);
          if (parsed.text) pending.textParts.push(`Tool call: ${toolName}\n${parsed.text}`);
          continue;
        }

        if (parsed.text) pending.textParts.push(parsed.text);
        if (parsed.markdown) pending.markdownParts.push(parsed.markdown);
        continue;
      }

      if (role === 'tool') {
        const pending = ensureAssistant(message);
        if (message.id) pending.sourceMessageIds.push(message.id);
        mergeUniqueAttachments(pending.attachments, parsed.attachments);
        if (includeToolDetails) {
          mergeUniqueImages(pending.images, parsed.images);
          if (parsed.markdown) {
            const toolName = getToolName(message);
            pending.markdownParts.push(`**Tool result: ${toolName}**\n\n${parsed.markdown}`);
            if (parsed.text) pending.textParts.push(`Tool result: ${toolName}\n${parsed.text}`);
          }
        } else {
          appendToolImages(pending, parsed);
        }
      }
    }

    flushAssistant();

    return {
      title: data?.title || null,
      conversationId,
      messages,
    };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      ...options,
    });
    if (!response.ok) throw new Error(`ChatGPT interface request failed (HTTP ${response.status}).`);
    return response.json();
  }

  /**
   * Fetch the complete current conversation through ChatGPT's own same-origin read API.
   */
  async function fetchCurrentConversation(locationLike = globalThis.location, options = {}) {
    if (typeof fetch !== 'function') throw new Error('fetch is unavailable on the current page.');
    const pathname = String(locationLike?.pathname || '');
    const conversationId = pathname.match(CONVERSATION_ID_PATTERN)?.[1] || null;
    if (!conversationId) return null;

    const session = await fetchJson('/api/auth/session');
    const accessToken = session?.accessToken;
    if (!accessToken) throw new Error('Unable to obtain the current ChatGPT session token.');

    const data = await fetchJson(`/backend-api/conversation/${conversationId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!data?.mapping || !data?.current_node) {
      throw new Error('ChatGPT returned incomplete conversation data.');
    }

    return {
      ...normalizeConversation(data, conversationId, options),
      accessToken,
    };
  }

  /**
   * Resolve a ChatGPT file id to a fresh signed binary download URL.
   */
  async function resolveFileDownload({ fileId, conversationId, accessToken }) {
    if (!fileId || !conversationId || !accessToken) throw new Error('Missing image download parameters.');
    const headers = { Authorization: `Bearer ${accessToken}` };
    const endpoints = [
      `/backend-api/files/download/${encodeURIComponent(fileId)}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`,
      `/backend-api/files/${encodeURIComponent(fileId)}/download`,
      `/backend-api/conversation/${encodeURIComponent(conversationId)}/attachment/${encodeURIComponent(fileId)}/download`,
    ];

    let lastError = null;
    for (const endpoint of endpoints) {
      try {
        const data = await fetchJson(endpoint, { headers });
        if (data?.download_url) return data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`Unable to resolve a download URL for image ${fileId}.`);
  }

  ns.remote = {
    linearizeActiveBranch,
    getFileId,
    parseMessageContent,
    normalizeConversation,
    fetchCurrentConversation,
    resolveFileDownload,
  };
})();

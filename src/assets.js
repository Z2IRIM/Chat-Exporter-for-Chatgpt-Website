(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.assets) return;

  const MIME_EXTENSION = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/jpg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/avif', 'avif'],
    ['image/bmp', 'bmp'],
    ['image/svg+xml', 'svg'],
  ]);

  const EXTENSION_MIME = new Map([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['avif', 'image/avif'],
    ['bmp', 'image/bmp'],
    ['svg', 'image/svg+xml'],
  ]);

  /**
   * Return a normalized supported image MIME type, or null for generic/non-image values.
   */
  function normalizeImageMime(value) {
    const mimeType = String(value || '').toLowerCase().split(';')[0].trim();
    return MIME_EXTENSION.has(mimeType) ? mimeType : null;
  }

  /**
   * Infer a supported image type from a filename extension.
   */
  function imageTypeFromName(name) {
    const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
    const extension = match?.[1] || null;
    const mimeType = extension ? EXTENSION_MIME.get(extension) || null : null;
    return mimeType ? { mimeType, extension: MIME_EXTENSION.get(mimeType) } : null;
  }

  /**
   * Detect common image formats from their leading bytes when metadata is unavailable.
   */
  function imageTypeFromMagic(bytes) {
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    const starts = (...signature) => signature.every((byte, index) => value[index] === byte);
    if (value.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
      return { mimeType: 'image/png', extension: 'png' };
    }
    if (value.length >= 3 && starts(0xff, 0xd8, 0xff)) {
      return { mimeType: 'image/jpeg', extension: 'jpg' };
    }
    if (value.length >= 6) {
      const header = String.fromCharCode(...value.subarray(0, 6));
      if (header === 'GIF87a' || header === 'GIF89a') return { mimeType: 'image/gif', extension: 'gif' };
    }
    if (
      value.length >= 12 &&
      String.fromCharCode(...value.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...value.subarray(8, 12)) === 'WEBP'
    ) {
      return { mimeType: 'image/webp', extension: 'webp' };
    }
    if (value.length >= 2 && starts(0x42, 0x4d)) return { mimeType: 'image/bmp', extension: 'bmp' };
    if (value.length >= 12 && String.fromCharCode(...value.subarray(4, 12)).includes('ftypavi')) {
      return { mimeType: 'image/avif', extension: 'avif' };
    }

    if (value.length) {
      const prefix = new TextDecoder().decode(value.subarray(0, Math.min(value.length, 512))).trimStart();
      if (/^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(prefix)) return { mimeType: 'image/svg+xml', extension: 'svg' };
    }
    return null;
  }

  /**
   * Resolve the final archive image type using trustworthy metadata before byte sniffing.
   */
  function resolveImageType({ httpMimeType, originalName, messageMimeType, bytes } = {}) {
    const httpMime = normalizeImageMime(httpMimeType);
    if (httpMime) return { mimeType: httpMime, extension: MIME_EXTENSION.get(httpMime), source: 'http' };

    const filenameType = imageTypeFromName(originalName);
    if (filenameType) return { ...filenameType, source: 'filename' };

    const messageMime = normalizeImageMime(messageMimeType);
    if (messageMime) {
      return { mimeType: messageMime, extension: MIME_EXTENSION.get(messageMime), source: 'message' };
    }

    const magicType = imageTypeFromMagic(bytes);
    if (magicType) return { ...magicType, source: 'magic' };

    return { mimeType: 'application/octet-stream', extension: 'bin', source: 'fallback' };
  }


  /**
   * Build optional Authorization headers for protected ChatGPT asset downloads.
   */
  function createAssetRequestHeaders(accessToken) {
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  }

  /**
   * Build a deterministic ZIP path for one archived conversation image.
   */
  function createImageAssetPath(messagePosition, imagePosition, mimeType, explicitExtension = null) {
    const extension = explicitExtension || MIME_EXTENSION.get(String(mimeType || '').toLowerCase()) || 'bin';
    return `assets/images/message-${String(messagePosition).padStart(4, '0')}-image-${String(imagePosition).padStart(2, '0')}.${extension}`;
  }

  /**
   * Replace remote image sources in Markdown with archived relative ZIP paths.
   */
  function rewriteMarkdownImageSources(markdown, images) {
    let output = String(markdown || '');
    for (const image of images || []) {
      if (!image?.src || !image?.localPath) continue;
      output = output.split(image.src).join(image.localPath);
    }
    return output;
  }

  /**
   * Ensure every collected image is represented in Markdown, including image-only user turns.
   */
  function appendMissingImageReferences(markdown, images) {
    let output = String(markdown || '').trim();
    const additions = [];
    for (const image of images || []) {
      const target = image?.localPath || image?.src;
      if (!target || output.includes(target)) continue;
      const alt = String(image?.alt || 'image').replace(/\]/g, '\\]');
      additions.push(`![${alt}](${target})`);
    }
    if (!additions.length) return output;
    return [output, additions.join('\n\n')].filter(Boolean).join('\n\n');
  }

  ns.assets = {
    createImageAssetPath,
    rewriteMarkdownImageSources,
    appendMissingImageReferences,
    resolveImageType,
    imageTypeFromMagic,
    createAssetRequestHeaders,
  };
})();

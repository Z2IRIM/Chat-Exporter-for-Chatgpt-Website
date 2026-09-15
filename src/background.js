'use strict';

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const ASSET_HOST_SUFFIXES = ['.openai.com', '.oaiusercontent.com', '.oaistatic.com', '.chatgpt.com'];
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

function isSupportedUrl(url) {
  try {
    return CHATGPT_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isAllowedAssetUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname === 'chatgpt.com' || parsed.hostname === 'openai.com') return true;
    return ASSET_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function setBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text });
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
}

function clearBadgeLater(tabId, delay = 2200) {
  setTimeout(() => setBadge(tabId, ''), delay);
}

async function sendOpenMenu(tabId) {
  return chrome.tabs.sendMessage(tabId, {
    type: 'CGPT_EXPORT_OPEN_MENU',
  });
}

/**
 * Encode binary response bytes for Chrome extension messaging without persisting them.
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * Fetch one OpenAI-hosted image for a content script when page-origin CORS blocks direct access.
 */
async function fetchAsset(url, accessToken = null) {
  if (!isAllowedAssetUrl(url)) throw new Error('不允许下载非 OpenAI 域名的跨域资源。');
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
  const response = await fetch(url, { credentials: 'include', cache: 'force-cache', headers });
  if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）。`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_ASSET_BYTES) throw new Error('图片超过 20MB 限制。');
  return {
    contentType: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream',
    base64: arrayBufferToBase64(buffer),
  };
}

/**
 * Open the export options on the active ChatGPT tab.
 */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !isSupportedUrl(tab.url)) {
    if (tab.id) {
      setBadge(tab.id, '!', '#b42318');
      clearBadgeLater(tab.id);
    }
    return;
  }

  try {
    await sendOpenMenu(tab.id);
  } catch {
    // Existing tabs opened before installation/reload do not have the content script yet.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['src/i18n.js', 'src/export-options.js', 'src/model-metadata.js', 'src/citation-resolver.js', 'src/remote.js', 'src/traversal.js', 'src/assets.js', 'src/range.js', 'src/zip.js', 'src/markdown-renderer.js', 'src/print.js', 'src/language-selector.js', 'src/content.js'],
      });
      await sendOpenMenu(tab.id);
    } catch (error) {
      console.error('[ChatGPT Conversation Exporter] Unable to start export.', error);
      setBadge(tab.id, '×', '#b42318');
      clearBadgeLater(tab.id, 3500);
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'CGPT_FETCH_ASSET') {
    fetchAsset(message.url, message.accessToken || null)
      .then((asset) => sendResponse({ ok: true, ...asset }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  const tabId = sender.tab?.id;
  if (!tabId) return undefined;

  if (message?.type === 'CGPT_EXPORT_COMPLETE') {
    setBadge(tabId, '✓', '#067647');
    clearBadgeLater(tabId);
  } else if (message?.type === 'CGPT_EXPORT_FAILED') {
    setBadge(tabId, '×', '#b42318');
    clearBadgeLater(tabId, 3500);
  }
  return undefined;
});

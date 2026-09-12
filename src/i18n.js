(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.i18n) return;

  const STORAGE_KEY = 'chatgptConversationExporter.locale';
  const DEFAULT_LOCALE = 'zh-CN';
  const MESSAGES = {
    'zh-CN': {
      'export.button': '↓ 导出',
      'export.busy': '扫描中…',
      'menu.rangeTitle': '导出范围',
      'menu.full': '全量导出',
      'menu.partial': '部分导出',
      'menu.fullSummary': '导出当前分支的全部对话内容',
      'menu.partialSummary': '起始点：{label}',
      'menu.partialFallback': '已选择 User 消息',
      'menu.optionsTitle': '导出选项',
      'menu.toolDetails': '包含 GPT 工具调用详情',
      'menu.toolDetailsHint': '关闭后仍保留工具生成的可见图片',
      'menu.languageTitle': '语言',
      'menu.hint': 'ZIP 会归档可下载图片；部分导出从选定 User 消息开始直到当前末尾',
      'menu.zip': '导出 ZIP（Markdown + JSON + 图片）',
      'menu.md': '仅导出 Markdown',
      'menu.json': '仅导出 JSON',
      'picker.title': '选择部分导出的起始消息',
      'picker.close': '关闭',
      'picker.loading': '正在读取完整对话…',
      'picker.choose': '请选择起始 User 消息 · 共 {count} 个可选点',
      'picker.failed': '无法读取起始点：{message}',
      'toast.running': '已有导出任务正在执行。',
      'toast.failed': '导出失败：{message}',
      'toast.complete': '导出完成：{count} 条消息（User {user} / Assistant {assistant}） · {scope}{source}{images}',
      'scope.full': '全量导出',
      'scope.partial': '部分导出',
      'source.api': ' · API 完整读取',
      'source.dom': ' · DOM 兼容模式',
      'images.summary': '；图片 {archived}/{total}',
      'images.failed': '，失败 {failed}',
      'progress.readApi': '读取完整对话数据',
      'progress.apiFallback': '完整数据接口不可用，切换页面遍历',
      'progress.archiveImages': '归档图片',
      'progress.generate': '生成导出文件…',
      'progress.index': '读取对话索引',
      'progress.scan': '扫描消息',
      'progress.loadOlder': '加载较早消息',
      'progress.walk': '遍历完整对话',
      'error.traversalModule': '对话遍历模块未加载。',
      'error.incompleteIndex': '对话索引共 {total} 条，但仍有 {missing} 条未能加载。为避免导出不完整，本次已停止。',
      'error.noScroller': '找不到 ChatGPT 对话滚动容器。',
      'error.noMessages': '没有识别到当前页面中的 ChatGPT 对话消息。请确认已打开具体对话。',
      'error.imageTooLarge': '图片超过 20MB 限制。',
      'error.imageDownload': '图片下载失败。',
      'error.imageModule': '图片归档模块未加载。',
      'error.imageUrl': '无法解析图片下载地址。',
      'error.rangeChanged': '当前对话已发生变化，请重新选择部分导出的起始点。',
      'error.rangeModule': '导出范围模块未加载。',
      'error.noUserStart': '当前对话没有可作为起始点的 User 消息。',
      'error.zipModule': 'ZIP 模块未加载。',
      'md.exportedAt': '导出时间',
      'md.source': '来源',
      'md.messageCount': '消息数量',
      'md.range': '导出范围',
      'md.fullRange': '全量导出',
      'md.partialRange': '部分导出（从原对话第 {start} 条消息开始，共 {total} 条）',
      'md.imageArchive': '图片归档',
      'md.imageNotArchived': '未执行（仅 ZIP 模式归档图片本体）',
      'md.imageFailed': '（失败 {failed}）',
      'md.branch': '分支',
      'md.currentBranch': '当前页面所选对话分支',
      'md.toolDetails': '工具调用详情',
      'md.included': '包含',
      'md.excluded': '不包含',
      'md.attachments': '附件：',
    },
    en: {
      'export.button': '↓ Export',
      'export.busy': 'Scanning…',
      'menu.rangeTitle': 'Export range',
      'menu.full': 'Full export',
      'menu.partial': 'Partial export',
      'menu.fullSummary': 'Export the entire active conversation branch',
      'menu.partialSummary': 'Start: {label}',
      'menu.partialFallback': 'Selected User message',
      'menu.optionsTitle': 'Export options',
      'menu.toolDetails': 'Include GPT tool-call details',
      'menu.toolDetailsHint': 'Visible images produced by tools are kept when this is off',
      'menu.languageTitle': 'Language',
      'menu.hint': 'ZIP archives downloadable images; partial export starts at the selected User message and continues to the end',
      'menu.zip': 'Export ZIP (Markdown + JSON + images)',
      'menu.md': 'Export Markdown only',
      'menu.json': 'Export JSON only',
      'picker.title': 'Choose partial-export start message',
      'picker.close': 'Close',
      'picker.loading': 'Loading the complete conversation…',
      'picker.choose': 'Choose a starting User message · {count} available',
      'picker.failed': 'Unable to load start points: {message}',
      'toast.running': 'An export is already running.',
      'toast.failed': 'Export failed: {message}',
      'toast.complete': 'Export complete: {count} messages (User {user} / Assistant {assistant}) · {scope}{source}{images}',
      'scope.full': 'Full export',
      'scope.partial': 'Partial export',
      'source.api': ' · Complete API read',
      'source.dom': ' · DOM compatibility mode',
      'images.summary': '; images {archived}/{total}',
      'images.failed': ', failed {failed}',
      'progress.readApi': 'Reading complete conversation data',
      'progress.apiFallback': 'Complete-data API unavailable; switching to page traversal',
      'progress.archiveImages': 'Archiving images',
      'progress.generate': 'Generating export files…',
      'progress.index': 'Reading conversation index',
      'progress.scan': 'Scanning messages',
      'progress.loadOlder': 'Loading earlier messages',
      'progress.walk': 'Walking complete conversation',
      'error.traversalModule': 'Conversation traversal module is not loaded.',
      'error.incompleteIndex': 'The conversation index contains {total} turns, but {missing} could not be hydrated. Export stopped to avoid an incomplete archive.',
      'error.noScroller': 'Unable to find the ChatGPT conversation scroll container.',
      'error.noMessages': 'No ChatGPT messages were detected on this page. Open a specific conversation and try again.',
      'error.imageTooLarge': 'Image exceeds the 20 MB limit.',
      'error.imageDownload': 'Image download failed.',
      'error.imageModule': 'Image archive module is not loaded.',
      'error.imageUrl': 'Unable to resolve the image download URL.',
      'error.rangeChanged': 'The current conversation changed. Select the partial-export start point again.',
      'error.rangeModule': 'Export range module is not loaded.',
      'error.noUserStart': 'This conversation has no User message that can be used as a start point.',
      'error.zipModule': 'ZIP module is not loaded.',
      'md.exportedAt': 'Exported at',
      'md.source': 'Source',
      'md.messageCount': 'Messages',
      'md.range': 'Export range',
      'md.fullRange': 'Full export',
      'md.partialRange': 'Partial export (starting at original message {start} of {total})',
      'md.imageArchive': 'Image archive',
      'md.imageNotArchived': 'Not run (image binaries are archived in ZIP mode only)',
      'md.imageFailed': ' ({failed} failed)',
      'md.branch': 'Branch',
      'md.currentBranch': 'Current selected conversation branch',
      'md.toolDetails': 'Tool-call details',
      'md.included': 'Included',
      'md.excluded': 'Excluded',
      'md.attachments': 'Attachments:',
    },
  };

  /**
   * Normalize browser/persisted locales to the languages currently shipped by the extension.
   */
  function normalizeLocale(value) {
    const locale = String(value || '').toLowerCase();
    return locale.startsWith('en') ? 'en' : DEFAULT_LOCALE;
  }

  /**
   * Translate one stable key and interpolate named placeholders.
   */
  function t(locale, key, variables = {}) {
    const normalized = normalizeLocale(locale);
    let text = MESSAGES[normalized]?.[key] ?? MESSAGES[DEFAULT_LOCALE]?.[key] ?? key;
    for (const [name, value] of Object.entries(variables || {})) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }

  /**
   * Load the selected UI locale. First install intentionally defaults to Simplified Chinese.
   */
  async function loadLocale() {
    try {
      if (!chrome?.storage?.local?.get) return DEFAULT_LOCALE;
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return normalizeLocale(result?.[STORAGE_KEY] || DEFAULT_LOCALE);
    } catch {
      return DEFAULT_LOCALE;
    }
  }

  /**
   * Persist and return a supported UI locale.
   */
  async function saveLocale(locale) {
    const normalized = normalizeLocale(locale);
    try {
      await chrome?.storage?.local?.set?.({ [STORAGE_KEY]: normalized });
    } catch {
      // Keep the in-memory locale even if persistence is unavailable.
    }
    return normalized;
  }

  ns.i18n = { DEFAULT_LOCALE, normalizeLocale, t, loadLocale, saveLocale };
})();

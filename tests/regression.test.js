'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadNamespaceScript(relativePath, globals = {}) {
  const filename = path.join(ROOT, relativePath);
  const sandbox = {
    console,
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    Blob,
    ...globals,
  };
  sandbox.globalThis = sandbox;
  sandbox.ChatGPTConversationExporter = {};

  if (fs.existsSync(filename)) {
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  }

  return sandbox.ChatGPTConversationExporter;
}

test('current ChatGPT turn shells expose the complete user/assistant turn count before hydration', () => {
  const ns = loadNamespaceScript('src/traversal.js');
  assert.equal(typeof ns.traversal?.getTurnShells, 'function', 'traversal.getTurnShells must exist');

  const currentShells = [
    { dataset: { turnId: 'a', turn: 'user' } },
    { dataset: { turnId: 'b', turn: 'assistant' } },
    { dataset: { turnId: 'tool', turn: 'tool' } },
    { dataset: { turnId: 'c', turn: 'user' } },
  ];
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === '#thread section[data-turn-id][data-turn]') return currentShells;
      return [];
    },
  };

  const shells = ns.traversal.getTurnShells(fakeDocument);
  assert.equal(shells.length, 3);
  assert.equal(shells.map((node) => node.dataset.turnId).join(','), 'a,b,c');
});

test('image asset paths are deterministic and Markdown image URLs can be rewritten locally', () => {
  const ns = loadNamespaceScript('src/assets.js');
  assert.equal(typeof ns.assets?.createImageAssetPath, 'function', 'assets.createImageAssetPath must exist');
  assert.equal(typeof ns.assets?.rewriteMarkdownImageSources, 'function', 'assets.rewriteMarkdownImageSources must exist');

  const pathName = ns.assets.createImageAssetPath(12, 2, 'image/webp');
  assert.equal(pathName, 'assets/images/message-0012-image-02.webp');

  const markdown = 'Before\n\n![sample](https://example.test/a.webp)\n\nAfter';
  const rewritten = ns.assets.rewriteMarkdownImageSources(markdown, [
    { src: 'https://example.test/a.webp', localPath: pathName },
  ]);
  assert.match(rewritten, /!\[sample\]\(assets\/images\/message-0012-image-02\.webp\)/);
  assert.doesNotMatch(rewritten, /https:\/\/example\.test\/a\.webp/);
});


test('virtualized turn shells are hydrated one by one without requiring manual scrolling', async () => {
  const ns = loadNamespaceScript('src/traversal.js');
  const shells = Array.from({ length: 4 }, (_, index) => ({
    dataset: { turnId: `turn-${index}`, turn: index % 2 ? 'assistant' : 'user' },
    mounted: index === 3,
    scrollIntoView() {
      this.mounted = true;
    },
  }));

  const result = await ns.traversal.hydrateTurnShells({
    shells,
    extract(shell) {
      return shell.mounted
        ? { key: shell.dataset.turnId, role: shell.dataset.turn, text: shell.dataset.turnId }
        : null;
    },
    async waitForMessage(shell) {
      return shell.mounted
        ? { key: shell.dataset.turnId, role: shell.dataset.turn, text: shell.dataset.turnId }
        : null;
    },
  });

  assert.equal(result.total, 4);
  assert.equal(result.missing, 0);
  assert.equal(result.messages.map((message) => message.key).join(','), 'turn-0,turn-1,turn-2,turn-3');
});


test('image-only turns gain Markdown references for archived images', () => {
  const ns = loadNamespaceScript('src/assets.js');
  assert.equal(typeof ns.assets?.appendMissingImageReferences, 'function', 'assets.appendMissingImageReferences must exist');

  const markdown = ns.assets.appendMissingImageReferences('', [
    { alt: 'uploaded screenshot', src: 'https://example.test/a.png', localPath: 'assets/images/message-0001-image-01.png' },
  ]);
  assert.equal(markdown, '![uploaded screenshot](assets/images/message-0001-image-01.png)');
});

test('API active branch follows current_node so the newest conversation turns are never dropped', () => {
  const ns = loadNamespaceScript('src/remote.js');
  assert.equal(typeof ns.remote?.linearizeActiveBranch, 'function', 'remote.linearizeActiveBranch must exist');

  const data = {
    current_node: 'a4',
    mapping: {
      root: { parent: null, message: null },
      u1: { parent: 'root', message: { id: 'm-u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['first'] } } },
      a1: { parent: 'u1', message: { id: 'm-a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['reply 1'] } } },
      orphan: { parent: 'u1', message: { id: 'm-orphan', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['unused branch'] } } },
      u2: { parent: 'a1', message: { id: 'm-u2', author: { role: 'user' }, content: { content_type: 'text', parts: ['latest question'] } } },
      a4: { parent: 'u2', message: { id: 'm-a4', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['latest answer'] } } },
    },
  };

  const branch = ns.remote.linearizeActiveBranch(data);
  assert.equal(branch.map((message) => message.id).join(','), 'm-u1,m-a1,m-u2,m-a4');
  assert.equal(branch.at(-1).content.parts[0], 'latest answer');
});

test('API conversation normalization preserves image-only turns and assistant tool images on the active branch', () => {
  const ns = loadNamespaceScript('src/remote.js');
  assert.equal(typeof ns.remote?.normalizeConversation, 'function', 'remote.normalizeConversation must exist');

  const data = {
    title: 'Fixture chat',
    current_node: 'a2',
    mapping: {
      root: { parent: null, message: null },
      u1: {
        parent: 'root',
        message: {
          id: 'u1-msg',
          author: { role: 'user' },
          content: {
            content_type: 'multimodal_text',
            parts: [
              'look at this',
              { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_user_img', width: 800, height: 600 },
            ],
          },
          metadata: { attachments: [{ id: 'file_user_img', name: 'screen.png', mime_type: 'image/png' }] },
        },
      },
      a1: {
        parent: 'u1',
        message: {
          id: 'a1-msg',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Here is the result.'] },
          metadata: {},
        },
      },
      tool1: {
        parent: 'a1',
        message: {
          id: 'tool-img',
          author: { role: 'tool' },
          content: {
            content_type: 'multimodal_text',
            parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file_generated_img', width: 1024, height: 1024 }],
          },
          metadata: {},
        },
      },
      a2: {
        parent: 'tool1',
        message: {
          id: 'a2-msg',
          author: { role: 'assistant' },
          content: { content_type: 'text', parts: ['Done.'] },
          metadata: {},
        },
      },
    },
  };

  const result = ns.remote.normalizeConversation(data, 'conversation-123');
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, 'user');
  assert.equal(result.messages[0].images[0].fileId, 'file_user_img');
  assert.equal(result.messages[1].role, 'assistant');
  assert.match(result.messages[1].markdown, /Here is the result\./);
  assert.match(result.messages[1].markdown, /Done\./);
  assert.equal(result.messages[1].images[0].fileId, 'file_generated_img');
});

test('API fetch obtains a short-lived session token and returns the full conversation tree', async () => {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/auth/session') {
      return { ok: true, json: async () => ({ accessToken: 'short-lived-token' }) };
    }
    if (url === '/backend-api/conversation/12345678-1234-1234-1234-123456789abc') {
      return {
        ok: true,
        json: async () => ({
          title: 'Remote fixture',
          current_node: 'a1',
          mapping: {
            u1: { parent: null, message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['Q'] }, metadata: {} } },
            a1: { parent: 'u1', message: { id: 'a1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['A'] }, metadata: {} } },
          },
        }),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const ns = loadNamespaceScript('src/remote.js', { fetch });
  assert.equal(typeof ns.remote?.fetchCurrentConversation, 'function', 'remote.fetchCurrentConversation must exist');
  const result = await ns.remote.fetchCurrentConversation({ pathname: '/c/12345678-1234-1234-1234-123456789abc' });

  assert.equal(result.messages.map((message) => message.text).join('|'), 'Q|A');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer short-lived-token');
  assert.equal(result.accessToken, 'short-lived-token');
});

test('image download resolution falls back to the conversation attachment endpoint for sediment assets', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url === '/backend-api/conversation/conversation-123/attachment/file_img/download') {
      return { ok: true, json: async () => ({ download_url: 'https://chatgpt.com/backend-api/estuary/content?id=file_img' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const ns = loadNamespaceScript('src/remote.js', { fetch });
  const resolved = await ns.remote.resolveFileDownload({
    fileId: 'file_img',
    conversationId: 'conversation-123',
    accessToken: 'token',
  });

  assert.equal(resolved.download_url, 'https://chatgpt.com/backend-api/estuary/content?id=file_img');
  assert.equal(calls.at(-1), '/backend-api/conversation/conversation-123/attachment/file_img/download');
});

test('partial export start options list only user messages with stable original positions', () => {
  const ns = loadNamespaceScript('src/range.js');
  assert.equal(typeof ns.range?.getUserStartOptions, 'function', 'range.getUserStartOptions must exist');

  const messages = [
    { key: 'u1', role: 'user', text: 'first user message' },
    { key: 'a1', role: 'assistant', text: 'first answer' },
    { key: 'u2', role: 'user', text: 'second user message with a longer body' },
    { key: 'a2', role: 'assistant', text: 'second answer' },
  ];

  const options = ns.range.getUserStartOptions(messages);
  assert.deepEqual(
    options.map((item) => ({ key: item.key, messagePosition: item.messagePosition, userOrdinal: item.userOrdinal })),
    [
      { key: 'u1', messagePosition: 1, userOrdinal: 1 },
      { key: 'u2', messagePosition: 3, userOrdinal: 2 },
    ],
  );
  assert.match(options[1].label, /#2/);
  assert.match(options[1].label, /second user message/);
});

test('partial export includes the selected user message and every following message through the end', () => {
  const ns = loadNamespaceScript('src/range.js');
  assert.equal(typeof ns.range?.applyExportRange, 'function', 'range.applyExportRange must exist');

  const messages = [
    { key: 'u1', role: 'user', text: 'Q1' },
    { key: 'a1', role: 'assistant', text: 'A1' },
    { key: 'u2', role: 'user', text: 'Q2' },
    { key: 'a2', role: 'assistant', text: 'A2' },
    { key: 'u3', role: 'user', text: 'Q3' },
    { key: 'a3', role: 'assistant', text: 'A3' },
  ];

  const result = ns.range.applyExportRange(messages, { mode: 'partial', startMessageKey: 'u2' });
  assert.deepEqual(result.messages.map((message) => message.key), ['u2', 'a2', 'u3', 'a3']);
  assert.equal(result.metadata.exportScope, 'partial');
  assert.equal(result.metadata.startMessageKey, 'u2');
  assert.equal(result.metadata.startMessagePosition, 3);
  assert.equal(result.metadata.originalMessageCount, 6);
  assert.equal(result.metadata.exportedMessageCount, 4);
});

test('partial export may start on an assistant message and full export preserves all messages', () => {
  const ns = loadNamespaceScript('src/range.js');
  const messages = [
    { key: 'u1', role: 'user', text: 'Q1' },
    { key: 'a1', role: 'assistant', text: 'A1' },
  ];

  const partial = ns.range.applyExportRange(messages, { mode: 'partial', startMessageKey: 'a1' });
  assert.deepEqual(partial.messages.map((message) => message.key), ['a1']);

  const full = ns.range.applyExportRange(messages, { mode: 'full' });
  assert.deepEqual(full.messages.map((message) => message.key), ['u1', 'a1']);
  assert.equal(full.metadata.exportScope, 'full');
  assert.equal(full.metadata.originalMessageCount, 2);
  assert.equal(full.metadata.exportedMessageCount, 2);
});

test('range selection returns export-safe message copies so image archiving cannot mutate the cached full branch', () => {
  const ns = loadNamespaceScript('src/range.js');
  const source = [
    {
      key: 'u1',
      role: 'user',
      text: 'Q1',
      markdown: '![img](chatgpt-file://file_1)',
      attachments: [{ name: 'a.txt' }],
      images: [{ fileId: 'file_1', src: 'chatgpt-file://file_1' }],
    },
  ];

  const ranged = ns.range.applyExportRange(source, { mode: 'full' });
  ranged.messages[0].markdown = 'changed';
  ranged.messages[0].images[0].localPath = 'assets/images/a.png';
  ranged.messages[0].attachments[0].name = 'changed.txt';

  assert.equal(source[0].markdown, '![img](chatgpt-file://file_1)');
  assert.equal(source[0].images[0].localPath, undefined);
  assert.equal(source[0].attachments[0].name, 'a.txt');
});

test('V1.3 packages the range module in both normal content scripts and old-tab fallback injection', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const contentScripts = manifest.content_scripts?.[0]?.js || [];
  assert.ok(contentScripts.includes('src/range.js'));
  assert.ok(contentScripts.indexOf('src/range.js') < contentScripts.indexOf('src/content.js'));

  const background = fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
  assert.match(background, /files:\s*\[[^\]]*'src\/range\.js'[^\]]*'src\/content\.js'/s);
  assert.match(background, /CGPT_EXPORT_OPEN_MENU/);
});

test('image archive type prefers a real filename extension when HTTP returns application/octet-stream', () => {
  const ns = loadNamespaceScript('src/assets.js');
  assert.equal(typeof ns.assets?.resolveImageType, 'function', 'assets.resolveImageType must exist');

  const resolved = ns.assets.resolveImageType({
    httpMimeType: 'application/octet-stream',
    originalName: 'generated-image.png',
    messageMimeType: null,
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  });

  assert.equal(resolved.mimeType, 'image/png');
  assert.equal(resolved.extension, 'png');
  assert.equal(resolved.source, 'filename');
  assert.equal(ns.assets.createImageAssetPath(4, 1, resolved.mimeType, resolved.extension), 'assets/images/message-0004-image-01.png');
});

test('image archive type can detect common image formats from magic bytes as a final fallback', () => {
  const ns = loadNamespaceScript('src/assets.js');
  const resolved = ns.assets.resolveImageType({
    httpMimeType: 'application/octet-stream',
    originalName: null,
    messageMimeType: null,
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  });

  assert.equal(resolved.mimeType, 'image/jpeg');
  assert.equal(resolved.extension, 'jpg');
  assert.equal(resolved.source, 'magic');
});

test('tool-call text is excluded by default while tool-produced visible images are preserved', () => {
  const ns = loadNamespaceScript('src/remote.js');
  const data = {
    title: 'Tool fixture',
    current_node: 'a2',
    mapping: {
      u1: { parent: null, message: { id: 'u1', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['question'] }, metadata: {} } },
      call1: { parent: 'u1', message: { id: 'call1', author: { role: 'assistant' }, recipient: 'web.run', content: { content_type: 'text', parts: ['{"query":"very noisy payload"}'] }, metadata: {} } },
      tool1: { parent: 'call1', message: { id: 'tool1', author: { role: 'tool', name: 'web.run' }, content: { content_type: 'text', parts: ['very long tool result'] }, metadata: {} } },
      toolImg: { parent: 'tool1', message: { id: 'tool-img', author: { role: 'tool', name: 'image_gen' }, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_visible_image' }] }, metadata: {} } },
      a2: { parent: 'toolImg', message: { id: 'a2', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['final answer'] }, metadata: {} } },
    },
  };

  const result = ns.remote.normalizeConversation(data, 'conversation-1');
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[1].role, 'assistant');
  assert.match(result.messages[1].markdown, /final answer/);
  assert.doesNotMatch(result.messages[1].markdown, /very noisy payload/);
  assert.doesNotMatch(result.messages[1].markdown, /very long tool result/);
  assert.equal(result.messages[1].images[0].fileId, 'file_visible_image');
});

test('tool-call details can be explicitly included and are visibly separated from normal assistant text', () => {
  const ns = loadNamespaceScript('src/remote.js');
  const data = {
    title: 'Tool fixture',
    current_node: 'a2',
    mapping: {
      u1: { parent: null, message: { id: 'u1', author: { role: 'user' }, recipient: 'all', content: { content_type: 'text', parts: ['question'] }, metadata: {} } },
      call1: { parent: 'u1', message: { id: 'call1', author: { role: 'assistant' }, recipient: 'python', content: { content_type: 'text', parts: ['print(123)'] }, metadata: {} } },
      tool1: { parent: 'call1', message: { id: 'tool1', author: { role: 'tool', name: 'python' }, content: { content_type: 'text', parts: ['123'] }, metadata: {} } },
      a2: { parent: 'tool1', message: { id: 'a2', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['final answer'] }, metadata: {} } },
    },
  };

  const result = ns.remote.normalizeConversation(data, 'conversation-1', { includeToolDetails: true });
  const assistant = result.messages[1];
  assert.match(assistant.markdown, /Tool call: python/);
  assert.match(assistant.markdown, /print\(123\)/);
  assert.match(assistant.markdown, /Tool result: python/);
  assert.match(assistant.markdown, /123/);
  assert.match(assistant.markdown, /final answer/);
});

test('export options default to hiding tool details and preserve explicit overrides', () => {
  const ns = loadNamespaceScript('src/export-options.js');
  assert.equal(typeof ns.exportOptions?.normalize, 'function', 'exportOptions.normalize must exist');
  assert.equal(ns.exportOptions.normalize().includeToolDetails, false);
  assert.equal(ns.exportOptions.normalize({ includeToolDetails: true }).includeToolDetails, true);
});

test('i18n supports Simplified Chinese and English with stable fallback keys', () => {
  const ns = loadNamespaceScript('src/i18n.js');
  assert.equal(typeof ns.i18n?.t, 'function', 'i18n.t must exist');
  assert.equal(ns.i18n.t('zh-CN', 'export.button'), '↓ 导出');
  assert.equal(ns.i18n.t('en', 'export.button'), '↓ Export');
  assert.equal(ns.i18n.normalizeLocale('en-US'), 'en');
  assert.equal(ns.i18n.normalizeLocale('zh-TW'), 'zh-CN');
  assert.equal(ns.i18n.t('en', 'missing.key'), 'missing.key');
});

test('V1.4 loads i18n and export options before content and requests storage permission', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts?.[0]?.js || [];
  assert.ok(manifest.permissions?.includes('storage'));
  assert.ok(scripts.includes('src/i18n.js'));
  assert.ok(scripts.includes('src/export-options.js'));
  assert.ok(scripts.indexOf('src/i18n.js') < scripts.indexOf('src/content.js'));
  assert.ok(scripts.indexOf('src/export-options.js') < scripts.indexOf('src/content.js'));

  const background = fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
  assert.match(background, /'src\/i18n\.js'/);
  assert.match(background, /'src\/export-options\.js'/);
});

test('execution_output aggregate images are collected as visible assistant assets without exporting noisy tool text', () => {
  const ns = loadNamespaceScript('src/remote.js');
  const data = {
    title: 'Execution image fixture',
    current_node: 'a2',
    mapping: {
      u1: { parent: null, message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['make chart'] }, metadata: {} } },
      exec1: {
        parent: 'u1',
        message: {
          id: 'exec1',
          author: { role: 'tool', name: 'python' },
          content: { content_type: 'execution_output' },
          metadata: {
            aggregate_result: {
              messages: [
                { message_type: 'stream', text: 'lots of tool output' },
                { message_type: 'image', image_url: 'sediment://file_chart_png', width: 900, height: 500 },
              ],
            },
          },
        },
      },
      a2: { parent: 'exec1', message: { id: 'a2', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'text', parts: ['chart ready'] }, metadata: {} } },
    },
  };

  const result = ns.remote.normalizeConversation(data, 'conversation-1');
  const assistant = result.messages[1];
  assert.equal(assistant.images[0].fileId, 'file_chart_png');
  assert.equal(assistant.images[0].width, 900);
  assert.match(assistant.markdown, /chatgpt-file:\/\/file_chart_png/);
  assert.doesNotMatch(assistant.markdown, /lots of tool output/);
});

test('export option and locale preferences persist through chrome.storage.local', async () => {
  const store = {};
  const chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: store[key] }; },
        async set(values) { Object.assign(store, values); },
      },
    },
  };

  const optionsNs = loadNamespaceScript('src/export-options.js', { chrome });
  await optionsNs.exportOptions.save({ includeToolDetails: true, includeImages: false });
  const loadedOptions = await optionsNs.exportOptions.load();
  assert.equal(loadedOptions.includeToolDetails, true);
  assert.equal(loadedOptions.includeImages, false);

  const i18nNs = loadNamespaceScript('src/i18n.js', { chrome });
  await i18nNs.i18n.saveLocale('en-US');
  assert.equal(await i18nNs.i18n.loadLocale(), 'en');
});

test('normal assistant image markdown is emitted once and tool-image preservation does not duplicate it', () => {
  const ns = loadNamespaceScript('src/remote.js');
  const data = {
    current_node: 'a1',
    mapping: {
      u1: { parent: null, message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['show image'] }, metadata: {} } },
      a1: { parent: 'u1', message: { id: 'a1', author: { role: 'assistant' }, recipient: 'all', content: { content_type: 'multimodal_text', parts: ['done', { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_once' }] }, metadata: {} } },
    },
  };

  const assistant = ns.remote.normalizeConversation(data, 'c1').messages[1];
  assert.equal((assistant.markdown.match(/chatgpt-file:\/\/file_once/g) || []).length, 1);
});

test('authenticated ChatGPT image downloads build Bearer headers only when a short-lived token is available', () => {
  const ns = loadNamespaceScript('src/assets.js');
  assert.equal(typeof ns.assets?.createAssetRequestHeaders, 'function', 'assets.createAssetRequestHeaders must exist');
  assert.equal(ns.assets.createAssetRequestHeaders().Authorization, undefined);
  assert.equal(ns.assets.createAssetRequestHeaders('short-token').Authorization, 'Bearer short-token');
});

test('background asset bridge forwards the short-lived access token as Authorization for protected image binaries', () => {
  const background = fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
  assert.match(background, /fetchAsset\(message\.url,\s*message\.accessToken/);
  assert.match(background, /Authorization:\s*`Bearer \$\{accessToken\}`/);
});

test('V1.5 export options default to including conversation images and persist an explicit disable', () => {
  const ns = loadNamespaceScript('src/export-options.js');
  const defaults = ns.exportOptions.normalize();
  assert.equal(defaults.includeToolDetails, false);
  assert.equal(defaults.includeImages, true);

  const disabled = ns.exportOptions.normalize({ includeToolDetails: true, includeImages: false });
  assert.equal(disabled.includeToolDetails, true);
  assert.equal(disabled.includeImages, false);
});

test('image bytes can be converted to a self-contained data URI without external files', () => {
  const ns = loadNamespaceScript('src/assets.js', {
    btoa(value) { return Buffer.from(value, 'binary').toString('base64'); },
  });
  assert.equal(typeof ns.assets?.bytesToDataUri, 'function', 'assets.bytesToDataUri must exist');
  const dataUri = ns.assets.bytesToDataUri(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
  assert.equal(dataUri, 'data:image/png;base64,iVBORw==');
});

test('Markdown image rendering embeds downloaded images and removes unresolved placeholders', () => {
  const ns = loadNamespaceScript('src/assets.js');
  assert.equal(typeof ns.assets?.renderMarkdownImages, 'function', 'assets.renderMarkdownImages must exist');

  const images = [
    { fileId: 'file_ok', src: 'chatgpt-file://file_ok', alt: 'ok image' },
    { fileId: 'file_missing', src: 'chatgpt-file://file_missing', alt: 'missing image' },
  ];
  const markdown = [
    'Before',
    '',
    '![ok image](chatgpt-file://file_ok)',
    '',
    '![missing image](chatgpt-file://file_missing)',
    '',
    'After',
  ].join('\n');
  const embedded = new Map([['file:file_ok', 'data:image/png;base64,AAAA']]);

  const rendered = ns.assets.renderMarkdownImages(markdown, images, embedded, true);
  assert.match(rendered, /data:image\/png;base64,AAAA/);
  assert.doesNotMatch(rendered, /chatgpt-file:\/\//);
  assert.match(rendered, /Before/);
  assert.match(rendered, /After/);
});

test('disabling conversation images removes image references instead of leaving broken chatgpt-file URLs', () => {
  const ns = loadNamespaceScript('src/assets.js');
  const markdown = 'Before\n\n![image](chatgpt-file://file_1)\n\nAfter';
  const rendered = ns.assets.renderMarkdownImages(
    markdown,
    [{ fileId: 'file_1', src: 'chatgpt-file://file_1', alt: 'image' }],
    new Map(),
    false,
  );

  assert.equal(rendered, 'Before\n\nAfter');
  assert.doesNotMatch(rendered, /chatgpt-file:\/\//);
});

test('large supported raster images are selected for compression while GIF and SVG stay untouched', () => {
  const ns = loadNamespaceScript('src/assets.js');
  assert.equal(typeof ns.assets?.shouldCompressImage, 'function', 'assets.shouldCompressImage must exist');
  assert.equal(ns.assets.shouldCompressImage({ byteLength: 2 * 1024 * 1024, mimeType: 'image/png' }), true);
  assert.equal(ns.assets.shouldCompressImage({ byteLength: 900 * 1024, mimeType: 'image/png' }), false);
  assert.equal(ns.assets.shouldCompressImage({ byteLength: 2 * 1024 * 1024, mimeType: 'image/gif' }), false);
  assert.equal(ns.assets.shouldCompressImage({ byteLength: 2 * 1024 * 1024, mimeType: 'image/svg+xml' }), false);
});

test('large raster compression downsizes the longest edge, emits WebP, and keeps the original when compression is not smaller', async () => {
  const ns = loadNamespaceScript('src/assets.js');
  assert.equal(typeof ns.assets?.compressImageForEmbedding, 'function', 'assets.compressImageForEmbedding must exist');

  const sourceBytes = new Uint8Array(2048);
  const calls = { draw: null, quality: null };
  const bitmap = { width: 4096, height: 1024, close() {} };
  const compressed = await ns.assets.compressImageForEmbedding(
    { bytes: sourceBytes, mimeType: 'image/png' },
    {
      thresholdBytes: 1024,
      createImageBitmap: async () => bitmap,
      createCanvas(width, height) {
        assert.equal(width, 2048);
        assert.equal(height, 512);
        return {
          getContext() {
            return { drawImage(...args) { calls.draw = args; } };
          },
          toBlob(callback, type, quality) {
            calls.quality = quality;
            callback(new Blob([new Uint8Array([1, 2, 3])], { type }));
          },
        };
      },
    },
  );

  assert.equal(compressed.compressed, true);
  assert.equal(compressed.mimeType, 'image/webp');
  assert.equal(compressed.bytes.length, 3);
  assert.equal(calls.quality, 0.85);
  assert.ok(calls.draw);

  const notSmaller = await ns.assets.compressImageForEmbedding(
    { bytes: new Uint8Array([1, 2]), mimeType: 'image/png' },
    {
      thresholdBytes: 1,
      createImageBitmap: async () => ({ width: 10, height: 10, close() {} }),
      createCanvas() {
        return {
          getContext() { return { drawImage() {} }; },
          toBlob(callback, type) { callback(new Blob([new Uint8Array([1, 2, 3])], { type })); },
        };
      },
    },
  );
  assert.equal(notSmaller.compressed, false);
  assert.equal(notSmaller.mimeType, 'image/png');
  assert.equal(notSmaller.bytes.length, 2);
});

test('V1.5 UI keeps the persisted conversation-image option and packages image assets for Markdown/ZIP', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.6.0');

  const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
  assert.match(content, /includeImages/);
  assert.match(content, /images-input/);
  assert.match(content, /setIncludeImages/);
  assert.match(content, /\.\.\.imageFiles/);
  assert.match(content, /createMarkdownImagePackage/);

  const i18n = fs.readFileSync(path.join(ROOT, 'src/i18n.js'), 'utf8');
  assert.match(i18n, /menu\.images/);
  assert.match(i18n, /Include conversation images/);
});

test('V1.5 multilingual UI supports nine locales through a styled custom listbox', () => {
  const ns = loadNamespaceScript('src/i18n.js');
  const locales = ['zh-CN', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'ru', 'uk'];
  const localizedUiKeys = ['menu.full', 'menu.partial', 'menu.hint', 'picker.failed', 'toast.complete', 'toast.printOpened', 'progress.readApi', 'progress.walk', 'menu.pdf'];
  for (const locale of locales) {
    assert.equal(ns.i18n.normalizeLocale(locale), locale);
    for (const key of localizedUiKeys) {
      assert.notEqual(ns.i18n.t(locale, key), key);
      if (locale !== 'en' && locale !== 'zh-CN') {
        assert.notEqual(ns.i18n.t(locale, key), ns.i18n.t('en', key), `${locale} should localize ${key}`);
      }
    }
  }
  assert.equal(ns.i18n.t('ja-JP', 'menu.full'), ns.i18n.t('ja', 'menu.full'));
  assert.equal(ns.i18n.t('ko-KR', 'menu.full'), ns.i18n.t('ko', 'menu.full'));

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts?.[0]?.js || [];
  assert.ok(scripts.includes('src/language-selector.js'));
  assert.ok(scripts.indexOf('src/language-selector.js') < scripts.indexOf('src/content.js'));

  const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
  assert.match(content, /language-picker/);
  assert.match(content, /role="listbox"/);
  assert.match(content, /role="option"/);
  assert.match(content, /🌐\s*语言\s*\/\s*Language/);
  assert.doesNotMatch(content, /<select[^>]*class="language-select"/);
});

test('language selector keyboard navigation wraps across all locale options', () => {
  const ns = loadNamespaceScript('src/language-selector.js');
  assert.equal(typeof ns.languageSelector?.nextIndex, 'function');
  assert.equal(ns.languageSelector.nextIndex(0, -1, 9), 8);
  assert.equal(ns.languageSelector.nextIndex(8, 1, 9), 0);
  assert.equal(ns.languageSelector.nextIndex(3, 1, 9), 4);
});

test('Markdown image export uses relative asset paths instead of data URIs', () => {
  const ns = loadNamespaceScript('src/assets.js');
  const images = [{ fileId: 'file_1', src: 'chatgpt-file://file_1', alt: 'image' }];
  const markdown = 'Before\n\n![image](chatgpt-file://file_1)\n\nAfter';
  const resolved = new Map([['file:file_1', 'assets/images/message-0001-image-01.png']]);

  const rendered = ns.assets.renderMarkdownImages(markdown, images, resolved, true);
  assert.match(rendered, /assets\/images\/message-0001-image-01\.png/);
  assert.doesNotMatch(rendered, /data:image\//);
  assert.doesNotMatch(rendered, /chatgpt-file:\/\//);
});

test('Markdown renderer converts visible Markdown syntax into semantic safe HTML for PDF', () => {
  const ns = loadNamespaceScript('src/markdown-renderer.js');
  assert.equal(typeof ns.markdownRenderer?.render, 'function', 'markdownRenderer.render must exist');
  const markdown = [
    '# Heading',
    '',
    '**bold** and `inline()`',
    '',
    '- one',
    '- two',
    '',
    '> quote',
    '',
    '```js',
    'const a = 1;',
    '```',
  ].join('\n');
  const html = ns.markdownRenderer.render(markdown);
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>inline\(\)<\/code>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code class="language-js">const a = 1;<\/code><\/pre>/);
  assert.doesNotMatch(html, /\*\*bold\*\*/);
  assert.doesNotMatch(html, /```js/);
  assert.doesNotMatch(html, /<script/i);
});

test('print renderer creates a self-contained printable document with embedded images', () => {
  const ns = loadNamespaceScript('src/print.js');
  assert.equal(typeof ns.print?.buildPrintHtml, 'function', 'print.buildPrintHtml must exist');
  const html = ns.print.buildPrintHtml({
    title: 'Conversation',
    messages: [{
      role: 'assistant',
      markdown: 'Answer\n\n![image](chatgpt-file://file_1)',
      images: [{ fileId: 'file_1', src: 'chatgpt-file://file_1', alt: 'image' }],
      attachments: [],
    }],
    imageDataBySource: new Map([['file:file_1', 'data:image/png;base64,AAAA']]),
    includeImages: true,
  });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.match(html, /@page\s*\{[^}]*size:\s*A4/i);
  assert.match(html, /max-height:\s*230mm/);
  assert.match(html, /break-inside:\s*avoid/);
  assert.match(html, /class="message-body"/);
  assert.doesNotMatch(html, /class="message-text"/);
  assert.doesNotMatch(html, /chatgpt-file:\/\//);
});

test('V1.5.1 PDF export keeps explicit pre-print confirmation', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.6.0');
  const scripts = manifest.content_scripts?.[0]?.js || [];
  assert.ok(scripts.includes('src/print.js'));
  assert.ok(scripts.indexOf('src/print.js') < scripts.indexOf('src/content.js'));

  const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
  assert.match(content, /format-pdf/);
  assert.match(content, /window\.confirm\(tr\('pdf\.confirm'\)\)/);
  assert.match(content, /exportConversation\('pdf'/);
  assert.match(content, /printDocument/);
});

test('Markdown exports with images package conversation.md plus assets while image-free Markdown remains a plain file', () => {
  const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
  assert.match(content, /createMarkdownImagePackage/);
  assert.match(content, /assets\/images/);
  assert.doesNotMatch(content, /bytesToDataUri\(prepared\.bytes/);
});

test('V1.5 old-tab fallback injects Markdown renderer and custom language selector before content', () => {
  const background = fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
  assert.match(background, /src\/markdown-renderer\.js/);
  assert.match(background, /src\/language-selector\.js/);
  const markdownIndex = background.indexOf("'src/markdown-renderer.js'");
  const printIndex = background.indexOf("'src/print.js'");
  const languageIndex = background.indexOf("'src/language-selector.js'");
  const contentIndex = background.indexOf("'src/content.js'");
  assert.ok(markdownIndex >= 0 && markdownIndex < printIndex);
  assert.ok(languageIndex >= 0 && languageIndex < contentIndex);
});

test('citation resolver replaces ChatGPT cite markers with real external links from content_references', () => {
  const ns = loadNamespaceScript('src/citation-resolver.js');
  assert.equal(typeof ns.citations?.resolveMarkdown, 'function', 'citations.resolveMarkdown must exist');

  const marker = '\uE200cite\uE202turn246161search4\uE202turn772970search21\uE201';
  const markdown = `偏瘫，肌力4级以下 → 七级伤残。${marker}`;
  const metadata = {
    content_references: [{
      matched_text: marker,
      type: 'grouped_webpages',
      safe_urls: [
        'https://example.com/standard-seven',
        'https://law.example.org/disability-grade',
      ],
      items: [
        { title: '人体损伤致残程度分级', url: 'https://example.com/standard-seven' },
        { title: '伤残等级标准', url: 'https://law.example.org/disability-grade' },
      ],
    }],
  };

  const resolved = ns.citations.resolveMarkdown(markdown, metadata);
  assert.match(resolved, /\[人体损伤致残程度分级\]\(https:\/\/example\.com\/standard-seven\)/);
  assert.match(resolved, /\[伤残等级标准\]\(https:\/\/law\.example\.org\/disability-grade\)/);
  assert.doesNotMatch(resolved, /cite\uE202turn|turn246161search4/);
});

test('citation resolver strips unresolved internal cite markers instead of exposing turn ids', () => {
  const ns = loadNamespaceScript('src/citation-resolver.js');
  const marker = '\uE200cite\uE202turn1search2\uE202turn1search3\uE201';
  const resolved = ns.citations.resolveMarkdown(`Answer ${marker} continues.`, { content_references: [] });
  assert.equal(resolved, 'Answer continues.');
  assert.doesNotMatch(resolved, /turn1search/);
});

test('citation resolver also accepts content-reference source records when safe_urls is absent', () => {
  const ns = loadNamespaceScript('src/citation-resolver.js');
  const marker = '\uE200cite\uE202turn4search1\uE201';
  const resolved = ns.citations.resolveMarkdown(`See ${marker}`, {
    content_references: [{
      matched_text: marker,
      type: 'webpage',
      sources: [{ title: 'Official source', url: 'https://official.example/source' }],
    }],
  });
  assert.match(resolved, /\[Official source\]\(https:\/\/official\.example\/source\)/);
});

test('V1.5 loads citation resolver before remote normalization and remote applies it to visible message markdown', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts?.[0]?.js || [];
  assert.ok(scripts.includes('src/citation-resolver.js'));
  assert.ok(scripts.indexOf('src/citation-resolver.js') < scripts.indexOf('src/remote.js'));

  const remote = fs.readFileSync(path.join(ROOT, 'src/remote.js'), 'utf8');
  assert.match(remote, /ns\.citations\?\.resolveMarkdown/);
});

test('partial export message options include both User and Assistant turns in original order', () => {
  const ns = loadNamespaceScript('src/range.js');
  assert.equal(typeof ns.range?.getMessageOptions, 'function', 'range.getMessageOptions must exist');
  const messages = [
    { key: 'u1', role: 'user', text: 'Question one' },
    { key: 'a1', role: 'assistant', text: 'Answer one' },
    { key: 'u2', role: 'user', text: 'Question two' },
    { key: 'a2', role: 'assistant', text: 'Answer two' },
  ];
  const options = ns.range.getMessageOptions(messages);
  assert.deepEqual(options.map((item) => [item.key, item.messagePosition, item.role]), [
    ['u1', 1, 'user'],
    ['a1', 2, 'assistant'],
    ['u2', 3, 'user'],
    ['a2', 4, 'assistant'],
  ]);
  assert.match(options[1].label, /#2 Assistant/);
});

test('partial export supports inclusive start and end points and records both boundaries', () => {
  const ns = loadNamespaceScript('src/range.js');
  const messages = [
    { key: 'u1', role: 'user', text: 'Q1' },
    { key: 'a1', role: 'assistant', text: 'A1' },
    { key: 'u2', role: 'user', text: 'Q2' },
    { key: 'a2', role: 'assistant', text: 'A2' },
    { key: 'u3', role: 'user', text: 'Q3' },
    { key: 'a3', role: 'assistant', text: 'A3' },
  ];

  const result = ns.range.applyExportRange(messages, {
    mode: 'partial',
    startMessageKey: 'a1',
    endMessageKey: 'u3',
  });

  assert.deepEqual(result.messages.map((message) => message.key), ['a1', 'u2', 'a2', 'u3']);
  assert.equal(result.metadata.startMessagePosition, 2);
  assert.equal(result.metadata.endMessagePosition, 5);
  assert.equal(result.metadata.startMessageKey, 'a1');
  assert.equal(result.metadata.endMessageKey, 'u3');
  assert.equal(result.metadata.exportedMessageCount, 4);
});

test('partial export defaults end point to the final message and rejects an end before start', () => {
  const ns = loadNamespaceScript('src/range.js');
  const messages = [
    { key: 'u1', role: 'user', text: 'Q1' },
    { key: 'a1', role: 'assistant', text: 'A1' },
    { key: 'u2', role: 'user', text: 'Q2' },
    { key: 'a2', role: 'assistant', text: 'A2' },
  ];

  const defaultEnd = ns.range.applyExportRange(messages, { mode: 'partial', startMessageKey: 'a1' });
  assert.deepEqual(defaultEnd.messages.map((message) => message.key), ['a1', 'u2', 'a2']);
  assert.equal(defaultEnd.metadata.endMessageKey, 'a2');
  assert.equal(defaultEnd.metadata.endMessagePosition, 4);

  assert.throws(
    () => ns.range.applyExportRange(messages, { mode: 'partial', startMessageKey: 'u2', endMessageKey: 'a1' }),
    /截止|end/i,
  );
});

test('PDF export warning explicitly tells users to disable browser headers and footers', () => {
  const ns = loadNamespaceScript('src/i18n.js');
  const zh = ns.i18n.t('zh-CN', 'pdf.confirm');
  const en = ns.i18n.t('en', 'pdf.confirm');
  assert.match(zh, /页眉和页脚/);
  assert.match(en, /headers and footers/i);
});

test('new start/end range controls are localized across every supported UI locale', () => {
  const ns = loadNamespaceScript('src/i18n.js');
  const locales = ['zh-CN', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'ru', 'uk'];
  for (const locale of locales) {
    for (const key of ['picker.start', 'picker.end', 'picker.confirm']) {
      assert.notEqual(ns.i18n.t(locale, key), key);
    }
    const summary = ns.i18n.t(locale, 'menu.partialSummary', { start: '#2 User', end: '#5 Assistant' });
    assert.doesNotMatch(summary, /\{label\}|\{start\}|\{end\}/);
    assert.match(summary, /#2 User/);
    assert.match(summary, /#5 Assistant/);
  }
});

test('partial-range message list uses wider spacing, left-aligned text, and no thick start/end edge bars', () => {
  const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
  assert.match(content, /\.picker-list\s*\{[^}]*gap:\s*8px/s);
  assert.match(content, /\.start-item\s*\{[^}]*text-align:\s*left/s);
  assert.doesNotMatch(content, /\.start-item\.is-start\s*\{[^}]*border-left:\s*3px/s);
  assert.doesNotMatch(content, /\.start-item\.is-end\s*\{[^}]*border-right:\s*3px/s);
  assert.match(content, /\.start-item\.is-start\s*\{[^}]*border-color:/s);
  assert.match(content, /\.start-item\.is-end\s*\{[^}]*border-color:/s);
});


test('V1.5.1 refresh reconciliation preserves valid boundaries and falls back when refreshed messages disappear', () => {
  const ns = loadNamespaceScript('src/range.js');
  assert.equal(typeof ns.range?.resolvePickerSelection, 'function', 'range.resolvePickerSelection must exist');
  const options = ns.range.getMessageOptions([
    { key: 'u1', role: 'user', text: 'Q1' },
    { key: 'a1', role: 'assistant', text: 'A1' },
    { key: 'u2', role: 'user', text: 'Q2' },
    { key: 'a2', role: 'assistant', text: 'A2' },
  ]);

  const preserved = ns.range.resolvePickerSelection(options, {
    startMessageKey: 'a1',
    endMessageKey: 'u2',
  });
  assert.equal(preserved.startOption.key, 'a1');
  assert.equal(preserved.endOption.key, 'u2');

  const missing = ns.range.resolvePickerSelection(options, {
    startMessageKey: 'removed-start',
    endMessageKey: 'removed-end',
  });
  assert.equal(missing.startOption.key, 'u1');
  assert.equal(missing.endOption.key, 'a2');

  const invalidOrder = ns.range.resolvePickerSelection(options, {
    startMessageKey: 'u2',
    endMessageKey: 'a1',
  });
  assert.equal(invalidOrder.startOption.key, 'u2');
  assert.equal(invalidOrder.endOption.key, 'a2');
});

test('V1.5.1 partial-range picker exposes refresh UI and refresh forces a fresh conversation read', () => {
  const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
  assert.match(content, /class="picker-refresh"/);
  assert.match(content, /openPartialPicker\(\{\s*forceRefresh\s*=\s*false,\s*selection\s*=\s*null\s*\}\s*=\s*\{\}\)/s);
  assert.match(content, /if\s*\(forceRefresh\)\s*partialScanCache\s*=\s*null/);
  assert.match(content, /openPartialPicker\(\{\s*forceRefresh:\s*true,\s*selection:/s);
  assert.match(content, /pickerRefresh\.disabled\s*=\s*true/);
  assert.match(content, /pickerConfirm\.disabled\s*=\s*true/);
});

test('V1.5.1 refresh control is localized across every supported UI locale', () => {
  const ns = loadNamespaceScript('src/i18n.js');
  for (const locale of ns.i18n.SUPPORTED_LOCALES) {
    const refresh = ns.i18n.t(locale, 'picker.refresh');
    assert.notEqual(refresh, 'picker.refresh');
    assert.ok(refresh.trim().length > 0);
  }
});

test('V1.6 model metadata helper keeps original field names and omits them when export is disabled', () => {
  const ns = loadNamespaceScript('src/model-metadata.js');
  assert.equal(typeof ns.modelMetadata?.toExportFields, 'function', 'modelMetadata.toExportFields must exist');

  const message = {
    role: 'assistant',
    model_slug: 'gpt-5.6',
    resolved_model_slug: 'gpt-5.6-sol',
    thinking_effort: 'high',
  };
  assert.equal(JSON.stringify(ns.modelMetadata.toExportFields(message, false)), '{}');
  assert.equal(JSON.stringify(ns.modelMetadata.toExportFields(message, true)), JSON.stringify({
    model_slug: 'gpt-5.6',
    resolved_model_slug: 'gpt-5.6-sol',
    thinking_effort: 'high',
  }));
});

test('V1.6 assistant normalization merges the last non-empty model metadata across one logical reply', () => {
  const ns = loadNamespaceScript('src/model-metadata.js');
  const remoteNs = loadNamespaceScript('src/remote.js', { ChatGPTConversationExporter: ns });
  const remote = remoteNs.remote || ns.remote;
  assert.equal(typeof remote?.normalizeConversation, 'function');

  const data = {
    current_node: 'a2',
    mapping: {
      u1: { parent: null, message: { id: 'u1', author: { role: 'user' }, content: { content_type: 'text', parts: ['Q'] }, metadata: {} } },
      a1: {
        parent: 'u1',
        message: {
          id: 'a1', author: { role: 'assistant' }, recipient: 'all',
          content: { content_type: 'text', parts: ['first part'] },
          metadata: { model_slug: 'gpt-5.6', resolved_model_slug: 'gpt-5.6-luna', thinking_effort: 'medium' },
        },
      },
      a2: {
        parent: 'a1',
        message: {
          id: 'a2', author: { role: 'assistant' }, recipient: 'all',
          content: { content_type: 'text', parts: ['second part'] },
          metadata: { resolved_model_slug: 'gpt-5.6-sol', thinking_effort: 'high' },
        },
      },
    },
  };

  const result = remote.normalizeConversation(data, 'conversation-1');
  const assistant = result.messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.model_slug, 'gpt-5.6');
  assert.equal(assistant.resolved_model_slug, 'gpt-5.6-sol');
  assert.equal(assistant.thinking_effort, 'high');
});

test('V1.6 latest model detector reads only the latest assistant reply and does not fall back to older replies', () => {
  const ns = loadNamespaceScript('src/model-metadata.js');
  assert.equal(typeof ns.modelMetadata?.getLatestAssistantInfo, 'function');

  const messages = [
    { role: 'assistant', resolved_model_slug: 'gpt-5.6-sol', thinking_effort: 'high' },
    { role: 'user', text: 'next' },
    { role: 'assistant', resolved_model_slug: null, thinking_effort: null },
  ];
  const latest = ns.modelMetadata.getLatestAssistantInfo(messages);
  assert.equal(latest.resolved_model_slug, null);
  assert.equal(latest.thinking_effort, null);
});

test('V1.6 export option defaults model metadata export off and preserves explicit enable', () => {
  const ns = loadNamespaceScript('src/export-options.js');
  assert.equal(ns.exportOptions.normalize().includeModelMetadata, false);
  assert.equal(ns.exportOptions.normalize({ includeModelMetadata: true }).includeModelMetadata, true);
});

test('V1.6 printable PDF can render assistant model metadata only when enabled', () => {
  const ns = loadNamespaceScript('src/print.js');
  const message = {
    role: 'assistant', markdown: 'Answer', images: [], attachments: [],
    model_slug: 'gpt-5.6', resolved_model_slug: 'gpt-5.6-sol', thinking_effort: 'high',
  };
  const labels = { selectedModel: 'Selected model', resolvedModel: 'Resolved model', thinkingEffort: 'Thinking effort' };
  const enabled = ns.print.buildPrintHtml({ messages: [message], includeModelMetadata: true, modelLabels: labels });
  assert.match(enabled, /Selected model/);
  assert.match(enabled, /gpt-5\.6-sol/);
  assert.match(enabled, /Thinking effort/);
  assert.match(enabled, /high/);

  const disabled = ns.print.buildPrintHtml({ messages: [message], includeModelMetadata: false, modelLabels: labels });
  assert.doesNotMatch(disabled, /Selected model/);
  assert.doesNotMatch(disabled, /gpt-5\.6-sol/);
});

test('V1.6 UI includes model metadata export switch, conversation model detector, and moves the floating control 20px left', () => {
  const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
  assert.match(content, /model-metadata-input/);
  assert.match(content, /model-detector/);
  assert.match(content, /resolved-model-value/);
  assert.match(content, /thinking-effort-value/);
  assert.match(content, /right:\s*38px/);
  assert.match(content, /refreshModelDetector/);
});

test('V1.6 model metadata UI strings exist for all supported locales', () => {
  const ns = loadNamespaceScript('src/i18n.js');
  const keys = [
    'menu.modelMetadata', 'menu.modelMetadataHint', 'modelDetector.title', 'modelDetector.resolvedModel',
    'modelDetector.thinkingEffort', 'modelDetector.loading', 'modelDetector.unavailable',
    'md.modelMetadata', 'md.selectedModel', 'md.resolvedModel', 'md.thinkingEffort',
  ];
  for (const locale of ns.i18n.SUPPORTED_LOCALES) {
    for (const key of keys) assert.notEqual(ns.i18n.t(locale, key), key, `${locale} must provide ${key}`);
  }
});

test('V1.6 packages model metadata before remote/content, upgrades schema to 9, and sets version 1.6.0', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.6.0');
  const scripts = manifest.content_scripts?.[0]?.js || [];
  assert.ok(scripts.includes('src/model-metadata.js'));
  assert.ok(scripts.indexOf('src/model-metadata.js') < scripts.indexOf('src/remote.js'));
  assert.ok(scripts.indexOf('src/model-metadata.js') < scripts.indexOf('src/content.js'));

  const background = fs.readFileSync(path.join(ROOT, 'src/background.js'), 'utf8');
  assert.match(background, /src\/model-metadata\.js/);
  const content = fs.readFileSync(path.join(ROOT, 'src/content.js'), 'utf8');
  assert.match(content, /schemaVersion:\s*9/);
});

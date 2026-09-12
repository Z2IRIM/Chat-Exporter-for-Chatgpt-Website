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

test('partial export rejects an assistant message as a start point and full export preserves all messages', () => {
  const ns = loadNamespaceScript('src/range.js');
  const messages = [
    { key: 'u1', role: 'user', text: 'Q1' },
    { key: 'a1', role: 'assistant', text: 'A1' },
  ];

  assert.throws(
    () => ns.range.applyExportRange(messages, { mode: 'partial', startMessageKey: 'a1' }),
    /User/,
  );

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
  await optionsNs.exportOptions.save({ includeToolDetails: true });
  assert.equal((await optionsNs.exportOptions.load()).includeToolDetails, true);

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

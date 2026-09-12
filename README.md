# ChatGPT Conversation Exporter

一个轻量、纯本地的 Chrome / Edge Manifest V3 扩展，用于将**当前打开的 ChatGPT 对话**完整归档。支持全量/部分导出、图片归档、GPT 工具调用详情开关，以及简体中文 / English 界面切换。

## V1.4.0

V1.4.0 在 V1.3.0 的 **API-first + DOM fallback + 全量/部分导出** 基础上，重点增加三项能力：

1. 修复图片归档类型判断，并补充 `execution_output` 工具图片识别；
2. 新增“是否包含 GPT 工具调用详情”选项，默认关闭；
3. 建立独立 i18n 模块，当前支持简体中文与 English，并持久化用户选择。

## 导出范围

### 全量导出

导出当前所选对话分支的全部 User / Assistant 内容。

### 部分导出

1. 在导出菜单中选择 **部分导出 / Partial export**；
2. 扩展先读取当前完整分支；
3. 弹出所有 User 消息组成的起始点列表；
4. 选择一条 User 消息；
5. 导出该 User 消息本身以及其后的全部内容，直到当前对话末尾。

起始点来自完整 conversation tree，不依赖页面当前滚动位置或 DOM 是否已渲染该消息。

## GPT 工具调用详情

导出菜单新增：

```text
[ ] 包含 GPT 工具调用详情
    关闭后仍保留工具生成的可见图片
```

默认关闭。

关闭时：

- 不导出 `assistant -> web.run / python / image_gen / ...` 等工具调用参数；
- 不导出普通 Tool 文本结果和长执行日志；
- 仍保留最终 Assistant 正文；
- **仍保留工具产生、用户可见的图片**。

开启时，工具调用与结果会以明确区块写入 Assistant Markdown，例如：

```text
Tool call: python
Tool result: python
```

JSON 元数据会记录：

```text
includeToolDetails: true | false
```

该选项会保存在 `chrome.storage.local`，下次继续使用上次设置。

## 图片归档

ZIP 模式会尝试将对话中的图片保存到：

```text
assets/images/
```

V1.4.0 修复了一个重要问题：ChatGPT 文件下载接口有时会把真实 PNG/JPEG/WebP 返回为：

```text
application/octet-stream
```

旧版因此可能把图片保存成 `.bin`，导致 Markdown 查看器无法按图片渲染。

另外，2026 年部分 ChatGPT `estuary/content` 文件流即使拿到了临时下载 URL，仍可能要求 Bearer Authorization。V1.4.0 会在解析 `file_id` 后继续用本次短期 access token 下载对应二进制；token 仅在 content script 与 extension service worker 内存之间传递，不写入导出文件或 storage。

现在图片类型依次按以下信息判定：

1. HTTP `Content-Type`（有效 image MIME 时）；
2. 下载接口返回的 `file_name` / 原始文件名；
3. conversation message 中的 MIME；
4. 图片二进制魔数；
5. 都无法识别时才退回 `.bin`。

目前识别：

- PNG
- JPEG
- WebP
- GIF
- AVIF
- BMP
- SVG

同时增加对 ChatGPT `execution_output -> metadata.aggregate_result.messages[].image_url` 图片的识别，因此 Python / Code Interpreter 等工具输出的可见图片不会因为关闭工具文本详情而丢失。

成功归档后，`conversation.md` 会使用 ZIP 内的相对路径，例如：

```markdown
![image](assets/images/message-0012-image-01.png)
```

如果某张图片下载失败：

- 整体导出继续完成；
- 对应 JSON image 记录包含 `archiveError`；
- `imageArchive.failures[]` 保存失败 file id / source / error；
- 完成提示显示失败数量。

## 多语言

当前支持：

- 简体中文（首次安装默认）
- English

导出菜单可直接切换语言。选择保存在 `chrome.storage.local`。

语言切换影响：

- 导出菜单
- 部分导出选择器
- 进度提示
- 完成/失败提示
- Markdown 文件中的固定元数据标签

不会翻译实际 User / Assistant 对话内容；角色名称继续稳定使用 `User / Assistant`。

## 完整对话读取

ChatGPT 长对话使用虚拟化渲染，因此扩展优先：

1. 从当前 URL 获取 conversation id；
2. 通过当前登录会话获取短期 access token；
3. 只读请求当前 conversation tree；
4. 从 `current_node` 沿 parent 链回溯当前真正选中的分支；
5. 根据“是否包含工具详情”的设置规范化 User / Assistant / Tool 节点；
6. API 不可用时才回退 DOM 虚拟化遍历。

access token 只存在于本次导出的内存中，不写入文件、不写入 storage、不写入日志。

## ZIP 内容

```text
<对话标题>_YYYY-MM-DD_HH-MM-SS.zip
├─ conversation.md
├─ conversation.json
└─ assets/
   └─ images/
      ├─ message-0001-image-01.png
      └─ ...
```

## 使用方式

点击浏览器工具栏扩展图标，或点击 ChatGPT 页面右下角的导出按钮。

菜单中可以设置：

```text
导出范围
[全量导出] [部分导出]

导出选项
[ ] 包含 GPT 工具调用详情

语言
[简体中文] [English]

导出 ZIP
仅导出 Markdown
仅导出 JSON
```

ZIP 模式会归档图片本体；单独 Markdown / JSON 不主动下载图片二进制。

## JSON 主要元数据

V1.4.0 schemaVersion：`5`

```text
exportScope
startMessageKey
startMessageId
startMessagePosition
startUserOrdinal
originalMessageCount
exportedMessageCount
includeToolDetails
uiLocale
imageArchive
extractionMode
```

## 隐私与安全

扩展只执行读取操作，不修改 ChatGPT 对话。

没有：

- 第三方后端
- OpenAI API Key
- 遥测
- 对话上传
- Cookie API 权限
- `<all_urls>` 权限

新增的 `storage` 权限只用于保存：

- UI 语言
- 是否包含工具调用详情

不会把 conversation、access token 或图片内容写入 extension storage。

## 当前边界

- 只导出当前选中的对话分支，不导出未选中的“重新生成”历史分支。
- 部分导出起始点仅允许选择 User 消息。
- 普通文件附件当前仍以元数据为主，尚未批量归档所有附件二进制。
- Canvas、视频、第三方 App 富媒体不保证完整归档。
- 不导出隐藏 system context、隐藏 reasoning / chain-of-thought 等非对话可见内容。
- ChatGPT 的 `/backend-api` 是 Web 客户端内部接口，并非公开稳定 API；变化时扩展会尝试回退 DOM 路径。

## 安装 / 更新

### Chrome

1. 解压扩展 ZIP。
2. 打开 `chrome://extensions/`。
3. 打开 **开发者模式**。
4. 旧版更新：替换扩展目录后点击 **重新加载**。
5. 首次安装：点击 **加载已解压的扩展程序**。
6. 选择 `chatgpt-conversation-exporter` 文件夹。
7. **刷新已经打开的 ChatGPT 标签页。**

### Edge

打开 `edge://extensions/`，其余步骤相同。

## 权限

- `activeTab`：点击工具栏图标时操作当前 ChatGPT 标签页。
- `scripting`：为安装/更新前已打开的 ChatGPT 标签页补注入脚本。
- `storage`：仅保存语言与导出选项。
- ChatGPT / OpenAI 图片域名：读取当前对话及下载当前对话引用的图片资产。

## 项目结构

```text
chatgpt-conversation-exporter/
├─ manifest.json
├─ README.md
├─ assets/
├─ src/
│  ├─ i18n.js
│  ├─ export-options.js
│  ├─ remote.js
│  ├─ traversal.js
│  ├─ assets.js
│  ├─ range.js
│  ├─ zip.js
│  ├─ content.js
│  └─ background.js
└─ tests/
   └─ regression.test.js
```

## Version

V1.4.0

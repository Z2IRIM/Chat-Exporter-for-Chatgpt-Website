(() => {
  'use strict';

  const ns = (globalThis.ChatGPTConversationExporter ||= {});
  if (ns.i18n) return;

  const STORAGE_KEY = 'chatgptConversationExporter.locale';
  const DEFAULT_LOCALE = 'zh-CN';
  const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'en', 'ja', 'ko', 'de', 'es', 'fr', 'ru', 'uk']);
  const LOCALE_LABELS = Object.freeze({
    'zh-CN': '简体中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
    de: 'Deutsch',
    es: 'Español',
    fr: 'Français',
    ru: 'Русский',
    uk: 'Українська',
  });

  const EN = {
    'export.button': '↓ Export',
    'export.busy': 'Scanning…',
    'menu.rangeTitle': 'Export range',
    'menu.full': 'Full export',
    'menu.partial': 'Partial export',
    'menu.fullSummary': 'Export the entire active conversation branch',
    'menu.partialSummary': 'Bereich: {start} → {end}',
    'menu.partialFallback': 'Selected range',
    'menu.optionsTitle': 'Export options',
    'menu.toolDetails': 'Include GPT tool-call details',
    'menu.toolDetailsHint': 'When off, tool-call arguments and textual tool results are omitted',
    'menu.modelMetadata': 'Include response model and reasoning info',
    'menu.modelMetadataHint': 'When on, export selected model, resolved model, and thinking effort for each Assistant reply',
    'modelDetector.title': 'Conversation model detector',
    'modelDetector.resolvedModel': 'Resolved model',
    'modelDetector.thinkingEffort': 'Thinking effort',
    'modelDetector.loading': 'Detecting…',
    'modelDetector.unavailable': 'Unavailable',
    'menu.images': 'Include conversation images',
    'menu.imagesHint': 'Markdown uses an MD + image-assets package; PDF embeds images in the printed document',
    'menu.languageTitle': '🌐 语言 / Language',
    'menu.hint': 'Partial export supports inclusive start/end points; the end defaults to the final message. JSON keeps image metadata only',
    'menu.zip': 'Export ZIP (Markdown + JSON)',
    'menu.md': 'Export Markdown',
    'menu.pdf': 'Export PDF',
    'menu.json': 'Export JSON only',
    'picker.title': 'Choose partial-export range',
    'picker.start': 'Start', 'picker.end': 'End', 'picker.confirm': 'Use this range', 'picker.last': 'Final message',
    'picker.close': 'Close',
    'picker.refresh': 'Refresh conversation list',
    'picker.loading': 'Loading the complete conversation…',
    'picker.choose': 'Choose a {boundary} message · {count} messages available',
    'picker.failed': 'Unable to load start points: {message}',
    'toast.running': 'An export is already running.',
    'toast.failed': 'Export failed: {message}',
    'toast.complete': 'Export complete: {count} messages (User {user} / Assistant {assistant}) · {scope}{source}{images}',
    'toast.printOpened': 'The system print dialog is open. Choose “Save as PDF” and keep “Headers and footers” disabled.',
    'scope.full': 'Full export',
    'scope.partial': 'Partial export',
    'source.api': ' · Complete API read',
    'source.dom': ' · DOM compatibility mode',
    'images.summary': '; images {archived}/{total}',
    'images.failed': ', failed {failed}',
    'progress.readApi': 'Reading complete conversation data',
    'progress.apiFallback': 'Complete-data API unavailable; switching to page traversal',
    'progress.archiveImages': 'Archiving images',
    'progress.preparePdf': 'Preparing printable PDF view…',
    'progress.generate': 'Generating export files…',
    'progress.index': 'Reading conversation index',
    'progress.scan': 'Scanning messages',
    'progress.loadOlder': 'Loading earlier messages',
    'progress.walk': 'Walking complete conversation',
    'pdf.confirm': 'A system print dialog will open next. 1) Choose “Save as PDF” / “Microsoft Print to PDF” as the destination. 2) Open More settings and disable “Headers and footers” so the conversation URL is not printed. Do not select a physical printer unless you intend to print on paper. Continue?',
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
    'error.printModule': 'PDF print renderer is not loaded.',
    'error.printFailed': 'Unable to open the system print dialog.',
    'md.exportedAt': 'Exported at',
    'md.source': 'Source',
    'md.messageCount': 'Messages',
    'md.range': 'Export range',
    'md.fullRange': 'Full export',
    'md.partialRange': 'Partial export (original messages {start}–{end} of {total})',
    'md.imageArchive': 'Conversation images',
    'md.imageNotArchived': 'Not included',
    'md.imageFailed': ' ({failed} failed)',
    'md.branch': 'Branch',
    'md.currentBranch': 'Current selected conversation branch',
    'md.toolDetails': 'Tool-call details',
    'md.modelMetadata': 'Response model and reasoning info',
    'md.selectedModel': 'Selected model',
    'md.resolvedModel': 'Resolved model',
    'md.thinkingEffort': 'Thinking effort',
    'md.included': 'Included',
    'md.excluded': 'Excluded',
    'md.attachments': 'Attachments:',
  };

  const OVERRIDES = {
    'zh-CN': {
      'menu.modelMetadata': '包含回复模型与推理信息',
      'menu.modelMetadataHint': '开启后导出每条 Assistant 回复的选择模型、命中模型和推理强度',
      'modelDetector.title': '对话模型检测器',
      'modelDetector.resolvedModel': '命中模型',
      'modelDetector.thinkingEffort': '推理强度',
      'modelDetector.loading': '检测中…',
      'modelDetector.unavailable': '不可用',
      'md.modelMetadata': '回复模型与推理信息',
      'md.selectedModel': '选择模型',
      'md.resolvedModel': '命中模型',
      'md.thinkingEffort': '推理强度',
      'export.button': '↓ 导出', 'export.busy': '扫描中…', 'menu.rangeTitle': '导出范围', 'menu.full': '全量导出', 'menu.partial': '部分导出',
      'menu.fullSummary': '导出当前分支的全部对话内容', 'menu.partialSummary': '范围：{start} → {end}', 'menu.partialFallback': '已选择范围',
      'menu.optionsTitle': '导出选项', 'menu.toolDetails': '包含 GPT 工具调用详情', 'menu.toolDetailsHint': '关闭后不导出工具调用参数与工具文本结果',
      'menu.images': '拉取对话图片', 'menu.imagesHint': 'Markdown 使用 MD + 图片资源包；PDF 会将图片嵌入打印文档', 'menu.languageTitle': '🌐 语言 / Language',
      'menu.hint': '部分导出可自由选择起始点和截止点，截止点默认最后一条消息；JSON 仅保存图片元数据', 'menu.zip': '导出 ZIP（Markdown + JSON）', 'menu.md': '导出 Markdown', 'menu.pdf': '导出 PDF', 'menu.json': '仅导出 JSON',
      'picker.title': '选择部分导出的消息范围', 'picker.close': '关闭', 'picker.loading': '正在读取完整对话…', 'picker.start': '起始点', 'picker.end': '截止点', 'picker.confirm': '使用此范围', 'picker.last': '最后一条消息', 'picker.choose': '请选择{boundary} · 共 {count} 条消息', 'picker.failed': '无法读取起始点：{message}',
      'toast.running': '已有导出任务正在执行。', 'toast.failed': '导出失败：{message}', 'toast.complete': '导出完成：{count} 条消息（User {user} / Assistant {assistant}） · {scope}{source}{images}', 'toast.printOpened': '系统打印窗口已打开。请选择“另存为 PDF / Save as PDF”，并保持“页眉和页脚”关闭。',
      'scope.full': '全量导出', 'scope.partial': '部分导出', 'source.api': ' · API 完整读取', 'source.dom': ' · DOM 兼容模式', 'images.summary': '；图片 {archived}/{total}', 'images.failed': '，失败 {failed}',
      'progress.readApi': '读取完整对话数据', 'progress.apiFallback': '完整数据接口不可用，切换页面遍历', 'progress.archiveImages': '归档图片', 'progress.preparePdf': '准备 PDF 打印视图…', 'progress.generate': '生成导出文件…', 'progress.index': '读取对话索引', 'progress.scan': '扫描消息', 'progress.loadOlder': '加载较早消息', 'progress.walk': '遍历完整对话',
      'pdf.confirm': '下一步将打开系统打印窗口。1）在“打印机/目标”中选择“另存为 PDF / Save as PDF”或“Microsoft Print to PDF”；2）展开“更多设置”，关闭“页眉和页脚”，避免在 PDF 底部打印当前对话 URL。除非你确实要打印纸张，否则不要选择实体打印机。是否继续？',
      'error.traversalModule': '对话遍历模块未加载。', 'error.incompleteIndex': '对话索引共 {total} 条，但仍有 {missing} 条未能加载。为避免导出不完整，本次已停止。', 'error.noScroller': '找不到 ChatGPT 对话滚动容器。', 'error.noMessages': '没有识别到当前页面中的 ChatGPT 对话消息。请确认已打开具体对话。', 'error.imageTooLarge': '图片超过 20MB 限制。', 'error.imageDownload': '图片下载失败。', 'error.imageModule': '图片归档模块未加载。', 'error.imageUrl': '无法解析图片下载地址。', 'error.rangeChanged': '当前对话已发生变化，请重新选择部分导出的起始点。', 'error.rangeModule': '导出范围模块未加载。', 'error.noUserStart': '当前对话没有可作为起始点的 User 消息。', 'error.zipModule': 'ZIP 模块未加载。', 'error.printModule': 'PDF 打印渲染模块未加载。', 'error.printFailed': '无法打开系统打印窗口。',
      'md.exportedAt': '导出时间', 'md.source': '来源', 'md.messageCount': '消息数量', 'md.range': '导出范围', 'md.fullRange': '全量导出', 'md.partialRange': '部分导出（原对话第 {start}–{end} 条消息，共 {total} 条）', 'md.imageArchive': '对话图片', 'md.imageNotArchived': '不包含', 'md.imageFailed': '（失败 {failed}）', 'md.branch': '分支', 'md.currentBranch': '当前页面所选对话分支', 'md.toolDetails': '工具调用详情', 'md.included': '包含', 'md.excluded': '不包含', 'md.attachments': '附件：',
    },
    ja: {
      'menu.modelMetadata': '返信モデルと推論情報を含める',
      'menu.modelMetadataHint': '各 Assistant 返信の選択モデル、実際のモデル、推論強度をエクスポートします',
      'modelDetector.title': '会話モデル検出',
      'modelDetector.resolvedModel': '実際のモデル',
      'modelDetector.thinkingEffort': '推論強度',
      'modelDetector.loading': '検出中…',
      'modelDetector.unavailable': '利用不可',
      'md.modelMetadata': '返信モデルと推論情報',
      'md.selectedModel': '選択モデル',
      'md.resolvedModel': '実際のモデル',
      'md.thinkingEffort': '推論強度',
      'export.button': '↓ エクスポート', 'export.busy': 'スキャン中…', 'menu.rangeTitle': 'エクスポート範囲', 'menu.full': '全体をエクスポート', 'menu.partial': '一部をエクスポート', 'menu.fullSummary': '現在の会話ブランチ全体をエクスポート', 'menu.partialSummary': '範囲：{start} → {end}', 'menu.optionsTitle': 'エクスポート設定', 'menu.toolDetails': 'GPT ツール呼び出し詳細を含める', 'menu.toolDetailsHint': 'オフの場合、ツール引数とテキスト結果を除外します', 'menu.images': '会話内の画像を取得', 'menu.imagesHint': 'Markdown は MD + 画像パッケージ、PDF は画像を印刷文書に埋め込みます', 'menu.languageTitle': '🌐 语言 / Language', 'menu.zip': 'ZIP をエクスポート（Markdown + JSON）', 'menu.md': 'Markdown をエクスポート', 'menu.pdf': 'PDF をエクスポート', 'menu.json': 'JSON のみ', 'picker.title': '部分エクスポートの範囲を選択', 'picker.close': '閉じる', 'picker.loading': '会話全体を読み込み中…', 'picker.start': '開始位置', 'picker.end': '終了位置', 'picker.confirm': 'この範囲を使用', 'picker.last': '最後のメッセージ', 'picker.choose': '{boundary}を選択 · {count} 件', 'toast.running': 'エクスポート処理が実行中です。', 'toast.failed': 'エクスポート失敗：{message}', 'scope.full': '全体', 'scope.partial': '一部', 'progress.archiveImages': '画像を保存中', 'progress.preparePdf': 'PDF 印刷表示を準備中…', 'progress.generate': 'エクスポートファイルを生成中…', 'pdf.confirm': '次にシステムの印刷ダイアログが開きます。PDF に保存する場合は、出力先として「PDF に保存 / Save as PDF」を選択してください。紙に印刷する意図がない場合は実プリンターを選択しないでください。続行しますか？', 'menu.hint': '部分エクスポートは開始位置と終了位置を選択でき、終了位置の既定値は最後のメッセージです。JSON は画像メタデータのみ保持します', 'picker.failed': '開始位置を読み込めません：{message}', 'toast.complete': 'エクスポート完了：{count} 件（User {user} / Assistant {assistant}） · {scope}{source}{images}', 'toast.printOpened': 'システムの印刷ダイアログを開きました。「PDF に保存 / Save as PDF」を選択して PDF エクスポートを完了してください。', 'progress.readApi': '会話データ全体を読み込み中', 'progress.walk': '会話全体を走査中', 'error.printFailed': 'システムの印刷ダイアログを開けませんでした。',
    },
    ko: {
      'menu.modelMetadata': '응답 모델 및 추론 정보 포함',
      'menu.modelMetadataHint': '각 Assistant 응답의 선택 모델, 실제 모델 및 추론 강도를 내보냅니다',
      'modelDetector.title': '대화 모델 감지기',
      'modelDetector.resolvedModel': '실제 모델',
      'modelDetector.thinkingEffort': '추론 강도',
      'modelDetector.loading': '감지 중…',
      'modelDetector.unavailable': '사용 불가',
      'md.modelMetadata': '응답 모델 및 추론 정보',
      'md.selectedModel': '선택 모델',
      'md.resolvedModel': '실제 모델',
      'md.thinkingEffort': '추론 강도',
      'export.button': '↓ 내보내기', 'export.busy': '스캔 중…', 'menu.rangeTitle': '내보내기 범위', 'menu.full': '전체 내보내기', 'menu.partial': '부분 내보내기', 'menu.fullSummary': '현재 대화 분기 전체를 내보냅니다', 'menu.partialSummary': '범위: {start} → {end}', 'menu.optionsTitle': '내보내기 옵션', 'menu.toolDetails': 'GPT 도구 호출 세부 정보 포함', 'menu.toolDetailsHint': '끄면 도구 인수와 텍스트 결과를 제외합니다', 'menu.images': '대화 이미지 가져오기', 'menu.imagesHint': 'Markdown은 MD + 이미지 패키지, PDF는 이미지를 인쇄 문서에 포함합니다', 'menu.languageTitle': '🌐 语言 / Language', 'menu.zip': 'ZIP 내보내기 (Markdown + JSON)', 'menu.md': 'Markdown 내보내기', 'menu.pdf': 'PDF 내보내기', 'menu.json': 'JSON만 내보내기', 'picker.title': '부분 내보내기 범위 선택', 'picker.close': '닫기', 'picker.loading': '전체 대화 불러오는 중…', 'picker.start': '시작점', 'picker.end': '종료점', 'picker.confirm': '이 범위 사용', 'picker.last': '마지막 메시지', 'picker.choose': '{boundary} 선택 · {count}개 메시지', 'toast.running': '내보내기가 이미 실행 중입니다.', 'toast.failed': '내보내기 실패: {message}', 'scope.full': '전체 내보내기', 'scope.partial': '부분 내보내기', 'progress.archiveImages': '이미지 저장 중', 'progress.preparePdf': 'PDF 인쇄 보기 준비 중…', 'progress.generate': '내보내기 파일 생성 중…', 'pdf.confirm': '다음 단계에서 시스템 인쇄 창이 열립니다. PDF로 저장하려면 대상에서 “PDF로 저장 / Save as PDF”를 선택하세요. 종이 인쇄가 목적이 아니라면 실제 프린터를 선택하지 마세요. 계속하시겠습니까?', 'menu.hint': '부분 내보내기는 시작점과 종료점을 선택할 수 있으며 종료점 기본값은 마지막 메시지입니다. JSON은 이미지 메타데이터만 유지합니다', 'picker.failed': '시작 지점을 불러올 수 없습니다: {message}', 'toast.complete': '내보내기 완료: {count}개 메시지 (User {user} / Assistant {assistant}) · {scope}{source}{images}', 'toast.printOpened': '시스템 인쇄 창이 열렸습니다. PDF 내보내기를 완료하려면 “PDF로 저장 / Save as PDF”를 선택하세요.', 'progress.readApi': '전체 대화 데이터 읽는 중', 'progress.walk': '전체 대화 순회 중', 'error.printFailed': '시스템 인쇄 창을 열 수 없습니다.',
    },
    de: {
      'menu.modelMetadata': 'Antwortmodell und Denkaufwand einschließen',
      'menu.modelMetadataHint': 'Exportiert ausgewähltes Modell, tatsächlich verwendetes Modell und Denkaufwand jeder Assistant-Antwort',
      'modelDetector.title': 'Konversationsmodell-Erkennung',
      'modelDetector.resolvedModel': 'Verwendetes Modell',
      'modelDetector.thinkingEffort': 'Denkaufwand',
      'modelDetector.loading': 'Erkennung…',
      'modelDetector.unavailable': 'Nicht verfügbar',
      'md.modelMetadata': 'Antwortmodell und Denkaufwand',
      'md.selectedModel': 'Ausgewähltes Modell',
      'md.resolvedModel': 'Verwendetes Modell',
      'md.thinkingEffort': 'Denkaufwand',
      'export.button': '↓ Exportieren', 'export.busy': 'Wird gescannt…', 'menu.rangeTitle': 'Exportbereich', 'menu.full': 'Vollständig', 'menu.partial': 'Teilweise', 'menu.fullSummary': 'Den gesamten aktiven Gesprächszweig exportieren', 'menu.partialSummary': 'Bereich: {start} → {end}', 'menu.optionsTitle': 'Exportoptionen', 'menu.toolDetails': 'GPT-Toolaufrufe einschließen', 'menu.toolDetailsHint': 'Wenn deaktiviert, werden Tool-Argumente und Textausgaben ausgelassen', 'menu.images': 'Bilder aus dem Gespräch abrufen', 'menu.imagesHint': 'Markdown nutzt ein MD- + Bilderpaket; PDF bettet Bilder in das Druckdokument ein', 'menu.languageTitle': '🌐 语言 / Language', 'menu.zip': 'ZIP exportieren (Markdown + JSON)', 'menu.md': 'Markdown exportieren', 'menu.pdf': 'PDF exportieren', 'menu.json': 'Nur JSON exportieren', 'picker.title': 'Bereich für Teilexport wählen', 'picker.close': 'Schließen', 'picker.loading': 'Vollständiges Gespräch wird geladen…', 'picker.start': 'Start', 'picker.end': 'Ende', 'picker.confirm': 'Diesen Bereich verwenden', 'picker.last': 'Letzte Nachricht', 'picker.choose': '{boundary} wählen · {count} Nachrichten', 'toast.running': 'Ein Export läuft bereits.', 'toast.failed': 'Export fehlgeschlagen: {message}', 'scope.full': 'Vollständig', 'scope.partial': 'Teilweise', 'progress.archiveImages': 'Bilder werden archiviert', 'progress.preparePdf': 'PDF-Druckansicht wird vorbereitet…', 'progress.generate': 'Exportdateien werden erstellt…', 'pdf.confirm': 'Als Nächstes öffnet sich der System-Druckdialog. Für einen PDF-Export wählen Sie als Ziel „Als PDF speichern / Save as PDF“. Wählen Sie keinen physischen Drucker, sofern Sie nicht wirklich auf Papier drucken möchten. Fortfahren?', 'menu.hint': 'Beim Teilexport können Start und Ende gewählt werden; das Ende ist standardmäßig die letzte Nachricht. JSON speichert nur Bildmetadaten', 'picker.failed': 'Startpunkte konnten nicht geladen werden: {message}', 'toast.complete': 'Export abgeschlossen: {count} Nachrichten (User {user} / Assistant {assistant}) · {scope}{source}{images}', 'toast.printOpened': 'Der System-Druckdialog ist geöffnet. Wählen Sie „Als PDF speichern / Save as PDF“, um den PDF-Export abzuschließen.', 'progress.readApi': 'Vollständige Gesprächsdaten werden gelesen', 'progress.walk': 'Vollständiges Gespräch wird durchlaufen', 'error.printFailed': 'Der System-Druckdialog konnte nicht geöffnet werden.',
    },
    es: {
      'menu.modelMetadata': 'Incluir modelo y nivel de razonamiento',
      'menu.modelMetadataHint': 'Exporta el modelo seleccionado, el modelo resuelto y el nivel de razonamiento de cada respuesta del Assistant',
      'modelDetector.title': 'Detector de modelo de conversación',
      'modelDetector.resolvedModel': 'Modelo resuelto',
      'modelDetector.thinkingEffort': 'Nivel de razonamiento',
      'modelDetector.loading': 'Detectando…',
      'modelDetector.unavailable': 'No disponible',
      'md.modelMetadata': 'Modelo y razonamiento de respuesta',
      'md.selectedModel': 'Modelo seleccionado',
      'md.resolvedModel': 'Modelo resuelto',
      'md.thinkingEffort': 'Nivel de razonamiento',
      'export.button': '↓ Exportar', 'export.busy': 'Escaneando…', 'menu.rangeTitle': 'Rango de exportación', 'menu.full': 'Exportación completa', 'menu.partial': 'Exportación parcial', 'menu.fullSummary': 'Exportar toda la rama activa de la conversación', 'menu.partialSummary': 'Rango: {start} → {end}', 'menu.optionsTitle': 'Opciones de exportación', 'menu.toolDetails': 'Incluir detalles de llamadas a herramientas GPT', 'menu.toolDetailsHint': 'Al desactivarlo se omiten argumentos y resultados de texto de herramientas', 'menu.images': 'Incluir imágenes de la conversación', 'menu.imagesHint': 'Markdown usa un paquete MD + imágenes; PDF incrusta las imágenes en el documento de impresión', 'menu.languageTitle': '🌐 语言 / Language', 'menu.zip': 'Exportar ZIP (Markdown + JSON)', 'menu.md': 'Exportar Markdown', 'menu.pdf': 'Exportar PDF', 'menu.json': 'Exportar solo JSON', 'picker.title': 'Elegir rango de exportación parcial', 'picker.close': 'Cerrar', 'picker.loading': 'Cargando la conversación completa…', 'picker.start': 'Inicio', 'picker.end': 'Fin', 'picker.confirm': 'Usar este rango', 'picker.last': 'Último mensaje', 'picker.choose': 'Elige {boundary} · {count} mensajes', 'toast.running': 'Ya hay una exportación en curso.', 'toast.failed': 'Error de exportación: {message}', 'scope.full': 'Completa', 'scope.partial': 'Parcial', 'progress.archiveImages': 'Archivando imágenes', 'progress.preparePdf': 'Preparando la vista de impresión PDF…', 'progress.generate': 'Generando archivos…', 'pdf.confirm': 'A continuación se abrirá el cuadro de impresión del sistema. Para exportar a PDF, elige “Guardar como PDF / Save as PDF” como destino. No selecciones una impresora física salvo que quieras imprimir en papel. ¿Continuar?', 'menu.hint': 'La exportación parcial permite elegir inicio y fin; el fin predeterminado es el último mensaje. JSON conserva solo metadatos de imágenes', 'picker.failed': 'No se pudieron cargar los puntos de inicio: {message}', 'toast.complete': 'Exportación completada: {count} mensajes (User {user} / Assistant {assistant}) · {scope}{source}{images}', 'toast.printOpened': 'Se abrió el cuadro de impresión del sistema. Elige “Guardar como PDF / Save as PDF” para completar la exportación PDF.', 'progress.readApi': 'Leyendo los datos completos de la conversación', 'progress.walk': 'Recorriendo la conversación completa', 'error.printFailed': 'No se pudo abrir el cuadro de impresión del sistema.',
    },
    fr: {
      'menu.modelMetadata': 'Inclure le modèle et le niveau de raisonnement',
      'menu.modelMetadataHint': 'Exporte le modèle sélectionné, le modèle résolu et le niveau de raisonnement de chaque réponse Assistant',
      'modelDetector.title': 'Détecteur de modèle de conversation',
      'modelDetector.resolvedModel': 'Modèle résolu',
      'modelDetector.thinkingEffort': 'Niveau de raisonnement',
      'modelDetector.loading': 'Détection…',
      'modelDetector.unavailable': 'Indisponible',
      'md.modelMetadata': 'Modèle et raisonnement de réponse',
      'md.selectedModel': 'Modèle sélectionné',
      'md.resolvedModel': 'Modèle résolu',
      'md.thinkingEffort': 'Niveau de raisonnement',
      'export.button': '↓ Exporter', 'export.busy': 'Analyse…', 'menu.rangeTitle': 'Plage d’export', 'menu.full': 'Export complet', 'menu.partial': 'Export partiel', 'menu.fullSummary': 'Exporter toute la branche active de la conversation', 'menu.partialSummary': 'Plage : {start} → {end}', 'menu.optionsTitle': 'Options d’export', 'menu.toolDetails': 'Inclure les détails des appels d’outils GPT', 'menu.toolDetailsHint': 'Si désactivé, les arguments et résultats textuels des outils sont omis', 'menu.images': 'Inclure les images de la conversation', 'menu.imagesHint': 'Markdown utilise un paquet MD + images ; le PDF incorpore les images au document imprimé', 'menu.languageTitle': '🌐 语言 / Language', 'menu.zip': 'Exporter ZIP (Markdown + JSON)', 'menu.md': 'Exporter Markdown', 'menu.pdf': 'Exporter PDF', 'menu.json': 'Exporter JSON uniquement', 'picker.title': 'Choisir la plage de l’export partiel', 'picker.close': 'Fermer', 'picker.loading': 'Chargement de la conversation complète…', 'picker.start': 'Début', 'picker.end': 'Fin', 'picker.confirm': 'Utiliser cette plage', 'picker.last': 'Dernier message', 'picker.choose': 'Choisissez {boundary} · {count} messages', 'toast.running': 'Un export est déjà en cours.', 'toast.failed': 'Échec de l’export : {message}', 'scope.full': 'Complet', 'scope.partial': 'Partiel', 'progress.archiveImages': 'Archivage des images', 'progress.preparePdf': 'Préparation de la vue d’impression PDF…', 'progress.generate': 'Génération des fichiers…', 'pdf.confirm': 'La boîte de dialogue d’impression du système va s’ouvrir. Pour exporter en PDF, choisissez « Enregistrer au format PDF / Save as PDF » comme destination. Ne choisissez pas une imprimante physique sauf si vous souhaitez réellement imprimer sur papier. Continuer ?', 'menu.hint': 'L’export partiel permet de choisir le début et la fin ; la fin par défaut est le dernier message. JSON conserve uniquement les métadonnées des images', 'picker.failed': 'Impossible de charger les points de départ : {message}', 'toast.complete': 'Export terminé : {count} messages (User {user} / Assistant {assistant}) · {scope}{source}{images}', 'toast.printOpened': 'La boîte de dialogue d’impression est ouverte. Choisissez « Enregistrer au format PDF / Save as PDF » pour terminer l’export PDF.', 'progress.readApi': 'Lecture des données complètes de la conversation', 'progress.walk': 'Parcours de la conversation complète', 'error.printFailed': 'Impossible d’ouvrir la boîte de dialogue d’impression.',
    },
    ru: {
      'menu.modelMetadata': 'Включать модель ответа и уровень рассуждения',
      'menu.modelMetadataHint': 'Экспортирует выбранную модель, фактически использованную модель и уровень рассуждения каждого ответа Assistant',
      'modelDetector.title': 'Определение модели диалога',
      'modelDetector.resolvedModel': 'Фактическая модель',
      'modelDetector.thinkingEffort': 'Уровень рассуждения',
      'modelDetector.loading': 'Определение…',
      'modelDetector.unavailable': 'Недоступно',
      'md.modelMetadata': 'Модель и рассуждение ответа',
      'md.selectedModel': 'Выбранная модель',
      'md.resolvedModel': 'Фактическая модель',
      'md.thinkingEffort': 'Уровень рассуждения',
      'export.button': '↓ Экспорт', 'export.busy': 'Сканирование…', 'menu.rangeTitle': 'Диапазон экспорта', 'menu.full': 'Полный экспорт', 'menu.partial': 'Частичный экспорт', 'menu.fullSummary': 'Экспортировать всю активную ветку диалога', 'menu.partialSummary': 'Диапазон: {start} → {end}', 'menu.optionsTitle': 'Параметры экспорта', 'menu.toolDetails': 'Включить детали вызовов инструментов GPT', 'menu.toolDetailsHint': 'Если выключено, аргументы и текстовые результаты инструментов исключаются', 'menu.images': 'Включить изображения диалога', 'menu.imagesHint': 'Markdown использует пакет MD + изображения; PDF встраивает изображения в документ печати', 'menu.languageTitle': '🌐 语言 / Language', 'menu.zip': 'Экспорт ZIP (Markdown + JSON)', 'menu.md': 'Экспорт Markdown', 'menu.pdf': 'Экспорт PDF', 'menu.json': 'Только JSON', 'picker.title': 'Выберите диапазон частичного экспорта', 'picker.close': 'Закрыть', 'picker.loading': 'Загрузка полного диалога…', 'picker.start': 'Начало', 'picker.end': 'Конец', 'picker.confirm': 'Использовать диапазон', 'picker.last': 'Последнее сообщение', 'picker.choose': 'Выберите {boundary} · сообщений: {count}', 'toast.running': 'Экспорт уже выполняется.', 'toast.failed': 'Ошибка экспорта: {message}', 'scope.full': 'Полный', 'scope.partial': 'Частичный', 'progress.archiveImages': 'Сохранение изображений', 'progress.preparePdf': 'Подготовка представления для печати PDF…', 'progress.generate': 'Создание файлов…', 'pdf.confirm': 'Сейчас откроется системное окно печати. Для экспорта PDF выберите «Сохранить как PDF / Save as PDF» в качестве назначения. Не выбирайте физический принтер, если не хотите печатать на бумаге. Продолжить?', 'menu.hint': 'В частичном экспорте можно выбрать начало и конец; по умолчанию конец — последнее сообщение. JSON сохраняет только метаданные изображений', 'picker.failed': 'Не удалось загрузить начальные точки: {message}', 'toast.complete': 'Экспорт завершён: {count} сообщений (User {user} / Assistant {assistant}) · {scope}{source}{images}', 'toast.printOpened': 'Системное окно печати открыто. Выберите «Сохранить как PDF / Save as PDF», чтобы завершить экспорт PDF.', 'progress.readApi': 'Чтение полных данных диалога', 'progress.walk': 'Обход полного диалога', 'error.printFailed': 'Не удалось открыть системное окно печати.',
    },
    uk: {
      'menu.modelMetadata': 'Включати модель відповіді та рівень міркування',
      'menu.modelMetadataHint': 'Експортує вибрану модель, фактично використану модель та рівень міркування кожної відповіді Assistant',
      'modelDetector.title': 'Визначення моделі розмови',
      'modelDetector.resolvedModel': 'Фактична модель',
      'modelDetector.thinkingEffort': 'Рівень міркування',
      'modelDetector.loading': 'Визначення…',
      'modelDetector.unavailable': 'Недоступно',
      'md.modelMetadata': 'Модель і міркування відповіді',
      'md.selectedModel': 'Вибрана модель',
      'md.resolvedModel': 'Фактична модель',
      'md.thinkingEffort': 'Рівень міркування',
      'export.button': '↓ Експорт', 'export.busy': 'Сканування…', 'menu.rangeTitle': 'Діапазон експорту', 'menu.full': 'Повний експорт', 'menu.partial': 'Частковий експорт', 'menu.fullSummary': 'Експортувати всю активну гілку розмови', 'menu.partialSummary': 'Діапазон: {start} → {end}', 'menu.optionsTitle': 'Параметри експорту', 'menu.toolDetails': 'Включити деталі викликів інструментів GPT', 'menu.toolDetailsHint': 'Якщо вимкнено, аргументи та текстові результати інструментів не експортуються', 'menu.images': 'Включити зображення розмови', 'menu.imagesHint': 'Markdown використовує пакет MD + зображення; PDF вбудовує зображення в документ друку', 'menu.languageTitle': '🌐 语言 / Language', 'menu.zip': 'Експорт ZIP (Markdown + JSON)', 'menu.md': 'Експорт Markdown', 'menu.pdf': 'Експорт PDF', 'menu.json': 'Лише JSON', 'picker.title': 'Виберіть діапазон часткового експорту', 'picker.close': 'Закрити', 'picker.loading': 'Завантаження повної розмови…', 'picker.start': 'Початок', 'picker.end': 'Кінець', 'picker.confirm': 'Використати діапазон', 'picker.last': 'Останнє повідомлення', 'picker.choose': 'Виберіть {boundary} · повідомлень: {count}', 'toast.running': 'Експорт уже виконується.', 'toast.failed': 'Помилка експорту: {message}', 'scope.full': 'Повний', 'scope.partial': 'Частковий', 'progress.archiveImages': 'Збереження зображень', 'progress.preparePdf': 'Підготовка подання для друку PDF…', 'progress.generate': 'Створення файлів…', 'pdf.confirm': 'Далі відкриється системне вікно друку. Для експорту PDF виберіть «Зберегти як PDF / Save as PDF» як призначення. Не вибирайте фізичний принтер, якщо не плануєте друк на папері. Продовжити?', 'menu.hint': 'У частковому експорті можна вибрати початок і кінець; за замовчуванням кінець — останнє повідомлення. JSON зберігає лише метадані зображень', 'picker.failed': 'Не вдалося завантажити початкові точки: {message}', 'toast.complete': 'Експорт завершено: {count} повідомлень (User {user} / Assistant {assistant}) · {scope}{source}{images}', 'toast.printOpened': 'Системне вікно друку відкрито. Виберіть «Зберегти як PDF / Save as PDF», щоб завершити експорт PDF.', 'progress.readApi': 'Читання повних даних розмови', 'progress.walk': 'Обхід повної розмови', 'error.printFailed': 'Не вдалося відкрити системне вікно друку.',
    },
  };

  const REFRESH_LABELS = Object.freeze({
    'zh-CN': '刷新对话列表',
    en: 'Refresh conversation list',
    ja: '会話リストを更新',
    ko: '대화 목록 새로고침',
    de: 'Konversationsliste aktualisieren',
    es: 'Actualizar lista de conversación',
    fr: 'Actualiser la liste de conversation',
    ru: 'Обновить список диалога',
    uk: 'Оновити список розмови',
  });

  const MESSAGES = Object.fromEntries(
    SUPPORTED_LOCALES.map((locale) => [locale, {
      ...EN,
      ...(OVERRIDES[locale] || {}),
      'picker.refresh': REFRESH_LABELS[locale] || EN['picker.refresh'],
    }]),
  );

  /** Normalize browser/persisted locale values to one supported extension locale. */
  function normalizeLocale(value) {
    const locale = String(value || '').trim().toLowerCase().replace('_', '-');
    if (locale.startsWith('zh')) return 'zh-CN';
    for (const supported of SUPPORTED_LOCALES) {
      if (supported === 'zh-CN') continue;
      if (locale === supported.toLowerCase() || locale.startsWith(`${supported.toLowerCase()}-`)) return supported;
    }
    return DEFAULT_LOCALE;
  }

  /** Translate one stable key and interpolate named placeholders. */
  function t(locale, key, variables = {}) {
    const normalized = normalizeLocale(locale);
    let text = MESSAGES[normalized]?.[key] ?? EN[key] ?? key;
    for (const [name, value] of Object.entries(variables || {})) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  }

  /** Load the selected UI locale. */
  async function loadLocale() {
    try {
      if (!chrome?.storage?.local?.get) return DEFAULT_LOCALE;
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return normalizeLocale(result?.[STORAGE_KEY] || DEFAULT_LOCALE);
    } catch {
      return DEFAULT_LOCALE;
    }
  }

  /** Persist and return a supported UI locale. */
  async function saveLocale(locale) {
    const normalized = normalizeLocale(locale);
    try {
      await chrome?.storage?.local?.set?.({ [STORAGE_KEY]: normalized });
    } catch {
      // Keep the in-memory locale even if persistence is unavailable.
    }
    return normalized;
  }

  ns.i18n = { DEFAULT_LOCALE, SUPPORTED_LOCALES, LOCALE_LABELS, normalizeLocale, t, loadLocale, saveLocale };
})();

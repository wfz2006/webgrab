# WebGrab

WebGrab 是一个 Chrome Manifest V3 扩展，用于按需发现和保存网页媒体资源，
并提供小说/长文本正文的按需提取能力。

P4-1 的“提取本章 / 提取全本”把结构化正文保存到扩展内部的
`webgrab_novels` IndexedDB；P4-2 可以把书库直接导出为 EPUB 3。图片资源可按
页面顺序打包为 CBZ、生成带自包含 `index.html` 的本地阅读文件夹，或同时生成两者。

## 可阅读成品

- 漫画：在资源列表选中图片，选择 `CBZ`、`文件夹 + index` 或`两者都要`，再点“打包漫画”。CBZ 页名固定为 `001.jpg`、`002.jpg` 等，优先采用 DOM 出现顺序。
- 小说：正文提取完成后点“导出 EPUB”。每章一个 XHTML，包含 EPUB 3 导航和兼容旧阅读器的 NCX 目录。
- 分页小说章节：全本提取按 URL 末尾 `_2`、`_3` 等结构识别同章物理分页，逐页礼貌延迟抓取并拼成一个章节；单章预览不额外联网，但会明确提示仍有分页未提取。
- 打包在 offscreen 中完成；fflate 的流式 Zip 输出直接写入 `FileSystemWritableFileStream`。内存只保留当前图片或当前章节，不先拼完整压缩包。
- 单项失败会被记录并跳过；只要至少有一个有效条目，仍会生成可打开的部分成品并在任务列表显示缺失数。

## 第三方软件

小说正文提取使用本地打包的 Mozilla Readability 0.6.0：

- Copyright (c) 2010 Arc90 Inc
- Apache License 2.0
- 官方来源：<https://github.com/mozilla/readability/tree/0.6.0>
- 完整声明与校验值见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
- 许可证副本见 `lib/readability.LICENSE.txt`

CBZ / EPUB ZIP 使用本地打包的 fflate 0.8.3（MIT）：

- 官方来源：<https://github.com/101arrowz/fflate>
- 固定文件：`lib/fflate.min.js`
- 完整声明、SHA-256 和许可证副本见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

扩展不从 CDN 或其他远程地址加载可执行代码。

## 已打开页面的自愈扫描

- 扩展首次安装或更新/重新加载时，Service Worker 会查询已经打开的匹配标签页，并按 `manifest.json` 原有的六组 content script 范围、world 和 frame 规则补注入；不增加权限，也不会把 B 站专用探针注入其他站点。
- DOM scanner 补装后会立刻扫描页面当前已有的 `img/video/audio/source` 等元素，因此大多数“必须刷新后列表才出现”的 DOM 资源可以直接恢复；单页或单组脚本注入失败不会阻断其他标签页。
- 正常导航仍由各 content script 的 `window.__webgrab*Installed` 守卫拦截同一文档内的重复初始化。安装/更新恢复流程会先在与脚本相同的 world/frame 范围清掉旧版本遗留的守卫，再注入当前版本；floating companion 还会先移除失效的旧宿主后重建，因此扩展重载后不会被陈旧标记拦住，也不会留下两个悬浮窗。
- 能力边界：MAIN world 的 hook/B站 probe 原本依赖 `document_start` 抢先埋点。迟到的自愈注入无法重放安装前已经结束的 fetch、媒体播放或脚本赋值，只能覆盖当下 DOM 和补注入之后的新事件；遇到必须依靠早期拦截的历史资源时，刷新页面仍然是完整重建捕获链的办法。

## 悬浮资源助手

- 当前页至少发现一个资源后，WebGrab 才会在顶层页面创建悬浮入口；空页面不显示，子 iframe 不重复注入。
- 角色壳使用 open Shadow DOM 隔离宿主 CSS。拖动基于 Pointer Events，过程只更新 `transform`，松手后吸附边缘；位置按站点保存，越界或缩窗后会自动修正。
- 点击角色会打开扩展页 `ui/panel.html`。面板在隔离 iframe 中直接复用完整 `popup.html`，资源、文本、B站和任务功能与工具栏 popup 使用同一套脚本。
- File System Access 选择器不能在悬浮窗的嵌套 iframe 中可靠调用。失败任务需要重新授权保存位置时，任务卡片会明确引导改用工具栏 popup 或侧边栏；顶层入口仍会正常弹出目录/文件选择器并提交重试。
- 页面全屏时自动隐藏；系统开启“减少动态效果”时雪碧图固定在首帧。设置页提供全局开关，角色右下角可一键“在本站不显示”，隐藏站点可在设置页恢复。
- 资源数量来自 `background/resource-store.js`，与 popup 列表和扩展 badge 是同一数据源；任务状态由统一 task upsert 发布为 scanning / downloading / done / error。
- 默认角色是 `assets/character/detective-girl/` 下的“蜜糖侦探”；根目录纯色占位角色仍保留并可在设置页切换。角色完全由 registry + `manifest.json` 描述，运行时代码没有硬编码图片名。详细约定见 `assets/character/README.md`。

## 资源控制台界面

- popup、悬浮面板和设置页使用同一 `system / dark / light` 主题偏好；默认跟随系统，可在设置页固定主题。
- popup 采用单青蓝强调色、语义状态色和中性色阶。字号、间距、圆角、颜色和动效均由 CSS custom properties 管理，正文与次要信息在暗/亮主题下均通过 4.5:1 对比度门禁。
- 图片资源在接近列表视口时才由 `IntersectionObserver` 加载缩略图；加载失败会删除破图并回退到本地类型图标。资源行同时展示文件名、格式、大小、尺寸和发现来源。
- 批量操作条只在选中资源后出现，可一键清除选择。失败任务保留“重试”，错误原因默认折叠并通过可键盘操作的按钮展开。
- 列表使用轻量边框和背景差，不使用渐变、滤镜、玻璃拟态或 UI 框架；长列表采用固定行高虚拟滚动，定时资源轮询会复用同一个外层 sizer，不会重置用户的滚动位置。只有资源字段确实变化时才重新渲染当前窗口。

# WebGrab 项目转接档案

> **目标读者**：接手维护的 Codex / AI 代理 / 工程师
> **版本快照**：v0.1.0（开发中，未上商店）
> **最后更新**：2026-08-03（补录 08-02~08-03 五轮工作，此前文档曾停留在 08-02 早期条目，落后当时实际代码进度）
> **项目路径**：`d:\workc\web\webgrab\`

---

## 0. 一分钟速览

WebGrab 是一个 **Chrome MV3 扩展**，作用是嗅探网页上的图片/视频/音频资源并提供下载，对**哔哩哔哩**做了深度适配（音视频分离流、番剧、互动视频识别）。架构特征：

- **三层嗅探**：网络层（webRequest）+ DOM 层（scanner）+ Hook 层（拦截 MediaSource/fetch）
- **三条下载路径**：
  1. 小文件 / 未知大小 → `chrome.downloads.download()`（含防盗链 403 自动 DNR 重试）
  2. 大文件 / 有 fileHandle → offscreen + fetch + FileSystemWritableStream 流式写盘
  3. B 站专属 → offscreen + mp4box.js 多轨 fMP4 重封装
- **ffmpeg.wasm 兜底**：本地打包（非 CDN），处理 AES-128 HLS / TS 转 MP4 / mp4box 处理不了的编码
- **DNR 规则池**：1000-1999 段，session rules，按 taskId 申请/回收，用于注入 Referer/Origin 绕过防盗链

---

## 1. 项目结构

```
webgrab/
├── manifest.json              # MV3 配置（含 CSP/COEP/COOP 声明）
├── background/                # Service Worker 层
│   ├── sw.js                  # 入口：事件注册 + 消息路由
│   ├── sniffer-network.js     # webRequest 网络嗅探
│   ├── resource-store.js      # 资源登记表（chrome.storage.session 持久化）
│   ├── download-manager.js    # 下载任务编排（含 DNR 重试逻辑）
│   ├── dnr-manager.js         # DNR 规则池管理（1000-1999）
│   └── adapter-router.js      # 适配器路由（按 URL 匹配）
├── content/                   # Content Script 层
│   ├── bilibili-probe.js      # B 站页面数据嗅探（__playinfo__ 拦截）
│   ├── bridge.js              # ISOLATED 世界桥接
│   └── scanner.js             # DOM 资源扫描
├── injected/                  # MAIN 世界注入脚本
│   └── hook.js                # MediaSource / fetch / XHR hook
├── offscreen/                 # Offscreen Document 层（长时下载执行环境）
│   ├── downloader.html        # 入口页面
│   ├── queue.js               # 下载任务队列 + 编排
│   ├── http-fetcher.js        # HTTP 流式 fetcher（Range 分块）
│   ├── segment-fetcher.js     # HLS/DASH 分片拉取（滑动窗口）
│   ├── hls-parser.js          # m3u8 解析
│   ├── dash-parser.js         # mpd 解析
│   ├── remuxer.js             # fMP4 重封装（mp4box.js，含 GOP-aware 批处理）
│   ├── ffmpeg-fallback.js     # ffmpeg.wasm 兜底（本地加载）
│   ├── writer.js              # FileSystemWritableStream 写入器
│   └── verify-remux.js        # 调试用：remux 结果校验
├── adapters/                  # 站点适配器
│   ├── base.js                # 抽象基类 SiteAdapter
│   ├── generic.js             # 兜底适配器（含防盗链 Referer 注入）
│   └── bilibili.js            # B 站专属适配器
├── lib/                       # 第三方库 + 工具
│   ├── ffmpeg/                # ffmpeg.wasm 核心文件（本地打包，~25MB）
│   │   ├── index.js           # ESM 入口
│   │   ├── classes.js         # FFmpeg 类
│   │   ├── const.js           # 常量（CORE_URL 已改本地）
│   │   ├── worker.js          # ffmpeg worker
│   │   ├── ffmpeg-core.js     # 核心编译产物
│   │   └── ffmpeg-core.wasm   # WASM 二进制
│   ├── mp4box.all.min.js      # mp4box.js（fMP4 demux/mux）
│   ├── m3u8-parser.min.js     # m3u8 解析
│   ├── mpd-parser.min.js      # mpd 解析
│   ├── filename.js            # 文件名构建
│   └── handle-store.js        # IndexedDB FileSystemFileHandle 存储
├── ui/                        # Popup UI
│   ├── popup.html
│   ├── popup.css
│   ├── popup.js               # UI 逻辑 + B 站专属面板
│   └── tasks.js               # 任务列表展示
└── icons/                     # 扩展图标
```

---

## 2. 核心架构

### 2.1 三层嗅探流程

```
页面加载
  │
  ├─ MAIN 世界 hook.js (document_start)
  │    └─ 拦截 MediaSource.addSourceBuffer / fetch / XHR
  │       捕获 blob URL 和流媒体请求
  │       postMessage → bridge.js
  │
  ├─ ISOLATED 世界 bridge.js (document_start)
  │    └─ 接收 MAIN 世界消息，转发给 SW
  │
  ├─ ISOLATED 世界 scanner.js (document_idle)
  │    └─ 扫描 DOM 中的 <img>/<video>/<audio>/<source>
  │
  └─ SW sniffer-network.js
       └─ webRequest.onBeforeRequest 监听所有网络请求
            按扩展名/MIME 分类为 image/video/audio/stream
            写入 resource-store（chrome.storage.session）
            updateBadge 更新扩展图标数字
```

**资源分类**（`ResourceKind`）：
- `image` / `video` / `audio` / `subtitle` / `stream`
- `stream` 特指 MediaSource blob URL（hook 层捕获）
- **重要**：UI 中"视频"筛选 tab 和计数器都包含 `kind === 'video' || kind === 'stream'`，两者必须一致

### 2.2 三条下载路径

决策点在 [download-manager.js:173](file:///d:/workc/web/webgrab/background/download-manager.js#L173) `startDownload`：

```
START_DOWNLOAD 消息
  │
  ├─ 无 fileHandle + 小文件（<50MB 或未知大小）
  │    └─ chrome.downloads.download() 直接下载
  │         ├─ 成功 → 任务 done
  │         └─ interrupted + SERVER_FORBIDDEN
  │              └─ adapter.requiredHeaders(url, pageUrl) 拿 Referer
  │                 acquire 临时 DNR（resourceTypes 含 main_frame）
  │                 清理失败下载项 → 重试 chrome.downloads.download()
  │                 终态后 release DNR
  │
  ├─ 有 fileHandle / 大文件 / 流媒体
  │    └─ offscreen 路径
  │         ├─ acquire DNR（xmlhttprequest，预注入 Referer）
  │         ├─ ensureOffscreen()
  │         ├─ EXECUTE_TASK → offscreen queue.js
  │         └─ offscreen 内部：
  │              ├─ 单图片/文件 → HttpFetcher 流式 fetch → FileWriter
  │              ├─ HLS → hls-parser + SegmentFetcher + remuxer
  │              ├─ DASH → dash-parser + SegmentFetcher + remuxer
  │              └─ ffmpeg 兜底 → ffmpeg-fallback.js
  │
  └─ B 站专属（streamMeta.kind === 'bilibili'）
       └─ executeBilibiliWithHandle
            ├─ 并发下载 video + audio 两条 m4s 流
            ├─ mp4box.js 多轨 fMP4 重封装（GOP-aware 批处理）
            └─ 输出 MP4（或 audioOnly 时输出 m4a）
```

### 2.3 DNR 规则管理

[dnr-manager.js](file:///d:/workc/web/webgrab/background/dnr-manager.js)

- **规则 ID 池**：1000-1999（session rules）
- **`acquire(taskId, { domains, headers, resourceTypes? })`**
  - 默认 `resourceTypes: ['xmlhttprequest']`（offscreen fetch）
  - 重试场景传 `['main_frame', 'xmlhttprequest', 'other']`（覆盖 chrome.downloads）
- **`release(taskId)`**：回收规则，从 map 和池中删除
- **`cleanupAll()`**：SW 启动时清空遗留规则
- **`taskRuleMap`**：taskId → ruleId 映射（内存，SW 重启丢失，靠 cleanupAll 兜底）

### 2.4 适配器模式

[adapters/base.js](file:///d:/workc/web/webgrab/adapters/base.js) 定义 `SiteAdapter` 抽象类：

```js
requiredHeaders(url, pageUrl)  // 返回 {Referer, Origin, ...} 供 DNR 注入
static match(url)              // 是否接管此页面
async extract(tabId, pageUrl)  // 提取媒体信息
buildFileName(meta, variant)   // 文件名构建
```

[adapter-router.js](file:///d:/workc/web/webgrab/background/adapter-router.js) 按顺序匹配，**BilibiliAdapter 优先于 GenericAdapter**。

- **BilibiliAdapter**：忽略 pageUrl，返回固定 `https://www.bilibili.com` Referer/Origin
- **GenericAdapter**：返回 `{Referer: pageUrl, Origin: <origin-of-pageUrl>}`，仅在 pageUrl 为 http(s) 时非空

---

## 3. 硬约束（不可违反）

> 这些是踩过坑总结的铁律，违反会导致下载失败、解码错误、审核被拒等。

### MV3 政策类
1. **ffmpeg.wasm 必须本地加载**：`lib/ffmpeg/` 目录已打包，通过 `chrome.runtime.getURL` 访问，**绝不允许**从 CDN（jsdelivr/unpkg）加载，违反 MV3 远程代码政策会被商店拒审
2. **CSP 必须显式声明 `wasm-unsafe-eval`**：manifest.json 中 `content_security_policy.extension_pages` 已配置，Chrome 151+ 默认 CSP 不会可靠继承到 Worker 上下文
3. **不构造 wbi 签名、不调用未授权页面接口**：B 站适配器只用 `window.__playinfo__`（页面注入数据）和网络嗅探，不调 playurl API

### 下载/写盘类
4. **下载与写盘必须真流式**：HttpFetcher 收到 chunk 立即通过 onChunk 传给 FileWriter，不能累积在内存（2GB+ 文件会爆内存）
5. **showSaveFilePicker 必须在用户点击同步上下文调用**：await 之后用户手势会过期，报 "Must be handling a user gesture"
6. **FileSystemFileHandle 通过 IndexedDB 传递**：`chrome.runtime.sendMessage` 是 JSON 序列化，会丢失原型方法；用 `lib/handle-store.js` 的 putHandle/getHandle
7. **ByteRange 请求信任服务器响应**：不要在客户端二次切片，会导致数据损坏

### fMP4 重封装类
8. **box 边界对齐**：网络分块可能截断 box 头，必须缓冲完整 box 再喂给 mp4box.js
9. **Track.first_dts 必须显式设置**：处理第一批 samples 前设置，防止时间基跳变
10. **Sample 数据必须浅拷贝**：`releaseUsedSamples` 会置空 sample.data，批处理时需浅拷贝
11. **视频批处理用 GOP-aware 切分**：遇 keyframe (is_sync=true) 且 batch ≥240 时 flush，确保片段以关键帧开头；音频用固定 240；MAX_BATCH_SIZE=960 兜底
12. **多轨 fMP4 用四字符 codec 标识**：mp4box.js addTrack 的 type 参数用 `avc1`/`mp4a` 等

### B 站特定
13. **CDN 请求 Referer/Origin 必须为 bilibili.com**：通过 DNR 注入
14. **DNR 规则作用域**：bilivideo.com / bilivideo.cn / akamaized.net，任务结束回收
15. **互动视频识别**：`window.__INITIAL_STATE__.videoData.rights.is_stein_gate === 1` 显示"暂不支持"并隐藏下载选项
16. **番剧页元数据来源**：`__INITIAL_STATE__` 已被移除，用 `__PLAYURL_HYBRATE_DATA__` + `__NEXT_DATA__`

### UI 一致性
17. **"视频"筛选和计数器必须用同一套分类**：两者都包含 `kind === 'video' || kind === 'stream'`

---

## 4. 近期变更（P3 阶段补丁十六~十八续）

### 补丁·十六续（ffmpeg.wasm 本地化）
- **问题**：ffmpeg.wasm 从 CDN 动态加载，违反 MV3 远程代码政策，AES-128 HLS 场景 100% 失败
- **修复**：
  - `lib/ffmpeg/` 目录打包所有核心文件（~25MB）
  - [ffmpeg-fallback.js](file:///d:/workc/web/webgrab/offscreen/ffmpeg-fallback.js) 用 `chrome.runtime.getURL` 加载
  - [const.js](file:///d:/workc/web/webgrab/lib/ffmpeg/const.js) 的 `CORE_URL` 改为 `new URL('./ffmpeg-core.js', import.meta.url).href`
  - manifest.json 的 `web_accessible_resources` 加入 `lib/ffmpeg/*`

### 补丁·十六续（视频筛选与计数器一致性）
- **问题**：hook 来源的 MediaSource blob URL 分类为 `kind='stream'`，计数器算进视频，但筛选只匹配 `kind === 'video'`，导致"计数器非零但列表为空"
- **修复**：[popup.js](file:///d:/workc/web/webgrab/ui/popup.js) 的 `getFilteredResources` 为 `activeKind === 'video'` 添加专门分支，筛选条件 `kind === 'video' || kind === 'stream'`

### 补丁·十七续（CSP 显式声明）
- **问题**：ffmpeg.wasm WASM 实例化被 CSP 拦截，Chrome 151 默认 CSP 未可靠继承到 Worker 上下文
- **修复**：manifest.json 显式声明 `content_security_policy.extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"`

### 补丁·十八续（dm5.com 防盗链通用重试）
- **问题**：dm5.com 图片下载报 SERVER_FORBIDDEN，CDN 防盗链要求 Referer，扩展 SW 上下文没有页面 origin
- **修复**：
  - `SiteAdapter.requiredHeaders` 签名扩展为 `(url, pageUrl)`
  - `GenericAdapter.requiredHeaders` 返回 `{Referer: pageUrl, Origin: <origin>}`
  - `BilibiliAdapter.requiredHeaders` 忽略 pageUrl，保持固定 bilibili.com Referer
  - popup.js START_DOWNLOAD 透传 `resource.pageUrl || currentPageUrl`
  - `download-manager.js` 新增 `handleDirectDownloadCompletion`：首次 chrome.downloads.download 失败（SERVER_FORBIDDEN）后，注册临时 DNR（含来源页 Referer）重试
  - `dnr-manager.js` `acquire` 新增可选 `resourceTypes` 参数，重试场景传 `['main_frame', 'xmlhttprequest', 'other']` 覆盖 chrome.downloads 请求类型
  - DNR 规则在下载终态后 release（在 finally 块，确保清理）

### 已删除的测试代码
- `testNoDialog` 测试脚手架已完全移除（popup.js / sw.js / download-manager.js / queue.js / writer.js）
- 生产代码强制流式写盘（showSaveFilePicker + FileSystemWritableStream），Blob 模式仅作为 <50MB 小文件 fallback

---

## 5. 已知限制与待办

### 已知限制（未在当前范围内处理）
1. **批量下载（startBatchDownload）的防盗链重试未实现**：BATCH_FALLBACK_DOWNLOAD 路径不经过 `handleDirectDownloadCompletion`，且消息未携带 pageUrl。若 dm5.com 批量下载失败，需另开补丁
2. **任务列表头部徽章与面板任务数不一致**：重新打开弹窗时"任务 0"徽章显示为 0，但面板里实际列着进行中任务（可能是徽章只统计当前标签页任务，面板统计全局）。低优先级，留到 P4
3. **ffmpeg.wasm 体积**：打包后扩展 ~30MB，无优化方案（MV3 不允许远程加载）

### 待办（P4 阶段候选）
- [ ] 批量下载防盗链重试（参考 `handleDirectDownloadCompletion` 模式）
- [ ] 任务徽章与面板统计口径统一
- [ ] 通用站点实测覆盖（已测 YouTube / yhdm.one / dm5.com / haoduoman.com / 包子漫画 / someacg.top，B 站路径需回归测试）

---

## 6. 关键文件代码地图

### 消息路由（SW）
[background/sw.js](file:///d:/workc/web/webgrab/background/sw.js) 处理以下消息：
- `START_DOWNLOAD` → `downloadManager.startDownload`
- `START_BATCH_DOWNLOAD` → `downloadManager.startBatchDownload`
- `BATCH_FALLBACK_DOWNLOAD` → chrome.downloads.download（批量下载 fetch 失败兜底）
- `START_BILIBILI_DOWNLOAD` → `downloadManager.startBilibiliDownload`
- `DOWNLOAD_FILE_HANDLE` / `CANCEL_TASK` / `GET_TASKS` / `DELETE_TASK`

### 下载编排
[download-manager.js](file:///d:/workc/web/webgrab/background/download-manager.js) 导出：
- `startDownload(resource, fileHandleKey)` — 单资源下载入口
- `startBatchDownload(resources, dirHandleKey)` — 批量下载
- `startBilibiliDownload(params)` — B 站专属
- `executeWithHandle(taskId, fileHandleKey, resource, streamType)` — offscreen 路径执行
- `cancelTask` / `getTasks` / `deleteTask` / `init`（清空 DNR）

### Offscreen 任务执行
[offscreen/queue.js](file:///d:/workc/web/webgrab/offscreen/queue.js) 处理 SW 发来的 `EXECUTE_TASK`：
- `streamMeta.kind === 'bilibili'` → `executeBilibiliTask`
- `streamMeta.kind === 'batch'` → 批量下载循环
- `streamType === 'hls'` → HLS 分片下载 + remux
- `streamType === 'dash'` → DASH 分片下载 + remux
- 其他 → HttpFetcher 直接下载

### fMP4 重封装
[offscreen/remuxer.js](file:///d:/workc/web/webgrab/offscreen/remuxer.js) 核心：
- `remuxMultiTrackMp4` — 多轨 fMP4 重封装（DASH/HLS）
- `createBatchedSampleWriter` — 接受 `gopAware` 参数（video=true, audio=false）
- `createMultiSampleMoof` — 复用 mp4box.js BoxParser 生成多样本片段
- box 边界对齐缓冲逻辑（防止 mp4box.js 解析卡死）

### ffmpeg 兜底
[offscreen/ffmpeg-fallback.js](file:///d:/workc/web/webgrab/offscreen/ffmpeg-fallback.js)：
- `loadFfmpeg()` — 首次调用时从 `lib/ffmpeg/` 本地加载，缓存在内存
- `remuxWithFfmpeg(input, outputFormat)` — TS 转 MP4 / 编码转换
- 命令优先用 `-c copy`（仅重封装），编码不兼容时才真转码

---

## 7. 调试与验证

### 加载扩展
1. Chrome → `chrome://extensions`
2. 开启"开发者模式"
3. "加载已解压的扩展程序" → 选 `d:\workc\web\webgrab\`
4. Service Worker 控制台：扩展卡片 → "检查视图：service worker"
5. Offscreen 控制台：在 SW 控制台执行 `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` 拿到 ID，再通过 chrome-devtools 连接
6. Popup 控制台：右键扩展图标 → 检查弹出内容

### 常用验证场景
| 场景 | 测试站点 | 预期 |
|------|---------|------|
| B 站普通视频 | bilibili.com/video | 音视频分离下载，合并 MP4 |
| B 站番剧 | bilibili.com/bangumi | 同上，cid 从 `__PLAYURL_HYBRATE_DATA__` 取 |
| B 站互动视频 | is_stein_gate=1 | 显示"暂不支持"，隐藏下载 |
| 通用图片 | haoduoman.com / 包子漫画 | 一次直接成功，无重试日志 |
| 防盗链图片 | dm5.com | 首次 SERVER_FORBIDDEN → DNR 重试 → 成功 |
| AES-128 HLS | yhdm.one | ffmpeg.wasm 兜底转码 |
| 普通图片嗅探 | 任意图片站 | 资源列表正确分类，"视频"tab 含 stream |
| 长视频（>1h） | B 站长视频 | 不爆内存，无解码错误（PIPELINE_ERROR_DECODE） |

### 日志关键字
- `[WebGrab]` — SW 主流程
- `[WebGrab/Offscreen]` — offscreen 主流程
- `[WebGrab] DNR 规则已申请/已回收` — DNR 生命周期
- `[WebGrab] 检测到防盗链 403，注册临时 DNR 重试` — 防盗链重试触发
- `[ffmpeg]` — ffmpeg.wasm 日志

---

## 8. 依赖与版本

| 依赖 | 版本 | 用途 |
|------|------|------|
| mp4box.js | 0.5.x | fMP4 demux/mux（`lib/mp4box.all.min.js`） |
| m3u8-parser | - | m3u8 解析（`lib/m3u8-parser.min.js`） |
| mpd-parser | - | mpd 解析（`lib/mpd-parser.min.js`） |
| @ffmpeg/ffmpeg | 0.12.10 | ffmpeg.wasm ESM 封装（`lib/ffmpeg/`） |
| @ffmpeg/core | 0.12.6 | ffmpeg.wasm 核心（`lib/ffmpeg/ffmpeg-core.*`） |

**无构建工具**：项目是原生 ES Modules，直接由 Chrome 加载，无 webpack/vite/rollup。

**最低 Chrome 版本**：116（manifest.json `minimum_chrome_version`）

---

## 9. 代码风格约定

- **模块系统**：ES Modules（`import`/`export`），无 CommonJS
- **注释语言**：中文（项目内存文件要求"代码注释跟随用户语言"）
- **文件命名**：kebab-case（`download-manager.js`、`handle-store.js`）
- **类命名**：PascalCase（`SiteAdapter`、`BilibiliAdapter`）
- **私有字段**：使用 `#` 前缀（如 `FFmpeg` 类的 `#worker`）
- **异步**：所有 I/O 操作用 `async/await`，不混用 `.then()`
- **错误处理**：下载路径用 try/catch 转化为任务状态更新，不抛错到顶层
- **DNR 规则**：终态后必 release（在 finally 块）

---

## 10. 上线前检查清单

发布到 Chrome 网上应用店前必须确认：

- [ ] `lib/ffmpeg/` 完整包含 9 个文件（index.js / classes.js / const.js / errors.js / types.js / utils.js / worker.js / ffmpeg-core.js / ffmpeg-core.wasm）
- [ ] manifest.json 的 `web_accessible_resources` 包含 `lib/ffmpeg/*`
- [ ] manifest.json 的 `content_security_policy.extension_pages` 包含 `wasm-unsafe-eval`
- [ ] 全局搜索 `cdn.jsdelivr.net` / `unpkg.com` 返回 0 匹配
- [ ] 全局搜索 `testNoDialog` / `webgrabTestNoDialog` / `BLOB_MAX_SIZE_TEST` 返回 0 匹配
- [ ] B 站下载路径回归测试通过（普通视频 + 番剧 + 互动视频识别）
- [ ] 通用站点测试：haoduoman.com（无防盗链）+ dm5.com（防盗链重试）
- [ ] 长视频（>1h）不爆内存、无解码错误
- [ ] ffmpeg.wasm 加载链路无对外网络请求

---

## 11. 联系上下文

- **项目内存文件**：`c:\Users\wfz\.trae-cn\memory\projects\-d-workc-web--p2-ee96d91c9dd20d1bdb2f\project_memory.md`（硬约束 + 工程约定 + 经验教训）
- **用户偏好**：中文沟通；HTML/CSS/JS/Canvas 技术栈；偏好浏览器原生 API 单文件方案；视觉风格偏好 16-bit 像素艺术 + 极简设计
- **开发节奏**：P0 渲染 → P1 下载 → P2 B 站适配 → P3 通用站点兼容 → P4 待定

---

*档案结束。接手后建议先按 §7 加载扩展并跑一遍验证场景，熟悉各路径行为。*

## P4-1 小说 / 长文本按需提取（2026-07-31）

### 已实现

- popup 新增顶层“文本”页签，按钮固定为“提取本章 / 提取全本”，P4-1 不生成 JSON/TXT/EPUB 或其他磁盘文件。
- `content/novel.js` 只响应用户触发消息；轻量检测不运行 Readability、不保存正文。
- 单章提取按需向当前主 frame 注入本地 `lib/readability.js`，在克隆 Document 上解析，不修改 live DOM；保留 `<p>`，清理通用广告/推荐/导航和活动 HTML，少于 100 字或无段落时失败。
- 全本目录识别只接受同源 HTTP(S) 章节链接，至少 10 条、同容器、共享非根路径前缀、标题长度分布一致；严格保持 DOM 顺序，外域链接只记录不访问。
- 全本提取复用现有 SW/offscreen `EXECUTE_TASK` 生命周期；全局只允许一个小说任务，内部严格串行，每章前可取消地随机等待 300–800ms，单请求 20 秒超时，硬上限 500 章。
- 章节失败记录后继续；部分失败任务为 done 并带失败计数，全部失败才 failed；取消为 canceled 且已落库章节保留。
- 独立 IndexedDB `webgrab_novels`：`books` 元数据和 `chapters` 的 `[bookId,index]` 分表。成功章节正文写入与成功计数在同一 readwrite transaction；失败不写空章节。
- P4-2 读取入口为 `background/novel-manager.js` 的 `getStoredNovel(bookId)`，返回 `{kind,title,author,source,chapters}`。
- 修复浏览器级烟测发现的消息竞态：`offscreen/queue.js` 现在只处理明确带 `target:'offscreen'` 的消息，不再抢答 popup → SW 消息。

### Readability 合规

- 固定 Mozilla Readability 0.6.0，官方许可证实际为 Apache-2.0（不是早期规格误写的 MPL-2.0）。
- 源文件：`lib/readability.js`，SHA-256 `34DCAB3D0832D0019F02990EED6B6124E029E8C32B9F0C6F2550544FF8DFF174`。
- 署名与许可证：`README.md`、`THIRD_PARTY_NOTICES.md`、`lib/readability.LICENSE.txt`。
- 所有代码从扩展包本地加载，无远程可执行代码。

### 验证记录

- 自动回归：`node --test tests/*.test.mjs`（P3 + P4-1）。
- 浏览器级本地 20 章烟测：真实加载 MV3 扩展；单章 855 字/5 段、无导航残留/活动 HTML；全本 20/20、索引 0–19、标题与目录一致、正文均含段落且不少于 100 字；第 1 章后取消成功并保留该章。
- biqukong.com 实测页面：`https://www.biqukong.com/119/119538/1035582.html`。
  - 轻量检测成功，目录识别为 `https://www.biqukong.com/119/119538/`。
  - 单章成功：1166 字、23 段。
  - 第一次前 20 章实测为 20/20，IndexedDB 章节数 20、顺序 0–19、正文质量闸门通过。
  - 加强“无导航残留/标题对应”门禁后的第二次实站复跑在 45 秒测试等待门限内未终结，疑似目标站延迟或限流；未用旧结果冒充这次复跑成功。随后已补每请求 20 秒超时，避免单章永久卡住；为遵守克制抓取原则未连续第三次轰击实站。

### 已知边界

- 全本链路只解析 HTTP 返回的静态 HTML，不执行章节页 JavaScript；JS 渲染正文会记录失败。单章链路读取当前真实 DOM，因此可处理已渲染内容。
- 广告/推荐清理是通用语义启发式，不含站点域名；若特定站点仍有漏删或误删，应以后通过适配器扩展，不在核心加入域名判断。
- P4-1 不支持断点续抓；取消后数据结构可供后续 P4-6 续抓功能复用。

## P4-2 可阅读成品打包（2026-07-31）

### 已实现

- 漫画支持 `CBZ`、`文件夹 + index.html`、`两者都要`。图片优先按嗅探时记录的 `domIndex` 排序；无 DOM 顺序时使用自然排序，输出名至少三位（`001`、`002`…）。
- CBZ 使用 stored 图片条目并附 `ComicInfo.xml`；单页 fetch/内容失败会跳过并记入最多 20 条诊断，只要存在有效页就封口生成可打开的部分包。
- 文件夹模式逐图写盘，末尾生成只引用相对文件名的自包含 `index.html`，支持响应式纵向阅读和方向键/PageUp/PageDown 翻页。
- 小说 EPUB 直接读取 P4-1 的 `webgrab_novels` IndexedDB，不重新抓取。包含严格首项且未压缩的 `mimetype`、`container.xml`、EPUB 3 OPF、nav.xhtml、toc.ncx、逐章 XHTML 和统一 CSS。
- HTML 通过浏览器 DOMParser 清理为允许的正文标签，再用 XMLSerializer 输出合法 XHTML；章节清单/目录/spine 只引用成功写入的章节。
- fflate 0.8.3 UMD 固定在 `lib/fflate.min.js`。Zip 回调通过串行写入链直接落到 `FileSystemWritableFileStream`；每个条目完成写入后才读取下一项，正文/图片内存不随文件数线性累积。
- 两种任务都复用现有 `EXECUTE_TASK`、AbortController、TASK_UPDATE、DNR 终态回收和 handle-store；SW 不传正文/图片，只持久化轻量计数与最多 20 条失败摘要。

### 验证记录

- `node --test tests/*.test.mjs`：46/46 通过（包含原 P3/P4-1 回归）。
- 实际生成 `.test-output/p4-2/fixture-comic.cbz`、20 章 `fixture-novel.epub` 和 `fixture-comic/index.html`。
- 独立 Python `zipfile` + XML 解析门禁：CBZ CRC 正常、图片顺序 `001–003` 且非零；EPUB 第一项为 stored `mimetype`、全部 XML/XHTML 可解析、spine 和 nav 均为 20 章。
- Chrome headless 以 `file://` 成功打开本地 `index.html` 并生成 `.test-output/p4-2/index-smoke.png`；页面显示 3 页及本地阅读 UI。
- Playwright Chromium 真实加载 MV3 扩展后，P4-1 本地 20 章浏览器回归再次通过：20/20、顺序和标题正确、取消后保留 1 章，说明新增 offscreen 模块没有破坏扩展启动或小说任务。
- 浏览器流式内存烟测 `tests/e2e-package-memory.mjs` 使用 OPFS 的真实 `FileSystemWritableFileStream` 打包 80 个、总计 41,952,240 字节的图片响应；CBZ 为 41,961,042 字节，JS 堆峰值只增长 666,506 字节，未随总输入线性增长。
- 本机未安装 Calibre/Apple Books/微信读书，因此“真实阅读器导入”尚未在本机完成；不能用结构校验冒充该门禁。
- 本轮没有再次请求 dm5.com/biqukong.com，避免在已有实站验证后连续抓取；真实站 CBZ/EPUB 最终验收仍需加载扩展后各执行一次。

### 入口和关键文件

- UI：`ui/popup.html`、`ui/popup.js`（打包漫画 / 导出 EPUB）。
- 后台：`background/download-manager.js` 的 `startComicPackage`、`startEpubPackage`。
- offscreen：`offscreen/archive-writer.js`、`comic-packager.js`、`epub-packager.js`。
- 纯生成逻辑：`lib/package-utils.js`、`gallery-index.js`、`epub-builder.js`。
- 许可证：`THIRD_PARTY_NOTICES.md`、`lib/fflate.LICENSE.txt`。

## P4-1 分页章节完整性修复（2026-07-31）

### 根因与修复

- 真实复现 `https://www.biqukong.com/119/119538/943662.html`：同一章被拆成 `943662.html / 943662_2.html / 943662_3.html`，但前两页的链接文字错误地写成“下一章”。旧 worker 每章只请求目录里的首页，因此静默漏掉后两页。
- `lib/novel-heuristics.js` 新增 URL 结构判定：只移除紧挨扩展名前的 `_数字` 后缀；候选 URL 归一后必须与当前页完全一致、页码必须向前、URL 未访问过。判断不读取链接文字，核心无站点域名硬编码。
- `offscreen/novel-worker.js` 在单章首页提取和落库之间加入物理页循环。首页沿用原章节延迟；每个后续物理页再次执行可中止的 300–800ms 随机等待，并复用同一个 20 秒超时、同源 HTTP(S) 校验和 AbortSignal。
- 单个物理页用 Readability 清理但暂缓 `>=100 字/至少一段`质量闸门；所有物理页 HTML/text 按顺序拼接后统一执行质量检查，再作为一章原子落库。
- 每章最多 20 个物理页。达到上限且仍有候选页时停止继续请求，记录警告并保存已拼内容，不把整章标为失败。visited URL 集合同时防止循环链接。
- `lib/novel-extractor.js` 会从正文文本节点中移除 `第(1/3)页` 这类标记，保留同一文本节点中的相邻正文。
- live DOM 单章路径不新增网络请求；只检测 URL 结构并向 popup 显示“检测到本章还有更多分页未提取，仅显示当前页内容”。

### 验证记录

- 定向 RED→GREEN 覆盖：链接文字错误但 URL 同章、已访问页循环、三页顺序拼接、低上限停止保存、分页等待中取消、正文内裸分页标记清理、单章提示。
- 全量 `node --test tests/*.test.mjs`：52/52 通过，P3、P4-1 和 P4-2 均无回归。
- 真实站点 `943662.html`：单页预览 804 字/43 段并显示分页提示；全本 worker 实际顺序请求 3 页，合并后 2342 字/126 段（单页约 2.91 倍），`第(1/3)页`等残留为 0。
- 三个物理页请求前的礼貌等待分别为 576ms、787ms、755ms，均处于 300–800ms；最终页的“下一章”指向 `943663.html`，因归一 URL 不同而正确停止。
- 无分页回归页 `1035582.html`：只请求 1 次、只发生原有的 1 次章节前延迟，正文 1166 字/23 段，无额外网络行为。

## P4-3 自动目录与命名模板（2026-07-31）

### 已实现

- `lib/package-utils.js` 的既有 `sanitizePackageName()` 已原地扩展：Windows 非法字符、尾随空格/点、`CON/PRN/AUX/NUL/COM1-9/LPT1-9`（含扩展名）统一规避；单段按 UTF-8 不超过 255 字节截断并保留扩展名。P4-2 与 P4-3 不存在两套清洗规则。
- 新增共享 `lib/path-planner.js`，支持 `{root} {类型} {站点} {作品} {章节} {序号} {标题} {日期} {ext}`。默认输出根为 `WebGrab/`，并按漫画、小说、视频、音频、图片、其他分别套用模板。
- 相对路径超过 260 字符时依次缩短作品、章节、标题、站点；扩展名与序号 token 保留。模板预览与实际写盘都调用同一 `renderPathTemplate/buildOrganizedPath`，避免显示和落盘不一致。
- `manifest.json` 注册 `ui/options.html` 设置页，popup 右上角新增设置入口。设置页可编辑六类模板、点击插入 token、切换预览类型，并实时使用 popup 当前选中资源（无选中时用示例数据）渲染路径。
- 冲突策略存于 `chrome.storage.local` 的 `webgrab_path_settings`：`uniquify`（默认自动加 `(2)`）、`skip`、`overwrite`。
- `chrome.downloads` 路径使用同一相对路径和冲突策略；单图、普通媒体、Blob 降级与 `BATCH_FALLBACK_DOWNLOAD` 均已接通。二十三续的 `startDownloadAndWait`“先监听后下载”结构保留，路径预检发生在请求启动之前，不影响竞态修复。
- File System Access 路径通过 `lib/file-system-path.js` 逐级 `getDirectoryHandle(...,{create:true})`；批量散文件、CBZ、漫画阅读文件夹、EPUB、普通大文件和 B 站视频都使用共享目录/文件冲突解析器。既有流式 writer/ZIP 逻辑未改为内存整包。

### 验证记录

- 定向 RED→GREEN 覆盖非法字符、保留设备名、100 个中文字符、总路径超过 260 字符、全部 token、默认结构、自定义模板预览=实际路径、逐级建目录和三种冲突策略。
- 全量 `*.test.mjs`：76/76 通过；包含 P3 防盗链/竞态、批量 DNR、P4-1 小说分页、P4-2 CBZ/EPUB/流式打包回归。
- 12 个变更 JavaScript 文件均通过 `node --check`；`manifest.json` UTF-8 JSON 解析通过。
- `tests/e2e-options-ui.py` 使用本机 Chrome headless 完成真实交互：修改漫画模板→预览即时变化→选择“跳过已存在”→保存→刷新后模板和策略恢复；截图为 `tests/options-ui-smoke.png`。
- 本轮没有代替用户在真实下载目录执行覆盖/跳过，也没有重新请求 dm5.com、biqukong.com；实际磁盘下载验收仍需重新加载扩展后按下面清单各跑一次。

### 已知平台边界与手工验收

- File System Access 可以精确判断磁盘同名项，因此三种策略完整生效。
- `chrome.downloads` 没有“跳过”枚举，也不能查询已从下载历史中擦除的任意磁盘文件。当前 `skip` 先匹配仍存在的 Chrome 下载历史；命中则不发起下载，无法确认时使用 `prompt`，保证不会把“跳过”静默降级成覆盖。
- 重新加载扩展后建议验证：普通图片自动进入 `WebGrab/图片/<站点>/<日期>/`；漫画 CBZ/文件夹进入 `WebGrab/漫画/<站点>/<作品>/`；EPUB 进入 `WebGrab/小说/<站点>/`；B 站视频进入 `WebGrab/视频/哔哩哔哩/`。分别重复一次验证自动重命名、跳过和覆盖，并核对设置页预览与实际路径一致。

## P4-4 Shadow DOM 悬浮角色与资源面板（2026-07-31）

### 已实现

- `content/floating-companion.js` 仅在顶层 HTTP(S) document 注入；页面无资源时连宿主节点都不创建。资源新增、清空和导航重置由 `resource-store` 的统一监听器推送，角标与 popup/扩展 badge 共用同一计数源。
- 悬浮宿主使用 `attachShadow({mode:'open'})`。所有角色、角标、进度环、提示和控制样式都在 Shadow DOM 内；宿主固定定位且不参与页面布局，z-index 为 `2147483646`。
- 拖动使用 Pointer Events + pointer capture，过程只改 `translate3d`。松手执行 28px 阈值吸边并把位置按 origin 保存到 `webgrab_companion_settings`；窗口 resize 会保留原边缘归属并拉回视口。
- 面板 `ui/panel.html` 是扩展页 iframe，内部复用 `popup.html?embedded=1`，没有复制资源/小说/B站/任务业务逻辑。两层消息都校验 `event.source` 与 origin；Esc 可从宿主页、panel 或内层 popup 关闭，焦点最后归还角色按钮。
- 面板位置会根据角色所在半屏选择方向，再用 transform 把完整面板限制在当前视口内，角色拖到四角或窗口缩小时不会把面板主体裁出屏幕。
- `assets/character/manifest.json` 定义 idle/scanning/found/downloading/done/error 六态；横向 WebP 使用 CSS `steps()` 播放。当前六张素材由 `tools/generate-character-placeholders.py` 生成，只是纯色占位块，没有角色设计或远程代码。
- `background/companion-manager.js` 将任务表状态映射为角色阶段和进度。所有 popup 下载/打包/小说任务携带来源 tabId；任务 upsert 是统一发布点，因此直接下载的瞬时终态也不会漏掉。
- 全屏自动隐藏，`prefers-reduced-motion: reduce` 停止动画。角色提供“在本站不显示”；设置页新增全局开关、隐藏站点列表、单站恢复和恢复全部。

### 验证记录

- TDD 新增角色 manifest、资源尺寸、位置/设置、状态桥、Shadow DOM、panel 安全和设置 UI 测试；全量 `node --test tests/*.test.mjs` 为 106/106 通过。
- `tests/e2e-floating-companion.py` 使用 Playwright Chromium 真实加载未打包 MV3 扩展，在带敌对全局 CSS 和子 iframe 的 fixture 上验证：顶层唯一实例、子 frame 无实例、CSS 隔离、角标非零、拖出视口后吸附到 8px、storage 持久化、刷新恢复、resize 修正、面板完整落在视口、popup 计数一致、Esc 焦点归还、reduced-motion、全屏隐藏、本站隐藏及恢复；测试通过。
- 真实站烟测 `tests/e2e-floating-live-smoke.py`：B站首页和 YouTube 首页都得到顶层 1 个 open Shadow Root、子 frame 0 个、悬浮窗可见、WebGrab 控制台错误 0。微博首页实际重定向到登录页且没有嗅探到资源，因此宿主为 0，符合懒初始化；未把登录页结果冒充微博内容页验收。
- 浏览器交互截图：`tests/floating-companion-smoke.png`。本机品牌 Chrome 已取消命令行侧载扩展支持，真实扩展自动化使用 Playwright 自带的 Chromium 148 new-headless；不是 DOM 模拟。

### 角色素材交接

- 替换角色只需更新 `assets/character/manifest.json` 及它引用的本地横向 WebP。每张图片尺寸必须为 `(width × frames) × height`，路径不能是 URL、绝对路径、data URL 或含 `..`。
- 非循环 found/done 播完自动回 idle；error 保持到后续任务状态并提供可点击原因入口。当前未引入 Lottie，后续若增加必须先评估运行时体积与 MV3 本地代码合规。

### P4-4.1 默认侦探桌宠（2026-08-01）

- 新增 `assets/character/detective-girl/`：“蜜糖侦探”六态均为 120×160 单帧 WebP；`registry.json` 同时保留根目录占位角色，新角色成为全新安装的默认选择。
- 单帧角色不运行无意义的 `steps(1)` 位移动画；found/done 静态展示 900ms 后回 idle。壳层独立运行 2.6 秒、上下 3px 的 breathing，拖动仍只修改 host transform；reduced-motion 同时停止壳层和雪碧图动画。
- error 采用方案 a：参考图缺少专门的为难/道歉姿势，因此复用 scanning 的问号思考图，叠加淡红色覆盖与 360ms 轻微抖动。小鸟只出现在 found/downloading/done。
- `assets/character/*` 已在真实 Playwright Chromium MV3 环境证明可暴露 `detective-girl/` 子目录，不需要扩大 `web_accessible_resources`。浏览器烟测同时覆盖 options 热切换、六态、进度环、角标一致性和 reduced-motion。
- 图像能力边界：当前工具能做参考图编辑、重绘、裁剪、透明化与合成，也能生成额外姿势，但不能保证 Live2D/Spine 级逐帧身份一致性。本阶段因此选择诚实的单帧状态图 + CSS 微动效，没有提交低质量伪连续动画。

## P4-5 Popup 控制台设计系统（2026-07-31）

### 已实现

- `ui/popup.css` 已按暗色优先的控制台设计重写：中性色承担主要界面，只有一套青蓝强调色和 success/warning/error 语义色；颜色、字号、4px 间距、4/8/999 圆角和 150–220ms 动效均为 CSS token。组件不再含散落色值、渐变、滤镜或重阴影。
- 新增 `lib/ui-settings.js`，`webgrab_ui_settings.theme` 只接受 `system/dark/light`。popup、`panel.html` 和 options 共享设置并监听 storage 变化；系统主题和强制主题均有暗/亮配色，reduced-motion 会把动画/过渡压到单帧。
- 资源行改为 48px 视觉区、主文件名与低对比度元数据层级。图片先写 `data-src`，唯一 `IntersectionObserver` 在距列表视口 96px 时才设置 `src`；URL 级状态缓存避免定时重绘重复尝试已知破图，失败后 `<img>` 被移除并保留本地 SVG 类型图标。
- 资源/任务状态图标均为内联 SVG，不依赖 emoji 或远程素材。文件大小、尺寸、计数、速度、ETA 和百分比统一使用等宽字体及 `tabular-nums`。
- 批量操作条默认 `hidden`，选中后显示“已选 N 项 / 全选 / 批量下载 / 漫画格式 / 打包 / 取消选择”。失败任务保留既有重试协议，原因默认折叠，通过 `aria-expanded` 与 `aria-controls` 可键盘展开。
- 空状态提供播放视频、滚动图片和刷新页面的具体引导，并有“重新扫描”按钮；没有改下载后台协议、P4-1/P4-2 数据结构或 P4-4 角色状态源。

### 验证记录

- TDD 新增 `ui-settings.test.mjs`、`popup-design-system.test.mjs`、`resource-thumbnail.test.mjs`、`popup-interactions.test.mjs`；全量 `node --test tests/*.test.mjs` 为 121/121 通过。
- `tests/e2e-popup-design.py` 在 Chromium 中渲染 250 条资源，验证有效缩略图、文件缺失回退、独立滚动区、批量条、失败原因、重试按钮、强制亮色、暗/亮正文和元数据均不低于 WCAG AA 4.5:1，以及 reduced-motion；暗/亮截图为 `tests/popup-console-dark.png` 和 `tests/popup-console-light.png`。
- `tests/e2e-options-ui.py` 验证主题即时应用、保存与刷新恢复；`tests/e2e-floating-companion.py` 通过，说明共享主题没有破坏 P4-4 iframe/Shadow DOM 链路。
- 真实站烟测：B站首页 popup 捕获 104 条、滚动内容高 8428px；YouTube 捕获 95 条、内容高 7690px；两者 WebGrab 控制台错误为 0。微博实际重定向登录页且未发现资源，悬浮入口按懒初始化保持不注入，未冒充内容页验收。

### 已知边界

- 本阶段没有实现 200+ 条目的虚拟滚动；使用 `content-visibility:auto`、无滤镜/重阴影和 IntersectionObserver 控制图片请求。真正的 DOM 虚拟化按原计划留到 P4-6。
- 防盗链缩略图会触发浏览器自身的一次网络失败日志，但 UI 会删除破图并回退图标；这不改变实际下载时已实现的 DNR/offscreen 防盗链路径。

## 已打开标签页的 content script 自愈（2026-08-01）

### 已实现

- 新增 `background/content-script-recovery.js`，把 manifest 六份 content script 声明镜像成可测试规则表。普通 HTTP(S) 页补注入 hook、bridge、scanner、novel 和 floating companion 五组；B站页额外补 bilibili probe；`chrome://`、`chrome-extension://` 等非 manifest 匹配协议不注入。
- `chrome.runtime.onInstalled` 在 install/update 的共同路径调用 `recoverOpenTabs()`。每一组 `chrome.scripting.executeScript()` 独立 try/catch；file 权限关闭、页面受保护或某个 frame 不可访问时，只记录该组失败并继续后续规则和标签页。
- `content/novel.js` 新增 `window.__webgrabNovelInstalled`，`content/floating-companion.js` 新增 `window.__webgrabFloatingCompanionInstalled`；守卫分别位于消息监听注册和动态模块加载之前。
- 没有修改 manifest 权限。补注入的 `files/world/allFrames` 与原 content_scripts 逐项一致，novel 的三个依赖文件仍按 heuristics → extractor → content script 的顺序一次注入。

### 2026-08-02 陈旧实例接管修复

- `onInstalled` 发生时，重载前内容脚本的 `chrome.runtime` 绑定已经失效，但它们写在页面 `window` 上的 `__webgrab*Installed` 标记仍会保留。恢复流程现在为每条规则先执行一次 `func` 清理对应标记，再执行原来的 `files` 注入；清理调用与文件注入使用完全相同的 `target.tabId`、`allFrames` 和 `world`，MAIN/ISOLATED world 不串用。
- floating companion 规则在清标记后还会单独移除 `#webgrab-floating-companion` 陈旧宿主，再注入新实例。正常导航不经过这段恢复清理，各脚本原有守卫保持不变，仍只负责同一次真实导航内的重复注入防护。
- 清标记、清宿主或文件注入任一步失败，都只计为当前规则失败并继续其余规则和标签页；恢复结果仍按规则统计，未改变调用方语义。

### 验证与边界

- `tests/content-script-recovery.test.mjs` 覆盖六组规则与 manifest 一致性、普通页/B站/特殊协议匹配、每条规则的“同 target/world 清标记 →（悬浮窗清宿主）→ files”严格顺序、单次 executeScript 失败隔离、两个重复守卫和 install/update 共路径。
- `tests/e2e-content-script-recovery.mjs` 在页面已经打开后才通过 Browser CDP 安装扩展，先打开旧悬浮面板并刷新任务，再对同一路径执行更新；全程不刷新页面。更新后新面板刷新无 `Extension context invalidated`，动态插入图片能获得 scanner 写入的 DOM 顺序索引。页面 marker 与 `performance.timeOrigin` 未变化，悬浮窗宿主始终只有一个。
- 既有 `e2e-floating-companion.py` 与 `e2e-novel-smoke.mjs` 回归通过，说明正常新开页的悬浮窗与小说单章/20章全本/取消路径未受影响。
- 这不是完整历史回放。document_start + MAIN world 的 hook/probe 无法补回迟注入前已经发生并结束的 fetch、媒体播放或一次性页面赋值；本补丁可靠恢复的是当前 DOM 可见资源和补装之后的新网络/SPA事件。需要最完整的早期捕获时，用户仍应刷新页面。

## 嵌套悬浮面板的任务重试引导（2026-08-02）

- `offscreen/writer.js` 的句柄权限检查保持不变：offscreen 没有用户手势，只能 `queryPermission()`；权限不是 `granted` 时必须停止写盘，不能在后台偷偷请求授权。
- `ui/tasks.js` 现在独立声明 `isNestedFrame = window.self !== window.top`，不依赖 `popup.js` IIFE 内部变量。单任务“重试”和批量“重试失败项”在悬浮窗嵌套 iframe 内都会在任何 File System Access 选择器调用前返回。
- 返回前会在对应任务卡片内显示 `role=status` 提示：“重试需要重新选择保存位置，悬浮窗里无法弹出选择框，请用工具栏图标或侧边栏打开 WebGrab。”原始失败原因仍可独立展开，不会被提示覆盖。
- 工具栏 popup 和侧边栏属于顶层文档，原有目录/文件选择、句柄入库和重试消息路径未改。`tests/e2e-task-retry-top-level.py` 验证顶层目录选择器调用一次并提交 `START_BATCH_DOWNLOAD`；`tests/e2e-floating-companion.py` 在真实 MV3 双层 iframe 中验证选择器调用为零且卡片提示可见。

## 资源列表轮询滚动稳定性（2026-08-02）

- 删除 `ui/popup.js::render()` 中无条件的 `listSizer = null`。非空列表重渲染时，`ensureListSizer()` 复用仍挂在 `listContainer` 下的 sizer，只替换虚拟窗口内的行，因此外层 `scrollTop` 不会因容器清空而被浏览器钳回 0。
- 空态分支仍会清空 `listContainer` 并放入 `emptyState`；之后资源重新出现时，旧 sizer 的 `parentElement` 已为 null，`ensureListSizer()` 会自然重建，不依赖手工置空引用。
- `loadResources()` 增加浅层资源字段变化检测。2 秒轮询返回与当前 UI 数据相同的列表时不调用 `render()`；URL、类型、大小、标题、尺寸、来源、DOM 顺序等字段变化时仍正常更新。
- `tests/e2e-popup-scroll-stability.mjs` 真实加载 Chromium MV3 扩展：图片列表滚到 `scrollTop=2048`，等待 2.6 秒后位置仍为 2048 且 sizer DOM 身份未变；清空当前页后动态新增资源，列表恢复为一个 sizer、一行资源且无空态残留。

## 图标替换（2026-08-02）

- 用户设计的成品图 `assets/icon-src/app-icon-source.png`（1254×1254，蜜糖侦探主题，无 alpha 通道）直接高质量重采样缩放，替换 `icons/icon16.png` / `icon48.png` / `icon128.png`。这次是成品图直出，不是 P4-4 那种风格参考重绘。
- `manifest.json` 及全项目代码均未改动——除 manifest 的 `icons` 三行外没有其他地方硬编码引用图标文件。
- 验证：`tests/extension-icons.test.mjs` 用 PIL 校验三个文件精确为 `(16,16)` / `(48,48)` / `(128,128)`、均为合法 PNG 且非空白图；本次复核用相同方法重新确认过尺寸，均通过。

## 全项目 debug·第 1 批（2026-08-02）

对整个项目做的彻底 debug，用可运行测试实证复现出两条最高优先级的下载失败/卡死根因，均在 `background/download-manager.js`：

- **问题 1（致命）**：`activeTaskCount` 整数计数记账错乱——批量下载启动路径漏了自增，取消一个任务又会因 SW 侧 + offscreen 侧 + abort 回调三处上报被多扣两次——导致 `scheduleOffscreenClose()` 的 30 秒定时器在其他任务仍在跑时把 offscreen 关掉，正在下载的任务被静默杀死。修复为 `activeOffscreenTaskIds`（`Set<taskId>`，[download-manager.js:28](file:///d:/workc/web/webgrab/background/download-manager.js#L28)）：启动时 add、终态时 delete，`size === 0` 才关闭；同一 taskId 的终态重复到达天然幂等，不会再被误扣。
- **问题 2（严重）**：`upsertTask()` 对 `chrome.storage.local` 的 get→改→set 是无并发保护的 read-modify-write，两个任务几乎同时上报终态时后写覆盖先写，任务永久卡在"downloading"僵尸态。修复为 `taskWriteGate` Promise 链式串行化（[download-manager.js:34,87-90](file:///d:/workc/web/webgrab/background/download-manager.js#L34)），终态更新不会被合并或丢弃。
- 测试：`tests/download-manager-accounting.test.mjs` 覆盖两条问题的复现与回归（含批量下载计数、并存取消、终态重复上报幂等性、并发终态不丢失）。

## 性能·第 1 批（2026-08-02）

- 批量下载（`offscreen/queue.js` 的 `executeBatchTask`）与漫画打包（`offscreen/comic-packager.js` 的 `packageComic`）从完全串行改为有界并发，新增 `lib/bounded-concurrency.js` 的 `runBoundedConcurrent` 统一实现，复用现成的 `segmentConcurrency` 设置（默认 6，1-8 可调），不新开设置项；`ui/options.html` 对应说明文案同步更新为覆盖批量场景。
- 顺带修掉一个并发无关的潜伏 bug：漫画页码此前用运行时 `successCount` 命名，中途任意一页失败会导致后续页码整体错位；改为按原始数组下标命名（`fixedPageName(index + 1, ...)`，[comic-packager.js:129](file:///d:/workc/web/webgrab/offscreen/comic-packager.js#L129)），页码只取决于资源在原始列表里的位置，与并发顺序和失败情况无关。
- 文件名冲突解析（查重+占位）保持互斥，避免并发下载时两个同名资源互相静默覆盖。
- 测试：`tests/batch-concurrency.test.mjs`、`tests/comic-packager.test.mjs`。

## 性能·第 2 批（2026-08-02）

资源发现/嗅探链路的两处 O(n) 放大，影响多标签页和无限滚动场景：

- `background/resource-store.js` 的存储粒度从"单 key 存全部标签页"改为按标签页拆分持久化（`persistTab(tabId)`，[resource-store.js:175](file:///d:/workc/web/webgrab/background/resource-store.js#L175)），任意标签页新增/清空资源不再触碰其他标签页的数据。
- `content/scanner.js` 的 `MutationObserver` 回调从"触发后重新 `document.querySelectorAll` 全文档"改为只扫描 `mutation.addedNodes` 及其子树 / `mutation.target`，无限滚动页面已加载内容越多不再导致每次新增资源的扫描越慢。
- 测试：`tests/resource-store-session.test.mjs`、`tests/resource-store-filter.test.mjs`、`tests/e2e-scanner-incremental.mjs`。

## 主流网站实测·第 1 条（2026-08-03，当前最新阶段）

- 真机实测（视频类 B站/Vimeo、漫画类 dm5.com 均正常）在晋江文学城（jjwxc.net）真实章节页上稳定复现：打开"文本"tab 后永久卡在"正在检测当前页面…"，无报错、无退出方式。
- 根因：`background/novel-manager.js` 的 `sendTab()` 是 `detectNovelPage`/`extractCurrentChapter` 共用的底层通信入口，`chrome.tabs.sendMessage()` 本身不带超时，content script 侧检测逻辑一旦卡住，上层 Promise 永远不 resolve/reject。
- 修复（必做项）：`sendTab()` 加 8 秒 `Promise.race` 超时兜底（`TAB_MESSAGE_TIMEOUT_MS = 8000`，[novel-manager.js:8](file:///d:/workc/web/webgrab/background/novel-manager.js#L8)），风格参照项目已有的 `content/bridge.js` PROBE_TIMEOUT 和 `background/sw.js` SWITCH_PART_TIMEOUT；超时后正常 throw，复用 `ui/popup.js` 既有错误展示路径，UI 侧未改动。
- 根因排查（非必做项）：新增 `tests/e2e-jjwxc-novel-detection.mjs` 在真实页面上分别测量 `detectDocument()` 同步执行耗时和完整扩展消息往返耗时用于诊断；`lib/novel-extractor.js`、`lib/novel-heuristics.js` 均未被改动，说明这一步未定位到可针对性修复的具体死循环/回溯点，**按任务允许的兜底路径处理，以超时保护为准**——这部分的排查结论建议下次真机复测 jjwxc 时一并确认并补充说明，而不是默认已根治。
- 测试：`tests/novel-manager-timeout.test.mjs`（mock 永不 resolve 的场景）、`tests/e2e-jjwxc-novel-detection.mjs`（真机诊断）、`tests/e2e-novel-smoke.mjs`（回归）。

---

**本次核对（2026-08-03）**：`node --test tests/*.test.mjs` 全量 182/182 通过。上面五轮工作此前均未被记入本文档，只有代码和测试已经落地——本次是纯文档补录，未新增/修改任何实现代码。

## 性能·第 3 批：任务进度广播解耦持久化 + 徽章/面板计数统一（2026-08-03）

### 根因

- `background/sw.js` 的 `TASK_UPDATE` 分支原先 `await downloadManager.handleTaskUpdate(message.task)` 落盘完成后才广播 `TASK_BROADCAST`。`handleTaskUpdate` 内部经 `taskWriteGate` 把全局所有任务的 `chrome.storage.local` 读改写串行化，高频下载（HLS/DASH 分片、B 站分块）每个 chunk/segment 完成都触发一次整表读改写；并发下载越多，单个任务的进度广播就越容易被排在别的任务写入后面，造成进度条卡顿——即使下载本身很顺畅。
- `ui/popup.js` 的任务徽章走独立的 `updateTaskBadge()`：每次收到 `TASK_BROADCAST` 都额外发一次 `GET_TASKS` 重新拉取整张任务表自己算一遍"进行中"数量，还叠加一个 3 秒 `setInterval` 兜底轮询。这与 `ui/tasks.js` 面板自己维护的任务表（`TASK_BROADCAST` 推送 + 自己的 3 秒兜底轮询）是两套完全独立的口径，天然容易不同步——这正是 HANDOVER.md §5 记录的"任务徽章与面板任务数不一致"已知问题的根因。

### 修复

- `background/sw.js`：`TASK_UPDATE` 分支调整顺序，先广播 `TASK_BROADCAST` 再 `await handleTaskUpdate`（[sw.js:350](file:///d:/workc/web/webgrab/background/sw.js#L350)）。`message.task` 本身已是完整任务对象（`queue.js` 的 `stripInternal` 产出），广播不依赖持久化结果，因此可以先发。
- `background/download-manager.js`：`upsertTask` 新增按 `taskId` 的写入合并（`pendingTaskWrites`，[download-manager.js:34-99](file:///d:/workc/web/webgrab/background/download-manager.js#L34)）。同一个 taskId 在排队等待落盘期间又收到新更新时，合并成最新数据复用同一个 pending promise，不再额外排队一次完整读改写；所有调用方仍然共享同一个 promise，`await` 后拿到的必定是合并后真正写入磁盘的最新结果——不会破坏"await 后数据已落盘"的既有强一致性保证（含终态覆盖中间进度值、`finishOffscreenTask` 幂等回收）。
- `ui/tasks.js`：`updateSummary()` 统计出的"进行中"数量通过新增的 `onActiveCountChange` 回调发布出去，并新增 `getActiveCount()` 供外部取当前值（[tasks.js](file:///d:/workc/web/webgrab/ui/tasks.js)）。判定口径抽成 `ACTIVE_STATUSES` 常量，不再让 popup.js 另起一份同样的状态列表。
- `ui/popup.js`：删除 `updateTaskBadge()` 的 `GET_TASKS` 拉取和它自己的 3 秒 `setInterval` 轮询，改为纯同步的 `renderTaskBadge(count)`，通过 `window.webgrabTasks.init(..., { onActiveCountChange: renderTaskBadge })` 订阅 tasks.js 统一维护的计数；popup 打开时用 `getActiveCount()` 取一次初值兜底首屏空白。

### 验证记录

- 新增 `tests/download-manager-write-coalescing.test.mjs`：用带真实异步延迟（非同步 resolve）的 `chrome.storage.local` mock 验证——20 次同任务高频更新合并落盘次数远少于 20 次且最终值不丢；不同 taskId 互不串味；进度更新与终态更新排在一起合并时终态不被中间值覆盖。
- `tests/popup-interactions.test.mjs` 新增契约测试：徽章渲染函数必须是同步函数（不能再变回 `async`/自己发 `GET_TASKS`），必须通过 `onActiveCountChange` 回调订阅，不能再有独立 `setInterval` 轮询徽章。
- 全量 `node --test tests/*.test.mjs`：186/186 通过（182 + 本轮新增 4 条）。
- 真机验证：chrome-devtools-mcp 装载未打包扩展，在真实 popup 页面内连续发 20 次同任务 `TASK_UPDATE` 模拟高频进度上报（20 次消息往返总耗时 55ms），确认徽章"任务 1"与面板"共 1 个任务（1 进行中）"、`1000 B / 1000 B`、`100%` 全部实时同步、无需等待轮询；随后发终态 `done`，确认 `chrome.storage.local` 正确落盘为 `status:"done"`、徽章正确归零、面板显示"已完成"；全程 popup 页面与 Service Worker 控制台均无报错。
- 未验证项：并发多个真实下载任务时的实际进度条流畅度改善（受限于 `showSaveFilePicker` 原生对话框无法自动化，未能驱动真实多任务并发下载场景做端到端体感验证），已用消息级别的直接模拟替代，行为路径与真实 offscreen 上报完全一致（同一个 `TASK_UPDATE` 消息格式和 SW 处理路径），但不是真实文件下载触发的。

## 主流网站实测·第 2 批（2026-08-03）

用 chrome-devtools-mcp 装载未打包扩展，覆盖视频（腾讯视频、优酷）、小说（纵横中文网）、漫画（快看漫画、哔哩哔哩漫画）、图片/综合（知乎、微博、起点中文网）共 8 个站点。

### 🔴 已修复：小说全本目录识别漏判"正文页自带选章列表"的站点（纵横中文网复现）

- 真机复现：`https://read.zongheng.com/chapter/1386445/90870541.html` 打开"文本"tab，单章提取正常（466 字/9 段），但"提取全本"始终灰置，提示"未找到目录页"。
- 直接把交付代码的 `identifyChapterList` 注入真实页面执行验证：页面本身有 461 章的同源选章列表（`container-13` 分组，`titleLenOk:true`），分组本身完全有效。
- 根因定位到 `lib/novel-extractor.js:143`（修复前）：`hasChapterGroup: !detected && Boolean(currentList?.chapters.length)`——只有"本页不像正文"时才认当前页是目录候选。纵横的阅读页正文和选章列表同时存在于一个 DOM，`detected` 恒为 `true`，导致已经识别出的 461 章分组从未被使用。
- 修复：去掉 `!detected` 限制，只要 `identifyChapterList` 本身找到有效分组就采信（`identifyChapterList` 自身的同源/同容器/≥10 条/标题长度一致性过滤已经足够严格，不需要额外的"本页不像正文"限制）。
- 测试：新增 `tests/novel-extractor.test.mjs` 对 `detectDocument` 的两条用例（手搭最小 DOM 桩，项目未引入 jsdom），覆盖"正文页自带选章列表——目录候选不能被正文检测否决"和"正文页没有选章列表——不凭空捏造目录"；用临时改回旧逻辑的方式确认新测试真的会在旧代码上失败（`catalogUrl` 从预期 URL 变成 `null`）。
- 真机复测：重载扩展后同一页面"提取全本"从灰置变为可点，提示文案从"未找到目录页"变为"已找到目录候选"。
- 全量 `node --test tests/*.test.mjs`：188/188 通过。

### 🔴→已修复：JS 渲染的选章列表在"全本准备"阶段不可见

- 上面那条 bug 修好后点"提取全本"，走到"准备"步骤又失败："全本准备失败：未识别到至少 10 章的目录列表"。
- 验证：`curl` 原始 HTML（未执行任何 JS，17KB）与真实浏览器渲染后的 DOM 对比——原始 HTML 里 `第N章：` 一处匹配都没有，同源 `/chapter/1386445/` 链接只有 4 条（上一章/下一章/自身/目录页跳转），461 章的选章列表完全是客户端 JS 渲染出来的，服务器响应里根本不存在。这正是文档已经写明的边界（"全本链路只解析 HTTP 返回的静态 HTML，不执行章节页 JavaScript"）在真实主流站点上的具体命中。
- **修复**：popup"文本"tab 的初次检测本来就在已经渲染好的真实 DOM 上做，已经成功识别出章节列表（标题+URL）；不该被"准备"阶段整个丢弃、对同一个 `catalogUrl` 重新发起一次注定看不到 JS 渲染内容的静态 fetch。改动链路：
  - `lib/novel-extractor.js` 的 `detectDocument()` 新增 `catalogChapters` 字段——仅当 `catalogReason === 'current-page'` 时才带上已识别出的章节列表（目录是另一个页面时不带，因为那种情况下当前页的章节列表跟目录页无关）。
  - `ui/popup.js` 的 `prepareFullNovel()` 把 `novelDetection.catalogChapters` 一并发给 SW。
  - `background/sw.js` 的 `NOVEL_PREPARE_FULL` 分支透传 `catalogChapters`；`background/novel-manager.js` 的 `prepareFullNovel` 本来就是整体转发 `input`，不用改。
  - `offscreen/novel-worker.js` 的 `prepareNovelExtraction()` 新增分支：`input.catalogChapters` 存在且 ≥10 条时直接采信（`finalUrl = catalogUrl`、`title = input.pageTitle`），完全跳过 `fetchDocument`；否则维持原有静态抓取路径不变，两条路径共享同一套 `capChapterPlan` 上限逻辑，对已经验证工作正常的站点（如 biqukong.com 那种目录页和阅读页分离的站点）零影响。
- 测试：新增 `tests/novel-worker-prepare.test.mjs`（`prepareNovelExtraction` 此前完全没有直接单测覆盖），三条用例：预识别列表存在且 ≥10 条时完全不调用 `fetchDocument`；没有预识别列表时照常抓取；预识别列表不足 10 条时安全回退到重新抓取而不是直接用不合格数据建档。
- 全量 `node --test tests/*.test.mjs`：191/191 通过（188 + 本轮新增 3 条）。
- 真机复测：重载扩展、重新打开同一页面点"提取全本"，不再是"全本准备失败"，正确弹出"确认提取范围"——"共识别 461 章，本次提取 461 章"、"外域链接跳过 0 条"、"预计等待 2.3–6.1 分钟"，与实测直接注入代码得到的 461 章数字一致。为遵守克制抓取原则，看到统计数字确认无误后点"取消"退出，没有真的对 461 章发起抓取。全程 popup 和 Service Worker 控制台零报错。

### ✅ 无异常站点

- 腾讯视频（v.qq.com）：自动播放预览视频正确嗅探为 5 条 TS 分片；控制台报错均为站点自身的桌面客户端直连探测失败（`ERR_CONNECTION_CLOSED`/`ERR_CONNECTION_REFUSED` 指向 `qqlive://`/127.0.0.1），与 WebGrab 无关。
- 优酷（youku.com）：HLS `m3u8` + 2 条 TS 分片 + 1 条 MediaSource blob（HOOK 层）全部正确捕获，控制台零报错。
- 快看漫画（kuaikanmanhua.com）：漫画详情页 215 张图片全部正确嗅探，零报错。
- 哔哩哔哩漫画（manga.bilibili.com）：首页 219 张图片正确嗅探；工具栏 popup 通过 chrome-devtools-mcp 的 `trigger_extension_action` 连续 5 次未能打开（判断为自动化工具与该页面的交互问题，不是 WebGrab 缺陷——同一份 `popup.html` 通过页面内悬浮面板打开后角标、资源列表、计数完全一致且正常渲染，零报错）。

### ⚪ 站点自身拦截，非 WebGrab 问题

- 起点中文网（qidian.com）：反自动化检测直接返回空白页（`document.title`/`body.innerText` 均为空），未加载任何内容，扩展无从测起。
- 知乎（zhihu.com）：未登录自动重定向到 `/signin`，控制台仅有站点自身的 DNS 探测请求被 CORS 拦截，与之前 P4-4/P4-5 阶段记录的微博首页重定向登录页是同一类情况（懒初始化，不冒充已登录内容页验收）。
- 微博（weibo.com）：未登录重定向到"Sina Visitor System"人机验证页，控制台零报错，符合预期。

### 方法论说明

- 全程通过 `list_console_messages` 过滤 `types:['error']` 排查每个站点，只有明确带 `[WebGrab` 前缀或能追溯到扩展代码路径的报错才计入发现，站点自身的埋点/广告/客户端直连失败一律排除，避免把"页面很吵"误判成"扩展有 bug"。
- 纵横中文网的根因定位没有停留在猜测：直接把交付代码的纯函数逻辑注入真实页面执行，用真实 DOM 数据验证每一步分组/过滤条件，而不是读源码猜"大概是这里"。
- 未对任何站点进行超过验证所需的重复请求；"提取全本"的确认步骤在看到统计数字后立即放弃，没有真的对 461 章发起抓取。

## 通用媒体恢复：迟注入页面漏掉 m3u8/正文原图，视频列表被 TS 分片淹没（2026-08-03）

- 真实复现页：`yzrkjypggm.fqtlucrs.cc/archives/268679/`。页面先加载完成、扩展随后安装/重载接管时，播放器的 m3u8 请求已经结束，恢复后的网络监听只能看到随后产生的 TS；页面还会把正文图片改写成没有 `data-src` 的 `data:image/...;base64`，现有 DOM scanner 为避免把大体积 base64 塞进 `chrome.storage.session` 会跳过它们。
- 根因不是 HLS 下载器不支持该站：真实 m3u8 为 AES-128 HLS（含 `EXT-X-KEY` 和约 101 个 TS 分片），项目现有 `hls-parser.js`/`segment-fetcher.js` 已支持密钥解析与 AES-CBC 解密。问题发生在更早的资源发现与列表呈现层。
- `content/scanner.js` 新增 PerformanceResourceTiming 恢复：仅从当前文档保留的 `performance.getEntriesByType('resource')` 中读取已知图片/视频/音频扩展名的 HTTP(S) URL，在首次扫描及 2 秒/5 秒兜底扫描时上报；滚动增量扫描不遍历 performance 历史。这样不存 base64 本体，也能恢复其原始图片请求和迟注入前的 m3u8。
- `lib/media-resource-view.js` 新增用户列表净化：确认同页存在 m3u8/MPD 后，TS/m4s 只作为底层诊断数据保留，不再出现在用户资源列表、分类计数和来源计数中；如果没有捕获到播放列表则仍显示分片，避免彻底失去排障入口。`ui/popup.js` 的选择集也会同步移除已隐藏分片。
- `lib/media-output.js` 统一 HLS/DASH 成品语义：清单资源即使没有文件句柄也禁止走 `chrome.downloads.download()` 直存清单，强制派发给 offscreen 做分片解析、AES 解密与合并；路径模板、任务文件名和保存建议名统一从 `.m3u8`/`.mpd` 改为实际成品 `.mp4`。MPD 判断优先于通用 `kind=stream`，避免误走 HLS 解析器。
- 真实最差场景复测（页面先加载 8 秒，再用 `Extensions.loadUnpacked` 安装扩展，全程不刷新页面）：修复前 `stream=0`；修复后资源表恢复 `image=121`、`stream=1`、`ts=2`，其中确认恢复 8 张正文原图。经过界面净化后视频列表为 `stream=1`、`ts=0`，只保留完整 m3u8 下载入口。
- TDD：新增 `tests/media-recovery.test.mjs`，先确认旧实现对 performance 历史返回空数组、净化模块不存在，再实现到转绿；随后补测清单强制 offscreen 与 MP4 命名，修复前稳定复现为一次错误的 `chrome.downloads` 调用。最终全量 `node --test`：195/195 通过，相关 JS 文件全部通过 `node --check`。
- 能力边界：PerformanceResourceTiming 是浏览器的有限历史缓冲，极长寿命且请求量巨大的页面可能淘汰更早的条目；带签名的历史 URL 若已过期仍需刷新页面生成新签名。本补丁显著扩大“不刷新恢复”的覆盖面，但不能承诺无限期重放所有历史网络事件。

## HLS 批量下载误把播放列表改名为 MP4（2026-08-03）

- 用户复测后下载得到的两个 `d7de3ddda3720cc355c2207b5e3b13d0*.mp4` 都只有 2253 字节；读取文件头确认内容以 `#EXTM3U` 开始，实际是播放列表文本，并非损坏的 MP4 容器。
- 从 Edge 扩展的真实 `chrome.storage.local` 任务记录确认，这两次操作进入的是 `START_BATCH_DOWNLOAD`：任务名为“批量下载(1个文件)”，`streamType:null`、`streamMeta.kind:'batch'`。上一轮只修复了行内单文件按钮的 `START_DOWNLOAD` 分发，批量入口仍用通用 `fetch -> write`，于是把 m3u8 响应直接写进已经规划成 `.mp4` 的路径；目录权限失败时的 `BATCH_FALLBACK_DOWNLOAD` 也只会再次保存同一份播放列表。
- `lib/media-output.js` 新增 `partitionAdaptiveStreamResources()`，供批量入口在派发前把 HLS/DASH 与普通文件分开。
- `ui/popup.js` 的 `batchDownload()` 对每个 HLS/DASH 先在用户选中的目录里解析并占用最终 `.mp4` 文件句柄，再分别发送 `START_DOWNLOAD`，复用现有 offscreen 清单解析、分片下载、AES 解密和封装链路；普通图片/直链视频仍合并为一个 `START_BATCH_DOWNLOAD`，原有有界并发行为不变。仅有流媒体时不再创建无人消费的目录句柄记录。
- `offscreen/queue.js` 的通用批量执行器增加防御性拒绝：若其他入口将自适应播放列表误传进普通批量任务，明确记录 dispatch 失败，不写盘，也不回退到 `chrome.downloads.download()`，避免再次出现“任务成功但文件是假 MP4”。
- TDD：`tests/media-recovery.test.mjs` 新增批量资源分流、popup 双路径派发、offscreen 假 MP4 防线三条回归测试；修复前 3/3 稳定失败，修复后全量 `node --test` 为 198/198 通过，`ui/popup.js`、`lib/media-output.js`、`offscreen/queue.js` 均通过 `node --check`。
- 实站诊断补充：对当前真实播放列表抓取并解密首个 AES-128 分片后，解密数据以 MPEG-TS 同步字节 `0x47` 开始且每 188 字节对齐，证明目标站的清单、密钥和分片本身有效；本次失败点确定在任务分发之前，不是目标视频源损坏。

## 抖音支持·真机测试（2026-08-04）：探针从未在真实页面产出过主视频资源

`content/douyin-probe.js`（连同 `lib/http-response-metadata.js`、`offscreen/http-fetcher.js` 的分片校验硬化、popup 主视频/候选 UI）此前只有 `tests/douyin-probe.test.mjs` 里 `vm.runInNewContext` 跑的沙箱单元测试，喂的是手写 fixture JSON，从未在真实 douyin.com 页面验证过。本次用 chrome-devtools-mcp 装真扩展、开真实首页做了第一次真机验证：

- **确认探针脚本本身正确安装**：真实页面上 `window.__webgrabDouyinProbeInstalled === true`，`window.fetch` 已被正确包装，manifest 里的 content_script 规则、`content-script-recovery.js` 的迟注入恢复规则都命中。
- **确认真实站点确实会请求探针要拦截的接口**：Network 面板实测抓到过一次真实 `GET /aweme/v1/web/aweme/detail/?...aweme_id=...` 返回 200（点击首页视频卡片触发）。
- **但资源列表里从未出现过探针产出的主视频**：多次重新加载页面、点击不同视频卡片后，`chrome.storage.session` 里对应标签页的资源列表中唯一的 `kind:'video'` 条目始终是来自 `byteeffecttos.com` 的一个 221.7KB 通用特效资源（被通用网络嗅探规则误标为“推荐候选”），`isPrimaryMedia` 恒为 `false`、`mediaId` 恒为空字符串——探针预期的 `postMessage({type:'resource', data:{isPrimaryMedia:true, mediaId:...}})` 从未真正发生过。
- **重要环境因素**：未登录状态下，抖音 PC 网页版点击视频卡片绝大多数情况下会弹出"登录后免费畅享高清视频"的强制登录遮罩（而不是真正播放/请求详情），这层遮罩用 `Escape`、点击可见关闭图标（含 DOM 精确坐标定位）均无法关闭，只能通过内部 CSS-module 哈希类名 `.S07JvDdQ` 直接 `.click()` 才短暂关闭又很快复现。这层登录墙很可能是探针从未捕获到真实主视频数据的直接原因——多数点击根本没有走到会返回完整 `aweme_detail` JSON 的那条请求路径。
- **登录态复测（同日）：根因已经明确定位，是真实的解析 bug，不是登录墙问题。** 用户扫码登录后，登录墙消失，点击首页视频卡片会以 `?modal_id=<aweme_id>` 打开弹层播放器。抓取该次交互的完整网络请求列表，发现真实客户端（版本 17.4.0）打开视频弹层走的是 `POST /aweme/v2/web/module/feed/`（返回 `aweme_list` 数组），全程**一次也没有**请求过 `GET /aweme/v1/web/aweme/detail/`——探针目前唯一拦截的路径。
  - 用 `mcp__chrome-devtools__get_network_request` 把该次 `module/feed` 响应体完整落盘核实：顶层字段是 `aweme_list`（数组），不是 `aweme_detail`/`aweme_details`/`data.aweme_detail` 中的任何一种——`lib`（此处为 `content/douyin-probe.js`）`detailFromPayload()` 目前只认这三种形状，`aweme_list` 完全不在检查范围内，因此就算探针侥幸拦截到这个请求也解析不出东西。
  - `aweme_list[0].aweme_id` 精确等于点击时 URL 上的 `modal_id`（`7663071793392913704`），确认这个响应就是当前正在看的这条视频的数据源；其 `video.play_addr_h264.url_list` 里是真实、当前有效的 H.264 mp4 直链（`v5-dy-ov-experiment.zjcdn.com/...`），证明"目标数据确实存在、格式也和 fixture 假设的 `video` 子对象一致，只是被套在了探针没识别的外层结构里"。
  - **结论：这是一个可复现、根因明确、修复方向清晰的真实 bug**，不是环境/登录问题。`isDetailRequest()` 的 `DETAIL_PATH` 需要同时匹配 `/aweme/v2/web/module/feed/`（POST），`detailFromPayload()` 需要新增对 `payload.aweme_list`（数组，需要遍历/按需选取，而不是像现有三种形状那样只取"唯一一个"）的支持。`/aweme/v1/web/aweme/detail/` 路径本身应该保留——早前离线状态下确实抓到过一次该路径的 200 响应，可能对应视频永久链接直接访问（如分享链接跳转）等其它入口，两条路径大概率并存、服务不同的用户路径，不是互斥关系。
  - 本次未做的：还没有在修复 `detailFromPayload` 之后重新live复测确认徽章/资源列表能正确显示这条视频；`aweme_list` 场景下如何避免把用户压根没点开、只是被这次批量响应"顺带"带回来的其余 8 条视频也误标为"当前正在看的视频"，需要在实现时用 `modal_id`/点击的 `aweme_id` 做匹配过滤，而不是无脑取数组第一个或全部上报。

### 已按上述分析修复并提交（同日）

- `content/douyin-probe.js`：`isDetailRequest()` 新增匹配 `/aweme/v2/web/module/feed/`；`detailFromPayload()` 新增对 `payload.aweme_list` 数组的支持，用 `currentModalAwemeId()`（读取 URL 上的 `modal_id` 查询参数）精确匹配"用户当前正在看的那一条"，没有 `modal_id` 或匹配不到时直接返回 `null`（宁可不报，不猜）。
- 新增 3 条单测（`tests/douyin-probe.test.mjs`）：`aweme_list` 命中 `modal_id` 正确产出资源、无 `modal_id` 时不产出、`modal_id` 匹配不到任何条目时不产出。临时改回旧代码验证过新增的"命中"测试确实会在旧代码上失败（0 !== 1），不是空转的假测试。全量 `node --test`：219/219 通过。

### 🔴 真机复测发现更深层的问题：抖音自己的安全 SDK 会在页面加载后整体替换 `window.fetch` / `XMLHttpRequest.prototype.send`，导致内容脚本的拦截从根上失效

登录后用 chrome-devtools-mcp 反复点击首页视频卡片复测上面的修复，`chrome.storage.session` 里始终没有出现探针产出的 `isPrimaryMedia:true` 资源，即使已经确认：
1. 部署的 `content/douyin-probe.js` 确实是修复后的版本（读取 SW 里 `chrome.runtime.getURL` 取到的文件内容核实过，`MULTI_DETAIL_PATH`/`aweme_list` 都在）；
2. 探针在页面上确实装上了（`window.__webgrabDouyinProbeInstalled === true`）；
3. 真实的 `module/feed` 请求确实按预期发生了（用一个独立安装的调试用 `XMLHttpRequest.prototype.open` 包装器直接抓到了完整 URL，且 `pre_item_ids`/`from_gid` 精确对应点击的 `modal_id`）；
4. `isDetailRequest()` 的路径匹配逻辑本身对这个真实 URL 返回 `true`（直接在页面里跑过一遍，`matches:true`）。

逐层排查后确认根因：直接读取页面**当前**的 `window.fetch.toString()` 和 `XMLHttpRequest.prototype.send.toString()`，两者都不是探针包装过的版本，而是抖音自己的安全 SDK 实现（能看到 `hookConfig`、`needProxy`、`secureOpenArgs` 这类字段名，应该是给请求加 `a_bogus`/`x-secsdk-web-signature` 签名的那一层）。也就是说：**探针在 `document_start` 装的包装器，会在页面自身的脚本跑起来之后，被抖音的安全 SDK 直接整体覆盖掉**（不是链式包装在探针外层，是彻底替换），导致无论 `isDetailRequest` 和 `detailFromPayload` 写得多准确，实际拦截层从根上就没有机会执行。

这是一个比"识别错了接口/识别错了数据形状"更深一层的问题——**这次修的 bug 确实是真实存在且已经修对了的（用真实抓包数据反复验证过），但它不足以让"点视频卡片→自动捕获成品地址"这条链路在真机上稳定工作**，因为拦截机制本身会被站点的反爬 SDK 绕过。等价的旧版探针（只认 `aweme/detail`）大概率也一直受这同一个问题影响——不是这次新问题，是本来就存在、只是之前没有真机测试所以没暴露出来。

**没有在这次会话里尝试的应对方向**：用 `Object.defineProperty(..., {configurable: false})` 之类的手段让探针的包装器不能被后来的脚本覆盖，是理论上可行的下一步，但这样做的本质是主动对抗站点自己的反篡改机制，且风险很高——如果抖音的安全 SDK 因为拿不到它期望的 `configurable` 属性而抛错，很可能直接导致播放器功能损坏（不仅仅是下载功能受影响，整个视频播放都可能起不来）。这个方向要不要做、做到什么程度，需要用户明确决策后再动手，这次没有擅自实现。

---

## 深度排查会话（2026-08-04 续）：静态审计 + 真机端到端，修掉 4 类真实缺陷

本轮目标是"深度 debug 并反复测试，发现 bug 直接修"。基线：全量 219/219 通过，连跑 5 次无偶发失败（排除了非确定性/竞态导致的间歇性失败）。

以下每个缺陷都做过"回退修复→对应测试必失败"的有效性验证，不存在写了个永远通过的假测试。

### 🔴 1. 小文件被静默下载成 1 字节残file，任务却报"已完成"（真机发现，测试套件完全没覆盖）

**这是本轮最严重的问题，只有真机测试能发现。**

真机复现：同时下载 3 个维基百科图片，任务全部 `status: done`、进度条 100%、`downloaded` 显示 33157 字节，但磁盘上的文件**只有 1 个字节**。

根因链（已用真机抓包取得硬证据，不是推测）：

1. `HttpFetcher.probe()` 会先发一个 `Range: bytes=0-0` 的探测请求拿总长度和 Range 支持情况；
2. Chrome 把这条 **1 字节的 206 响应写进了 HTTP 缓存**；
3. 小于 1MB 的文件不走分块，`_downloadStream()` 紧接着发不带 Range 的完整 GET，**命中被污染的缓存**，拿回的响应是 `status: 200` + `Content-Length: 33157`，但 body 只有 1 字节；
4. `_downloadStream()` 读到流结束就 `return`，**完全没有校验实际字节数**；
5. `executeDirectTask` 收尾时又执行 `task.downloaded = task.total`，把进度强行改写成 100%，把问题彻底掩盖掉。

在页面里直接复现的证据：

```
probe   → status 206, content-range "bytes 0-0/33157", content-length 1
fullGet → status 200, content-length 33157, 实际 body 字节数 = 1
```

**为什么之前的"真实下载测试"没发现**：那轮测的是 `chrome.downloads.download()` 直连路径（根本不发探测请求）和一个 11.9MB 的大文件（走分块路径）。而分块路径在早先的 "Range 完整性加固" 里已经补齐了校验（要求 206、校验 Content-Range、校验字节数）——**唯独把流式这条分支漏掉了**。1 字节 bug 就住在这条没人测过的分支里。

**影响面**：所有走 offscreen 且小于 1MB 分块阈值的下载，也就是绝大多数图片和小体积媒体。且因为依赖缓存状态，表现为**时好时坏**（同一批 3 个文件里有 1 个是好的），比稳定失败更难被用户察觉。

修复（`offscreen/http-fetcher.js`）：

- 探测请求加 `cache: 'no-store'`，从源头上不让 1 字节的分片响应进缓存；
- `_downloadStream()` 补完整性校验：已知期望长度时，实际收到的字节数必须相等，否则报"响应被截断"而不是静默成功；
- 截断后**原地用 `cache: 'no-store'` 重取一次**（截断的头号成因就是缓存里存着不完整条目，用同样的缓存策略重试只会拿回同一份坏响应）；重取仍失败才换 backup URL；
- 每次尝试前把 `progress.downloaded` 归零，避免重试把字节数累加成假的完整长度。

**修复过程中这个改动自身又暴露了一个连带缺陷**：重取会把同一段数据重发一次，而 `FileWriter` 的 Blob 降级模式是"按到达顺序拼接"的，会把 1 字节的失败片段和完整内容**都**拼进去，产出 33158 字节的坏文件。已一并修掉（`offscreen/writer.js`）：Blob 模式改为**按 offset 定位组装**，语义与文件句柄模式的定位写入一致（同一位置后写覆盖先写）；50MB 上限也改为按"文件末端位置"判定，而不是写入字节数累加。

真机验证（复用那批已被污染缓存的 URL，专门压测重取路径）：

| 文件 | 修复前 | 修复后 | 期望 |
|---|---|---|---|
| verify-1.jpg | 1 字节 | **33157** `FF D8 FF DB` | 33157 |
| verify-2.png | 1 字节 | **2206** `89 50 4E 47` | 2206 |
| verify-3.jpg | 51160 | 51160 | 51160 |

三个任务的 `downloaded === total === 实际文件大小`，文件头签名全部合法。

测试：`tests/http-fetcher-stream-integrity.test.mjs`（4 条）、`tests/writer-blob-assembly.test.mjs`（5 条）。

### 🔴 2. 并发下载时 offscreen 创建竞态，第二个之后的任务直接失败

整个扩展同时只允许存在一个 offscreen document，第二次 `createDocument()` 会**直接抛错**而不是排队等待。而 `ensureOffscreen()` 的"检查是否已存在 → 创建"之间有 `await`，几个同时开始的下载任务会各自穿过检查、都走到 `createDocument`，第一个之外的全部拿到 `Only a single offscreen document may be created.` 并被 `dispatchOffscreenTask` 判为任务失败。

触发场景很日常：用户在列表里连点两个视频。popup 依次发 `START_DOWNLOAD`，SW 每次都会异步走 `executeWithHandle → dispatchOffscreenTask → ensureOffscreen`，第一个还没建好文档时第二个就进来了。`novel-manager.js` 也会直接调 `ensureOffscreen()`，同样会撞上。

修复（`background/download-manager.js`）：

- 加**单飞锁** `offscreenSetupPromise`，并发调用共用同一次创建流程；
- `createDocument` 外层加竞态兜底：捕获到 "single offscreen document" 类报错时按成功处理（这种报错恰恰说明文档确实存在），不把任务判死；
- 顺带修掉一个潜伏的 5 秒空等：就绪 Promise 原本在 `createDocument` **之后**才建立，而 offscreen 文档加载很快，`OFFSCREEN_READY` 完全可能先于 `createDocument` 返回就送达，那时 `offscreenReadyResolve` 还是空的，通知直接落空、只能干等 5 秒超时兜底。改为先建就绪 Promise 再创建文档。

真机验证：三个下载任务在同一轮内并发发起，全部 `done`，`chrome.runtime.getContexts()` 显示**恰好 1 个** offscreen 文档，空闲后正常关闭。

测试：`tests/offscreen-lifecycle.test.mjs`（3 条，分别守护单飞锁、竞态兜底、就绪时序——逐个回退验证过每条都真的只守护自己那一项）。

### 🟠 3. SW 冷启动恢复窗口内双向丢资源

`sw.js` 是**先同步注册 webRequest 监听**（嗅探器立刻就能干活）、**再异步调用** `restoreFromStorage()` 的，两者没有先后保证。而 `restoreFromStorage()` 里有一句 `cache.clear()`：

- 恢复窗口内嗅探到的新资源被这句 `cache.clear()` 静默丢掉 → popup 里看不到、角标数字不对；
- 更糟的是这些新资源此前的 `persistTab()` 是从**当时还空着的缓存**写出去的，已经用"只有新资源"的数组**覆盖掉了该标签页原有的持久化数据** → 存储层也丢数据。

MV3 的 SW 每 30 秒空闲就会被回收，这个恢复窗口在实际使用中会反复出现。

修复（`background/resource-store.js`）：改为**只补不清**——按 URL 合并，内存里已有的那份永远优先（它只会比磁盘更新）；恢复结束后把合并结果写回，修掉恢复窗口内造成的覆盖。

测试：`tests/resource-store-restore-race.test.mjs`（3 条，含"不能用磁盘旧副本覆盖内存里更完整的同一条资源"和"无并发时行为与原来一致"的回归保护）。

### 🟠 4. Blob 降级路径落盘失败被完全吞掉，任务谎报 done

无文件句柄时（悬浮窗 iframe、File System Access API 不可用等），offscreen 把数据攒成 Blob 再让 SW 用 `chrome.downloads.download()` 落盘。而 `handleBlobDownload()` 把所有异常都 `catch` 掉只打了条 log，`sw.js` 无条件返回 `{ok:true}`，`queue.js` 也不检查返回值 —— **这是降级路径唯一的落盘动作，失败了用户却看到"已完成"**。

修复：

- `handleBlobDownload()` 不再吞异常，改为等真正落盘完成才算成功（复用 `startDownloadAndWait`），启动失败 / 中断 / 超时都抛错。等待期间 blob URL 也保持有效；
- `offscreen/queue.js` 的三条路径（普通 / 流媒体 / B 站）都补上返回值检查，失败即把任务判 failed。

测试：`tests/blob-download-outcome.test.mjs`（4 条）。

### 🟡 5. popup 单文件下载派发失败时泄漏 IndexedDB 文件句柄

`ui/popup.js` 的批量下载和 EPUB 路径在 `START_DOWNLOAD` 失败时都会 `deleteHandle` 收尾，**唯独单文件下载这条主路径没有**——`sendMessage` 抛错或返回 `ok:false` 时，刚存进 IndexedDB 的 `FileSystemFileHandle` 再也没有任何一方会来清理，会一直占着写入授权。已按其它路径的同款写法补上。

### 本轮未处理、留待决策的问题

- **`task.downloaded = task.total` 的进度粉饰**：`offscreen/queue.js` 有 4 处在收尾时把 `downloaded` 强行改写成 `total`。第 1 条 bug 的排查里，正是这句让"实际只下了 1 字节"看起来像 100% 完成。现在完整性保证已经下沉到 `HttpFetcher` 这一层（成功即字节数相符），这几句不再会掩盖真问题，但它仍然是"编造数据"而非如实上报。要不要改需要权衡进度条 UI 的回归风险，本轮没动。
- 抖音安全 SDK 覆盖 `window.fetch` / `XMLHttpRequest.prototype.send` 的问题（见上一节）依然悬而未决，本轮未涉及。

### 本轮测试规模

219 → **238** 条，全量连跑 3 次全绿。新增 19 条全部经过"回退修复即失败"的有效性验证。

---

## ⚠️ 更正：上一节"抖音安全 SDK 会整体替换 fetch/XHR 导致拦截失效"的结论是错的

2026-08-04 复测推翻了这个判断。**探针的拦截链一直是通的，不需要对抗反篡改。**

### 之前错在哪

上一节的依据是：读取页面当前的 `window.fetch.toString()` 和
`XMLHttpRequest.prototype.send.toString()`，发现是抖音安全 SDK 的实现而不是探针的包装器，
就据此断定"探针的钩子被整体覆盖、彻底替换掉了"。

**这是误判。** `toString()` 只能告诉你谁在**最外层**，告诉不了你里层还有没有别人。
抖音的 SDK 是**套在探针外面**的：它的包装器形如 `function(){return X(e,this,arguments,r)}`，
其中 `e` 就是它加载时 `window.fetch` / `XMLHttpRequest.prototype.send` 的当前值——
也就是探针在 `document_start` 装好的那一层。它是**链式包装**，不是丢弃重建。

### 这次怎么拿到硬证据的

不再靠 `toString()` 推断，而是给探针的包装器临时加计数器，直接测"我们的函数体到底有没有被执行"：

```
probeInstalled: true
fetchCalls:  8      ← 探针的 fetch 包装器被真实调用了
xhrSends:    26     ← 探针的 send 包装器被真实调用了
detailHits:  1      ← isDetailRequest 命中了真实的 module/feed 请求
payloads:    2      ← reportPayload 被调用，响应 JSON 成功解析
```

同时探针还成功捕获到了真实的请求 URL（`/aweme/v2/web/module/feed/?...`、
`/aweme/v1/web/hot/search/list/` 等一批 `/aweme/` 接口）。

**结论：拦截层从来没有失效过。** 之所以没产出视频资源，是因为当时 URL 上没有 `modal_id`，
`detailFromPayload()` 走了"没有明确的当前视频标识，宁可不报也不猜"这条分支。
换句话说，卡住的是**识别"用户正在看哪一条"**这一步，不是拦截本身。

### 因此，不要做那个"对抗反篡改"的改动

上一节留下的待决策项——用 `Object.defineProperty(..., {configurable: false})`
防止 SDK 覆盖探针钩子——**是基于错误前提提出的，不应该做**。它解决的是一个不存在的问题，
却要付出破坏抖音播放器的真实风险。这个方向就此关闭。

### 仍未验证的部分（需要登录态）

复测时账号是登出状态，登录墙导致点击视频卡片没有真正打开弹层（只触发了一次信息流刷新，
`module/feed` 请求里也确实没有任何标识"点了哪条"的参数，只有 `pre_item_ids` 和 `refresh_index`）。
所以下面这一步**还没有端到端验证过**：

> 登录后点开视频 → URL 出现 `modal_id` → `module/feed` 响应里按 `modal_id` 匹配出正确条目
> → 资源出现在列表里

已知 `modal_id` 在登录态下确实会出现在 URL 上（本次会话开始时浏览器里就停在
`https://www.douyin.com/jingxuan?modal_id=7668575477216414991`）。
既然拦截链已证明可用、`modal_id` 匹配逻辑也有单元测试覆盖，这条链路**有可能已经是好的**。

**一个尚未证实的疑点**：弹层是异步路由打开的，`module/feed` 的响应有可能早于页面把
`modal_id` 写进 URL。若真如此，探针在响应到达那一刻读 `location.href` 会读不到 `modal_id`
而丢弃这次结果。这只是推测，**没有观测证据**，因此没有据此提前加"延迟重匹配"之类的机制——
要先在登录态下实测确认问题真实存在，再决定要不要做。

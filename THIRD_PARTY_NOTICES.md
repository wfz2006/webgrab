# Third-party notices

> WebGrab 自身的源代码采用 MIT License（见 [LICENSE](LICENSE)）。
> **本文件列出的第三方组件各自保留其原有许可证，不受 MIT 声明影响。**
> `LICENSE` 文件保持标准 MIT 原文不做增删，以便 GitHub 等工具正确识别；
> 适用范围的说明放在这里和 README。

## Mozilla Readability

WebGrab bundles the standalone Mozilla Readability library locally for its
on-demand novel/article extraction feature.

- Package: `@mozilla/readability`
- Version: `0.6.0`
- Source: <https://github.com/mozilla/readability/tree/0.6.0>
- Vendored file: `lib/readability.js`
- SHA-256: `34DCAB3D0832D0019F02990EED6B6124E029E8C32B9F0C6F2550544FF8DFF174`
- Copyright: Copyright (c) 2010 Arc90 Inc
- License: Apache License 2.0
- License copy: `lib/readability.LICENSE.txt`

The vendored source is kept unmodified and retains its original copyright and
license header. It is loaded only from the extension package; WebGrab does not
execute a remote copy.

## fflate

WebGrab bundles fflate locally for streaming CBZ and EPUB ZIP creation.

- Package: `fflate`
- Version: `0.8.3`
- Source: <https://github.com/101arrowz/fflate>
- Vendored file: `lib/fflate.min.js` (official npm UMD build)
- SHA-256: `462EF8041FC970E3615A20A9DD2B2E3047A073B2DA729EF4F02B634BBA8B7B83`
- Copyright: Copyright (c) 2026 Arjun Barrett
- License: MIT
- License copy: `lib/fflate.LICENSE.txt`

The archive library is loaded only from the extension package. No CDN or
remote executable copy is referenced at runtime.

## m3u8-parser

用于解析 HLS 清单。

- Package: `m3u8-parser`
- Version: `7.2.0`（文件头自带声明）
- Vendored file: `lib/m3u8-parser.min.js`
- SHA-256: `6F452735F5310931F13DA8A7C7264868BAAB8C7FA79D93182CE6C2810C2B4E58`
- License: Apache-2.0（`/*! @name m3u8-parser @version 7.2.0 @license Apache-2.0 */`，文件内自带）
- Source: <https://github.com/videojs/m3u8-parser>

## mpd-parser

用于解析 DASH 清单。

- Package: `mpd-parser`
- Version: `1.3.0`（文件头自带声明）
- Vendored file: `lib/mpd-parser.min.js`
- SHA-256: `F756630C0BE286D5E3243F822BDA2521703CA6C53DA2D3A7FE0DAC4A646E61E5`
- License: Apache-2.0（`/*! @name mpd-parser @version 1.3.0 @license Apache-2.0 */`，文件内自带）
- Source: <https://github.com/videojs/mpd-parser>

## mp4box.js

用于 MP4 解析与重封装（fMP4 → MP4）。

- Vendored file: `lib/mp4box.all.min.js`
- Build marker: `/*! mp4box 19-03-2022 */`（文件内仅有此标记，无版本号、无许可证头）
- SHA-256: `07CCF31D127803DD1CCA1208BBFD0983B21F795CB0D2B80687A7EC6BDB391219`
- Source: <https://github.com/gpac/mp4box.js>
- License: ⚠️ **待核对**。上游仓库声明为 BSD-3-Clause，但这份打包文件内没有内嵌
  许可证头，无法仅凭仓库内容证实。发布前应回上游确认版本与许可证，并补上
  BSD-3-Clause 要求保留的版权声明副本。

## FFmpeg.wasm

仅在 remuxer 快速路径不适用时作为兜底转码/合并使用。

### @ffmpeg/ffmpeg（JS 封装层）

- Vendored files: `lib/ffmpeg/classes.js`、`const.js`、`errors.js`、`index.js`、
  `types.js`、`utils.js`、`worker.js`
- Source: <https://github.com/ffmpegwasm/ffmpeg.wasm>
- License: ⚠️ **待核对**。上游声明为 MIT，但这些文件内没有内嵌许可证头。

### @ffmpeg/core（FFmpeg 本体，WebAssembly 构建）

- Vendored files: `lib/ffmpeg/ffmpeg-core.js`（111,804 字节）、
  `lib/ffmpeg/ffmpeg-core.wasm`（32,232,419 字节）
- SHA-256 (js): `67A48F11645F85439F3FDE4F2119042C16B374B910206B7A7A24F342E28DCAE3`
- SHA-256 (wasm): `9F57947A5BD530D8F00C5B3F2CB2A3492FAA7E5D823315342D6A8656D0A6B7B7`
- Source: <https://github.com/ffmpegwasm/ffmpeg.wasm-core>
- License: ⚠️ **需要重点确认**。FFmpeg 本体是 **LGPL v2.1 或 GPL**（取决于构建时
  启用了哪些组件，例如启用 libx264 会使整体变为 GPL）。这两个文件内都没有许可证
  头，**无法仅凭仓库内容判定具体是哪一种**。

  这一点对公开分发有实际影响：
  - 若为 LGPL v2.1：可以与 MIT 代码一起分发，但必须保留 LGPL 声明、提供对应源码
    获取方式，并保证使用者能够替换/重新链接该组件；
  - 若为 GPL 构建：GPL 的传染性会波及与之一起分发的整体作品，与仓库当前的 MIT
    声明存在冲突。

  **建议**：回 ffmpeg.wasm 上游确认这份 core 的确切版本与构建配置，据此补齐
  许可证副本与源码获取说明；在确认之前，不宜把本仓库对外描述为"整体 MIT"。

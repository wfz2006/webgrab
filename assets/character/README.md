# WebGrab 角色素材接口

根目录的 WebP 是用于跑通整条链路的纯色占位雪碧图，继续作为可选回归角色保留。当前默认角色“蜜糖侦探”位于 `detective-girl/`，角色注册表见 `registry.json`。

换角色时，替换一个角色文件夹及其中的 `manifest.json` 即可，业务代码不需要改动。设置中的 `characterRoot` 指向该文件夹；路径必须是扩展包内相对路径，不能使用网络 URL、`data:` URL、绝对路径或 `..`。

## manifest 约定

- `width` / `height`：单帧逻辑尺寸，单位为 CSS 像素。
- `states`：必须包含 `idle`、`scanning`、`found`、`downloading`、`done`、`error`。
- `sheet`：相对于 manifest 所在文件夹的 WebP 文件名。
- `frames`：横向雪碧图中的帧数；图片实际尺寸必须是 `width × frames` 乘 `height`。
- `fps`：播放帧率。
- `loop`：是否循环。非循环状态播放一遍后由壳回到 `idle`。

动画由 CSS `steps(frames)` 驱动，运行时不会用 JavaScript 逐帧切图。系统开启“减少动态效果”时只显示第一帧。当前版本不加载 Lottie 运行时。

## 蜜糖侦探

- 六个状态均为 120×160 单帧 WebP；角色没有伪装成多帧连续动作，桌宠感来自壳层独立的 2.6 秒呼吸动效。
- `idle` 使用喝茶看书坐姿；`scanning` 使用放大镜与问号思考姿势；`found` 使用跳跃发现姿势；`downloading` 使用侧身行走姿势；`done` 使用正面庆祝姿势。
- 参考设定没有专门的出错表情，因此 `error` 采用方案 a：复用 `scanning` 姿势，并由壳层添加淡红色覆盖和一次轻微抖动。
- 小鸟伙伴出现在 `found`、`downloading`、`done`，不出现在 `idle`、`scanning`、`error`。
- 原始用户参考图保存在 `assets/character-src/reference-sheet.png`；最终状态图是基于该参考图生成、透明化和统一缩放后的本地派生素材。

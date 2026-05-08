# webutau_vst_host

webUTAU 的 VST3 插件宿主子进程。Tauri 主程序通过 stdio JSON 协议拉起本进程并和它通信，
插件 GUI 在独立的浮动窗口里渲染（不嵌入主 webview）。

## 许可

本子进程依赖 [JUCE](https://github.com/juce-framework/JUCE)，作为独立可执行二进制以
**GPLv3** 发布；webUTAU 主程序保持 MIT。两者通过 IPC（stdio + WS）通信，按 FSF/JUCE
官方解释属"分开作品"。详细说明见仓库根 README。

## 构建

依赖：CMake 3.22+、C++20 编译器、Git。macOS 还需 Xcode 命令行工具，Linux 需要
ALSA/X11 等 JUCE 通用图形依赖。

```bash
cd external/vst-host
# 钉 7.0.12——最后一个 7.x 稳定版。JUCE 8 master 把 juce_audio_processors
# 拆成 headless / 全功能两份，host 模块需要的 addDefaultFormats() 在 headless
# 里被 = delete，会编译失败。等 JUCE 8 稳定后再升
git clone --depth=1 --branch=7.0.12 https://github.com/juce-framework/JUCE.git
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

产物：

* macOS / Linux：`build/webutau_vst_host_artefacts/Release/webutau_vst_host`
* Windows：`build\webutau_vst_host_artefacts\Release\webutau_vst_host.exe`

构建脚本 `scripts/prepare-tauri-assets.mjs` 会在打包阶段把它复制到
`src-tauri/resources/vst-host/`。手工开发态也可以直接放到 `external/vst-host/build/`，
Rust 桥会从那个路径回退查找。

## 协议概览

控制面：行分隔 JSON 走 stdin/stdout。请求形如
`{ "id": 1, "cmd": "load", "pluginPath": "...", ... }`，响应 `{ "id": 1, "ok": true, "data": ... }`，
事件 `{ "event": "ready", ... }`。详见 `Source/StdioProtocol.h` 与
`src-tauri/src/vst_host.rs` 的注释。

数据面（实时音频）：v0.1 暂未实现。`ready` 事件中 `wsPort=0` 通知前端把实时
桥接降级为 dry through。后续版本将引入 WebSocket（推荐 ixwebsocket）。

## 当前状态（v0.1）

- [x] 加载/卸载 VST3 插件实例（macOS / Win / Linux）
- [x] 顶层独立编辑器窗口（关闭按钮仅隐藏，不卸载）
- [x] 参数 set/get
- [x] 插件状态 chunk get/set（base64）
- [x] 离线 PCM 处理（`process_offline`）
- [ ] 实时 WebSocket 数据面
- [ ] 扫描沙箱（避免烂插件 crash 整个 host）
- [ ] AU / CLAP（仅 macOS / 全平台 future work）
- [ ] 插件参数变化事件回报（GUI 调旋钮 → 工程 chunk 同步）

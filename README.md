# Melody Singer

基于浏览器的歌声合成 DAW，导入 MIDI 即可合成人声。

## 功能

- **多轨编辑器** — 钢琴卷帘 + 总览时间线，支持多轨道管理
- **MIDI 导入** — 自动解析音符、歌词，支持批量歌词编辑
- **DiffSinger 合成** — 后端调用 DiffSinger 模型，逐短语渲染人声
- **音高编辑** — 画笔工具编辑音高偏差曲线 (PITD)，实时同步后端重渲染
- **乐器采样** — 内置钢琴、小提琴、吉他、鼓组采样，Tone.js 回放
- **人声混响** — 卷积混响 (Voxengo IR)，可调发送量
- **撤销/重做** — Ctrl+Z / Ctrl+Shift+Z
- **实时播放** — 渲染中即可播放已完成短语，未完成短语自动等待

## 项目结构

```
melody-singer/
├── 3/                    # 前端 (HTML + CSS + JS)
│   ├── index.html
│   ├── app.js
│   └── style.css
├── server/
│   └── DiffSingerApi/    # .NET 后端 API
├── lib/                  # Tone.js, Midi.min.js
├── samples/              # 乐器采样 + 混响 IR
├── singer.html           # 独立合成页面
└── start-v3.bat          # 一键启动脚本
```

## 运行

### 前置条件

- .NET 8 SDK
- Python 3 (用于本地 HTTP 服务)
- DiffSinger ONNX 模型 + 声库（放入 `server/DiffSingerApi/bin/.../voicebanks/`）

### 启动

```bat
start-v3.bat
```

会自动：
1. 启动后端 API（端口 5000）
2. 启动前端服务器（端口 3000）
3. 打开浏览器 `http://localhost:3000/3/index.html`

## 技术栈

- **前端**: 原生 HTML/CSS/JS, Canvas 2D, Web Audio API, Tone.js
- **后端**: ASP.NET Core, ONNX Runtime (DiffSinger 推理)

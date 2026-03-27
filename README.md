# Melody Singer

AI 歌声合成工作站 — 基于 DiffSinger 的浏览器端音乐制作工具。

## 功能

- MIDI 导入与钢琴卷帘编辑器
- 中/日语歌词编辑与语言切换
- AI 歌声渲染（DiffSinger 后端）
- 音频播放与导出

## 快速开始

### 前端

```bash
npm install
npm run dev
```

浏览器打开 http://localhost:3000

### 后端

后端（DiffSinger API）通过 [Release](https://github.com/Marigold1122/melody-singer/releases) 分发，下载后解压到 `server/` 目录，运行 `start-server.bat`。

### 一键启动

```bash
dev.bat
```

同时启动后端 + 前端开发服务器。

## 技术栈

- 前端：Vanilla JS + Vite
- 后端：.NET (DiffSinger API)
- AI 引擎：DiffSinger / Seed-VC

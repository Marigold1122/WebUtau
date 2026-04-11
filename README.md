# WebUtau

**浏览器端虚拟歌姬工作站** — 导入 MIDI，填写歌词，让虚拟歌姬为你演唱！

![webUTAU 界面预览](docs/screenshot.png)

## 功能亮点

### 虚拟歌姬演唱
基于 [OpenUtau](https://github.com/stakira/OpenUtau) 歌声合成引擎，支持加载 UTAU 主流声库，在浏览器中即可驱动虚拟歌姬声库演唱你编写的旋律与歌词。

### 音色转换
集成 [SeedVC](https://github.com/Plachtaa/seed-vc) 音色转换技术，可将歌姬的演唱转换为目标音色，拓展声音表现力。

### 钢琴卷帘编辑器
直观的钢琴卷帘界面，支持 MIDI 导入与手动编辑，提供音高、时值的精细控制。

### 歌词编辑
支持中文与日语歌词输入，提供快速填词面板，可批量填写并自动匹配音符。

### 多轨乐器伴奏
内置钢琴、小提琴、鼓组等多种乐器音色，支持多轨编排与混音，为歌声配上完整伴奏。

### 混音与效果
轨道级混响、音量控制，多种预设效果风格，让作品更具表现力。

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) LTS
- [Git](https://git-scm.com/)

### 安装与启动

```bash
git clone https://github.com/Marigold1122/melody-singer.git
cd melody-singer
npm install
```

从 [Releases](https://github.com/Marigold1122/melody-singer/releases) 下载最新后端运行时，解压到 `server/` 目录，确保 `server/DiffSingerApi.exe` 存在。

将声库放入 `server/voicebanks/` 下（每个歌手为独立子文件夹）。

```bash
dev.bat
```

打开浏览器访问 http://localhost:3000 即可使用。

<details>
<summary><strong>从源码构建后端</strong></summary>

需要 [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)：

```bash
dotnet publish server/DiffSingerApi/DiffSingerApi.csproj -c Release -o server
```

使用 `dev-source.bat` 可直接从源码启动后端与前端开发服务器。

</details>

## Tauri 桌面打包

桌面版会把前端静态资源和已发布的 DiffSinger/OpenUtau 运行时一起打进客户端，Tauri 只负责资源整理、本地后端拉起和进程生命周期管理，不接管现有前端业务逻辑。

打包前执行：

```bash
npm install
npm run tauri:build
```

如果当前 shell 里 `dotnet` 不在默认 `PATH`，可先设置 `DOTNET_BIN` 指向真实可执行文件。若你已经手动执行过 `dotnet publish`，也可以通过 `MELODY_TAURI_BACKEND_SOURCE_DIR` 直接指定现成的发布目录。

安装后的客户端会在固定目录下保留如下结构，用户升级客户端时这些目录不会被覆盖：

- `runtime/`：桌面壳复制出的只读后端运行时
- `voicebanks/`：用户自定义声库目录，可直接手动放入歌手子目录
- `uploads/`：运行时上传缓存
- `output/`：渲染导出产物
- `logs/`：本地后端日志

其中 `voicebanks/README.txt` 会在首次启动时自动创建，提示用户如何手动放置自定义声库。

典型路径示例：

- Windows：安装目录下的 `voicebanks/`、`uploads/`、`output/`、`logs/`
- macOS：`~/webutau/voicebanks`
- Linux：`~/webutau/voicebanks`

Windows 的 NSIS 安装器默认会优先把安装目录设为 `D:\webUTAU`；如果目标机器没有 `D:` 盘，则回退到 `%LOCALAPPDATA%\webUTAU`。你仍然可以在安装向导里手动改成其他路径。

<details>
<summary><strong>SeedVC 音色转换（可选）</strong></summary>

需要 [Python 3.10](https://www.python.org/downloads/release/python-31011/)，建议配备 NVIDIA GPU（GTX 1060+）。

```bash
git clone https://github.com/Plachtaa/seed-vc.git external/seed-vc
cd external/seed-vc
python -m venv .venv
.venv\Scripts\activate
pip install torch==2.4.1+cu124 torchvision==0.19.1+cu124 torchaudio==2.4.1+cu124 --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
pip install fastapi uvicorn python-multipart
cd ../..
scripts\start-seedvc-service.bat
```

> 无 NVIDIA GPU 可将 PyTorch 安装命令替换为 `pip install torch torchvision torchaudio`。

</details>

## 技术栈

前端：Vanilla JavaScript + Vite + Web Audio API + Tone.js
后端：.NET 8 + ASP.NET Core（基于 [OpenUtau](https://github.com/stakira/OpenUtau) 核心模块）
音色转换：Python + PyTorch + SeedVC

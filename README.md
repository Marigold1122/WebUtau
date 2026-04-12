# WebUtau

**一站式虚拟歌姬网页工作站** — 导入 MIDI，填写歌词，让虚拟歌姬为你演唱！

![webUTAU 界面预览](docs/screenshot.png)

## 功能亮点

### 虚拟歌姬演唱
基于 [OpenUtau](https://github.com/stakira/OpenUtau) 歌声合成引擎，支持加载 UTAU 主流声库，在浏览器中即可驱动虚拟歌姬声库演唱你编写的旋律与歌词。

### 灵活的使用方式
支持通过源码启动网页版，也支持安装点击即用的客户端。无论是在网页版还是客户端中，你都可以生成一个分享链接，在其它设备上使用或分享给他人。在浏览器中打开分享链接即可以完整使用该项目，并加载你在本地的声库，无需其它安装流程。

### 音色转换
支持 [SeedVC](https://github.com/Plachtaa/seed-vc) 音色转换技术，可将歌姬的演唱转换为目标音色，使用此功能需自行在本地部署[SeedVC](https://github.com/Plachtaa/seed-vc)。

### 钢琴卷帘编辑器
直观的钢琴卷帘界面，支持 MIDI 导入与手动编辑，提供音高、时值的精细控制，对于多轨道MIDI有良好的支持。

### 歌词编辑
支持中文与日语歌词输入，提供快速填词面板，可批量填写并自动匹配音符。

### 多轨乐器伴奏
内置钢琴、小提琴、鼓组等多种乐器音色，支持多轨编排与混音，为歌声配上完整伴奏。

### 混音与效果
轨道级混响、音量控制，多种预设效果风格，让作品更具表现力。

### 无损导出
可精准导出指定轨道或整个工程的无损音频，快速产出试听版本。

### 跨平台支持
支持Windows、Mac、Linux平台使用。

## 快速开始

### 通过客户端版本运行

对于无部署经验的用户，通过 [Releases](https://github.com/Marigold1122/WebUtau/releases/latest) 下载可直接安装的客户端是最好的选择。安装后，你可在指定目录中配置你的声库。

Mac版的声库配置目录位于 `～/webutau/voicebanks` , Windows版位于软件安装目录下的 `runtime/voicebanks-seed` ，将解压后的声库放在这两个目录下即可，每个歌手为独立子文件夹。

### 通过源码启动网页版

该方式仅推荐有项目部署经验的用户使用。

#### 环境要求

- [Node.js](https://nodejs.org/) LTS
- [Git](https://git-scm.com/)
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0)

#### 安装与启动

```bash
git clone https://github.com/Marigold1122/melody-singer.git
cd melody-singer
npm install
```

将声库放入 `server/voicebanks/` 下（每个歌手为独立子文件夹）。

在Mac上应运行`dev-mac.sh`，在Windows上应运行`dev.bat`。

打开浏览器访问 http://localhost:3000 即可使用。(具体端口以终端显示为准)


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

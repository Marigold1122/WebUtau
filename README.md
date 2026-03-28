# Melody Singer

基于 DiffSinger 的浏览器端 AI 歌声合成工作站。

导入 MIDI、填写歌词，即可通过 AI 合成歌声。支持音色转换（SeedVC）、多轨编辑和乐器伴奏。

## 功能

- MIDI 导入与钢琴卷帘编辑
- 中文 / 日语歌词编辑
- AI 歌声合成（DiffSinger）
- AI 音色转换（SeedVC，可选）
- 钢琴、小提琴、鼓等乐器轨道
- 多轨播放与导出

## 架构概览

项目由三个服务组成：

| 服务 | 端口 | 说明 |
|------|------|------|
| 前端（Vite） | 3000 | 浏览器界面，仓库自带 |
| DiffSinger 后端 | 5000 | 歌声合成引擎，需从 Releases 下载 |
| SeedVC 服务 | 5001 | 音色转换引擎，需手动搭建（可选） |

## 环境要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| [Node.js](https://nodejs.org/) | LTS | 前端开发服务器 |
| [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) | 8.0+ | DiffSinger 后端运行时 |
| [Python](https://www.python.org/downloads/release/python-31011/) | 3.10 | SeedVC 服务（可选） |
| [Git](https://git-scm.com/) | - | 克隆仓库 |
| NVIDIA GPU | GTX 1060+ | SeedVC 推理加速（强烈建议） |

> DiffSinger 后端在 CPU 上即可运行。SeedVC 支持 CPU 但推理速度较慢，建议使用 NVIDIA GPU。

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/Marigold1122/melody-singer.git
cd melody-singer
```

> 建议项目路径为纯英文且不含空格。

### 2. 安装前端依赖

```bash
npm install
```

国内用户如遇下载缓慢，可切换镜像源：

```bash
npm config set registry https://registry.npmmirror.com
```

### 3. 下载 DiffSinger 后端

后端体积较大，通过 [Releases](https://github.com/Marigold1122/melody-singer/releases) 分发。

1. 前往 Releases 页面下载最新版后端压缩包
2. 解压到项目根目录下的 `server/` 文件夹
3. 确认 `server/DiffSingerApi.exe` 存在

> 如果解压后出现 `server/server/` 嵌套目录，请将内容上移一层。

### 4. 放置歌手模型（声库）

将 DiffSinger 声库放入 `server/voicebanks/` 下，每个歌手为独立子文件夹：

```
server/voicebanks/
  kiritan/
    character.yaml
    dsconfig.yaml
    *.onnx
    dsdur/
    dspitch/
    dsvariance/
    dsvocoder/
```

注意事项：
- 保持歌手文件夹的完整结构，不要打散文件
- 不要放入 `server/Singers/` 或 `public/samples/`（用途不同）

> 兼容 DiffSinger 格式的声库可在 [OpenUtau](https://github.com/stakira/OpenUtau) 社区获取。

### 5. 启动服务

**分步启动（推荐首次使用）：**

```bash
# 终端 1 — 启动后端
start-server.bat

# 终端 2 — 启动前端
npm run dev
```

**一键启动（确认各服务正常后）：**

```bash
dev.bat
```

### 6. 验证

- 前端：http://localhost:3000 — 看到界面即成功
- 后端：http://localhost:5000/api/voicebanks — 返回歌手列表即成功
- SeedVC：http://localhost:5001/health — 返回 `{"status":"ok"}` 即成功

## SeedVC 音色转换（可选）

如需音色转换功能，按以下步骤搭建 SeedVC 环境。

### 安装

```bash
# 克隆 Seed-VC
git clone https://github.com/Plachtaa/seed-vc.git external/seed-vc
cd external/seed-vc

# 创建虚拟环境
python -m venv .venv

# 激活虚拟环境
# CMD:
.venv\Scripts\activate
# PowerShell:
.venv\Scripts\Activate.ps1

# 安装 PyTorch（NVIDIA GPU）
pip install torch==2.4.1+cu124 torchvision==0.19.1+cu124 torchaudio==2.4.1+cu124 --index-url https://download.pytorch.org/whl/cu124

# 安装依赖
pip install -r requirements.txt
pip install fastapi uvicorn python-multipart

# 回到项目根目录启动服务
cd ../..
scripts\start-seedvc-service.bat
```

> 无 NVIDIA GPU 的环境可将 PyTorch 安装命令替换为 `pip install torch torchvision torchaudio`。

> 首次启动会自动下载约 1.4 GB 模型文件，期间终端无输出属正常现象，请耐心等待。

> PowerShell 如提示脚本执行策略限制，执行 `Set-ExecutionPolicy -Scope Process Bypass` 后重试。

## 使用流程

1. 打开 http://localhost:3000
2. **文件** → 导入 MIDI
3. 在轨道区域右键 → 新建轨道
4. 点击轨道声源按钮，切换为 **人声**
5. 双击轨道打开编辑器，选择语言（中文 / 日语）
6. 等待 AI 合成完成

### 音色转换

人声合成完成后，在右侧面板的「音色转换」区域：

1. **选择参考** → 上传参考音频（支持 wav / mp3 / flac 等）
2. 调整参数（可使用默认值）
3. **开始转换** → 等待完成
4. **应用转换后** 试听效果；**恢复原始** 可切回

## 项目结构

```
melody-singer/
├── src/                        # 前端源码
│   ├── host/                   #   主界面逻辑
│   ├── voice-runtime/          #   人声编辑器运行时
│   ├── modules/                #   核心模块（播放、渲染、MIDI）
│   ├── ui/                     #   UI 组件（钢琴卷帘等）
│   └── config/                 #   配置与常量
├── public/samples/             # 乐器采样（钢琴、小提琴、鼓）
├── scripts/seedvc_service/     # SeedVC 本地服务
├── server/                     # [需下载] DiffSinger 后端
│   └── voicebanks/             # [需下载] 歌手模型
├── external/seed-vc/           # [需下载] Seed-VC 代码与环境
├── dev.bat                     # 一键启动
├── start-server.bat            # 单独启动后端
└── vite.config.js              # Vite 配置
```

## 常见问题

| 问题 | 排查方向 |
|------|----------|
| `localhost:5000` 无响应 | 确认 `server/DiffSingerApi.exe` 存在、.NET 8 已安装、端口未被占用 |
| `/api/voicebanks` 返回空数组 | 检查声库是否在 `server/voicebanks/` 下，目录层级是否正确 |
| `npm install` 缓慢 | 切换镜像源：`npm config set registry https://registry.npmmirror.com` |
| SeedVC 启动后无输出 | 首次需下载 ~1.4 GB 模型，等待即可 |
| 右侧无「音色转换」面板 | 需先将轨道切为人声、选择语言、完成一次合成 |
| SeedVC 转换缓慢 | 建议使用 NVIDIA GPU，CPU 推理速度较慢 |
| PowerShell 脚本执行受限 | `Set-ExecutionPolicy -Scope Process Bypass` |

## 技术栈

- 前端：Vanilla JavaScript + Vite
- 后端：.NET 8（DiffSinger API，基于 OpenUtau）
- 音色转换：Python + PyTorch（Seed-VC）
- 音频：Web Audio API + Tone.js

## License

本仓库当前未单独附带代码许可证文件。所使用的歌手模型与 AI 引擎各有独立的许可条款，请注意遵守；公开分发前请自行确认相关授权。

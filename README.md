# Melody Singer

基于 DiffSinger 的浏览器端 AI 歌声合成工作站。

导入 MIDI、填写歌词，即可通过 AI 合成歌声。项目同时支持多轨编辑、乐器伴奏，以及可选的 SeedVC 音色转换。

## 功能

- MIDI 导入与钢琴卷帘编辑
- 中文 / 日语歌词编辑
- AI 歌声合成（DiffSinger）
- AI 音色转换（SeedVC，可选）
- 钢琴、小提琴、鼓等乐器轨道
- 多轨播放与导出

## 架构

项目由三部分组成：

| 组件 | 端口 | 说明 |
| --- | --- | --- |
| 前端（Vite） | 3000 | 浏览器界面，仓库自带 |
| DiffSinger 后端运行时 | 5000 | 预编译包可从 Releases 下载，也可由仓库内源码构建 |
| SeedVC 服务 | 5001 | 音色转换服务，源码在仓库内，运行环境需手动搭建 |

仓库当前同时包含以下源码：

- 前端源码：`src/`
- DiffSinger 后端源码：`server/DiffSingerApi/`
- 后端依赖的 OpenUtau 源码子集：`OpenUtau/OpenUtau.Core/`、`OpenUtau/OpenUtau.Plugin.Builtin/`
- SeedVC 本地服务源码：`scripts/seedvc_service/`

说明：

- 仓库跟踪的是后端源码，不跟踪大体积运行时文件、声库、输出缓存。
- 运行 `start-server.bat` / `dev.bat` 时，仍然需要根目录下存在可执行运行时 `server/DiffSingerApi.exe`。
- 这个运行时可以从 Releases 下载，也可以由仓库内源码自行生成。

## 环境要求

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | LTS | 前端开发服务器 |
| [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) | 8.0+ | 构建 / 调试 DiffSinger 后端 |
| [Python](https://www.python.org/downloads/release/python-31011/) | 3.10 | SeedVC 服务（可选） |
| [Git](https://git-scm.com/) | - | 克隆仓库 |
| NVIDIA GPU | GTX 1060+ | SeedVC 推理加速（强烈建议） |

> DiffSinger 后端可在 CPU 上运行。SeedVC 也支持 CPU，但推理速度通常较慢。

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/Marigold1122/melody-singer.git
cd melody-singer
```

> 建议项目路径使用纯英文且不含空格。

### 2. 安装前端依赖

```bash
npm install
```

国内用户如遇下载缓慢，可切换镜像源：

```bash
npm config set registry https://registry.npmmirror.com
```

### 3. 准备 DiffSinger 后端运行时

你可以任选一种方式：

#### 方式 A：下载预编译运行时

1. 前往 [Releases](https://github.com/Marigold1122/melody-singer/releases) 下载最新版后端压缩包
2. 解压到项目根目录下的 `server/` 文件夹
3. 确认 `server/DiffSingerApi.exe` 存在

> 如果解压后出现 `server/server/` 嵌套目录，请将内容上移一层。

#### 方式 B：从仓库源码构建运行时

仓库已包含后端源码和其所需的 OpenUtau 源码子集，可直接构建：

```bash
dotnet publish server/DiffSingerApi/DiffSingerApi.csproj -c Release -o server
```

构建完成后，根目录下应出现：

```text
server/
  DiffSingerApi.exe
  DiffSingerApi.dll
  DiffSingerApi.runtimeconfig.json
  ...
```

### 4. 放置歌手模型（声库）

将 DiffSinger 声库放入 `server/voicebanks/` 下，每个歌手为独立子文件夹：

```text
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
- 不要放入 `server/Singers/` 或 `public/samples/`

### 5. 启动服务

#### 运行预编译后端

```bash
# 终端 1
start-server.bat

# 终端 2
npm run dev
```

#### 调试后端源码

```bash
dev-source.bat
```

这个脚本会直接从 `server/DiffSingerApi/` 运行 `dotnet run`，同时启动前端开发服务器。

#### 一键启动预编译运行时

```bash
dev.bat
```

### 6. 验证

- 前端：<http://localhost:3000>
- 后端：<http://localhost:5000/api/voicebanks>
- SeedVC：<http://localhost:5001/health>

## SeedVC 音色转换（可选）

如需音色转换功能，按以下步骤搭建 SeedVC 环境。

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

## 项目结构

```text
melody-singer/
  src/                              # 前端源码
  public/samples/                   # 乐器采样
  scripts/seedvc_service/           # SeedVC 本地服务源码
  server/DiffSingerApi/             # DiffSinger 后端源码
  OpenUtau/OpenUtau.Core/           # 后端依赖的 OpenUtau Core 源码子集
  OpenUtau/OpenUtau.Plugin.Builtin/ # 后端依赖的 OpenUtau 插件源码子集
  dev.bat                           # 一键启动预编译运行时
  dev-source.bat                    # 一键启动源码调试环境
  start-server.bat                  # 单独启动预编译后端
```

## 常见问题

| 问题 | 排查方向 |
| --- | --- |
| `localhost:5000` 无响应 | 确认根目录 `server/DiffSingerApi.exe` 存在，或使用 `dev-source.bat` 从源码启动 |
| `/api/voicebanks` 返回空数组 | 检查 `server/voicebanks/` 下是否至少有一个有效声库 |
| `dotnet publish` 失败 | 确认 .NET 8 SDK 已安装，且可访问 NuGet |
| `npm install` 缓慢 | 切换镜像源：`npm config set registry https://registry.npmmirror.com` |
| SeedVC 启动后无输出 | 首次可能在后台下载较大模型，等待即可 |

## 技术栈

- 前端：Vanilla JavaScript + Vite
- 后端：.NET 8 + ASP.NET Core + DiffSinger API
- 后端依赖：OpenUtau Core / Plugin.Builtin（源码子集已随仓库提供）
- 音色转换：Python + PyTorch + SeedVC
- 音频：Web Audio API + Tone.js

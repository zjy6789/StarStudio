# Star Studio

<img src="plugin/icon@2x.png" width="72" alt="Star Studio 图标">

**在 Photoshop 中完成星空堆栈、星点分离、星点加工和重混合。照片在你的电脑上处理。**

[下载安装包](https://github.com/zjy6789/StarStudio/releases) · [报告问题](https://github.com/zjy6789/StarStudio/issues) · [第三方来源与许可](THIRD_PARTY.md)

Star Studio is a local astrophotography plugin for Adobe Photoshop on Windows. The installer includes Python, image-processing dependencies and the MIT-licensed Starrem2k13 model. No separate Python installation or cloud account is required. This prerelease has not yet completed Photoshop UI validation; see [validation status](VALIDATION.md).

> 当前为 **0.5.0 Beta 预发布**。新安装包与星点加工页面尚未完成 Photoshop 原生端到端验证，不能视为稳定版。历史验证范围见 [VALIDATION.md](VALIDATION.md)。

## 系统要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11，x64。当前没有 macOS / Windows ARM 原生安装包。 |
| Photoshop | **2024（25.0）或更新版本**，使用 UXP Imaging API；历史原生验证环境为 Photoshop 2026（27.1），其他版本尚未逐个验证。 |
| 安装组件 | 已安装 Adobe Creative Cloud 桌面应用，且至少启动过一次 Photoshop。 |
| 内存与磁盘 | 建议 16 GB 内存；全尺寸大批量 RAW 建议 32 GB 及 SSD。缓存需求随分辨率和堆栈模式变化。 |
| 相机 RAW | 由捆绑的 LibRaw 支持；DNG 在 Photoshop 中的打开方式由 Camera Raw 决定。 |

无需安装 Python、CUDA、Siril 或 StarNet，即可使用堆栈、默认星点分离、曲线、星点缩小、辉光、饱和度和重混合。**彗差减少单项功能需要另装 Siril 1.4.x**。

## 安装与更新

1. 从 [Releases](https://github.com/zjy6789/StarStudio/releases) 下载 `StarStudio-版本-Windows-x64-Setup.exe`。Beta 请选择标有 **Pre-release** 的条目；“Source code” 压缩包是源码，不是安装包。
2. 双击安装程序。它将处理组件、模型和面板放到 `%LOCALAPPDATA%\StarStudio`，生成本机专属配置，并调用 Adobe 安装工具安装面板。写入本项目目录不需要管理员权限；Adobe 的安装策略可能另外要求确认或提权。
3. 在 Photoshop 打开 **增效工具 → Star Studio → Star Studio**（英文：Plugins → Star Studio）。若新面板尚未出现，保存工作后重新打开 Photoshop。
4. 首次使用时允许插件启动本机处理组件。之后从 Photoshop 打开面板即可，无需运行 CMD 或保持服务窗口。

安装程序目前没有代码签名；请从本仓库 Release 下载，并可用 `SHA256SUMS.txt` 核对内容。Windows 或 Adobe 可能显示外部插件安装确认；安装程序不会绕过它们。[Adobe CCX 安装说明](https://developer.adobe.com/uxp/guides/how-to/distribution/install/)

**更新：**关闭 Star Studio 面板并等待至少 90 秒，让空闲组件退出，再运行新版安装程序。本机令牌保留；工作期间不要更新正在使用的组件。

**卸载：**在 Creative Cloud → 插件管理中卸载 Star Studio。关闭面板、等待后台退出后，可删除 `%LOCALAPPDATA%\StarStudio`，一并清除临时缓存与日志；不影响另存到其他目录的照片。项目不设置开机自启、登录自启或系统服务。

**安装失败：**查看 `%LOCALAPPDATA%\StarStudio\artifacts\install.log`，确认 Creative Cloud 已安装且 Photoshop 满足版本要求；也可双击安装目录内自动生成的 `StarStudio.ccx`，通过 Creative Cloud 重试。单独分享这份 CCX 无法为另一台电脑提供完整运行环境，请分享 Release 的 EXE。

## 从堆栈到重混合

面板按工作流排列：**堆栈 → 星点分离 → 星点加工 → 星点重混合**。图层自动同步，星点加工及重混合的来源由用户自己选择。

### 1. 堆栈

在面板选择多张照片或文件夹；输入素材无需预先在 Photoshop 打开。

- 模式包含均值、中间值、Sigma 裁剪均值、最大值、最小值。降噪通常从均值开始；最大/最小值用于特殊合成，不保证降噪。
- 素材按自然文件名排序，以排序后的中间一张为基准。纯星空直接配准；带地景模式排除检测到的跨帧固定特征，只对齐星空。
- 固定地景检测不是语义分割。可用画笔涂抹山脊、灯光等区域，排除其参与星点匹配。蒙版不删除像素；地景随天空变换，允许拖影。
- 选择输出位置及格式，完成后只在 Photoshop 打开堆栈结果。原始照片保持不变。

| 输出格式 | 信息与用途 |
| --- | --- |
| **DNG**（RAW 默认） | 32 位浮点 **LinearRaw DNG**，保存去马赛克后的相机线性 RGB、色彩矩阵及白平衡；不是原 CFA RAW 的无损替代。Camera Raw 可能以 16 位文档打开。 |
| **32 位浮点 TIFF** | 带线性 ProPhoto RGB ICC，保留负值及超过 1 的高光；适合直接在 Photoshop 中保留 32 位处理空间。 |
| **16 位 TIFF** | 最后一次量化，负值截零；必要时全图统一缩放以保留高光比例。缩放、截断和配准信息写入同名 JSON。 |

请保留原片。RAW 使用线性 AHD 去马赛克，不自动提亮、不逐帧白平衡或曝光归一化；16 位解码后转为浮点，均值以 64 位累加。去马赛克、解码与重采样本身仍有损失；后续不做 8 位往返或显示拉伸。面板拉伸只影响预览。

均值/最大/最小逐帧累积；中间值与 Sigma 使用磁盘缓存、分块统计。**100 张 2400 万像素 RGB 浮点帧仅对齐帧缓存约 26.8 GiB**，另需工作空间和输出文件。小图预览速度不能代表全尺寸 RAW 速度。

无 ICC 的 TIFF 假定为线性 ProPhoto RGB；JPEG/PNG 无 ICC 时按 sRGB 解码。暂不支持 LUT ICC、透明堆栈素材、不同尺寸或不同相机混合。详细精度与色彩约定见 [处理说明](docs/PROCESSING.md)。

### 2. 星点分离

在 Photoshop 中打开照片，选择来源图层，点击 **执行星点分离**。

- 生成 `XXX_starless` 背景和 `XXX_starmask` 星点图层，保留原始 `XXX`。星点图层初始隐藏，便于直接查看背景。
- 默认 **Starrem2k13**，模型已随源码和安装包提供。需要 StarNet 时展开「星点提取模型」并指定 CLI 位置。
- 支持滤色和相加分离；重混合应选择与分离相同的方式。
- 模型可能改变星云、星晕或地景细节；Starrem2k13 上游训练样本较少，质量须按照片评估，必要时用原图局部修正。

图层操作支持 RGB / 灰度、8 / 16 / 32 位普通范围像素。32 位 HDR 若超出 `0..1` 会报错，须先映射到普通范围；这与允许超范围高光的 RAW 堆栈流程不同。新图层保持文档尺寸、颜色配置与透明度；智能对象输出为新的像素图层。

### 3. 星点加工

手动选择星点图层。点击功能展开参数，启用需要的效果；完成后生成新的 `_processed` 图层。

| 功能 | 参数与用途 |
| --- | --- |
| 亮度曲线 | 阴影、中间调、高光锚点及曝光 |
| 星点缩小 | 半径与强度；按亮度缩小并保留颜色比例 |
| 彗差减少 | Siril 星点检测与圆星重建、强度及形状阈值；需要 Siril 1.4.x |
| 辉光 | 柔焦亮星扩散；强度、半径、亮度上下阈值及过渡柔度 |
| 饱和度 | 星点颜色增强及高光保护 |

支持原图/效果预览及 Photoshop 画布预览。彗差减少针对检测到的拉长星点做圆星重建，属于外观修整，不等同于恢复真实光学 PSF 或原始测光信息。

### 4. 星点重混合

分别手动选择背景与星点图层，预览会自动加载；调整后点击 **执行重混合**，生成新的结果图层。

两侧各有 ln(D+1)、局部拉伸强度 b、拐点 SP、高光保护 HP 和黑点 BP。高级选项提供阴影保护 LP、GHS / 改进 arcsinh / 线性拉伸、亮度 / 独立 RGB 通道、颜色越界处理和可连续应用的拉伸链。

面板显示两侧直方图、曲线及较大的合成预览，可切换到 **Photoshop 画布预览**。预览最长边为 1600 像素以减少传输；最终图层使用原尺寸。面板 PNG 不嵌入文档 ICC，颜色以 Photoshop 画布为准。

## 引擎、上游与升级

| 引擎/库 | 用途 | 随包提供 | 原项目 / 最新版 |
| --- | --- | --- | --- |
| Starrem2k13 | 默认星点提取 | **是**，MIT ONNX 模型及许可 | [源码与模型](https://github.com/code2k13/starrem2k13) |
| StarNet v2 CLI | 可选星点提取 | 否，支持外部 CLI | [官方 CLI 下载](https://starnetastro.com/cli-tools/) |
| Siril | 彗差减少 CLI、重混合数学来源 | GPL 参考源码；CLI 另装 | [源码](https://gitlab.com/free-astro/siril) · [下载](https://siril.org/download/) |
| Astroalign / SEP / OpenCV | 匹配、检测及重采样 | 是，随运行环境 | [Astroalign](https://github.com/quatrope/astroalign) · [SEP](https://github.com/sep-developers/sep) · [OpenCV](https://github.com/opencv/opencv) |
| rawpy / LibRaw | RAW 解码 | 是，随运行环境 | [rawpy](https://github.com/letmaik/rawpy) · [LibRaw](https://www.libraw.org/download) |

StarNet 不按本项目 GPL 许可发布，个人非商用不等于获得其源码或权重的再分发授权。本项目不重打包 StarNet；请从官网获取并遵循其条款。适配器对应旧版 **v2.0.2 `starnet++.exe`** 接口，不能承诺任意新版命令直接兼容。

可将完整 Siril 或 StarNet 目录放到安装目录内 `engines/siril/` 或 `engines/starnet/`；Siril 也支持系统安装，StarNet 也可在面板选择其他位置。目录结构和版本要求见 [引擎配置](engines/README.md)。

Starrem 模型位于 `vendor/starrem2k13/weights/model.onnx`，已固定哈希。自行替换时须确保输入输出约定兼容；上游最新版不一定格式相同。构建脚本核对固定模型，避免误打包未知权重。

## 隐私与后台组件

照片不上传云端。组件仅监听 `127.0.0.1:8765`，安装时生成独立随机令牌；使用插件时按需启动，空闲且无任务时约 90 秒退出。不设置开机自启、登录自启或系统服务。

UXP 网络声明为 `domains: "all"`，用于兼容部分 Photoshop 对回环域名声明的限制；代码将图像请求限制为上述本机回环地址。发行包不含用户照片或预生成令牌。

临时像素、缓存与日志位于安装目录 `artifacts/`，不自动上传。组件退出后可清理，任务期间不要删除。反馈日志前请检查是否含不愿公开的文件路径。

## 从源码运行 / 构建

开发环境：Windows x64、Python **3.12**、Git；JavaScript 检查另需 Node.js。普通用户请使用 Release。

```powershell
git clone https://github.com/zjy6789/StarStudio.git
cd StarStudio
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe tools\install.py
```

最后一条生成本机配置、启动器和 CCX，并通过 Adobe UPIA 安装。也可生成配置后使用 UXP Developer Tool 加载 `plugin/manifest.json`。不要分享或提交含有本机令牌的 `plugin/bridge.json`。

构建可分享的独立安装包（不会安装到 Photoshop，也不会启动照片处理）：

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-build.txt
.venv\Scripts\python.exe tools\build_release.py --tag v0.5.0-beta.1
```

输出在 `dist/`：Windows EXE、LGPL 对应源码归档与 SHA256 清单。构建会下载与捆绑库版本对应的第三方源码，安装及日常处理无需这些下载。项目完整源码和构建脚本由对应 Git 标签提供。

开发检查（不属于普通安装步骤）：

```powershell
.venv\Scripts\python.exe -m pytest -q
node --test tests\test_preview.js
```

`tools/` 的 smoke/native 脚本会实际处理图像，部分需要本地测试素材、Photoshop 或外部引擎；不要把它们作为安装步骤。持续集成不能代替 Photoshop 原生验证。

## 许可与反馈

项目自有代码按 **GPL-3.0-or-later** 发布。第三方署名、许可及对应源码见 [THIRD_PARTY.md](THIRD_PARTY.md)，安装目录 `licenses/` 和 `vendor/` 保留原许可。Release 同时提供 LGPL 对应源码，允许按许可修改、调试及重建相关库。

反馈请说明系统 / Photoshop / 插件版本、引擎、图像格式与位深、复现步骤和错误文字。性能问题另补充素材数量、尺寸、模式、内存及缓存磁盘。无需公开原片，可先用愿意分享的局部或合成素材。

This product includes DNG technology under license by Adobe. Photoshop、Camera Raw 与 Creative Cloud 是 Adobe 的产品；本项目为独立开源项目。

# Star Studio

<img src="plugin/icon@2x.png" width="72" alt="Star Studio 图标">

**在 Photoshop 中完成星空堆栈、星点分离与星点加工，用图层混合查看星点和背景的效果。照片在你的电脑上处理。**

[下载安装包](https://github.com/zjy6789/StarStudio/releases) · [报告问题](https://github.com/zjy6789/StarStudio/issues) · [第三方来源与许可](THIRD_PARTY.md)

Star Studio is a local astrophotography plugin for Adobe Photoshop on Windows. The installer includes Python and image-processing dependencies. Star removal requires a separate StarNet++ CLI installation; see the instructions below. Star-processing controls, previews and layer output have been checked in Photoshop 2026; see [validation status](VALIDATION.md).

> 当前为 **0.6.0 Beta 预发布**。星点加工页面已在 Photoshop 2026 完成原生验证；干净电脑安装及其他 Photoshop 版本尚未验证。详见 [VALIDATION.md](VALIDATION.md)。

> 0.6.0 安装包包含堆栈校准场与 FITS 输出，已验证数值及真实 RAW 暗场/偏置处理。使用规则见 [校准说明](docs/CALIBRATION.md)，测试结果和剩余范围见 [验证记录](VALIDATION.md)。需要在 Siril 继续处理时请选择 32 位 FITS；Siril 1.4.2 不能完整读取本插件 16 位 FITS 的缩放浮点范围。

> 0.6.0 关闭独立的星点重混合页面，改为在星点加工中选择背景和 Photoshop 混合模式，自动打开全分辨率预览；支持新版 StarNet GPU CLI 和可选彩色残留修正。验证范围见 [VALIDATION.md](VALIDATION.md)。

## 系统要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10 / 11，x64。当前没有 macOS / Windows ARM 原生安装包。 |
| Photoshop | **2024（25.0）或更新版本**，使用 UXP Imaging API；历史原生验证环境为 Photoshop 2026（27.1），其他版本尚未逐个验证。 |
| 安装组件 | 已安装 Adobe Creative Cloud 桌面应用，且至少启动过一次 Photoshop。 |
| 内存与磁盘 | 建议 16 GB 内存；全尺寸大批量 RAW 建议 32 GB 及 SSD。缓存需求随分辨率和堆栈模式变化。 |
| 相机 RAW | 由捆绑的 LibRaw 支持；DNG 在 Photoshop 中的打开方式由 Camera Raw 决定。 |

无需安装 Python 或 CUDA，即可使用堆栈、曲线、星点缩小、辉光、饱和度和图层混合预览。**星点分离需要另装 StarNet++ CLI；彗差减少需要另装 Siril 1.4.x**。两个外部引擎独立配置，不影响其余功能。

## 安装与更新

1. 从 [Releases](https://github.com/zjy6789/StarStudio/releases) 下载 `StarStudio-版本-Windows-x64-Setup.exe`。Beta 请选择标有 **Pre-release** 的条目；“Source code” 压缩包是源码，不是安装包。
2. 双击安装程序。它将处理组件和面板放到 `%LOCALAPPDATA%\StarStudio`，生成本机专属配置，并调用 Adobe 安装工具安装面板。写入本项目目录不需要管理员权限；Adobe 的安装策略可能另外要求确认或提权。
3. 在 Photoshop 打开 **增效工具 → Star Studio → Star Studio**（英文：Plugins → Star Studio）。若新面板尚未出现，保存工作后重新打开 Photoshop。
4. 首次使用时允许插件启动本机处理组件。之后从 Photoshop 打开面板即可，无需运行 CMD 或保持服务窗口。

安装程序目前没有代码签名；请从本仓库 Release 下载，并可用 `SHA256SUMS.txt` 核对内容。Windows 或 Adobe 可能显示外部插件安装确认；安装程序不会绕过它们。[Adobe CCX 安装说明](https://developer.adobe.com/uxp/guides/how-to/distribution/install/)

**更新：**关闭 Star Studio 面板并等待至少 90 秒，让空闲组件退出，再运行新版安装程序。本机令牌保留；工作期间不要更新正在使用的组件。

**卸载：**在 Creative Cloud → 插件管理中卸载 Star Studio。关闭面板、等待后台退出后，可删除 `%LOCALAPPDATA%\StarStudio`，一并清除临时缓存与日志；不影响另存到其他目录的照片。项目不设置开机自启、登录自启或系统服务。

**安装失败：**查看 `%LOCALAPPDATA%\StarStudio\artifacts\install.log`，确认 Creative Cloud 已安装且 Photoshop 满足版本要求；也可双击安装目录内自动生成的 `StarStudio.ccx`，通过 Creative Cloud 重试。单独分享这份 CCX 无法为另一台电脑提供完整运行环境，请分享 Release 的 EXE。

### 安装 StarNet++ 星点分离引擎

StarNet++ 只需配置一次。它是外部程序，本项目不随包分发；无需把原始照片交给 StarNet 的界面打开。

1. 打开 [StarNet 官方 CLI 下载页](https://starnetastro.com/cli-tools/starnet/)，下载 Windows x64 的完整 ZIP。截至 2026-10-10 为 **StarNet2 2.6.2-0242 ORT**，可用页面提供的 SHA-256 校验。
2. 将 ZIP **完整解压**到固定的英文路径，例如 `D:\AstroTools\StarNet2`。当前新版的模型加载不兼容中文引擎路径；Star Studio 项目和照片目录仍可使用中文。保留 `starnet2.exe`、`StarNet2_weights.onnx`、`LICENSE.txt` 和所有 DLL 的相对位置；不要只复制 EXE，也不要混用不同发行包的 DLL。
3. 打开 Star Studio 的 **星点分离 → 星点提取模型：StarNet**，点击“选择程序…”选中 `starnet2.exe`，也可在唯一的“StarNet 程序位置”输入框填写完整路径，不加引号。插件自动识别引擎版本。点击“查看当前引擎许可”，阅读完整条款并明确勾选同意；同一条款只需接受一次，条款改变需重新接受。路径与许可选择自动保存。
4. 保持处理步长为 **256**，选择 Photoshop 中的源图层，点击 **执行星点分离**。插件自动调用引擎并创建两个结果图层。官方 Windows 包自带 DirectML，可使用兼容 NVIDIA / AMD / Intel GPU；不可用时自动回退 CPU，无需另装 CUDA 或 cuDNN。实际执行设备见任务缓存目录中的 `starnet.log`，不是仅依据显卡型号判断。

**选择 CPU 版：**可在 [官方旧版 CLI 下载页](https://starnetastro.com/cli-tools/legacy/)下载 `StarNetv2CLI_Win.zip`，完整解压到另一个目录，在同一个“StarNet 程序位置”选择 `starnet++.exe` 即可。插件自动使用旧接口；已为 Siril 配置的同版目录可以复用。它使用旧版 v2.0.2 模型/运行库，处理效果可能与新版不同。新版 2.6.2 CLI 没有公开强制选择 CPU 的参数，自带的 CPU 回退仍可用。

更新时先保留可用目录，再从官方源下载完整发行包并切换路径；不要覆盖仍在使用的引擎。若提示“找不到 StarNet”或权重加载失败，检查 EXE 路径、完整解压目录及发行包 README。新版最低尺寸为 512 × 512，插件对较小图层反射补边，完成后还原原尺寸。Star Studio 仍只处理 `0..1` 普通范围像素，不会自动裁掉堆栈的超范围高光。

**独立官方 PS 面板：**可从 [StarNet2 Photoshop 下载页](https://starnetastro.com/ps-plugins/starnet/)下载 CCX，通过 Creative Cloud 安装；目前为 **1.0.4-0005**，要求 Photoshop **26.11.7 或更新**。从 **增效工具 → StarNet2 → StarNet2** 打开，与 Star Studio 独立共存、自带模型，无需 CLI 路径。官方面板支持已拉伸的 8/16 位 RGB/灰度，暂不支持线性或 32 位图片；比较效果时应使用同一图片和参数。[官方安装说明](https://starnetastro.com/ps-plugins/installation/)

## 从堆栈到星点加工

面板按工作流排列：**堆栈 → 星点分离 → 星点加工**。图层自动同步，星点和预览背景都由用户自己选择。星点加工通过 Photoshop 原生图层混合展示合成效果，不再提供独立的星点重混合页面。

### 1. 堆栈

在面板选择多张照片或文件夹；输入素材无需预先在 Photoshop 打开。

- 模式包含均值、中间值、Sigma 裁剪均值、最大值、最小值。降噪通常从均值开始；最大/最小值用于特殊合成，不保证降噪。
- 素材按自然文件名排序，以排序后的中间一张为基准。纯星空直接配准；带地景模式排除检测到的跨帧固定特征，只对齐星空。
- 固定地景检测不是语义分割。可用画笔涂抹山脊、灯光等区域，排除其参与星点匹配。蒙版不删除像素；地景随天空变换，允许拖影。
- 选择输出位置及格式，完成后只在 Photoshop 打开堆栈结果。原始照片保持不变。
- 展开 **校准场（可选）**，分别选择暗场、平场、偏置场的多张文件或文件夹，可任意清除；较长曝光平场可增加匹配的平暗场。全部不选时使用原有流程。暗场可以单独使用；平场先去偏置或匹配平暗场，未提供时 Bayer RAW 使用自带黑电平近似。暗场不自动缩放，需匹配曝光、ISO/增益与温度。[组合与拍摄要求](docs/CALIBRATION.md#可选组合与依赖)

| 输出格式 | 信息与用途 |
| --- | --- |
| **DNG**（默认） | 32 位浮点 **LinearRaw DNG**，保存去马赛克后的相机线性 RGB、色彩矩阵及白平衡；不是原 CFA RAW 的无损替代。Camera Raw 可能以 16 位文档打开。 |
| **32 位浮点 TIFF** | 带线性 ProPhoto RGB ICC，保留负值及超过 1 的高光；适合直接在 Photoshop 中保留 32 位处理空间。 |
| **16 位 TIFF** | 最后一次量化，负值截零；必要时全图统一缩放以保留高光比例。缩放、截断和配准信息写入同名 JSON。 |
| **32 位 FITS** | 线性 RGB 浮点三平面，保留负值与高光；颜色与校准元数据在 FITS 扩展中。Photoshop 通过临时 32 位 TIFF 打开结果。 |
| **16 位 FITS** | 缩放整数，以 BSCALE/BZERO 保存完整正负值范围，仍有量化；Photoshop 通过量化前结果生成的临时 32 位 TIFF 打开。 |

请保留原片。未使用校准场的 RAW 沿用线性 AHD 去马赛克与 16 位解码后转浮点的路径。使用校准场的 Bayer RAW 在未去马赛克的 float32 传感器平面，复用 ccdproc 完成校准，再用开源 Colour Malvar 算法做浮点去马赛克，保留负值和超范围高光；均值仍以 float64 累加。不自动提亮、不逐帧白平衡或曝光归一化，不做 8 位往返或显示拉伸。去马赛克、重采样与有限精度计算仍有边界，不能宣称全过程无损。面板拉伸只影响预览。

校准支持原始 RGB Bayer RAW，以及明确声明已线性显影、去黑电平的 16/32 位 TIFF；不接受 JPEG/PNG、非线性 TIFF、已去马赛克的 DNG 或 X-Trans 作为校准输入。主校准场一次合成、浮点分块与磁盘缓存，记录来源及参数，不修改输入素材。FITS 保存后只打开临时 TIFF 结果，后续 Photoshop 编辑请另存 PSD/TIFF；不需要在 Photoshop 打开亮场或校准场原片。

均值/最大/最小逐帧累积；中间值与 Sigma 使用磁盘缓存、分块统计。**100 张 2400 万像素 RGB 浮点帧仅对齐帧缓存约 26.8 GiB**，另需工作空间和输出文件。小图预览速度不能代表全尺寸 RAW 速度。

无 ICC 的 TIFF 假定为线性 ProPhoto RGB；JPEG/PNG 无 ICC 时按 sRGB 解码。暂不支持 LUT ICC、透明堆栈素材、不同尺寸或不同相机混合。详细精度与色彩约定见 [处理说明](docs/PROCESSING.md)。

### 2. 星点分离

在 Photoshop 中打开照片，选择来源图层，点击 **执行星点分离**。

- 生成 `XXX_starless` 背景和 `XXX_starmask` 星点图层，保留原始 `XXX`。星点图层初始隐藏，便于直接查看背景。
- 首次使用前按上面的 [StarNet 安装步骤](#安装-starnet-星点分离引擎)配置 CLI 位置及许可；之后直接执行。
- 支持滤色和相加分离；在星点加工中选择对应的滤色或线性减淡（添加）混合模式，可查看还原效果。
- 如果星点周围出现明显彩色暗圈，可勾选 **保留模型背景（减少彩色残留）**，然后重新执行分离。默认关闭，不追加模糊或第二次去星推理；它保留模型填回的背景，并将正负差值保存到星点层。模型本身的残留仍可能存在。
- 勾选后，8/16 位星点层使用灰底编码并自动设为 **线性光**；32 位使用浮点差值和 **线性减淡（添加）**。灰底层请保留线性光模式，星点加工会自动识别、解码并只调整正星点信号，负修正保留。建议使用16/32位：灰底整数编码仍有量化，不能称为无损。详细对照与精度见[彩色残留调查](docs/STAR_REMOVAL_ARTIFACTS.md)。
- 模型可能改变星云、星晕或地景细节；请放大检查，必要时用原图局部修正。
- 默认步长256；在「星点提取模型」中，新版可选384，适合广域小星点。128/64会明显增加计算量。步长会改变去星效果，不等同于纯性能开关；选择建议见[官方文档](https://starnetastro.com/documentation/starnet/tips-and-tricks/)。
- 新版推理显示实际 GPU/CPU 后端与进度；完成后列出读取、引擎和写回时间，释放临时像素缓存。分离始终使用完整尺寸，新版用 float32 FITS 中转。

图层操作支持 RGB / 灰度、8 / 16 / 32 位普通范围像素。32 位 HDR 若超出 `0..1` 会报错，须先映射到普通范围；这与允许超范围高光的 RAW 堆栈流程不同。新图层保持文档尺寸、颜色配置与透明度；智能对象输出为新的像素图层。

### 3. 星点加工

手动选择星点图层，可再选择同一源文档中的背景图层。选择星点后自动在 Photoshop 新标签页打开全分辨率预览，无需点击预览按钮；选择背景后，可边调整星点边查看它覆盖背景的效果。

混合模式使用 Photoshop 原生的 **正常、变亮、滤色、颜色减淡、线性减淡（添加）、浅色**。可用模式以当前文档位深和 Photoshop 支持为准；不会为了使用某种模式自动降低文档位深。滤色分离通常搭配滤色，相加分离搭配线性减淡（添加）；其他模式适合按需要调整外观。

点击功能展开参数，启用需要的效果。完成后执行星点加工，在源文档创建新的 `_processed` 星点图层，并自动设置为预览时选定的混合模式。背景仅用于预览，不会合并进新星点图层；原星点和背景图层保留。

| 功能 | 参数与用途 |
| --- | --- |
| 亮度曲线 | 阴影、中间调、高光锚点及曝光 |
| 星点缩小 | 半径与强度；按亮度缩小并保留颜色比例 |
| 彗差减少 | Siril 星点检测与圆星重建、强度及形状阈值；需要 Siril 1.4.x |
| 辉光 | 柔焦亮星扩散；强度、半径、亮度上下阈值及过渡柔度 |
| 饱和度 | 星点颜色增强及高光保护 |

预览保持源文档的完整像素尺寸，可使用 Photoshop 的缩放和移动观察细节。预览打开时仍可切换背景、星点、混合模式和加工参数；打开预览标签页不会把它当作新的输入文档。背景与混合模式切换由 Photoshop 直接更新，不重新计算星点效果；图层读取和加工结果会缓存，连续拖动参数时以最新设置为准。

全分辨率预览不会降采样。首次读取大图、辉光和彗差减少等计算仍可能需要等待，耗时取决于照片尺寸、参数和电脑配置；不能保证每次拖动都立即完成。彗差减少针对检测到的拉长星点做圆星重建，属于外观修整，不等同于恢复真实光学 PSF 或原始测光信息。

## 引擎、上游与升级

| 引擎/库 | 用途 | 随包提供 | 原项目 / 最新版 |
| --- | --- | --- | --- |
| StarNet++ v2 CLI | 星点提取，需单独安装 | 否，调用外部 CLI | [支持接口的旧版包](https://starnetastro.com/cli-tools/legacy/) · [官方最新版](https://starnetastro.com/cli-tools/starnet/) |
| Siril | 彗差减少 CLI | GPL 参考源码；CLI 另装 | [源码](https://gitlab.com/free-astro/siril) · [下载](https://siril.org/download/) |
| Astroalign / SEP / OpenCV | 匹配、检测及重采样 | 是，随运行环境 | [Astroalign](https://github.com/quatrope/astroalign) · [SEP](https://github.com/sep-developers/sep) · [OpenCV](https://github.com/opencv/opencv) |
| rawpy / LibRaw | RAW 解码 | 是，随运行环境 | [rawpy](https://github.com/letmaik/rawpy) · [LibRaw](https://www.libraw.org/download) |

StarNet 不按本项目 GPL 许可发布，个人非商用不等于获得其源码或权重的再分发授权。本项目不重打包 StarNet；请从官网获取并遵循其条款。适配器支持 **StarNet2 2.6.2 `starnet2.exe`** 和旧版 **v2.0.2 `starnet++.exe`**，不能承诺任意其他版本的命令直接兼容。

可将完整 Siril 或 StarNet 目录放到安装目录内 `engines/siril/` 或 `engines/starnet/`；Siril 也支持系统安装，StarNet 也可在面板选择其他位置。目录结构和版本要求见 [引擎配置](engines/README.md)。

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
.venv\Scripts\python.exe tools\build_release.py --tag v0.6.0-beta.1
```

输出在 `dist/`：Windows EXE、LGPL 对应源码归档与 SHA256 清单。构建会下载与捆绑库版本对应的第三方源码，安装及日常处理无需这些下载。项目完整源码和构建脚本由对应 Git 标签提供。

开发检查（不属于普通安装步骤）：

```powershell
.venv\Scripts\python.exe -m pip install -r requirements-test.txt
.venv\Scripts\python.exe -m pytest -q
node --test tests\test_preview.js tests\test_star_processing.js tests\test_host_write.js tests\test_model_settings.js
```

`tools/` 的 smoke/native 脚本会实际处理图像，部分需要本地测试素材、Photoshop 或外部引擎；不要把它们作为安装步骤。持续集成不能代替 Photoshop 原生验证。

## 许可与反馈

项目自有代码按 **GPL-3.0-or-later** 发布。第三方署名、许可及对应源码见 [THIRD_PARTY.md](THIRD_PARTY.md)，安装目录 `licenses/` 和 `vendor/` 保留原许可。Release 同时提供 LGPL 对应源码，允许按许可修改、调试及重建相关库。

反馈请说明系统 / Photoshop / 插件版本、引擎、图像格式与位深、复现步骤和错误文字。性能问题另补充素材数量、尺寸、模式、内存及缓存磁盘。无需公开原片，可先用愿意分享的局部或合成素材。

This product includes DNG technology under license by Adobe. Photoshop、Camera Raw 与 Creative Cloud 是 Adobe 的产品；本项目为独立开源项目。

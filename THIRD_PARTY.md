# 第三方来源与分发许可

Star Studio 自有代码按 GPL-3.0-or-later 发布，完整许可在根目录 LICENSE。以下组件保留各自版权与许可，不因随包分发而改用本项目许可。

## Siril — GPL-3.0-or-later

- [源码](https://gitlab.com/free-astro/siril) · [重混合文档](https://siril.readthedocs.io/en/stable/processing/stars/star-recomp.html) · [圆星重建文档](https://siril.readthedocs.io/en/stable/processing/stars/resynthesis.html)。
- `vendor/siril-ght.c` 保留原始版权及 GPL-3.0-or-later 声明。`backend/algorithms.py` 改写其 GHS / modified arcsinh 分段数学，保留参数、端点归一化与拉伸后黑点位移；不声称完整复制 Siril 的颜色模型。
- 彗差减少调用用户另装的 Siril 1.4.x CLI。源码和 Release 不包含 Siril 二进制。

## StarNet v2 — 星点分离的外部程序

- [官网与最新版 CLI](https://starnetastro.com/cli-tools/starnet/)。支持 StarNet2 2.6.2 的 `starnet2.exe` 命名参数/FITS 接口，以及 v2.0.2 的 `starnet++.exe` 位置参数/TIFF 接口；两者均作为外部独立进程调用。
- 本项目不包含 StarNet 程序、权重、测试样片或源码。许可证由用户获取的官方发行包提供。
- 个人非商业天文处理许可不等同于源码开源或再分发授权，StarNet 不由本项目 GPL 许可覆盖。
- 新版发行包许可（2026-09-07）要求集成明确标识 StarNet2、提供完整条款并取得用户肯定接受。面板读取用户安装目录的原文并按 SHA-256 保存接受记录，条款改变需重新接受；引擎只从官网直接下载，不随 Star Studio 分发，不直接加载模型。不将 StarNet 输出加入本项目测试样片或资产；本地集成调用检查与用户比较结果不上传仓库。

## KinoBloom — MIT

- [keijiro/KinoBloom](https://github.com/keijiro/KinoBloom)，Copyright (c) 2015–2017 Keijiro Takahashi。
- 辉光 quadratic soft knee 参考其 Bloom shader，改用 SciPy 双尺度高斯扩散；原许可在 `vendor/KINOBLOOM-LICENSE.txt`。

## 星空配准与 RAW 堆栈

| 组件 | 用途 | 许可与原项目 |
| --- | --- | --- |
| Astroalign | 三角星点匹配及变换估计 | MIT · [quatrope/astroalign](https://github.com/quatrope/astroalign) |
| SEP | 星点背景估计、检测与质心 | LGPL-3.0 · [sep-developers/sep](https://github.com/sep-developers/sep) |
| rawpy | RAW 解码 Python 接口 | MIT · [letmaik/rawpy](https://github.com/letmaik/rawpy) |
| LibRaw | RAW 解码库 | LGPL-2.1 / CDDL 双许可，分发按 LGPL-2.1 · [LibRaw](https://www.libraw.org/) |
| OpenCV | 投影精化、Lanczos4 重采样及形态学 | Apache-2.0 · [opencv/opencv](https://github.com/opencv/opencv) |
| SciPy / scikit-image | 曲线、滤波及变换估计 | BSD-3-Clause · [SciPy](https://github.com/scipy/scipy) · [scikit-image](https://github.com/scikit-image/scikit-image) |
| ccdproc 2.5.1 | 主校准场合成、偏置/暗场减法与平场校准 | BSD-3-Clause · [astropy/ccdproc](https://github.com/astropy/ccdproc/tree/2.5.1) |
| Astropy 8.0.1 | CCDData、Sigma/MAD 统计与标准 FITS I/O | BSD-3-Clause · [astropy/astropy](https://github.com/astropy/astropy/tree/v8.0.1) |
| PyWavelets 1.10.0 | scikit-image背景噪声估计的小波变换 | MIT AND BSD-3-Clause · [PyWavelets/pywt](https://github.com/PyWavelets/pywt)；完整wheel许可随包保存 |
| ExifRead 3.5.1 | 拍摄参数与相机型号读取 | BSD-3-Clause · [ianare/exif-py](https://github.com/ianare/exif-py) |
| Colour demosaicing | 校准后的浮点 Bayer Malvar 去马赛克 | BSD-3-Clause · [v0.2.6 源码](https://github.com/colour-science/colour-demosaicing/blob/v0.2.6/colour_demosaicing/bayer/demosaicing/malvar2004.py) |

`backend/demosaic.py` 适配 Colour Developers 的 Malvar2004 实现（Copyright 2015 Colour Developers），保留算法，改为 float32 分块及相位切片；原版权和完整许可保存在 `vendor/COLOUR-DEMOSAICING-LICENSE.txt`，构建脚本随包复制。ccdproc/Astropy 直接作为库调用，不独立复制其校准函数；wheel 许可继续由构建脚本收入 `licenses/`。实际研究来源与适配边界见 [校准说明](docs/CALIBRATION.md)。

Nikon Z5_2 的九个校准矩阵整数取自 [RawSpeed 相机数据库](https://github.com/darktable-org/rawspeed/blob/develop/data/cameras.xml)，由 RawSpeed camera database contributors 贡献，按 [CC-BY-SA-3.0](https://creativecommons.org/licenses/by-sa/3.0/) 使用。`vendor/stack-camera-calibrations.json` 转为 1/10000 小数单位并保留来源、署名及相同许可；仅用于该型号解码器返回空矩阵的情况。

DNG 写出遵循 [Adobe DNG 规范](https://helpx.adobe.com/camera-raw/desktop/dng-and-file-formats/digital-negative.html)。This product includes DNG technology under license by Adobe.

## Windows Release 的运行环境

安装包包含 Python 3.12、NumPy（BSD）、Pillow（HPND）、tifffile（BSD）及上表运行库与必要依赖。精确版本见安装目录 `licenses/components.json`；各 wheel 原始 LICENSE、NOTICE 及底层库声明保存在 `licenses/`。

- [Python](https://www.python.org/)：PSF License，原许可随包。
- [PyInstaller](https://github.com/pyinstaller/pyinstaller)：GPL-2.0-or-later with bootloader exception，例外允许冻结应用分发，原许可随包。
- 同一 Release 的 `third-party-sources.zip` 提供实际版本 SEP、rawpy、LibRaw 对应源码、构建文件、来源及 SHA256。项目自有完整源码和 `tools/build_release.py` 在对应 Git 标签中提供，可按许可修改、重建及替换这些库；本项目不禁止为调试 LGPL 修改而逆向工程。
- 数学库、图片编解码器及解释器底层库的许可由各原始发行包的 notices 保留；并非全部只受 Python 包主许可证覆盖。

运行环境随独立后台组件分发；CCX 仅包含 UXP 面板与安装时生成的本机配置。没有捆绑 Adobe、StarNet 或 Siril 可执行程序，没有用户照片或开发者令牌。

## Photoshop UXP 与图标

- [UXP Imaging API](https://developer.adobe.com/photoshop/uxp/2022/ps_reference/media/imaging/) · [安装说明](https://developer.adobe.com/uxp/guides/how-to/distribution/install/)。运行需要用户自己的 Photoshop 与 Creative Cloud，Adobe 产品不随本项目分发。
- 图标为本项目原创图形，绘制源码是 `tools/make_icons.py`，按项目许可发布；合成测试星场由 `tools/stack_smoke.py` 生成。

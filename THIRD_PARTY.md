# 第三方来源与分发许可

Star Studio 自有代码按 GPL-3.0-or-later 发布，完整许可在根目录 LICENSE。以下组件保留各自版权与许可，不因随包分发而改用本项目许可。

## Siril — GPL-3.0-or-later

- [源码](https://gitlab.com/free-astro/siril) · [重混合文档](https://siril.readthedocs.io/en/stable/processing/stars/star-recomp.html) · [圆星重建文档](https://siril.readthedocs.io/en/stable/processing/stars/resynthesis.html)。
- `vendor/siril-ght.c` 保留原始版权及 GPL-3.0-or-later 声明。`backend/algorithms.py` 改写其 GHS / modified arcsinh 分段数学，保留参数、端点归一化与拉伸后黑点位移；不声称完整复制 Siril 的颜色模型。
- 彗差减少调用用户另装的 Siril 1.4.x CLI。源码和 Release 不包含 Siril 二进制。

## StarNet v2 — 星点分离的外部程序

- [官网与最新版 CLI](https://starnetastro.com/cli-tools/)。旧版适配器对应 v2.0.2 的 `starnet++.exe` 接口，新版接口不一定兼容。
- 本项目不包含 StarNet 程序、权重、测试样片或源码。许可证由用户获取的官方发行包提供。
- 个人非商业天文处理许可不等同于源码开源或再分发授权，StarNet 不由本项目 GPL 许可覆盖。

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

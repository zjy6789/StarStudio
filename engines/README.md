# 外部引擎

星点分离需要单独安装 StarNet++；彗差减少需要单独安装 Siril。安装包不包含这些引擎。其余功能可直接使用。

## StarNet2 CLI 与 CPU 兼容版

从 [官方最新版](https://starnetastro.com/cli-tools/starnet/)下载完整 Windows ORT CLI ZIP，校验 SHA-256 后完整解压。当前适配 StarNet2 **2.6.2-0242** 的 `starnet2.exe --input ... --output ... --stride ...` 接口，使用 float32 FITS 中转；发行包自带 DirectML，GPU 不可用时回退 CPU。无需单独安装 Python、CUDA 或 cuDNN。面板「星点分离 → 星点提取模型：StarNet」填写 EXE 完整路径，查看许可并明确同意；当前许可改变时需重新接受。[详细安装步骤](../README.md#安装-starnet-星点分离引擎)。

新版完整引擎应放在固定的英文路径，例如 `D:\AstroTools\StarNet2`；实测其模型加载不兼容中文引擎路径。项目和任务目录可使用中文，新版以相对文件名交换 FITS。保留程序、模型、全部 DLL 和 LICENSE。CPU 兼容版从 [官方旧版页](https://starnetastro.com/cli-tools/legacy/)下载 `StarNetv2CLI_Win.zip`，完整解压到另一目录，在同一个“StarNet 程序位置”选择 `starnet++.exe`。插件根据 EXE 自动识别；旧版 v2.0.2 使用位置参数及 16 位 TIFF，继续保留。不要混用运行库、仅复制 EXE、重新命名 EXE，或将引擎及用户照片上传到本仓库。

独立 [官方 Photoshop CCX](https://starnetastro.com/ps-plugins/starnet/) 可与 Star Studio 共存，模型内置，不使用上述 CLI 配置。

## Siril 1.4.x

「彗差减少」需要 [Siril](https://siril.org/download/) 的 `siril-cli.exe`（脚本接口 1.4）。可安装官方 Windows 版本，或将完整引擎目录放到 `engines/siril/`，使 `engines/siril/bin/siril-cli.exe` 存在。启动后端时按顺序查找：本目录、系统 Program Files 下的 Siril、PATH。

默认安装包不包含 Siril 二进制。其重混合参考源码、署名和 GPL 许可已保留；其他星点加工功能与堆栈不需要安装 Siril。不要单独复制 CLI 而遗漏 DLL 或资源。

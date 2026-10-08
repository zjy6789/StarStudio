# 外部引擎

星点分离需要单独安装 StarNet++；彗差减少需要单独安装 Siril。安装包不包含这些引擎。其余功能可直接使用。

## StarNet v2 CLI

从 [StarNet 官方旧版下载页](https://starnetastro.com/cli-tools/legacy/)下方 **StarNet legacy CLI archives → Windows** 下载 `StarNetv2CLI_Win.zip`，阅读其许可并完整解压。将包含 `starnet++.exe`、权重和 DLL 的**完整目录**放到固定位置，然后在面板「星点分离 → 星点提取模型：StarNet++」中填写 EXE 的完整路径，不加引号。参数自动保存，插件会在执行分离时调用它。详细步骤见 [README](../README.md#安装-starnet-星点分离引擎)。

也可将完整引擎目录放到 `engines/starnet/`，并填写该目录内的 EXE 路径。适配器使用旧版 v2 的 `starnet++.exe input.tif output.tif stride` 接口；已验证接口为 v2.0.2。[官方最新版](https://starnetastro.com/cli-tools/starnet/)的命令、文件名或授权可能变化，尚未验证任意新版直接兼容。不要仅复制 exe，不要将 StarNet 上传到本仓库。

## Siril 1.4.x

「彗差减少」需要 [Siril](https://siril.org/download/) 的 `siril-cli.exe`（脚本接口 1.4）。可安装官方 Windows 版本，或将完整引擎目录放到 `engines/siril/`，使 `engines/siril/bin/siril-cli.exe` 存在。启动后端时按顺序查找：本目录、系统 Program Files 下的 Siril、PATH。

默认安装包不包含 Siril 二进制。其重混合参考源码、署名和 GPL 许可已保留；其他星点加工功能与堆栈不需要安装 Siril。不要单独复制 CLI 而遗漏 DLL 或资源。

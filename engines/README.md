# 可选引擎

默认 Starrem2k13 模型已包含在 `vendor/starrem2k13/weights/model.onnx`，无需下载。

## StarNet v2 CLI

从 [StarNet 官方命令行下载页](https://starnetastro.com/cli-tools/) 下载 Windows CLI，阅读其许可后，将包含 `starnet++.exe`、权重和 DLL 的**完整目录**放到 `engines/starnet/`。也可在面板「星点提取模型」中填写其他安装位置。

适配器使用旧版 v2 的 `starnet++.exe input.tif output.tif stride` 接口；已验证接口为 v2.0.2。上游新版命令、文件名或授权可能变化，下载最新版后应先确认兼容性。不要仅复制 exe，不要将 StarNet 上传到本仓库。

## Siril 1.4.x

「彗差减少」需要 [Siril](https://siril.org/download/) 的 `siril-cli.exe`（脚本接口 1.4）。可安装官方 Windows 版本，或将完整引擎目录放到 `engines/siril/`，使 `engines/siril/bin/siril-cli.exe` 存在。启动后端时按顺序查找：本目录、系统 Program Files 下的 Siril、PATH。

默认安装包不包含 Siril 二进制。其重混合参考源码、署名和 GPL 许可已保留；其他星点加工功能与堆栈不需要安装 Siril。不要单独复制 CLI 而遗漏 DLL 或资源。

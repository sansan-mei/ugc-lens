# Windows安装包改LZMA

- 日期：2026-11-11
- 关联步骤：roadmap 第 19.1 步

## 改动内容

- 新增 `scripts/desktop/ugc-lens.iss`：Inno Setup 安装脚本，装到当前用户目录（不需要管理员权限），开始菜单快捷方式、可选桌面快捷方式，LZMA2 ultra64 固实压缩。
- `.github/workflows/desktop.yml`：Windows 产物由 zip 改为 `ugc-lens-<版本>-win-x64-setup.exe`；运行器上没有 Inno Setup 时用 choco 安装。

## 设计决定

- 用户关心下载体积。普通 zip 是 41.3MB，同一个 exe 用 xz -9e 压缩是 27.9MB，Inno Setup 的 LZMA2 与之同类，所以改用安装包。
- 放弃裁剪 ICU 来缩小 Node：`src/analysis/keywords.ts` 用 `Intl.Segmenter('zh-CN')` 做中文分词，需要完整 ICU 数据。

## 验证

- `desktop.yml` 运行 43016293793 两个平台都通过构建和冒烟：Windows 安装包 29.2MB（exe 99.0MB）；macOS dmg 35.8MB。
- 安装脚本只是打包配置，没有新增单元测试；安装、卸载、快捷方式在 Windows 真机上未验证。

## 后续

- macOS 想再小只能退回 Node 22（官方 xz 包比 Node 26 小约 4.5MB），需要 esbuild 打包与 `sea.getAsset` 读取内置文件。

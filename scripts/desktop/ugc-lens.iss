; Windows 安装包（roadmap 第 19.1 步原型）。用法：iscc /DAppVersion=x.y.z /DSourceExe=<ugc-lens.exe> /DOutDir=<目录> ugc-lens.iss
; 文件带 UTF-8 BOM，ISCC 才按 UTF-8 读取。
; 装到当前用户目录，不需要管理员权限；LZMA2 固实压缩，下载体积主要取决于这里。
#ifndef AppVersion
  #error 需要 /DAppVersion
#endif

[Setup]
AppId={{6F1C2B5E-7A0D-4E8B-9C3F-2D5A1B7E4C90}
AppName=ugc-lens
AppVersion={#AppVersion}
AppPublisher=MEI
AppPublisherURL=https://github.com/sansan-mei/ugc-lens
DefaultDirName={localappdata}\Programs\ugc-lens
DefaultGroupName=ugc-lens
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
OutputDir={#OutDir}
OutputBaseFilename=ugc-lens-{#AppVersion}-win-x64-setup
UninstallDisplayIcon={app}\ugc-lens.exe

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\ugc-lens"; Filename: "{app}\ugc-lens.exe"
Name: "{autodesktop}\ugc-lens"; Filename: "{app}\ugc-lens.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Run]
Filename: "{app}\ugc-lens.exe"; Description: "{cm:LaunchProgram,ugc-lens}"; Flags: nowait postinstall skipifsilent

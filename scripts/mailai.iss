#ifndef MyAppVersion
  #define MyAppVersion "1.0.9.0"
#endif

[Setup]
AppId={{7B538711-BF4A-49DE-9FB5-7C670120F2DE}
AppName=MailAI
AppVersion={#MyAppVersion}
AppPublisher=langjiahui
AppPublisherURL=https://github.com/langjiahui
AppSupportURL=mailto:1107048037@qq.com
DefaultDirName={localappdata}\Programs\MailAI
DefaultGroupName=MailAI
UsePreviousAppDir=yes
UsePreviousTasks=yes
DisableDirPage=auto
UninstallDisplayName=MailAI
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=MailAI-Windows-x64-Setup
SetupIconFile=..\build\mailai.ico
UninstallDisplayIcon={app}\MailAI.exe
; Normal, non-solid compression is easier for endpoint scanners to inspect and
; avoids the opaque high-entropy payload produced by maximum solid packing.
Compression=lzma2/normal
SolidCompression=no
WizardStyle=modern
DisableWelcomePage=no
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#MyAppVersion}
VersionInfoProductName=MailAI
VersionInfoDescription=MailAI 邮件安全与效率助手安装程序

[Languages]
#if FileExists(AddBackslash(CompilerPath) + "Languages\ChineseSimplified.isl")
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#else
Name: "english"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked
Name: "startup"; Description: "登录 Windows 后自动启动 MailAI"; GroupDescription: "后台收信："; Flags: unchecked

; Only the PyInstaller runtime is replaced. Never delete {app} recursively:
; user databases/configuration live in {localappdata}\MailAI and credentials
; remain in Windows Credential Manager under the stable service name MailAI.
[InstallDelete]
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "..\dist\windows\MailAI\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\MailAI"; Filename: "{app}\MailAI.exe"
Name: "{autodesktop}\MailAI"; Filename: "{app}\MailAI.exe"; Tasks: desktopicon
Name: "{userstartup}\MailAI"; Filename: "{app}\MailAI.exe"; Tasks: startup

[Run]
Filename: "{app}\MailAI.exe"; Description: "启动 MailAI"; Flags: nowait postinstall

[Code]
procedure InitializeWizard();
begin
  { The destination directory is not initialized during InitializeWizard.
    Keep this welcome text independent of installation-directory constants. }
  WizardForm.WelcomeLabel1.Caption := '安装或更新 MailAI';
  WizardForm.WelcomeLabel2.Caption :=
    '首次安装将创建 MailAI 程序；已安装时将沿用原目录并更新程序。' + #13#10 + #13#10 +
    '保留邮件、草稿、附件、账号配置和已保存的登录凭据，无需先卸载旧版。' + #13#10 + #13#10 +
    '请先保存正在编辑的邮件，安装完成后可直接启动继续使用。';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  { Ensure the running/tray instance releases MailAI.exe before replacement. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM MailAI.exe', '',
    SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

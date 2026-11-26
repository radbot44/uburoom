; Per-user Windows x64 Inno Setup installer for uburoom (GPL-3.0-only).
; Compiled with Inno Setup 6 (iscc.exe) using /D defines passed by scripts/package-standalone.js
; or .github/workflows/release.yml.
;
; Required define:
;   /DSourceDir=<staged portable bundle directory>
;
; Optional defines:
;   /DAppVersion=<semver from package.json>
;   /DAppSlot=<version-g<commit> slot identifier>
;   /DAppNumericVersion=<Major.Minor.Build.Revision for Windows PE VersionInfo>
;   /DIconFile=<path to .ico>
;   /DLicenseFile=<path to LICENSE>
;   /DOutputDir=<output directory>
;   /DOutputBaseFilename=<output filename without .exe>
;
; Code signing:
;   SignPath Foundation OSS signing runs server-side in CI (see docs/releases.md),
;   so no local SignTool directive is hardcoded here.

#ifndef SourceDir
  #error "SourceDir must be defined via /DSourceDir=<path>"
#endif

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#ifndef AppSlot
  #define AppSlot AppVersion
#endif

#ifndef AppNumericVersion
  #define DashPos Pos("-", AppVersion)
  #if DashPos > 0
    #define AppNumericVersion Copy(AppVersion, 1, DashPos - 1) + ".0"
  #else
    #define AppNumericVersion AppVersion + ".0"
  #endif
#endif

#ifndef IconFile
  #define IconFile "..\web\assets\uburoom-favicon.ico"
#endif

#ifndef LicenseFile
  #define LicenseFile "..\LICENSE"
#endif

#ifndef OutputDir
  #define OutputDir "..\releases"
#endif

#ifndef OutputBaseFilename
  #define OutputBaseFilename "uburoom-" + AppSlot + "-setup"
#endif

#ifndef AppURL
  #define AppURL "https://github.com/radbot44/uburoom"
#endif

[Setup]
AppId={{7B6F3E21-4D8A-4A5B-9C1E-6F2A8D0E5B34}
AppName=uburoom
AppVersion={#AppVersion}
AppVerName=uburoom {#AppVersion}
AppPublisher=uburoom
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={localappdata}\Programs\uburoom
DefaultGroupName=uburoom
AllowNoIcons=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
UsePreviousTasks=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
#if VER >= 0x06030000
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#else
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
#endif
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\uburoom-tray.exe
UninstallDisplayName=uburoom
LicenseFile={#LicenseFile}
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
VersionInfoVersion={#AppNumericVersion}
VersionInfoProductName=uburoom
VersionInfoProductVersion={#AppVersion}
VersionInfoDescription=uburoom Installer ({#AppSlot})

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start uburoom when Windows starts"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
; Exclude config/ defensively so upgrades can never overwrite user configuration or SQLite data.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "config,config\*"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\uburoom"; Filename: "{app}\uburoom-tray.exe"; WorkingDir: "{app}"; IconFilename: "{app}\uburoom-tray.exe"; Comment: "Start uburoom in the system tray"
Name: "{group}\uburoom Doctor"; Filename: "{cmd}"; Parameters: "/c ""call ""{app}\doctor.bat"" & echo. & pause"""; WorkingDir: "{app}"; IconFilename: "{app}\uburoom-tray.exe"; Comment: "Check uburoom configuration and media tools"
Name: "{group}\uburoom Console"; Filename: "{app}\start-uburoom.bat"; WorkingDir: "{app}"; IconFilename: "{app}\uburoom-tray.exe"; Comment: "Run uburoom in a console window"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "uburoom"; ValueData: """{app}\uburoom-tray.exe"" --no-browser"; Flags: uninsdeletevalue; Tasks: autostart
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "uburoom"; Flags: deletevalue; Tasks: not autostart

[Run]
Filename: "{app}\uburoom-tray.exe"; Description: "Launch uburoom"; Flags: nowait postinstall skipifsilent

[Code]
procedure StopRunningUburoom(const AppDir: String);
var
  TrayExe: String;
  ResultCode: Integer;
begin
  TrayExe := AddBackslash(AppDir) + 'uburoom-tray.exe';
  if FileExists(TrayExe) then
  begin
    Log('Stopping running uburoom instance via: ' + TrayExe + ' --quit');
    if Exec(TrayExe, '--quit', AppDir, SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Log('uburoom-tray.exe --quit exited with code ' + IntToStr(ResultCode));
      Sleep(300);
    end
    else
    begin
      Log('Failed to invoke uburoom-tray.exe --quit (error ' + IntToStr(ResultCode) + ')');
    end;
  end;
end;

var
  PreviousSlot: String;

function ReadInstalledSlot(const AppDir: String): String;
var
  CurrentFile: String;
  Raw: AnsiString;
begin
  Result := '';
  CurrentFile := AddBackslash(AppDir) + 'current.txt';
  if FileExists(CurrentFile) and LoadStringFromFile(CurrentFile, Raw) then
    Result := Trim(String(Raw));
end;

procedure PruneOldVersionSlots(const AppDir: String; const ActiveSlot: String; const KeepSlot: String);
var
  VersionsDir: String;
  FindRec: TFindRec;
  SlotPath: String;
begin
  VersionsDir := AddBackslash(AppDir) + 'versions';
  if not DirExists(VersionsDir) then
    Exit;

  if FindFirst(AddBackslash(VersionsDir) + '*', FindRec) then
  begin
    try
      repeat
        if ((FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0) and
           (FindRec.Name <> '.') and
           (FindRec.Name <> '..') and
           (CompareText(FindRec.Name, ActiveSlot) <> 0) and
           ((KeepSlot = '') or (CompareText(FindRec.Name, KeepSlot) <> 0)) then
        begin
          SlotPath := AddBackslash(VersionsDir) + FindRec.Name;
          Log('Removing superseded uburoom slot (keeping active and previous slot): ' + SlotPath);
          DelTree(SlotPath, True, True, True);
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  AppDir: String;
begin
  AppDir := ExpandConstant('{app}');
  PreviousSlot := ReadInstalledSlot(AppDir);
  if (PreviousSlot <> '') and (CompareText(PreviousSlot, '{#AppSlot}') = 0) then
    PreviousSlot := '';
  if PreviousSlot <> '' then
    Log('Preserving previous uburoom slot for rollback: ' + PreviousSlot);
  StopRunningUburoom(AppDir);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    PruneOldVersionSlots(ExpandConstant('{app}'), '{#AppSlot}', PreviousSlot);
  end;
end;

function PromptRemoveSavedData(const ConfigDir: String; const KeyFile: String): Boolean;
var
  Form: TSetupForm;
  InfoLabel: TNewStaticText;
  RemoveCheck: TNewCheckBox;
  KeyNoteLabel: TNewStaticText;
  OkButton: TNewButton;
begin
  Result := False;
#if VER >= 0x06060000
  Form := CreateCustomForm(440, 196, False, False);
#else
  Form := CreateCustomForm();
  Form.ClientWidth := ScaleX(440);
  Form.ClientHeight := ScaleY(196);
#endif
  try
    Form.Caption := 'Uninstall uburoom';
    Form.BorderStyle := bsDialog;
    Form.Position := poScreenCenter;

    InfoLabel := TNewStaticText.Create(Form);
    InfoLabel.Parent := Form;
    InfoLabel.Left := ScaleX(16);
    InfoLabel.Top := ScaleY(16);
    InfoLabel.Width := ScaleX(408);
    InfoLabel.Height := ScaleY(46);
    InfoLabel.AutoSize := False;
    InfoLabel.WordWrap := True;
    InfoLabel.Caption :=
      'uburoom has been removed. Your saved configuration and database in "' +
      ConfigDir + '" were kept so you can reinstall without losing settings.';

    RemoveCheck := TNewCheckBox.Create(Form);
    RemoveCheck.Parent := Form;
    RemoveCheck.Left := ScaleX(16);
    RemoveCheck.Top := ScaleY(72);
    RemoveCheck.Width := ScaleX(408);
    RemoveCheck.Height := ScaleY(20);
    RemoveCheck.Caption := 'Remove saved settings and data (config\ folder)';
    RemoveCheck.Checked := False;

    KeyNoteLabel := TNewStaticText.Create(Form);
    KeyNoteLabel.Parent := Form;
    KeyNoteLabel.Left := ScaleX(16);
    KeyNoteLabel.Top := ScaleY(102);
    KeyNoteLabel.Width := ScaleX(408);
    KeyNoteLabel.Height := ScaleY(44);
    KeyNoteLabel.AutoSize := False;
    KeyNoteLabel.WordWrap := True;
    KeyNoteLabel.Caption :=
      'Your credential encryption key at "' + KeyFile +
      '" is never deleted automatically so existing backups remain readable.';

    OkButton := TNewButton.Create(Form);
    OkButton.Parent := Form;
    OkButton.Left := ScaleX(344);
    OkButton.Top := ScaleY(156);
    OkButton.Width := ScaleX(80);
    OkButton.Height := ScaleY(24);
    OkButton.Caption := 'OK';
    OkButton.ModalResult := mrOk;
    OkButton.Default := True;

    if Form.ShowModal() = mrOk then
    begin
      Result := RemoveCheck.Checked;
    end;
  finally
    Form.Free;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDir: String;
  ConfigDir: String;
  KeyFile: String;
begin
  AppDir := ExpandConstant('{app}');

  if CurUninstallStep = usUninstall then
  begin
    StopRunningUburoom(AppDir);
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    ConfigDir := AddBackslash(AppDir) + 'config';
    KeyFile := ExpandConstant('{localappdata}\uburoom\credentials.key');

    if (not UninstallSilent) and DirExists(ConfigDir) then
    begin
      if PromptRemoveSavedData(ConfigDir, KeyFile) then
      begin
        Log('User opted to remove saved settings and data: ' + ConfigDir);
        DelTree(ConfigDir, True, True, True);
        RemoveDir(AppDir);
      end;
    end;
  end;
end;

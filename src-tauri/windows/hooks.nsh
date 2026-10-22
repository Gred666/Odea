; ============================================================
; Windows 安装包的钩子（tauri.conf.json 的 bundle.windows.nsis.installerHooks）。
;
; 改名：OnTheWay → Odea（0.3.0，src-tauri/src/old_name.rs）。产品名一换，安装目录、开始菜单、
; 「应用和功能」里的那一项都跟着换，自动更新装出来的 Odea 是另一个程序 —— 旧的那份
; 不清掉的话，开始菜单和桌面上会有两个图标，点旧的打开的还是旧版。
;
; 装完以后清掉旧的安装：快捷方式（先从任务栏取消固定）、程序文件、卸载项。
; 只清安装的东西，数据一律不碰：应用数据目录由新版第一次启动时搬（old_name::move_app_dirs），
; 笔记仓库是用户自己的文件夹。也不跑旧的卸载程序：它的「删除应用数据」在静默模式下怎么走
; 不好担保，宁可自己删这几样。
;
; 删了旧的快捷方式，就在原来的位置建上 Odea 的。自动更新带着 /UPDATE，Tauri 的安装包这时
; 只改已有的快捷方式、不新建（installer.nsi 的 CreateOrUpdateStartMenuShortcut）—— Odea 原来
; 没有，就一个都没有，开始菜单、桌面、搜索里都找不到，看着像程序被删了。0.3.0、0.4.0 就是这样
; （2026-10-22 用户发现，docs/TODO.md P9）。任务栏的固定建不回来：Windows 不让程序自己固定
; ============================================================

!define OLD_PRODUCTNAME "OnTheWay"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCTNAME}"
; 卸载项里的记号：开始菜单的快捷方式查过、该补的补过了。卸载时跟着卸载项一起删
!define SHORTCUT_CHECKED "OdeaShortcutChecked"

; 和 Tauri 安装包自己建的一样：指向主程序，带 AppUserModelID（任务栏靠它把窗口和快捷方式认成一个）
!macro OdeaCreateShortcut lnk
  CreateShortcut "${lnk}" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "${lnk}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; $R3 = 1：开始菜单里该有一个 Odea，没有就建
  StrCpy $R3 0

  ReadRegStr $R0 HKCU "${OLD_UNINSTKEY}" "UninstallString"
  ${If} $R0 != ""
    ; 从旧名升级上来：开始菜单总要有一个（新装的话 Tauri 自己也会建）
    StrCpy $R3 1
    ${If} ${FileExists} "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      !insertmacro UnpinShortcut "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
    ${EndIf}
    ; 桌面：原来有才换成新的
    ${If} ${FileExists} "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      !insertmacro UnpinShortcut "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        !insertmacro OdeaCreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}

    ; 旧的安装目录：卸载项里记着，带引号（"C:\Users\…\AppData\Local\OnTheWay"）
    ReadRegStr $R1 HKCU "${OLD_UNINSTKEY}" "InstallLocation"
    StrCpy $R2 $R1 1
    ${If} $R2 == '"'
      StrCpy $R1 $R1 -1 1
    ${EndIf}
    ; 只删认得的两个文件，文件夹空了才删：万一用户把它装进了放着别的东西的文件夹
    ${If} $R1 != ""
    ${AndIf} $R1 != $INSTDIR
      Delete "$R1\ontheway.exe"
      Delete "$R1\uninstall.exe"
      RMDir "$R1"
    ${EndIf}

    DeleteRegKey HKCU "${OLD_UNINSTKEY}"
  ${EndIf}

  ; 0.3.0 / 0.4.0 自动更新上来的：旧的快捷方式当时删了、新的没建，开始菜单里什么都没有。
  ; 补一次就记下来，以后用户自己删了不再补（和 Tauri 一样：更新不新建快捷方式）
  ReadRegDWORD $R0 SHCTX "${UNINSTKEY}" "${SHORTCUT_CHECKED}"
  ${If} $R0 <> 1
    StrCpy $R3 1
  ${EndIf}
  ${If} $R3 = 1
  ${AndIf} $NoShortcutMode <> 1
  ${AndIfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !insertmacro OdeaCreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  WriteRegDWORD SHCTX "${UNINSTKEY}" "${SHORTCUT_CHECKED}" 1
!macroend

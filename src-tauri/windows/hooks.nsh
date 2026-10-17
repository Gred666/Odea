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
; ============================================================

!define OLD_PRODUCTNAME "OnTheWay"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCTNAME}"

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R0 HKCU "${OLD_UNINSTKEY}" "UninstallString"
  ${If} $R0 != ""
    ${If} ${FileExists} "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      !insertmacro UnpinShortcut "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} ${FileExists} "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      !insertmacro UnpinShortcut "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
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
!macroend

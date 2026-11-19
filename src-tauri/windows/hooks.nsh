; ============================================================
; Windows 安装包的钩子（tauri.conf.json 的 bundle.windows.nsis.installerHooks）。
;
; 改名（OnTheWay → Odea，0.3.0）以后，从旧名升级上来的机器上开始菜单里没有 Odea：
; 0.3.0、0.4.0 的钩子删了 OnTheWay 的快捷方式，Odea 的没人建 —— 自动更新带着 /UPDATE，
; Tauri 的安装包这时只改已有的快捷方式、不新建（installer.nsi 的 CreateOrUpdateStartMenuShortcut），
; 开始菜单、桌面、搜索里都找不到，看着像程序被删了（2026-10-22 用户发现，docs/TODO.md P9）。
; 这里补一次开始菜单的，补过就记在卸载项里，以后用户自己删了不再补。任务栏的固定建不回来：
; Windows 不让程序自己固定。
;
; 清旧的 OnTheWay 安装（快捷方式、程序文件、卸载项）的那一段 2026-11-19 删了：所有设备都升上来了
; ============================================================

; 卸载项里的记号：开始菜单的快捷方式查过、该补的补过了。卸载时跟着卸载项一起删
!define SHORTCUT_CHECKED "OdeaShortcutChecked"

; 和 Tauri 安装包自己建的一样：指向主程序，带 AppUserModelID（任务栏靠它把窗口和快捷方式认成一个）
!macro OdeaCreateShortcut lnk
  CreateShortcut "${lnk}" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "${lnk}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; 0.3.0 / 0.4.0 自动更新上来的：旧的快捷方式当时删了、新的没建，开始菜单里什么都没有。
  ; 补一次就记下来，以后用户自己删了不再补（和 Tauri 一样：更新不新建快捷方式）
  ReadRegDWORD $R0 SHCTX "${UNINSTKEY}" "${SHORTCUT_CHECKED}"
  ${If} $R0 <> 1
  ${AndIf} $NoShortcutMode <> 1
  ${AndIfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    !insertmacro OdeaCreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  WriteRegDWORD SHCTX "${UNINSTKEY}" "${SHORTCUT_CHECKED}" 1
!macroend

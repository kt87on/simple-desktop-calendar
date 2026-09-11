; ============================================================
; 简洁桌面日历 · NSIS 安装脚本扩展（由 electron-builder 的 nsis.include 引入）
; 作用：在安装"完成"页增加一个"查看说明文档"勾选项。
;       运行程序勾选项由 electron-builder 的 runAfterFinish 提供。
; 注意：MUI_FINISHPAGE_* 必须在 MUI_PAGE_FINISH 之前定义，
;       electron-builder 会在插入页面前 !include 本文件，故此处定义生效。
; ============================================================

!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\使用说明.html"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看说明文档"
; v2.3.0：默认勾选「查看说明文档」，安装完成点击「完成」即自动打开使用说明。
!define MUI_FINISHPAGE_SHOWREADME_CHECKED

; ============================================================
; v2.4.4：卸载时询问是否删除个人数据（设置 / 特别关注等）
; ------------------------------------------------------------
; 【挂载点证据】electron-builder 24.x 模板
;   node_modules/app-builder-lib/templates/nsis/uninstaller.nsh
; 在 Section "un.install" 末尾（DeleteRegKey 之后、SectionEnd 之前）有：
;     !ifmacrodef customUnInstall
;       !insertmacro customUnInstall
;     !endif
; 故在此定义 customUnInstall 宏，即会被挂到卸载流程末尾执行。
;
; 【个人数据目录】= Electron 的 app.getPath('userData')。
; 本应用实测（Windows 全量枚举确认）位于：
;     %APPDATA%\simple-desktop-calendar
; 即 package.json 的 name（对应 electron-builder 的 ${APP_PACKAGE_NAME}）。
; electron-builder 内置的 deleteAppDataOnUninstall 会删：
;     $APPDATA\${APP_FILENAME}          （= SimpleCalendar）
;     $APPDATA\${APP_PRODUCT_FILENAME}  （仅当与 APP_FILENAME 不同时定义）
; 故本宏同样覆盖以上候选目录（目录不存在时 RMDir /r 为无操作）。
;
; 【$APPDATA】为标准 NSIS 变量 = 当前用户的 Roaming 目录，不受
;   SetShellVarContext 影响；perMachine:false → 卸载器以当前用户运行，取值正确。
;
; 【升级不弹窗】覆盖安装时，安装器会以
;     "旧卸载器" /S /KEEP_APP_DATA --updated
; 静默调用旧卸载器（见 include/installUtil.nsh 的 uninstallOldVersion），
; 因此用 ${IfNot} ${Silent} 保证升级 / 静默卸载时不弹窗、个人数据默认保留。
; ============================================================
!macro customUnInstall
  ${IfNot} ${Silent}
    ; 默认按钮为「否」（MB_DEFBUTTON2 → 第 2 个按钮 = 否 = 保留），避免误删。
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "是否同时删除「简洁桌面日历」的设置、特别关注等个人数据？$\r$\n$\r$\n选「否」将保留这些数据（推荐），下次安装可继续使用。" IDNO customUnInstallKeepData

    ; 选「是」：删除个人数据目录（不可恢复）
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif
    !ifdef APP_FILENAME
      RMDir /r "$APPDATA\${APP_FILENAME}"
    !endif
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif

    customUnInstallKeepData:
  ${EndIf}
!macroend

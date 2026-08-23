; ============================================================
; 简洁桌面日历 · NSIS 安装脚本扩展（由 electron-builder 的 nsis.include 引入）
; 作用：在安装"完成"页增加一个"查看说明文档"勾选项。
;       运行程序勾选项由 electron-builder 的 runAfterFinish 提供。
; 注意：MUI_FINISHPAGE_* 必须在 MUI_PAGE_FINISH 之前定义，
;       electron-builder 会在插入页面前 !include 本文件，故此处定义生效。
; ============================================================

!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\使用说明.html"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看说明文档"

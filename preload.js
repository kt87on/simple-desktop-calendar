'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/* v1.6.2 preload：在 contextIsolation 安全沙箱内向渲染进程暴露以下能力
 *   基础（v1.6 沿用）：
 *     toggleExpand / exitApp / setTheme / resizeWindow / onThemeChanged / onGotoYm
 *   特别关注（v1.6.2 新增）：
 *     listReminders          <- 主进程下发的关注列表
 *     addReminder            -> 新增关注项
 *     removeReminder         -> 删除关注项（"取消选择"）
 *     onRemindersChanged     <- 订阅主进程列表变化（写盘后推回）
 *     onReminderTrigger      <- 主进程推送到期提醒，渲染层负责弹窗 UI
 *     ackReminder            -> 用户在弹窗里点"知道了/稍后提醒" → 主进程记录
 */
contextBridge.exposeInMainWorld('api', {
  // ---- v1.6 基础 ----
  toggleExpand: function () { ipcRenderer.send('toggle-expand'); },
  // v1.7.11：主进程在 mini/expanded 切换后回推，渲染层据此同步 #widget 的 .max 类
  onExpandChanged: function (cb) {
    ipcRenderer.on('expand-changed', function (e, expanded) { try { cb && cb(!!expanded); } catch (err) {} });
  },
  // v1.7.11：任务栏挂件条
  dockToggleMain: function () { ipcRenderer.send('dock-toggle-main'); },
  dockShowMenu: function () { ipcRenderer.send('dock-show-menu'); },
  // v1.7.17 需求8：主窗右键弹菜单（去托盘后）
  mainShowMenu: function () { ipcRenderer.send('main-show-menu'); },
  // v1.7.17 需求5：浮动态拖动挂件条（绝对定位，详见 electron-main.js dock-drag-* 与 dock.html 注释）
  // v1.7.22.5：传的是鼠标**屏幕坐标**（不是 dx/dy 增量），主进程算 newPos = mousePos - offset，零累加漂移
  dockDragStart: function (mouseX, mouseY) { ipcRenderer.send('dock-drag-start', mouseX, mouseY); },
  dockDragMove: function (mouseX, mouseY) { ipcRenderer.send('dock-drag-move', mouseX, mouseY); },
  dockDragEnd: function () { ipcRenderer.send('dock-drag-end'); },
  // v1.7.21 需求1：页面按鼠标坐标动态开关「鼠标穿透」，把点击热区精确限制在
  // 插件可视的小方框（#card 矩形）内；方框外的透明区域一律穿透，不拦鼠标。
  dockSetMouse: function (ignore) { ipcRenderer.send('dock-set-mouse', !!ignore); },
  // 仅仅用于自检：证明"鼠标穿透"状态下 mousemove 确实被 forward 进了页面。
  // 若这条始终没上报，说明 forward 在当前环境失效 → 插件会完全点不动（热区方案失效）。
  dockHitReady: function () { ipcRenderer.send('dock-hit-ready'); },
  // v1.7.20：原 onDockEmbedded（主进程回推"是否已嵌入任务栏"）随嵌入方案一并删除。
  // v1.7.19：主进程下发挂件条物理窗口的真实宽高，页面用固定像素布局，
  // 绕开 Chromium viewport 被错算成 ~16px 导致的内容裁切（不再用 setSize 硬撑）。
  onDockSize: function (cb) {
    ipcRenderer.on('dock-size', function (e, size) { try { cb && cb(size); } catch (err) {} });
  },
  exitApp: function () { ipcRenderer.send('exit-app'); },
  setTheme: function (mode) { ipcRenderer.send('set-theme', mode); },
  resizeWindow: function (w) { ipcRenderer.send('resize-window', w); },
  onThemeChanged: function (cb) { ipcRenderer.on('theme-changed', function (e, mode) { cb(mode); }); },
  // v2.4.0：皮肤状态（按 surface 解析好的背景 + 自动明暗文字）下发
  onSkinState: function (cb) { ipcRenderer.on('skin-state', function (e, state) { try { cb && cb(state); } catch (err) {} }); },
  // v2.4.0 A2：窗口隐藏信号（渲染层收到即 clearRange 清除算天数残留）
  onWinHidden: function (cb) { ipcRenderer.on('win-hidden', function () { try { cb && cb(); } catch (err) {} }); },
  onGotoYm: function (cb) { ipcRenderer.on('goto-ym', function (e, y, m, d) { cb(y, m, d); }); },
  // v2.2.0 需求7：每次打开日历回到当前月份
  onResetMonth: function (cb) { ipcRenderer.on('reset-month', function () { try { cb && cb(); } catch (err) {} }); },
  // v2.2.0 需求2：放大模式等比缩放 —— 主进程下发窗口实际宽高，渲染层据此算 zoom
  onWinSize: function (cb) { ipcRenderer.on('win-size', function (e, size) { try { cb && cb(size); } catch (err) {} }); },

  // ---- v2.2.0 需求4：桌面插件（日历板块桌面工具）----
  desktopDragStart: function (mouseX, mouseY) { ipcRenderer.send('desktop-drag-start', mouseX, mouseY); },
  desktopDragMove: function (mouseX, mouseY) { ipcRenderer.send('desktop-drag-move', mouseX, mouseY); },
  desktopDragEnd: function () { ipcRenderer.send('desktop-drag-end'); },
  desktopLockToggle: function () { ipcRenderer.send('desktop-lock-toggle'); },
  desktopToggle: function () { ipcRenderer.send('desktop-toggle'); },
  onDesktopLocked: function (cb) { ipcRenderer.on('desktop-locked', function (e, locked) { try { cb && cb(!!locked); } catch (err) {} }); },

  // ---- v2.2.0 需求5：设置弹窗 ----
  settingsSet: function (key, value) { ipcRenderer.send('settings-set', key, value); },
  settingsAction: function (action) { ipcRenderer.send('settings-action', action); },
  onSettingsState: function (cb) { ipcRenderer.on('settings-state', function (e, state) { try { cb && cb(state); } catch (err) {} }); },

  // ---- v2.4.0 第二轮：独立皮肤窗口 ----
  // v3.0.0：field 支持 'style'（default|minimal|glass|neu|tech|warm）/ 'bg'（native|image）
  //        / 'tone'（auto|light|dark|system）/ 'text' / 'follow' / 'opacity' / 'clarity' / 'image'。
  skinSet: function (surface, field, value) { ipcRenderer.send('skin-set', surface, field, value); },
  skinAction: function (action, payload) { ipcRenderer.send('skin-action', action, payload); },
  skinImport: function (surface, filePath) { return ipcRenderer.invoke('skin-import', surface, filePath); },
  onSkinConfigState: function (cb) { ipcRenderer.on('skin-config-state', function (e, s) { try { cb && cb(s); } catch (err) {} }); },
  onSkinImportResult: function (cb) { ipcRenderer.on('skin-import-result', function (e, r) { try { cb && cb(r); } catch (err) {} }); },
  // v3.4.0 第三轮：媒体诊断留痕（视频 error/stalled/ended、play() 被拒）→ 经 'media-diag' 由主进程写进 calendar.log。
  mediaDiag: function (msg) { ipcRenderer.send('media-diag', msg); },

  // ---- v1.6.2 关注 ----
  listReminders: function () { return ipcRenderer.invoke('list-reminders'); },
  // v3.0.0：item 可选 hh(0~23)/mm(0~59)，缺省或非法 = 全天；主进程归一后落盘并回传含 hh/mm 的 r。
  addReminder: function (item) { return ipcRenderer.invoke('add-reminder', item); },
  removeReminder: function (id) { return ipcRenderer.invoke('remove-reminder', id); },
  onRemindersChanged: function (cb) {
    ipcRenderer.on('reminders-changed', function (e, list) { cb(list); });
  },
  onReminderTrigger: function (cb) {
    ipcRenderer.on('reminder-trigger', function (e, item) { cb(item); });
  },
  ackReminder: function (id, action) {
    // action: 'dismiss' = 知道了（标记今天已确认，保留关注项，今天不再弹）
    //         'snooze'  = 稍后提醒（30 分钟后再弹）
    ipcRenderer.send('ack-reminder', id, action);
  },

  // ---- v2.0 退出确认弹窗（原生 dialog → 卡片弹窗）----
  confirmExit: function () { ipcRenderer.send('exit-confirm'); },
  cancelExit: function () { ipcRenderer.send('exit-cancel'); },

  // ---- v2.1.0 节假日年度联网更新 ----
  // 渲染层首帧拉取全量数据；主进程更新成功后经 holiday-data-changed 推送增量同步。
  getHolidayData: function () { return ipcRenderer.invoke('holiday-get-data'); },
  onHolidayDataChanged: function (cb) {
    ipcRenderer.on('holiday-data-changed', function (e, payload) { try { cb && cb(payload); } catch (err) {} });
  },
  // 更新弹窗（holidayupd.html）专用：手动触发检查 / 执行更新 / 推迟 / 从文件导入 / 关闭
  holidayCheckUpdate: function () { ipcRenderer.send('holiday-check-update'); },
  holidayDoUpdate: function (year) { ipcRenderer.send('holiday-do-update', year); },
  holidayPostpone: function (year) { ipcRenderer.send('holiday-postpone', year); },
  holidayImportFile: function () { ipcRenderer.send('holiday-import-file'); },
  holidayCloseDialog: function () { ipcRenderer.send('holiday-dialog-close'); },
  // 主进程 → 弹窗：推送状态机状态 { state, year, detail, missing }
  onHolidayDialog: function (cb) {
    ipcRenderer.on('holiday-dialog', function (e, payload) { try { cb && cb(payload); } catch (err) {} });
  },

  // ---- v1.7.12：关注列表改为独立窗口 ----
  // 原先 #reminderList 是 #widget 内的 DOM 浮层，拖动被限制在日历窗口可视区内。
  // 改为独立 BrowserWindow 后，表头用 -webkit-app-region: drag 由 Electron 原生拖动，
  // 可拖到屏幕任意位置，不受主窗口裁剪。
  openReminderListWindow: function () { ipcRenderer.send('remindlist-open'); },
  remindlistGoto: function (y, m, d) { ipcRenderer.send('remindlist-goto-ym', y, m, d); },
  remindlistRemove: function (id) { ipcRenderer.send('remindlist-remove', id); },
  remindlistClose: function () { ipcRenderer.send('remindlist-close'); },
  onRemindlistData: function (cb) {
    ipcRenderer.on('remindlist-data', function (e, data) { try { cb && cb(data); } catch (err) {} });
  }
});
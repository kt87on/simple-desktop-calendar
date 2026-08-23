'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 3.0 preload：在保持 contextIsolation 安全约定的前提下，
// 向渲染进程暴露以下能力（均由主进程通过 IPC 处理）：
//   toggleExpand -> 切换 mini / expanded 双窗口模式（R4）
//   requestSnap  -> 拖拽结束后请求窗口吸附到最近屏幕边（R4）
//   setTooltip   -> 推送农历+星期字符串作为托盘 tooltip（R3）
contextBridge.exposeInMainWorld('api', {
  toggleExpand: function () {
    ipcRenderer.send('toggle-expand');
  },
  requestSnap: function () {
    ipcRenderer.send('request-snap');
  },
  setTooltip: function (str) {
    ipcRenderer.send('set-tooltip', str);
  }
});

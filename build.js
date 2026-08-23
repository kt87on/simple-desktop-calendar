'use strict';

// 3.0 build.js —— 使用相对路径，确保在 3.0 目录内运行即可正确读取 3.0 自己的源文件。
const fs = require('fs');
const lunar = fs.readFileSync('./lunar.min.js', 'utf8');
const app = fs.readFileSync('./app.js', 'utf8');
let tpl = fs.readFileSync('./template.html', 'utf8');
tpl = tpl.replace('/*__LUNAR_LIB__*/', lunar).replace('/*__APP__*/', app);
fs.writeFileSync('./calendar.html', tpl);
console.log('已生成 3.0/calendar.html，大小(字节):', Buffer.byteLength(tpl, 'utf8'));

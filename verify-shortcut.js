#!/usr/bin/env node
/**
 * verify-shortcut.js —— 独立回读解析 .lnk，确认结构自洽（不依赖 COM / 管理员）
 *
 * 存在的意义：make-shortcut.js 只能自证"我写进去的字符串在文件里"，无法证明
 * "Windows 能按 MS-SHLLINK 规范解析"。本脚本以**读**的方式重走一遍规范，
 * 校验每个 offset 是否指向它该指向的地方 —— 双向印证，避免写出双击无反应的坏快捷方式。
 *
 * 用法：node verify-shortcut.js <xxx.lnk>
 */
'use strict';
const fs = require('fs');

const lnkPath = process.argv[2];
if (!lnkPath) { console.error('用法: node verify-shortcut.js <xxx.lnk>'); process.exit(1); }
if (!fs.existsSync(lnkPath)) { console.error('文件不存在: ' + lnkPath); process.exit(1); }

const b = fs.readFileSync(lnkPath);
let ok = true;
function chk(name, cond, extra) {
  console.log((cond ? '  [OK]   ' : '  [FAIL] ') + name + (extra ? '  → ' + extra : ''));
  if (!cond) ok = false;
}

console.log('解析: ' + lnkPath + '（' + b.length + ' 字节）\n--- ShellLinkHeader ---');
chk('HeaderSize = 76', b.readUInt32LE(0) === 0x4C, b.readUInt32LE(0));
const clsid = b.slice(4, 20).toString('hex');
chk('LinkCLSID = 00021401-0000-0000-C000-000000000046',
  clsid === '0114020000000000c000000000000046', clsid);
const flags = b.readUInt32LE(20);
chk('HAS_LINK_INFO', !!(flags & 0x02));
chk('HAS_WORKING_DIR', !!(flags & 0x10));
chk('HAS_ICON_LOCATION', !!(flags & 0x40));
chk('IS_UNICODE', !!(flags & 0x80));
chk('ShowCommand = SW_SHOWNORMAL', b.readUInt32LE(60) === 1);

console.log('--- LinkTargetIDList ---');
let p = 76;
if (flags & 0x01) { const n = b.readUInt16LE(p); p += 2 + n; chk('IDList 长度 = ' + n, true); }
else chk('未使用 IDList（LinkInfo 足够定位本地文件）', true);

console.log('--- LinkInfo ---');
const liSize = b.readUInt32LE(p);
const liHdr = b.readUInt32LE(p + 4);
const volOff = b.readUInt32LE(p + 12);
const baseOff = b.readUInt32LE(p + 16);
const netOff = b.readUInt32LE(p + 20);
const sufOff = b.readUInt32LE(p + 24);
chk('LinkInfoHeaderSize = 0x1C', liHdr === 0x1C, '0x' + liHdr.toString(16));
chk('VolumeIDAndLocalBasePath 标志', (b.readUInt32LE(p + 8) & 0x01) === 1);
chk('CommonNetworkRelativeLinkOffset = 0（本地文件无需网络路径）', netOff === 0);
chk('VolumeIDOffset 指向 LinkInfo 内', volOff === liHdr && volOff < liSize);
chk('LocalBasePathOffset 在 VolumeID 之后', baseOff > volOff && baseOff < liSize);
chk('CommonPathSuffixOffset 在 LocalBasePath 之后', sufOff > baseOff && sufOff < liSize);

const volStart = p + volOff;
const volSize = b.readUInt32LE(volStart);
const volLabelEnd = b.indexOf(0, volStart + 16);
chk('VolumeIDSize 与卷标结束位置自洽', volSize === (volLabelEnd + 1 - volStart), volSize);
chk('DriveType = DRIVE_FIXED(3)', b.readUInt32LE(volStart + 4) === 3);
chk('VolumeLabelOffset = 0x10', b.readUInt32LE(volStart + 12) === 0x10);
const baseEnd = b.indexOf(0, p + baseOff);
const base = b.slice(p + baseOff, baseEnd).toString('latin1');
chk('LocalBasePath 非空且以 .exe 结尾', /\.exe$/i.test(base), base);
chk('CommonPathSuffix 为空（路径已完整）', b[p + sufOff] === 0);

console.log('--- StringData (Unicode) ---');
p += liSize;
function rdStr(o) {
  const n = b.readUInt16LE(o);
  return { n: n, str: b.slice(o + 2, o + 2 + n * 2).toString('utf16le'), next: o + 2 + n * 2 };
}
let cursor = p;
const strNames = ['NAME', 'RELATIVE_PATH', 'WORKING_DIR', 'ARGUMENTS', 'ICON_LOCATION'];
const present = [];
if (flags & 0x04) present.push('NAME');
if (flags & 0x08) present.push('RELATIVE_PATH');
if (flags & 0x10) present.push('WORKING_DIR');
if (flags & 0x20) present.push('ARGUMENTS');
if (flags & 0x40) present.push('ICON_LOCATION');
for (const nm of present) {
  const r = rdStr(cursor);
  chk(nm + ' = "' + r.str + '"（' + r.n + ' 字符）', r.n > 0 && r.str.length === r.n);
  cursor = r.next;
}

console.log('--- ExtraData ---');
chk('终止块 = 0x00000000', b.readUInt32LE(cursor) === 0);
chk('无多余尾随字节', b.length === cursor + 4, b.length + ' vs ' + (cursor + 4));

console.log('\n' + (ok ? '== 回读解析全部通过，结构自洽 ==' : '== 存在结构问题 =='));
process.exit(ok ? 0 : 1);

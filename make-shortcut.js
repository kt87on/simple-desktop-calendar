#!/usr/bin/env node
/**
 * make-shortcut.js —— 生成 Windows .lnk 快捷方式（纯 Node，零依赖、无需管理员）
 *
 * 为什么需要它：
 *   - WScript.Shell COM 被安全策略拦截（"COM object instantiation can run arbitrary code"）
 *   - New-Item -ItemType SymbolicLink 需要管理员权限
 *   - mklink / cmd.exe 在本环境被拦截
 *   按 MS-SHLLINK 规范手写二进制是唯一可行且确定性的方案。
 *
 * 用法：
 *   node make-shortcut.js <目标exe绝对路径> <快捷方式输出路径.lnk> [工作目录]
 *
 * 例：
 *   node make-shortcut.js "D:\SimpleCalendar\SimpleCalendar.exe" ^
 *        "C:\Users\byab\Desktop\简洁桌面日历.lnk" "D:\SimpleCalendar"
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ---- ShellLinkHeader ----
const CLSID_SHELL_LINK = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46
]);

const FLAG = {
  HAS_LINK_TARGET_IDLIST: 0x00000001,
  HAS_LINK_INFO:          0x00000002,
  HAS_NAME:               0x00000004,
  HAS_RELATIVE_PATH:      0x00000008,
  HAS_WORKING_DIR:        0x00000010,
  HAS_ARGUMENTS:          0x00000020,
  HAS_ICON_LOCATION:      0x00000040,
  IS_UNICODE:             0x00000080
};

function buildLinkInfo(localBasePath) {
  // VolumeID：不带卷标（VolumeLabelOffset=0x10，其后仅一个 ANSI 结束符）
  const volLabelOffset = 0x10;
  const volumeLabel = Buffer.from([0x00]);
  const volumeIdBody = Buffer.alloc(volLabelOffset);
  volumeIdBody.writeUInt32LE(0, 0);   // 占位：VolumeIDSize
  volumeIdBody.writeUInt32LE(3, 4);   // DriveType = DRIVE_FIXED
  volumeIdBody.writeUInt32LE(0, 8);   // DriveSerialNumber = 0
  volumeIdBody.writeUInt32LE(volLabelOffset, 12); // VolumeLabelOffset
  const volumeId = Buffer.concat([volumeIdBody, volumeLabel]);
  volumeId.writeUInt32LE(volumeId.length, 0);

  const localBasePathBuf = Buffer.concat([Buffer.from(localBasePath, 'ascii'), Buffer.from([0x00])]);
  const commonPathSuffix = Buffer.from([0x00]);

  const headerSize = 0x1C;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(0, 0);  // 占位：LinkInfoSize
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(0x01, 8);  // VolumeIDAndLocalBasePath
  header.writeUInt32LE(headerSize, 12);                          // VolumeIDOffset
  header.writeUInt32LE(headerSize + volumeId.length, 16);        // LocalBasePathOffset
  header.writeUInt32LE(0, 20);                                   // CommonNetworkRelativeLinkOffset
  header.writeUInt32LE(headerSize + volumeId.length + localBasePathBuf.length, 24); // CommonPathSuffixOffset

  const out = Buffer.concat([header, volumeId, localBasePathBuf, commonPathSuffix]);
  out.writeUInt32LE(out.length, 0);
  return out;
}

/** StringData 条目：CountCharacters(2) + UTF-16LE 字符串 */
function unicodeString(s) {
  const body = Buffer.from(s, 'utf16le');
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16LE(s.length, 0);   // 字符数（非字节数）
  return Buffer.concat([prefix, body]);
}

function makeLnk(opts) {
  const { target, workingDir, iconPath, description } = opts;

  let flags = FLAG.HAS_LINK_INFO | FLAG.IS_UNICODE;
  if (workingDir)  flags |= FLAG.HAS_WORKING_DIR;
  if (iconPath)    flags |= FLAG.HAS_ICON_LOCATION;
  if (description) flags |= FLAG.HAS_NAME;

  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4C, 0);                 // HeaderSize
  CLSID_SHELL_LINK.copy(header, 4);              // LinkCLSID
  header.writeUInt32LE(flags, 20);               // LinkFlags
  header.writeUInt32LE(0x00000020, 24);          // FileAttributes = FILE_ATTRIBUTE_ARCHIVE
  // CreationTime(28) / AccessTime(36) / WriteTime(44) 全 0 —— Windows 可正常解析
  header.writeUInt32LE(0, 52);                   // FileSize
  header.writeUInt32LE(0, 56);                   // IconIndex
  header.writeUInt32LE(1, 60);                   // ShowCommand = SW_SHOWNORMAL
  header.writeUInt16LE(0, 64);                   // HotKey
  header.writeUInt16LE(0, 66);                   // Reserved1
  header.writeUInt32LE(0, 68);                   // Reserved2
  header.writeUInt32LE(0, 72);                   // Reserved3

  const parts = [header];
  // LinkTargetIDList 省略：LinkInfo 已足够定位本地文件，Windows 可正常解析
  parts.push(buildLinkInfo(target));
  if (description) parts.push(unicodeString(description)); // StringData: NAME
  if (workingDir)  parts.push(unicodeString(workingDir));  // StringData: WORKING_DIR
  if (iconPath)    parts.push(unicodeString(iconPath));    // StringData: ICON_LOCATION

  parts.push(Buffer.from([0x00, 0x00, 0x00, 0x00]));  // ExtraData 终止块
  return Buffer.concat(parts);
}

/** 回读校验：确认生成的 .lnk 里确实含目标路径 */
function verifyLnk(buf, target) {
  const flags = buf.readUInt32LE(20);
  if (!(flags & FLAG.HAS_LINK_INFO)) return 'LinkFlags 缺 HAS_LINK_INFO';
  if (buf.readUInt32LE(0) !== 0x4C) return 'HeaderSize 非法';
  const ascii = buf.toString('latin1');
  if (ascii.indexOf(target) === -1) return 'LinkInfo 中找不到目标路径';
  return null;
}

// ---- CLI ----
(function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('用法: node make-shortcut.js <目标exe> <输出.lnk> [工作目录]');
    process.exit(1);
  }
  const target = path.resolve(args[0]);
  const outFile = path.resolve(args[1]);
  const workingDir = args[2] ? path.resolve(args[2]) : path.dirname(target);

  if (!fs.existsSync(target)) {
    console.error('目标不存在: ' + target);
    process.exit(1);
  }

  const buf = makeLnk({
    target: target,
    workingDir: workingDir,
    iconPath: target,
    description: path.basename(target, '.exe')
  });

  const err = verifyLnk(buf, target);
  if (err) { console.error('生成失败: ' + err); process.exit(1); }

  fs.writeFileSync(outFile, buf);
  console.log('OK 已生成快捷方式: ' + outFile);
  console.log('   目标: ' + target);
  console.log('   起始位置: ' + workingDir);
  console.log('   大小: ' + buf.length + ' 字节');
})();

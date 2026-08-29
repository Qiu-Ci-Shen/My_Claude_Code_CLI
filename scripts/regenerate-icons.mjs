#!/usr/bin/env node
// 从 desktop/assets/logo-windows.ico 重新生成全套应用图标：
//   public/favicon.png / public/logo-*.png / public/icons/icon-*.png
//   desktop/assets/logo-macos.png / logo-macos.icns
// SVG（favicon.svg / logo.svg / icons/icon-*.svg）统一替换为 claude-ai-icon.svg 内容。
// 用法：node scripts/regenerate-icons.mjs [ico路径（可选，默认项目内 logo-windows.ico）]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const icoPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, 'desktop', 'assets', 'logo-windows.ico');
const svgSource = path.join(ROOT, 'public', 'icons', 'claude-ai-icon.svg');

// ---------- 1. 解析 ICO，取最大的 PNG 帧 ----------
const buf = fs.readFileSync(icoPath);
const count = buf.readUInt16LE(4);
let best = null;
for (let i = 0; i < count; i++) {
  const off = 6 + i * 16;
  const width = buf[off] || 256;
  const size = buf.readUInt32LE(off + 8);
  const dataOff = buf.readUInt32LE(off + 12);
  const frame = buf.subarray(dataOff, dataOff + size);
  if (frame.subarray(0, 4).toString('hex') !== '89504e47') continue; // 跳过 BMP 帧
  if (!best || width > best.width) best = { width, frame };
}
if (!best) throw new Error('ICO 中没有 PNG 帧');
console.log(`最大帧: ${best.width}x${best.width}`);

const base = sharp(best.frame);

// ---------- 2. 生成全部 PNG 尺寸 ----------
const PNG_TARGETS = [
  ['public/favicon.png', 64],
  ['public/logo-32.png', 32],
  ['public/logo-64.png', 64],
  ['public/logo-128.png', 128],
  ['public/logo-256.png', 256],
  ['public/logo-512.png', 512],
  ['public/icons/icon-72x72.png', 72],
  ['public/icons/icon-96x96.png', 96],
  ['public/icons/icon-128x128.png', 128],
  ['public/icons/icon-144x144.png', 144],
  ['public/icons/icon-152x152.png', 152],
  ['public/icons/icon-192x192.png', 192],
  ['public/icons/icon-384x384.png', 384],
  ['public/icons/icon-512x512.png', 512],
  ['desktop/assets/logo-macos.png', 512],
];
for (const [rel, size] of PNG_TARGETS) {
  const out = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await base.clone().resize(size, size).png().toFile(out);
  console.log(`PNG ${size}x${size} -> ${rel}`);
}

// ---------- 3. 重建 mac icns（icns 容器直接装 PNG 帧） ----------
const icnsEntries = [
  ['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512],
];
const chunks = [];
for (const [type, size] of icnsEntries) {
  const png = await base.clone().resize(size, size).png().toBuffer();
  const head = Buffer.alloc(8);
  head.write(type, 0, 'ascii');
  head.writeUInt32LE(png.length + 8, 4);
  chunks.push(head, png);
}
const body = Buffer.concat(chunks);
const icns = Buffer.alloc(8 + body.length);
icns.write('icns', 0, 'ascii');
icns.writeUInt32LE(icns.length, 4);
body.copy(icns, 8);
fs.writeFileSync(path.join(ROOT, 'desktop', 'assets', 'logo-macos.icns'), icns);
console.log('ICNS -> desktop/assets/logo-macos.icns');

// ---------- 4. SVG 全部替换为矢量源 ----------
const svg = fs.readFileSync(svgSource, 'utf8');
const SVG_TARGETS = [
  'public/favicon.svg',
  'public/logo.svg',
  ...[72, 96, 128, 144, 152, 192, 384, 512].map((s) => `public/icons/icon-${s}x${s}.svg`),
];
for (const rel of SVG_TARGETS) {
  fs.writeFileSync(path.join(ROOT, rel), svg);
}
console.log(`SVG x${SVG_TARGETS.length} 已替换为 claude-ai-icon.svg`);
console.log('完成。');

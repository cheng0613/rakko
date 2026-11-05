#!/usr/bin/env node
/**
 * 从 1024 的母版生成各尺寸图标与 Windows 用的 .ico。
 *
 * 母版 build/icon-1024.png 由 build/icon.svg 渲染而来（Edge headless，
 * 透明背景），只在改 logo 时需要重新生成；这里负责切尺寸与打包。
 *
 *   node scripts/make-icons.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { PNG } from 'pngjs';

const BUILD = path.resolve(import.meta.dirname, '..', 'build');
/** 主 mark（C 环）与 16–32px 用的爪印——设计稿里就是这么分工的 */
const MARK_RING = path.join(BUILD, 'icon-1024.png');
const MARK_PAW = path.join(BUILD, 'icon-paw-1024.png');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
/** 32px 及以下用爪印：环 + 点在 16px 会糊成一团 */
const SMALL_MARK_MAX = 32;

/** 面积平均重采样：每个目标像素取源图上对应矩形的加权平均（含边缘的分数覆盖） */
function resize(source, size) {
  const scale = source.width / size;
  const out = new PNG({ width: size, height: size });

  for (let y = 0; y < size; y += 1) {
    const sy0 = y * scale;
    const sy1 = sy0 + scale;
    for (let x = 0; x < size; x += 1) {
      const sx0 = x * scale;
      const sx1 = sx0 + scale;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;

      for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy += 1) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx += 1) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const index = (sy * source.width + sx) << 2;
          // 预乘 alpha 再平均，避免透明边缘出现黑边
          const alpha = source.data[index + 3] / 255;
          r += source.data[index] * alpha * w;
          g += source.data[index + 1] * alpha * w;
          b += source.data[index + 2] * alpha * w;
          a += alpha * w;
          weight += w;
        }
      }

      const index = (y * size + x) << 2;
      out.data[index] = a > 0 ? Math.round(r / a) : 0;
      out.data[index + 1] = a > 0 ? Math.round(g / a) : 0;
      out.data[index + 2] = a > 0 ? Math.round(b / a) : 0;
      out.data[index + 3] = Math.round((a / weight) * 255);
    }
  }

  return out;
}

/** 组装 .ico：Vista 起允许直接塞 PNG，省得自己写 BMP/掩码 */
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;

  for (const { size, buffer } of pngs) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += buffer.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((item) => item.buffer)]);
}

const ring = PNG.sync.read(await readFile(MARK_RING));
const paw = PNG.sync.read(await readFile(MARK_PAW));
for (const [name, master] of [['icon-1024', ring], ['icon-paw-1024', paw]]) {
  if (master.width !== master.height) {
    console.error(`${name} 必须是正方形，现在是 ${master.width}×${master.height}`);
    process.exit(1);
  }
}

const pngs = [];
for (const size of SIZES) {
  const master = size <= SMALL_MARK_MAX ? paw : ring;
  const image = resize(master, size);
  const buffer = PNG.sync.write(image);
  await writeFile(path.join(BUILD, `icon-${size}.png`), buffer);
  pngs.push({ size, buffer });
  console.log(`✓ icon-${size}.png`);
}

// Linux / 通用
await writeFile(path.join(BUILD, 'icon.png'), await readFile(path.join(BUILD, 'icon-512.png')));

// Windows 安装包与 exe 图标：16/24/32/48/64/128/256
const icoEntries = pngs.filter((item) => item.size <= 256);
await writeFile(path.join(BUILD, 'icon.ico'), buildIco(icoEntries));
console.log(`✓ icon.ico（${icoEntries.map((item) => item.size).join('/')}）`);

// 打包用的页面文件不留着
console.log(`\n完成：${BUILD}`);

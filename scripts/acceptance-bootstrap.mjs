#!/usr/bin/env node
/**
 * 验收资产的自举与校验。
 *
 *   node scripts/acceptance-bootstrap.mjs                 # 从远端恢复并校验
 *   node scripts/acceptance-bootstrap.mjs --from <url|dir>  # 指定来源
 *   node scripts/acceptance-bootstrap.mjs --seal          # 按当前内容重写清单（发布前用）
 *   node scripts/acceptance-bootstrap.mjs --verify        # 只校验，不下载
 *
 * 来源优先级：--from > RAKKO_ACCEPTANCE_REMOTE > 验收目录自身的 git origin。
 * 清单 acceptance.json 必须在来源里，恢复后逐个文件比对 sha256 —— 拿不到清单就当不可信。
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const VAULT = process.env.RAKKO_ACCEPTANCE_DIR ?? path.join(homedir(), '.rakko-acceptance');
const MANIFEST = 'acceptance.json';
const TRACKED = ['checks', 'snapshots'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

/** 按「换行归一化」后算：同一份文件在 CRLF 与 LF 的工作区里应当得到同一个校验和 */
const sha256 = async (file) => {
  const buffer = await readFile(file);
  const normalized = Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
  return createHash('sha256').update(normalized).digest('hex');
};

const exists = async (target) => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/** 把一个目录下 checks/ 与 snapshots/ 的文件收集成 {相对路径: sha256} */
async function collect(baseDir) {
  const files = {};
  for (const folder of TRACKED) {
    const root = path.join(baseDir, folder);
    if (!(await exists(root))) continue;
    for (const name of await readdir(root)) {
      const full = path.join(root, name);
      const info = await stat(full);
      if (!info.isFile()) continue;
      files[`${folder}/${name}`] = await sha256(full);
    }
  }
  return files;
}

async function readManifest(baseDir) {
  const file = path.join(baseDir, MANIFEST);
  if (!(await exists(file))) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (!parsed || typeof parsed.files !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function seal() {
  const files = await collect(VAULT);
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    note: '验收资产清单：checks/ 与 snapshots/ 的 sha256。恢复时会逐个比对。',
    files,
  };
  await writeFile(path.join(VAULT, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`已写入清单：${path.join(VAULT, MANIFEST)}（${Object.keys(files).length} 个文件）`);
  for (const [file, hash] of Object.entries(files)) console.log(`  ${hash.slice(0, 12)}…  ${file}`);
}

/** 逐文件比对；返回是否全部通过 */
async function verify(baseDir = VAULT) {
  const manifest = await readManifest(baseDir);
  if (!manifest) {
    console.log(`✗ ${path.join(baseDir, MANIFEST)} 不存在 —— 没有清单就无法判断资产是否被改过`);
    return false;
  }

  const expected = manifest.files ?? {};
  const actual = await collect(baseDir);
  let ok = true;

  for (const [file, hash] of Object.entries(expected)) {
    const got = actual[file];
    if (!got) {
      ok = false;
      console.log(`✗ 缺文件 ${file}`);
    } else if (got !== hash) {
      ok = false;
      console.log(`✗ 校验不通过 ${file}\n    期望 ${hash.slice(0, 12)}…  实际 ${got.slice(0, 12)}…`);
    } else {
      console.log(`✓ ${file}`);
    }
  }

  for (const file of Object.keys(actual)) {
    if (!(file in expected)) {
      ok = false;
      console.log(`✗ 清单外多出的文件 ${file}（不受信任）`);
    }
  }

  console.log(`\n${ok ? '清单校验通过' : '清单校验不通过'}`);
  return ok;
}

/** 解析来源：git 地址就 clone，目录就复制 */
async function fetchSource(source) {
  const isGit = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(source) || source.endsWith('.git');
  if (!isGit) {
    if (!(await exists(source))) throw new Error(`来源目录不存在：${source}`);
    return { dir: path.resolve(source), cleanup: async () => {} };
  }

  const work = await mkdtemp(path.join(tmpdir(), 'rakko-acceptance-'));
  console.log(`从 git 恢复：${source}`);
  await exec('git', ['-c', 'core.autocrlf=false', 'clone', '--depth', '1', source, work], { maxBuffer: 8 * 1024 * 1024 });
  return { dir: work, cleanup: () => rm(work, { recursive: true, force: true }) };
}

async function resolveRemote() {
  if (value('from')) return value('from');
  if (process.env.RAKKO_ACCEPTANCE_REMOTE) return process.env.RAKKO_ACCEPTANCE_REMOTE;

  if (await exists(path.join(VAULT, '.git'))) {
    try {
      const { stdout } = await exec('git', ['-C', VAULT, 'remote', 'get-url', 'origin']);
      const url = stdout.trim();
      if (url) return url;
    } catch {
      /* 没有 origin */
    }
  }
  return null;
}

async function bootstrap() {
  const source = await resolveRemote();
  if (!source) {
    console.error(
      [
        '找不到验收资产来源。三条路：',
        '  1) --from <git url | 目录>',
        '  2) RAKKO_ACCEPTANCE_REMOTE=<git url | 目录>',
        `  3) 给 ${VAULT} 配一个 origin 远端（git -C <dir> remote add origin …）`,
      ].join('\n'),
    );
    process.exit(1);
  }

  const { dir, cleanup } = await fetchSource(source);
  try {
    const manifest = await readManifest(dir);
    if (!manifest) {
      console.error(`来源里没有 ${MANIFEST}：拒绝恢复没有清单的资产`);
      process.exit(1);
    }

    await mkdir(VAULT, { recursive: true });
    for (const folder of TRACKED) {
      const from = path.join(dir, folder);
      if (!(await exists(from))) continue;
      await cp(from, path.join(VAULT, folder), { recursive: true });
    }
    await writeFile(path.join(VAULT, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    console.log(`已恢复 ${Object.keys(manifest.files ?? {}).length} 个文件到 ${VAULT}\n`);
    process.exit((await verify(VAULT)) ? 0 : 1);
  } finally {
    await cleanup();
  }
}

if (flag('seal')) {
  await seal();
  process.exit(0);
}

if (flag('verify')) {
  process.exit((await verify(VAULT)) ? 0 : 1);
}

await bootstrap();

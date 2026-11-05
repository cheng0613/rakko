/**
 * electron-builder 配置。
 *
 * 两个环境相关的坑，都写在这里而不是 package.json：
 *   1. electronDist：npm 包已经把 Electron 二进制下到 node_modules 里了，
 *      直接指过去就不用从 GitHub 再下一遍（很多内网/受限网络下 GitHub 连不上）；
 *   2. 输出目录固定在 apps/desktop/release，便于 .gitignore。
 */

const path = require('node:path');

const electronDir = path.dirname(require.resolve('electron/package.json'));

module.exports = {
  appId: 'app.rakko.desktop',
  productName: 'Rakko',
  copyright: 'Rakko',
  electronDist: path.join(electronDir, 'dist'),
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  files: ['dist/**/*', 'package.json'],
  extraResources: [
    { from: 'build/server.mjs', to: 'server.mjs' },
    { from: '../../packages/db/migrations', to: 'migrations' },
    // 界面是单文件，直接跟着走
    { from: '../../apps/web', to: 'web' },
  ],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.ico',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'Rakko',
    artifactName: 'Rakko-${version}-setup.${ext}',
  },
};

/**
 * electron-builder 配置。
 *
 * 关键点：把 resources/pi（裁剪后的内置运行时，约 94MB）打进安装包的
 * resources/pi 下。主进程通过 process.resourcesPath/pi 找到它。
 */
module.exports = {
  appId: "app.rakko.desktop",
  productName: "Rakko",
  directories: {
    output: "../../release",
    buildResources: "build",
  },
  files: ["out/**/*", "package.json"],
  /**
   * 内置 pi 运行时（约 94MB）。
   *
   * 用 extraFiles 而不是 extraResources：
   * electron-builder 对 extraResources 会自动排除 node_modules
   * （它假设那是应用自己的依赖），导致 pi 加载扩展时缺 jiti。
   * extraFiles 是原样复制，不做依赖分析。
   *
   * 产物路径：<安装目录>/resources/pi
   * 主进程通过 process.resourcesPath/pi 找到它。
   */
  extraFiles: [
    {
      from: "../../resources/pi",
      to: "resources/pi",
      filter: ["**/*", "!**/*.map"],
    },
  ],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "Rakko-${version}-${arch}.${ext}",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
  // 内置运行时里有 .node 二进制，不能被 asar 打包
  asar: true,
  asarUnpack: ["**/*.node"],
};

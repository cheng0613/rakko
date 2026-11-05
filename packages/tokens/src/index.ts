/**
 * Rakko 设计令牌 —— 颜色的唯一事实源。
 *
 * 来源：从海獭本体与它的环境逐像素采样，不从「不想要哪个色」倒推。
 *   天蓝  = 水与天（环境，只做行动与状态）
 *   米杏  = 毛（表面与温度）
 *   深栗  = 眼鼻（正文与标题，永不换色）
 *
 * 硬规则：单色语义、无渐变、无阴影；图标底色只跟品牌不跟主题。
 */

/** 品牌六色：样品即真相，不要在别处再写一遍十六进制。 */
export const brand = {
  /** 水与天 —— 主行动 */
  waterBlue: '#5AA9EC',
  /** 水与天的暗部 —— 按下态、深色底板 */
  deepBlue: '#3F85CB',
  /** 毛 —— 米杏底色、卡片衬底 */
  furCream: '#F4DDC1',
  /** 毛的高光 */
  furHighlight: '#FDEBD0',
  /** 眼鼻 —— 正文、标题 */
  chestnut: '#4A2E22',
  /** 石头 —— 次要文字、分隔 */
  stoneGrey: '#A69C90',
} as const;

export type Hex = `#${string}`;

/**
 * 语义色板。UI 只允许引用语义名，不允许引用 `brand.*` 的裸色值，
 * 否则深色模式必然漏改一处。
 */
export interface Palette {
  /** 整页底色 */
  bg: Hex;
  /** 卡片 / 面板 */
  surface: Hex;
  /** 次级面板、hover */
  surfaceAlt: Hex;
  /** 正文 */
  text: Hex;
  /** 说明文字 */
  textSecondary: Hex;
  /** 时间戳、占位符 */
  textTertiary: Hex;
  /** 1px 分隔线 */
  border: Hex;
  /** 主行动底色 */
  accent: Hex;
  /** 主行动按下 */
  accentPressed: Hex;
  /** 浅色强调底（标签、选中项） */
  accentSoft: Hex;
  /** 主行动上的文字 */
  onAccent: Hex;
  success: Hex;
  warning: Hex;
  danger: Hex;
}

export const light: Palette = {
  bg: '#FBF8F3',
  surface: '#FFFFFF',
  surfaceAlt: '#F4EFE7',
  text: '#33241B',
  textSecondary: '#6E5C4E',
  textTertiary: '#9A8B7D',
  border: '#E6DED2',
  accent: brand.waterBlue,
  accentPressed: brand.deepBlue,
  accentSoft: '#E3F1FC',
  onAccent: '#12232E',
  success: '#4F7A5B',
  warning: '#B97A2B',
  danger: '#B4462F',
};

export const dark: Palette = {
  bg: '#17120E',
  surface: '#221A14',
  surfaceAlt: '#2B211A',
  text: '#F6EFE6',
  textSecondary: '#C6B6A6',
  textTertiary: '#8E7F71',
  border: '#392C23',
  accent: '#7BCBF0',
  accentPressed: brand.waterBlue,
  accentSoft: '#1E3A4A',
  onAccent: '#0B1A24',
  success: '#7FB08C',
  warning: '#E0A45C',
  danger: '#E2795F',
};

/** 圆角：粗描边 + 大圆角是这只海獭的手感，别用 2px。 */
export const radius = { xs: 6, sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const;

/** 4px 基准间距。 */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64 } as const;

/** 字号阶梯贴近 Apple HIG，中文行高放宽 2px。 */
export const type = {
  caption: { size: 11, line: 16, weight: 500 },
  footnote: { size: 12, line: 18, weight: 400 },
  body: { size: 14, line: 22, weight: 400 },
  bodyStrong: { size: 14, line: 22, weight: 600 },
  title3: { size: 17, line: 24, weight: 600 },
  title2: { size: 22, line: 30, weight: 600 },
  title1: { size: 28, line: 36, weight: 700 },
  display: { size: 40, line: 48, weight: 700 },
} as const;

export const font = {
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
} as const;

/** 动效：只做「东西从哪来」，不做装饰。 */
export const motion = {
  duration: { fast: 120, base: 180, slow: 240, overlay: 320 },
  easing: {
    standard: 'cubic-bezier(.2,.8,.2,1)',
    enter: 'cubic-bezier(0,0,.2,1)',
    exit: 'cubic-bezier(.4,0,1,1)',
  },
} as const;

/** textSecondary -> --rk-text-secondary */
const kebab = (key: string): string => key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

export function paletteVars(p: Palette): string {
  return Object.entries(p)
    .map(([key, value]) => `  --rk-${kebab(key)}: ${value};`)
    .join('\n');
}

function scaleVars(prefix: string, scale: Record<string, number | string>): string {
  return Object.entries(scale)
    .map(([key, value]) => `  --rk-${prefix}-${key}: ${typeof value === 'number' ? `${value}px` : value};`)
    .join('\n');
}

/** 生成可直接注入的样式表：`:root`、深色媒体查询、显式 `data-theme` 覆盖。 */
export function css(): string {
  const indent = (block: string): string =>
    block
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');

  return [
    ':root {',
    paletteVars(light),
    `  --rk-font-sans: ${font.sans};`,
    `  --rk-font-mono: ${font.mono};`,
    scaleVars('radius', radius),
    scaleVars('space', space),
    scaleVars('duration', motion.duration),
    `  --rk-ease: ${motion.easing.standard};`,
    '  color-scheme: light;',
    '}',
    '',
    '/* 跟随系统，但允许显式 data-theme 覆盖 */',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    indent(paletteVars(dark)),
    '    color-scheme: dark;',
    '  }',
    '}',
    '',
    '[data-theme="dark"] {',
    paletteVars(dark),
    '  color-scheme: dark;',
    '}',
    '',
    'body {',
    '  margin: 0;',
    '  background: var(--rk-bg);',
    '  color: var(--rk-text);',
    '  font-family: var(--rk-font-sans);',
    '  font-size: 14px;',
    '  line-height: 22px;',
    '  -webkit-font-smoothing: antialiased;',
    '}',
    '',
  ].join('\n');
}

/**
 * 实体名的归一化。
 *
 * 知识图谱最怕「Postgres」和「postgres」被当成两个实体 —— 图会碎成一片。
 * 显示名保留原样（大小写好看），键统一小写、压空白、去掉首尾的标点。
 */

/** 显示用：去掉首尾空白、把连续空白压成一个空格 */
export function normalizeEntityName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/** 合并用的键：小写 + 压空白 + 去首尾标点 */
export function entityKey(name: string): string {
  return normalizeEntityName(name).toLowerCase().replace(/^[\s._\-"'“”‘’()（）]+|[\s._\-"'“”‘’()（）]+$/g, '');
}

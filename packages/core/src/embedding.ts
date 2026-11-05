/**
 * 语义检索用的 embedding 客户端。
 *
 * 走 OpenAI 兼容的 /embeddings；模型名与维度从配置来，
 * 失败一律返回 null —— 检索退化成关键词，不能让记忆功能把运行拖垮。
 */

export interface EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface OpenAICompatibleEmbeddingsOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dims: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[]; index?: number }>;
}

export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  private readonly options: OpenAICompatibleEmbeddingsOptions;

  constructor(options: OpenAICompatibleEmbeddingsOptions) {
    this.options = options;
    this.model = options.model;
    this.dims = options.dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 20_000);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(
        `${this.options.baseUrl.replace(/\/+$/, '')}/embeddings`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`embedding 接口返回 ${response.status}`);

      const body = (await response.json()) as EmbeddingResponse;
      const vectors = (body.data ?? [])
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((item) => item.embedding ?? []);

      if (vectors.length !== texts.length) throw new Error('embedding 数量对不上');
      for (const vector of vectors) {
        if (vector.length !== this.dims) throw new Error(`维度不对：期望 ${this.dims}，实际 ${vector.length}`);
      }
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 余弦相似度：两边都非零才有意义 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 把向量转成 pgvector 能吃的字面量：'[0.1,0.2]' */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => Number(value.toFixed(6))).join(',')}]`;
}

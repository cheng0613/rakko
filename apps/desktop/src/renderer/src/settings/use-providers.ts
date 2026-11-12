/**
 * 设置页 · 模型供应商的数据层。
 *
 * 只做三件事：读列表、增删改、调上游探模型。
 * 所有真实 key 只在主进程，这里拿到的是 ProviderView（含掩码）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ListRemoteModelsResult,
  ProviderView,
  TestProviderResult,
  UpsertProviderInput,
} from "@rakko/shared";

export interface ProvidersState {
  providers: ProviderView[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  create: (input: UpsertProviderInput) => Promise<ProviderView>;
  update: (id: string, input: Partial<UpsertProviderInput>) => Promise<ProviderView>;
  remove: (id: string) => Promise<void>;
  listRemote: (baseUrl: string, apiKey: string) => Promise<ListRemoteModelsResult>;
  test: (baseUrl: string, apiKey: string, model: string) => Promise<TestProviderResult>;
}

export function useProviders(): ProvidersState {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 组件卸载后不再 setState，避免 React 警告
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const list = await window.rakko.listProviders();
      if (!alive.current) return;
      setProviders(list);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(
    async (input: UpsertProviderInput) => {
      const created = await window.rakko.createProvider(input);
      await reload();
      return created;
    },
    [reload],
  );

  const update = useCallback(
    async (id: string, input: Partial<UpsertProviderInput>) => {
      const updated = await window.rakko.updateProvider(id, input);
      await reload();
      return updated;
    },
    [reload],
  );

  const remove = useCallback(
    async (id: string) => {
      await window.rakko.deleteProvider(id);
      await reload();
    },
    [reload],
  );

  const listRemote = useCallback(
    (baseUrl: string, apiKey: string) => window.rakko.listRemoteModels({ baseUrl, apiKey }),
    [],
  );

  const test = useCallback(
    (baseUrl: string, apiKey: string, model: string) =>
      window.rakko.testProvider({ baseUrl, apiKey, model }),
    [],
  );

  return { providers, loading, error, reload, create, update, remove, listRemote, test };
}

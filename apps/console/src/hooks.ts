import { useCallback, useEffect, useMemo, useState } from "react";

interface AsyncState<T> {
  loading: boolean;
  error: string | null;
  data: T | null;
  refresh: () => Promise<void>;
}

export function useAsyncData<T>(loader: () => Promise<T>, deps: unknown[], intervalMs = 0): AsyncState<T> {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<T | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loader();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (intervalMs <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      void refresh();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [intervalMs, refresh]);

  return useMemo(
    () => ({
      loading,
      error,
      data,
      refresh
    }),
    [loading, error, data, refresh]
  );
}

export interface PaginationState<T> {
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  startIndex: number;
  endIndex: number;
  items: T[];
  setPage: (page: number) => void;
}

export function usePagination<T>(allItems: T[], pageSize = 5): PaginationState<T> {
  const total = allItems.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const [page, setPageRaw] = useState(1);

  useEffect(() => {
    setPageRaw((prev) => {
      if (prev > pageCount) {
        return 1;
      }
      return Math.max(prev, 1);
    });
  }, [pageCount, total]);

  const setPage = useCallback(
    (next: number) => {
      setPageRaw(Math.min(Math.max(next, 1), pageCount));
    },
    [pageCount]
  );

  const startIndex = Math.min((page - 1) * pageSize, total);
  const endIndex = Math.min(startIndex + pageSize, total);
  const items = useMemo(() => allItems.slice(startIndex, endIndex), [allItems, startIndex, endIndex]);

  return useMemo(
    () => ({
      page,
      pageSize,
      pageCount,
      total,
      startIndex,
      endIndex,
      items,
      setPage
    }),
    [page, pageSize, pageCount, total, startIndex, endIndex, items, setPage]
  );
}

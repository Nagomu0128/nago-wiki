import { useCallback, useEffect, useRef, useState } from "react";

export type QueryState<T> =
  | { status: "idle" | "loading"; data?: T; error?: undefined }
  | { status: "success"; data: T; error?: undefined }
  | { status: "error"; data?: T; error: Error };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function useApiQuery<T>(
  query: (signal: AbortSignal) => Promise<T>,
  dependencies: readonly unknown[],
  enabled = true,
) {
  const queryRef = useRef(query);
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<QueryState<T>>({ status: enabled ? "loading" : "idle" });

  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void queryRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ status: "success", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", error: asError(error) });
      },
    );
    return () => {
      controller.abort();
    };
    // The caller owns the stable, explicit query key in dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, enabled, nonce]);

  const refetch = useCallback(() => {
    setState((current) => current.data === undefined ? { status: "loading" } : { status: "loading", data: current.data });
    setNonce((value) => value + 1);
  }, []);
  return { ...state, refetch };
}

export function useApiMutation<TInput, TResult>(mutation: (input: TInput, signal: AbortSignal) => Promise<TResult>) {
  const mutationRef = useRef(mutation);
  const controllerRef = useRef<AbortController | null>(null);
  const [state, setState] = useState<QueryState<TResult>>({ status: "idle" });

  useEffect(() => {
    mutationRef.current = mutation;
  }, [mutation]);

  useEffect(() => () => {
    controllerRef.current?.abort();
  }, []);

  const mutate = useCallback(async (input: TInput) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ status: "loading" });
    try {
      const data = await mutationRef.current(input, controller.signal);
      if (!controller.signal.aborted) setState({ status: "success", data });
      return data;
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: "error", error: asError(error) });
      throw error;
    }
  }, []);

  return { ...state, mutate };
}

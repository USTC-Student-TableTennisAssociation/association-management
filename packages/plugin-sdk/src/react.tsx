"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  ViewCommandResult,
  ViewReaction,
  ViewPresentationSnapshot,
} from "./index.js";

interface ViewLoadState {
  requestKey: string;
  viewKey: string;
  snapshot?: ViewPresentationSnapshot;
  error?: string;
}

async function responseJson<Response>(response: globalThis.Response): Promise<Response> {
  const body = await response.json() as Response & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Sydaris API 请求失败：${response.status}`);
  return body;
}

export function useView(viewKey: string, refreshRevision = 0) {
  const [reloadSequence, setReloadSequence] = useState(0);
  const [loadState, setLoadState] = useState<ViewLoadState>();
  const requestKey = `${viewKey}:${refreshRevision}:${reloadSequence}`;

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/views/${encodeURIComponent(viewKey)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(responseJson<ViewPresentationSnapshot>)
      .then((snapshot) => setLoadState({ requestKey, viewKey, snapshot }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setLoadState({
            requestKey,
            viewKey,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => controller.abort();
  }, [requestKey, viewKey]);

  const isCurrentRequest = loadState?.requestKey === requestKey;
  const isCurrentView = loadState?.viewKey === viewKey;
  return {
    snapshot: isCurrentView ? loadState.snapshot : undefined,
    error: isCurrentRequest ? loadState.error : undefined,
    loading: !isCurrentRequest,
    refresh: useCallback(() => setReloadSequence((value) => value + 1), []),
  };
}

export function useViewCommand(viewKey: string) {
  return useCallback(async <Result = ViewCommandResult>(
    commandKey: string,
    input: unknown,
    expectedStateVersion?: string,
  ): Promise<Result> => {
    const response = await fetch(
      `/api/views/${encodeURIComponent(viewKey)}/commands/${encodeURIComponent(commandKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, expectedStateVersion }),
      },
    );
    return responseJson<Result>(response);
  }, [viewKey]);
}

export function useViewReactions(
  viewKey: string,
  options: { limit?: number; pollIntervalMs?: number; enabled?: boolean } = {},
) {
  const { limit = 20, pollIntervalMs = 2_000, enabled = true } = options;
  const [reactions, setReactions] = useState<readonly ViewReaction[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(enabled);
  const [reloadSequence, setReloadSequence] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/views/${encodeURIComponent(viewKey)}/reactions?limit=${limit}`,
          { cache: "no-store", signal: controller.signal },
        );
        const body = await responseJson<{ reactions: readonly ViewReaction[] }>(response);
        setReactions(body.reactions);
        setError(undefined);
        setLoading(false);
        const active = body.reactions.some((reaction) =>
          reaction.attention.status === "queued" ||
          reaction.attention.status === "running" ||
          reaction.knowledge.status === "queued" ||
          reaction.knowledge.status === "running"
        );
        timer = setTimeout(load, active ? pollIntervalMs : Math.max(pollIntervalMs, 10_000));
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
        timer = setTimeout(load, Math.max(pollIntervalMs, 10_000));
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, limit, pollIntervalMs, reloadSequence, viewKey]);

  const refresh = useCallback(() => setReloadSequence((value) => value + 1), []);
  const markSeen = useCallback(async (reactionId: string) => {
    const response = await fetch(
      `/api/views/${encodeURIComponent(viewKey)}/reactions/${encodeURIComponent(reactionId)}/seen`,
      { method: "POST" },
    );
    const body = await responseJson<{ reaction: ViewReaction }>(response);
    setReactions((current) => current.map((reaction) =>
      reaction.id === body.reaction.id ? body.reaction : reaction
    ));
    return body.reaction;
  }, [viewKey]);

  return { reactions, error, loading: enabled && loading, refresh, markSeen };
}

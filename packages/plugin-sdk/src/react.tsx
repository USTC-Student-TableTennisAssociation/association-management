"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  ViewCardState,
  ViewManifest,
  ViewSchema,
} from "./index.js";

export interface EchoViewSnapshot {
  viewKey: string;
  pluginVersion: string;
  schemaVersion: string;
  stateVersion: string;
  observedAt: string;
  manifest: ViewManifest;
  schema: ViewSchema;
  cards: readonly ViewCardState[];
  references: readonly unknown[];
  objects?: readonly { id: string; canonicalName: string }[];
}

interface EchoViewLoadState {
  requestKey: string;
  viewKey: string;
  snapshot?: EchoViewSnapshot;
  error?: string;
}

async function responseJson<Response>(response: globalThis.Response): Promise<Response> {
  const body = await response.json() as Response & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Echo API 请求失败：${response.status}`);
  return body;
}

export function useEchoView(viewKey: string, refreshRevision = 0) {
  const [reloadSequence, setReloadSequence] = useState(0);
  const [loadState, setLoadState] = useState<EchoViewLoadState>();
  const requestKey = `${viewKey}:${refreshRevision}:${reloadSequence}`;

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/views/${encodeURIComponent(viewKey)}`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(responseJson<EchoViewSnapshot>)
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

export function useEchoCommand(viewKey: string) {
  return useCallback(async <Result = unknown>(
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

"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function SetupPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [actorObjectId, setActorObjectId] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/status", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((body: { setupRequired?: boolean }) => {
        if (body.setupRequired === false) router.replace("/login");
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [router]);

  function updateDisplayName(value: string) {
    setDisplayName(value);
    if (!loginName || loginName === displayName) setLoginName(value);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          loginName,
          password,
          ...(actorObjectId.trim() ? { actorObjectId: actorObjectId.trim() } : {}),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "无法完成初始化。");
      router.replace("/");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "无法完成初始化。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#eef2ef] px-5 py-10 text-zinc-950">
      <section className="w-full max-w-lg rounded-2xl border border-emerald-950/10 bg-white p-8 shadow-xl shadow-emerald-950/10">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">Sydaris 首次配置</p>
        <h1 className="mt-3 text-3xl font-semibold">创建第一个管理员</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">该账号会同时建立 Actor 身份，并关联同名 Actor Object。后续可以由此账号创建其他成员。</p>
        <form className="mt-7 grid gap-5" onSubmit={submit}>
          <label className="text-sm font-medium text-zinc-800">
            真实姓名
            <input autoFocus value={displayName} onChange={(event) => updateDisplayName(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-zinc-300 px-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
          </label>
          <label className="text-sm font-medium text-zinc-800">
            登录名
            <input autoComplete="username" value={loginName} onChange={(event) => setLoginName(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-zinc-300 px-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
          </label>
          <label className="text-sm font-medium text-zinc-800">
            密码（至少 8 位）
            <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-zinc-300 px-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
          </label>
          <label className="text-xs text-zinc-500">
            可选：如果系统提示存在多个同名 Object，填写确认后的 Actor Object ID
            <input aria-label="Actor Object ID" placeholder="UUID" value={actorObjectId} onChange={(event) => setActorObjectId(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-zinc-300 px-3 text-sm text-zinc-800" />
          </label>
          {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
          <button type="submit" disabled={submitting || !displayName.trim() || !loginName.trim() || password.length < 8} className="h-11 rounded-lg bg-emerald-800 font-medium text-white hover:bg-emerald-700 disabled:bg-zinc-300">
            {submitting ? "正在初始化…" : "创建管理员并进入 Sydaris"}
          </button>
        </form>
      </section>
    </main>
  );
}

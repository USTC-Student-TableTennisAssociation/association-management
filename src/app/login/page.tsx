"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/status", { cache: "no-store", signal: controller.signal })
      .then((response) => response.json())
      .then((body: { setupRequired?: boolean }) => {
        if (body.setupRequired) router.replace("/setup");
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [router]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ loginName, password }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "无法登录。");
      router.replace("/");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "无法登录。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#eef2ef] px-5 py-10 text-zinc-950">
      <section className="w-full max-w-md rounded-2xl border border-emerald-950/10 bg-white p-8 shadow-xl shadow-emerald-950/10">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">Sydaris</p>
        <h1 className="mt-3 text-3xl font-semibold">登录</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-600">使用管理员为你设置的姓名账号和密码进入工作空间。</p>
        <form className="mt-7 space-y-5" onSubmit={submit}>
          <label className="block text-sm font-medium text-zinc-800">
            登录名
            <input autoFocus autoComplete="username" value={loginName} onChange={(event) => setLoginName(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-zinc-300 px-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
          </label>
          <label className="block text-sm font-medium text-zinc-800">
            密码
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 h-11 w-full rounded-lg border border-zinc-300 px-3 outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100" />
          </label>
          {error ? <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
          <button type="submit" disabled={submitting || !loginName.trim() || !password} className="h-11 w-full rounded-lg bg-emerald-800 font-medium text-white hover:bg-emerald-700 disabled:bg-zinc-300">
            {submitting ? "正在登录…" : "登录"}
          </button>
        </form>
      </section>
    </main>
  );
}

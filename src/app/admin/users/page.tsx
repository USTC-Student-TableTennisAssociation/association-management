"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type UserRow = {
  id: string;
  loginName: string;
  role: "ADMIN" | "MEMBER";
  status: "ACTIVE" | "DISABLED";
  lastLoginAt: string | null;
  actor: { displayName: string };
  actorObject: { id: string; canonicalName: string } | null;
};

export default function UserAdminPage() {
  const router = useRouter();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [loginName, setLoginName] = useState("");
  const [password, setPassword] = useState("");
  const [actorObjectId, setActorObjectId] = useState("");
  const [role, setRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const loadUsers = useCallback(async () => {
    const response = await fetch("/api/admin/users", { cache: "no-store" });
    if (response.status === 401) {
      router.replace("/login");
      return;
    }
    if (response.status === 403) {
      router.replace("/");
      return;
    }
    const body = await response.json() as { users?: UserRow[]; error?: string };
    if (!response.ok || !body.users) throw new Error(body.error ?? "无法读取账号列表。");
    setUsers(body.users);
  }, [router]);

  useEffect(() => {
    async function load() {
      try {
        await loadUsers();
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "无法读取账号列表。");
      }
    }
    void load();
  }, [loadUsers]);

  function updateDisplayName(value: string) {
    setDisplayName(value);
    if (!loginName || loginName === displayName) setLoginName(value);
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName,
          loginName,
          password,
          role,
          ...(actorObjectId.trim() ? { actorObjectId: actorObjectId.trim() } : {}),
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "无法创建账号。");
      setDisplayName("");
      setLoginName("");
      setPassword("");
      setActorObjectId("");
      setRole("MEMBER");
      await loadUsers();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "无法创建账号。");
    } finally {
      setBusy(false);
    }
  }

  async function updateUser(userId: string, changes: Record<string, unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "无法更新账号。");
      await loadUsers();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "无法更新账号。");
    } finally {
      setBusy(false);
    }
  }

  function resetPassword(user: UserRow) {
    const nextPassword = window.prompt(`为 ${user.actor.displayName} 设置新密码（至少 8 位）：`);
    if (nextPassword) void updateUser(user.id, { password: nextPassword });
  }

  return (
    <main className="min-h-dvh bg-[#f4f6f3] px-5 py-8 text-zinc-950">
      <div className="mx-auto max-w-6xl">
        <header className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-700">Sydaris 管理</p>
            <h1 className="mt-2 text-3xl font-semibold">登录人员</h1>
            <p className="mt-2 text-sm text-zinc-600">账号与 Actor、Actor Object 一对一关联。密码只能重置，不能查看。</p>
          </div>
          <button onClick={() => router.push("/")} className="rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm hover:bg-zinc-50">返回 Sydaris</button>
        </header>

        {error ? <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}

        <section className="mt-7 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">创建账号</h2>
          <form onSubmit={createUser} className="mt-4 grid gap-4 md:grid-cols-5">
            <input aria-label="真实姓名" placeholder="真实姓名" value={displayName} onChange={(event) => updateDisplayName(event.target.value)} className="h-10 rounded-lg border border-zinc-300 px-3 text-sm" />
            <input aria-label="登录名" placeholder="登录名" value={loginName} onChange={(event) => setLoginName(event.target.value)} className="h-10 rounded-lg border border-zinc-300 px-3 text-sm" />
            <input aria-label="初始密码" type="password" placeholder="初始密码（至少 8 位）" value={password} onChange={(event) => setPassword(event.target.value)} className="h-10 rounded-lg border border-zinc-300 px-3 text-sm" />
            <select aria-label="账号角色" value={role} onChange={(event) => setRole(event.target.value as "ADMIN" | "MEMBER")} className="h-10 rounded-lg border border-zinc-300 px-3 text-sm">
              <option value="MEMBER">成员</option>
              <option value="ADMIN">管理员</option>
            </select>
            <button disabled={busy || !displayName.trim() || !loginName.trim() || password.length < 8} className="h-10 rounded-lg bg-emerald-800 px-4 text-sm font-medium text-white disabled:bg-zinc-300">创建</button>
            <label className="md:col-span-5 text-xs text-zinc-500">
              可选：同名 Object 存在歧义时，填写系统提示的 Actor Object ID
              <input aria-label="Actor Object ID" placeholder="UUID" value={actorObjectId} onChange={(event) => setActorObjectId(event.target.value)} className="mt-2 h-9 w-full rounded-lg border border-zinc-300 px-3 text-sm text-zinc-800" />
            </label>
          </form>
        </section>

        <section className="mt-6 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
          <div className="grid grid-cols-[1.1fr_1fr_0.7fr_0.8fr_1.4fr] gap-3 border-b border-zinc-200 bg-zinc-50 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            <span>姓名 / Object</span><span>登录名</span><span>角色</span><span>状态</span><span>操作</span>
          </div>
          {users.map((user) => (
            <div key={user.id} className="grid grid-cols-[1.1fr_1fr_0.7fr_0.8fr_1.4fr] items-center gap-3 border-b border-zinc-100 px-5 py-4 text-sm last:border-b-0">
              <div><p className="font-medium">{user.actor.displayName}</p><p className="mt-1 truncate text-xs text-zinc-500">{user.actorObject?.canonicalName ?? "未关联 Actor Object"}</p></div>
              <span>{user.loginName}</span>
              <span>{user.role === "ADMIN" ? "管理员" : "成员"}</span>
              <span className={user.status === "ACTIVE" ? "text-emerald-700" : "text-zinc-400"}>{user.status === "ACTIVE" ? "已启用" : "已停用"}</span>
              <div className="flex flex-wrap gap-2">
                <button disabled={busy} onClick={() => resetPassword(user)} className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs">重置密码</button>
                <button disabled={busy} onClick={() => void updateUser(user.id, { role: user.role === "ADMIN" ? "MEMBER" : "ADMIN" })} className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs">设为{user.role === "ADMIN" ? "成员" : "管理员"}</button>
                <button disabled={busy} onClick={() => void updateUser(user.id, { status: user.status === "ACTIVE" ? "DISABLED" : "ACTIVE" })} className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs">{user.status === "ACTIVE" ? "停用" : "启用"}</button>
              </div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

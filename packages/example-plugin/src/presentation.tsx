"use client";

import { useState } from "react";

import type { EchoPresentationProps } from "@sydaris/plugin-sdk";
import { useEchoCommand, useEchoView } from "@sydaris/plugin-sdk/react";

export function ExampleNotesWorkspace(props: EchoPresentationProps) {
  const { snapshot, loading, error, refresh } = useEchoView(
    props.viewKey,
    props.refreshRevision,
  );
  const runCommand = useEchoCommand(props.viewKey);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<string>();
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!snapshot || !title.trim()) return;
    setSaving(true);
    setStatus(undefined);
    try {
      const result = await runCommand<{ kind?: string }>(
        "example.create_note",
        { title: title.trim(), body: body.trim() || undefined },
        snapshot.stateVersion,
      );
      setTitle("");
      setBody("");
      setStatus(result.kind === "proposed" ? "已创建待审批 Proposal" : "笔记已创建");
      refresh();
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 32 }}>正在加载示例 View…</div>;
  if (!snapshot) return <div style={{ padding: 32, color: "#b91c1c" }}>{error}</div>;

  return (
    <main style={{ minHeight: "100%", background: "#f6f7f5", padding: 28 }}>
      <header style={{ maxWidth: 960, margin: "0 auto 24px" }}>
        <small style={{ color: "#047857", fontWeight: 700 }}>ONLINE PLUGIN EXAMPLE</small>
        <h1 style={{ margin: "8px 0", fontSize: 32 }}>{snapshot.manifest.label}</h1>
        <p style={{ color: "#52525b" }}>{snapshot.manifest.description}</p>
      </header>
      <div style={{ maxWidth: 960, margin: "0 auto", display: "grid", gap: 20 }}>
        <form
          onSubmit={submit}
          style={{ background: "white", border: "1px solid #e4e4e7", borderRadius: 16, padding: 20 }}
        >
          <h2 style={{ marginTop: 0 }}>新建笔记</h2>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="标题"
            style={{ width: "100%", padding: 10, marginBottom: 10 }}
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="正文"
            rows={4}
            style={{ width: "100%", padding: 10, marginBottom: 10 }}
          />
          <button type="submit" disabled={saving || !title.trim()}>
            {saving ? "提交中…" : "提交 Command"}
          </button>
          {status ? <p>{status}</p> : null}
        </form>
        <section style={{ display: "grid", gap: 12 }}>
          {snapshot.cards.map((card) => (
            <article key={card.id} style={{ background: "white", borderRadius: 14, padding: 18 }}>
              <strong>{String(card.dimensions.title ?? "未命名")}</strong>
              {card.dimensions.body ? <p>{String(card.dimensions.body)}</p> : null}
            </article>
          ))}
          {!snapshot.cards.length ? <p style={{ color: "#71717a" }}>还没有笔记。</p> : null}
        </section>
      </div>
    </main>
  );
}

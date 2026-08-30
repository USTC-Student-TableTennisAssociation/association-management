"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AIInvocation } from "@sydaris/plugin-sdk";

import type {
  LibraryDeleteResult,
  LibraryFolderView,
  LibraryImportBatchView,
  LibraryListing,
  LibraryNodeView,
  LibraryProcessingProfile,
} from "@/library/types";

const PROFILE_LABELS: Record<LibraryProcessingProfile, string> = {
  catalog: "仅归档",
  coarse: "粗编译",
  deep: "深度冷启动",
};

const STATUS_LABELS: Record<LibraryNodeView["processingStatus"], string> = {
  idle: "未处理",
  queued: "已排队",
  running: "处理中",
  ready: "已完成",
  failed: "失败",
};

function readableSize(raw?: string): string {
  if (!raw) return "—";
  const size = Number(raw);
  if (!Number.isFinite(size)) return raw;
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "资料库操作失败");
  return body;
}

function FolderTree({
  rootId,
  folders,
  activeId,
  onOpen,
}: {
  rootId: string;
  folders: LibraryFolderView[];
  activeId: string;
  onOpen: (id: string) => void;
}) {
  const children = new Map<string, LibraryFolderView[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const list = children.get(folder.parentId) ?? [];
    list.push(folder);
    children.set(folder.parentId, list);
  }
  for (const list of children.values()) {
    list.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }
  const renderChildren = (parentId: string, depth: number): React.ReactNode =>
    (children.get(parentId) ?? []).map((folder) => (
      <div key={folder.id}>
        <button
          type="button"
          onClick={() => onOpen(folder.id)}
          className={`flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm ${
            activeId === folder.id
              ? "bg-emerald-100 font-medium text-emerald-900"
              : "text-zinc-700 hover:bg-zinc-100"
          }`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <span aria-hidden="true">📁</span>
          <span className="truncate">{folder.name}</span>
        </button>
        {renderChildren(folder.id, depth + 1)}
      </div>
    ));
  return (
    <div>
      <button
        type="button"
        onClick={() => onOpen(rootId)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
          activeId === rootId
            ? "bg-emerald-100 font-medium text-emerald-900"
            : "text-zinc-700 hover:bg-zinc-100"
        }`}
      >
        <span aria-hidden="true">🗂️</span> 资料库
      </button>
      {renderChildren(rootId, 1)}
    </div>
  );
}

function FilePreview({ item }: { item: LibraryNodeView }) {
  const source = `/api/library/files/${encodeURIComponent(item.id)}/content?disposition=inline`;
  if (item.mimeType?.startsWith("image/")) {
    return <Image unoptimized src={source} alt={item.name} width={1024} height={768} className="max-h-72 w-full rounded-md bg-zinc-100 object-contain" />;
  }
  if (item.mimeType === "application/pdf" || item.mimeType === "text/plain") {
    return <iframe src={source} title={item.name} className="h-72 w-full rounded-md border border-zinc-200 bg-white" />;
  }
  return (
    <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-4 py-8 text-center text-sm text-zinc-500">
      当前格式不在线预览，可下载后用本地应用打开。
    </div>
  );
}

export function LibraryWorkspace({
  initialFolderId,
  onFolderChange,
  onOpenProcessing,
  onInvokeAI,
  onOpenAI,
}: {
  initialFolderId?: string;
  onFolderChange?: (folderId: string) => void;
  onOpenProcessing: () => void;
  onInvokeAI: (invocation: AIInvocation) => void;
  onOpenAI: () => void;
}) {
  const [listing, setListing] = useState<LibraryListing>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string>();
  const [filter, setFilter] = useState("");
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState("");
  const [importing, setImporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [importProgress, setImportProgress] = useState<{
    completed: number;
    total: number;
    label: string;
  }>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (folderId?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const params = folderId ? `?parentId=${encodeURIComponent(folderId)}` : "";
      const next = await requestJson<LibraryListing>(`/api/library${params}`);
      setListing(next);
      setSelected(new Set());
      setFocusedId(undefined);
      onFolderChange?.(next.folder.id);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法读取资料库");
    } finally {
      setLoading(false);
    }
  }, [onFolderChange]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(initialFolderId), 0);
    return () => window.clearTimeout(timer);
  }, [initialFolderId, load]);

  useEffect(() => {
    const refresh = () => void load(listing?.folder.id);
    window.addEventListener("sydaris-library-changed", refresh);
    return () => window.removeEventListener("sydaris-library-changed", refresh);
  }, [listing?.folder.id, load]);

  const visibleItems = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase("zh-CN");
    if (!query) return listing?.items ?? [];
    return (listing?.items ?? []).filter((item) =>
      item.name.toLocaleLowerCase("zh-CN").includes(query) ||
      item.originalRelativePath?.toLocaleLowerCase("zh-CN").includes(query)
    );
  }, [filter, listing?.items]);
  const focused = listing?.items.find((item) => item.id === focusedId);
  const selectedFiles = listing?.items.filter(
    (item) => selected.has(item.id) && item.kind === "file",
  ) ?? [];

  async function mutate(url: string, body: unknown) {
    setError(undefined);
    try {
      await requestJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await load(listing?.folder.id);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "操作失败");
    }
  }

  async function createFolder() {
    if (!listing) return;
    const name = window.prompt("新文件夹名称");
    if (!name) return;
    await mutate("/api/library/folders", { parentId: listing.folder.id, name });
  }

  async function renameFocused() {
    if (!focused) return;
    const name = window.prompt("新名称", focused.name);
    if (!name || name === focused.name) return;
    setError(undefined);
    try {
      await requestJson(`/api/library/items/${encodeURIComponent(focused.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      await load(listing?.folder.id);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "重命名失败");
    }
  }

  async function setProfile(profile: LibraryProcessingProfile) {
    if (!selectedFiles.length) return;
    await mutate("/api/library/profile", {
      nodeIds: selectedFiles.map((item) => item.id),
      profile,
    });
  }

  async function importFromBrowser(files: File[], folderMode: boolean) {
    if (!listing || !files.length) return;
    setImporting(true);
    setError(undefined);
    setNotice(undefined);
    let batchId: string | undefined;
    try {
      const browserPaths = files.map((file) => file.webkitRelativePath || file.name);
      const rootFolderName = folderMode ? browserPaths[0].split("/")[0] : undefined;
      if (folderMode && (
        !rootFolderName ||
        browserPaths.some((relativePath) => relativePath.split("/")[0] !== rootFolderName)
      )) {
        throw new Error("一次只能导入一个根文件夹");
      }
      const relativePaths = browserPaths.map((relativePath, index) => {
        if (!folderMode) return files[index].name;
        const insideRoot = relativePath.split("/").slice(1).join("/");
        if (!insideRoot) throw new Error("文件夹中包含无效文件路径");
        return insideRoot;
      });
      const maximumFileBytes = 128 * 1024 * 1024;
      if (files.some((file) => file.size > maximumFileBytes)) {
        throw new Error("单个文件不能超过 128 MB");
      }
      const started = await requestJson<LibraryImportBatchView>("/api/library/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentId: listing.folder.id,
          displayName: rootFolderName ?? `网页导入 ${files.length} 个文件`,
          ...(rootFolderName ? { rootFolderName } : {}),
        }),
      });
      batchId = started.id;
      const chunks: Array<Array<{ file: File; relativePath: string }>> = [];
      let currentChunk: Array<{ file: File; relativePath: string }> = [];
      let currentBytes = 0;
      for (let index = 0; index < files.length; index += 1) {
        const entry = { file: files[index], relativePath: relativePaths[index] };
        if (currentChunk.length && (
          currentChunk.length >= 6 ||
          currentBytes + entry.file.size > 240 * 1024 * 1024
        )) {
          chunks.push(currentChunk);
          currentChunk = [];
          currentBytes = 0;
        }
        currentChunk.push(entry);
        currentBytes += entry.file.size;
      }
      if (currentChunk.length) chunks.push(currentChunk);
      let completedFiles = 0;
      for (const chunk of chunks) {
        setImportProgress({
          completed: completedFiles,
          total: files.length,
          label: `正在导入 ${chunk[0].relativePath}`,
        });
        const formData = new FormData();
        formData.append("batchId", started.id);
        formData.append("parentId", started.uploadParentId);
        formData.append("relativePaths", JSON.stringify(chunk.map((entry) => entry.relativePath)));
        for (const entry of chunk) formData.append("files", entry.file, entry.file.name);
        await requestJson<{ files: unknown[] }>("/api/library/import", {
          method: "POST",
          body: formData,
        });
        completedFiles += chunk.length;
        setImportProgress({
          completed: completedFiles,
          total: files.length,
          label: `已导入 ${completedFiles} / ${files.length}`,
        });
      }
      const finished = await requestJson<{
        fileCount: number;
        uniqueBlobCount: number;
      }>("/api/library/import", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: started.id }),
      });
      setNotice(`导入完成：${finished.fileCount} 个文件，${finished.uniqueBlobCount} 个唯一内容。`);
      setImportProgress(undefined);
      await load(listing.folder.id);
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : "导入失败";
      if (batchId) {
        await requestJson("/api/library/import", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ batchId, errorMessage: message }),
        }).catch(() => undefined);
      }
      setError(message);
    } finally {
      setImporting(false);
    }
  }

  async function deleteSelectedOrFocused() {
    if (!listing) return;
    const targetIds = selected.size
      ? [...selected]
      : focused
        ? [focused.id]
        : [];
    if (!targetIds.length) return;
    const targetItems = listing.items.filter((item) => targetIds.includes(item.id));
    const folderCount = targetItems.filter((item) => item.kind === "folder").length;
    const confirmed = window.confirm(
      folderCount
        ? `确定永久删除 ${targetIds.length} 个项目吗？其中包含 ${folderCount} 个文件夹，文件夹内容也会递归删除。`
        : `确定永久删除选中的 ${targetIds.length} 个文件吗？`,
    );
    if (!confirmed) return;
    setDeleting(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await requestJson<LibraryDeleteResult>("/api/library/items", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nodeIds: targetIds }),
      });
      setNotice([
        `已删除 ${result.deletedNodes} 个文件树节点`,
        `清理 ${result.deletedBlobs} 个无引用原件`,
        result.deletedImportBatches ? `清理 ${result.deletedImportBatches} 个空导入批次` : undefined,
        result.retainedSharedBlobs ? `保留 ${result.retainedSharedBlobs} 个仍被其他位置引用的原件` : undefined,
        result.storageWarnings.length ? `磁盘清理警告 ${result.storageWarnings.length} 条` : undefined,
      ].filter(Boolean).join("；") + "。");
      await load(listing.folder.id);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-zinc-200 bg-white px-6 py-5 lg:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-emerald-700">组织原始资料</p>
            <h1 className="mt-1 text-2xl font-semibold text-zinc-950">资料库</h1>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={onOpenProcessing} className="rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50">导入与处理</button>
            <button type="button" onClick={onOpenAI} className="rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-50">与 Sydaris 整理</button>
            <button type="button" onClick={() => onInvokeAI({ actionId: "library.triage", message: "帮我筛选当前资料库的处理优先级，先给建议。" })} className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800">请 AI 帮我筛选</button>
          </div>
        </div>
        {listing ? (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {[
              ["文件", listing.summary.files],
              ["文件夹", listing.summary.folders],
              ["仅归档", listing.summary.catalog],
              ["粗编译", listing.summary.coarse],
              ["深度冷启动", listing.summary.deep],
              ["唯一内容", listing.summary.uniqueBlobs],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2">
                <p className="text-xs text-zinc-500">{label}</p>
                <p className="mt-0.5 text-lg font-semibold text-zinc-900">{value}</p>
              </div>
            ))}
          </div>
        ) : null}
      </header>

      <div className="flex min-h-[38rem] flex-1">
        <aside className="w-64 shrink-0 border-r border-zinc-200 bg-[#f8f9f7] p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">文件夹</p>
            <button type="button" onClick={createFolder} className="rounded px-2 py-1 text-sm text-emerald-700 hover:bg-emerald-100" title="新建文件夹">＋</button>
          </div>
          {listing ? <FolderTree rootId={listing.rootId} folders={listing.folders} activeId={listing.folder.id} onOpen={(id) => void load(id)} /> : null}
          <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-3 text-xs leading-5 text-zinc-500">
            <p className="font-medium text-zinc-700">网页导入</p>
            <p className="mt-1">可直接选择多个文件或整个文件夹。Sydaris 会复制原件、保留目录层级，并按 SHA-256 去重。</p>
          </div>
        </aside>

        <section className="min-w-0 flex-1 p-5 lg:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1 text-sm">
              {listing?.breadcrumbs.map((entry, index) => (
                <span key={entry.id} className="flex items-center gap-1">
                  {index ? <span className="text-zinc-300">/</span> : null}
                  <button type="button" onClick={() => void load(entry.id)} className="rounded px-1.5 py-1 text-zinc-700 hover:bg-zinc-100">{entry.name}</button>
                </span>
              ))}
            </div>
            <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="在当前文件夹筛选…" className="h-9 w-60 rounded-md border border-zinc-200 bg-white px-3 text-sm outline-none focus:border-emerald-500" />
          </div>

          <div className="mt-3 flex min-h-10 flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2">
            <button type="button" onClick={createFolder} className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-50">＋ 新建文件夹</button>
            <button type="button" disabled={importing || deleting} onClick={() => fileInputRef.current?.click()} className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-sm text-emerald-800 hover:bg-emerald-100 disabled:opacity-40">↑ 导入文件</button>
            <button type="button" disabled={importing || deleting} onClick={() => folderInputRef.current?.click()} className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-sm text-emerald-800 hover:bg-emerald-100 disabled:opacity-40">↑ 导入文件夹</button>
            <button type="button" disabled={!focused} onClick={renameFocused} className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-40">重命名</button>
            <button type="button" disabled={!selected.size} onClick={() => { setMoveTarget(listing?.rootId ?? ""); setMoveOpen(true); }} className="rounded-md border border-zinc-200 px-2.5 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-40">移动到…</button>
            <button type="button" disabled={deleting || importing || (!selected.size && !focused)} onClick={() => void deleteSelectedOrFocused()} className="rounded-md border border-red-200 px-2.5 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40">{deleting ? "删除中…" : "删除"}</button>
            <span className="mx-1 h-5 w-px bg-zinc-200" />
            <select disabled={!selectedFiles.length} defaultValue="" onChange={(event) => { if (event.target.value) void setProfile(event.target.value as LibraryProcessingProfile); event.currentTarget.value = ""; }} className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-sm disabled:opacity-40">
              <option value="" disabled>设置处理档位…</option>
              <option value="catalog">仅归档（不解析）</option>
              <option value="coarse">粗编译</option>
              <option value="deep">深度冷启动</option>
            </select>
            <span className="ml-auto text-xs text-zinc-500">已选 {selected.size} 项</span>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void importFromBrowser(files, false); }} />
            <input ref={folderInputRef} type="file" multiple className="hidden" {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)} onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ""; void importFromBrowser(files, true); }} />
          </div>

          {error ? <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
          {notice ? <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}
          {importProgress ? (
            <div className="mt-3 rounded-md border border-sky-200 bg-sky-50 px-3 py-2.5">
              <div className="flex items-center justify-between gap-3 text-xs text-sky-900"><span className="truncate">{importProgress.label}</span><span>{importProgress.completed}/{importProgress.total}</span></div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-sky-100"><div className="h-full rounded-full bg-sky-600 transition-[width]" style={{ width: `${importProgress.total ? importProgress.completed / importProgress.total * 100 : 0}%` }} /></div>
            </div>
          ) : null}
          <div className="mt-3 overflow-hidden rounded-lg border border-zinc-200 bg-white">
            <table className="w-full table-fixed text-left text-sm">
              <thead className="bg-zinc-50 text-xs text-zinc-500">
                <tr><th className="w-10 px-3 py-2"></th><th className="px-3 py-2">名称</th><th className="w-32 px-3 py-2">处理档位</th><th className="w-24 px-3 py-2">大小</th><th className="w-36 px-3 py-2">修改时间</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {loading ? <tr><td colSpan={5} className="px-4 py-12 text-center text-zinc-400">正在读取资料库…</td></tr> : null}
                {!loading && !visibleItems.length ? <tr><td colSpan={5} className="px-4 py-12 text-center text-zinc-400">当前文件夹是空的</td></tr> : null}
                {visibleItems.map((item) => (
                  <tr key={item.id} onClick={() => setFocusedId(item.id)} onDoubleClick={() => { if (item.kind === "folder") void load(item.id); }} className={`cursor-default hover:bg-emerald-50/50 ${focusedId === item.id ? "bg-emerald-50" : ""}`}>
                    <td className="px-3 py-2"><input type="checkbox" checked={selected.has(item.id)} onChange={(event) => { setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(item.id); else next.delete(item.id); return next; }); }} onClick={(event) => event.stopPropagation()} aria-label={`选择 ${item.name}`} /></td>
                    <td className="truncate px-3 py-2.5 font-medium text-zinc-800" title={item.name}><span className="mr-2" aria-hidden="true">{item.kind === "folder" ? "📁" : item.mimeType?.startsWith("image/") ? "🖼️" : "📄"}</span>{item.name}{item.duplicateCount ? <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-normal text-zinc-500">同内容 {item.duplicateCount + 1} 份</span> : null}</td>
                    <td className="px-3 py-2 text-xs text-zinc-600">{item.kind === "file" ? PROFILE_LABELS[item.processingProfile] : "—"}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{readableSize(item.byteSize)}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="w-72 shrink-0 border-l border-zinc-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">详细信息</p>
          {!focused ? <p className="mt-8 text-center text-sm leading-6 text-zinc-400">单击文件查看预览与索引信息。</p> : (
            <div className="mt-3 space-y-4">
              <div><p className="break-words font-medium text-zinc-900">{focused.name}</p><p className="mt-1 text-xs text-zinc-500">{focused.kind === "folder" ? "文件夹" : focused.mimeType}</p></div>
              {focused.kind === "file" ? <FilePreview item={focused} /> : null}
              <dl className="space-y-2 text-xs">
                <div><dt className="text-zinc-400">处理方式</dt><dd className="mt-0.5 text-zinc-700">{PROFILE_LABELS[focused.processingProfile]} · {STATUS_LABELS[focused.processingStatus]}</dd></div>
                {focused.originalRelativePath ? <div><dt className="text-zinc-400">导入时路径</dt><dd className="mt-0.5 break-all text-zinc-700">{focused.originalRelativePath}</dd></div> : null}
                {focused.sha256 ? <div><dt className="text-zinc-400">SHA-256</dt><dd className="mt-0.5 break-all font-mono text-[10px] text-zinc-500">{focused.sha256}</dd></div> : null}
              </dl>
              {focused.kind === "file" ? <a href={`/api/library/files/${encodeURIComponent(focused.id)}/content`} className="block rounded-md border border-zinc-200 px-3 py-2 text-center text-sm text-zinc-700 hover:bg-zinc-50">下载原文件</a> : null}
            </div>
          )}
        </aside>
      </div>

      {moveOpen && listing ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-zinc-950/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setMoveOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-label="移动到文件夹" className="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl">
            <h2 className="text-lg font-semibold">移动 {selected.size} 个项目</h2>
            <label className="mt-4 block text-sm text-zinc-600">目标文件夹<select value={moveTarget} onChange={(event) => setMoveTarget(event.target.value)} className="mt-2 h-10 w-full rounded-md border border-zinc-200 bg-white px-3"><option value={listing.rootId}>资料库</option>{listing.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
            <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setMoveOpen(false)} className="rounded-md border border-zinc-200 px-3 py-2 text-sm">取消</button><button type="button" onClick={() => { setMoveOpen(false); void mutate("/api/library/move", { nodeIds: [...selected], targetFolderId: moveTarget }); }} className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white">确认移动</button></div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

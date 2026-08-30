"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DimensionDefinition } from "@sydaris/plugin-sdk";

import styles from "./society-overview.module.css";

export type SocietyCreateKind = "advisor" | "team" | "activity" | "platform";

export type SocietyObjectOption = {
  id: string;
  canonicalName: string;
};

export type SocietyCreateSubmission = {
  object: SocietyObjectOption;
  values: Record<string, string>;
};

type SocietyCardCreatorProps = {
  kind: SocietyCreateKind;
  title: string;
  objectLabel: string;
  dimensions: readonly DimensionDefinition[];
  excludedObjectIds: ReadonlySet<string>;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onCreate: (submission: SocietyCreateSubmission) => void;
};

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5 5 10 10M15 5 5 15" />
    </svg>
  );
}

function fieldValue(dimension: DimensionDefinition): string {
  const value = dimension.defaultValue;
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : String(value);
}

function renderField(input: {
  dimension: DimensionDefinition;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { dimension, value, disabled, onChange } = input;
  const fieldId = `society-creator-${dimension.key}`;
  const describedBy = dimension.description ? `${fieldId}-description` : undefined;
  const common = {
    id: fieldId,
    name: dimension.key,
    value,
    disabled,
    required: dimension.required,
    "aria-describedby": describedBy,
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
    ) => onChange(event.target.value),
  };
  if (dimension.type === "enum") {
    return (
      <select {...common}>
        {!dimension.required ? <option value="">未设置</option> : null}
        {(dimension.constraints?.enumOptions ?? []).map((option) => (
          <option key={option.key} value={option.key}>{option.label}</option>
        ))}
      </select>
    );
  }
  if (dimension.type === "rich_text" || dimension.presentation?.multiline) {
    return <textarea {...common} rows={5} maxLength={dimension.constraints?.maxLength} />;
  }
  return (
    <input
      {...common}
      type={dimension.key === "url" ? "url" : dimension.type === "date" ? "date" : "text"}
      minLength={dimension.constraints?.minLength}
      maxLength={dimension.constraints?.maxLength}
      pattern={dimension.constraints?.pattern}
      placeholder={dimension.presentation?.placeholder}
    />
  );
}

export function SocietyCardCreator({
  kind,
  title,
  objectLabel,
  dimensions,
  excludedObjectIds,
  saving,
  error,
  onClose,
  onCreate,
}: SocietyCardCreatorProps) {
  const initialValues = useMemo(() => Object.fromEntries(
    dimensions.map((dimension) => [dimension.key, fieldValue(dimension)]),
  ), [dimensions]);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [query, setQuery] = useState("");
  const [objects, setObjects] = useState<readonly SocietyObjectOption[]>([]);
  const [selectedObject, setSelectedObject] = useState<SocietyObjectOption>();
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const sheetRef = useRef<HTMLElement>(null);
  const hasChanges = Boolean(selectedObject) || Object.entries(values).some(
    ([key, value]) => value !== (initialValues[key] ?? ""),
  );
  const requestClose = useCallback(() => {
    if (saving) return;
    if (hasChanges) setConfirmDiscard(true);
    else onClose();
  }, [hasChanges, onClose, saving]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      void fetch(`/api/objects?query=${encodeURIComponent(query)}&limit=20`, {
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json() as {
          objects?: readonly SocietyObjectOption[];
          error?: string;
        };
        if (!response.ok) throw new Error(body.error ?? "无法搜索稳定 Object");
        setObjects((body.objects ?? []).filter((object) => !excludedObjectIds.has(object.id)));
        setSearchError(undefined);
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setSearchError(cause instanceof Error ? cause.message : String(cause));
        }
      }).finally(() => {
        if (!controller.signal.aborted) setSearching(false);
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [excludedObjectIds, query]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const firstField = sheetRef.current?.querySelector<HTMLElement>("input");
    firstField?.focus();
    return () => previous?.focus();
  }, [kind]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        event.preventDefault();
        if (confirmDiscard) setConfirmDiscard(false);
        else requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const focusable = [...sheet.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
      )].filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmDiscard, requestClose, saving]);

  return (
    <div
      className={styles.editorScrim}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <section
        ref={sheetRef}
        className={styles.editorSheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="society-creator-title"
      >
        <header className={styles.editorHeader}>
          <div>
            <p>直接管理</p>
            <h2 id="society-creator-title">{title}</h2>
            <span>先选择已有的稳定 Object，再填写这张 Card 的正式字段。</span>
          </div>
          <button type="button" onClick={requestClose} disabled={saving} aria-label="关闭新增面板">
            <CloseIcon />
          </button>
        </header>

        <form
          className={styles.editorForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!selectedObject || saving) return;
            onCreate({
              object: selectedObject,
              values: Object.fromEntries(
                Object.entries(values).filter(([, value]) => value !== ""),
              ),
            });
          }}
        >
          <div className={styles.editorFields}>
            <div className={styles.objectPicker}>
              <label htmlFor="society-object-search">{objectLabel}</label>
              {selectedObject ? (
                <div className={styles.selectedObject}>
                  <span>{selectedObject.canonicalName}</span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => setSelectedObject(undefined)}
                  >
                    重新选择
                  </button>
                </div>
              ) : (
                <>
                  <input
                    id="society-object-search"
                    type="search"
                    value={query}
                    disabled={saving}
                    placeholder={`搜索${objectLabel}`}
                    autoComplete="off"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  <div className={styles.objectResults} role="listbox" aria-label={`${objectLabel}搜索结果`}>
                    {objects.map((object) => (
                      <button
                        key={object.id}
                        type="button"
                        role="option"
                        aria-selected="false"
                        onClick={() => setSelectedObject(object)}
                      >
                        {object.canonicalName}
                      </button>
                    ))}
                    {!searching && !objects.length ? (
                      <p>没有匹配的稳定 Object；如需建立新对象，请先让 Sydaris 根据证据创建。</p>
                    ) : null}
                    {searching ? <p>正在搜索…</p> : null}
                  </div>
                </>
              )}
              {searchError ? <small role="alert">{searchError}</small> : null}
            </div>

            {dimensions.map((dimension) => (
              <label key={dimension.key} className={styles.editorField}>
                <span>{dimension.label}{dimension.required ? <b>必填</b> : null}</span>
                {renderField({
                  dimension,
                  value: values[dimension.key] ?? "",
                  disabled: saving,
                  onChange: (value) => setValues((current) => ({
                    ...current,
                    [dimension.key]: value,
                  })),
                })}
                {dimension.description ? (
                  <small id={`society-creator-${dimension.key}-description`}>
                    {dimension.description}
                  </small>
                ) : null}
              </label>
            ))}
          </div>

          {confirmDiscard ? (
            <div className={styles.discardPrompt} role="alert">
              <div>
                <strong>放弃本次新增？</strong>
                <p>已选择的 Object 和填写内容不会保留。</p>
              </div>
              <div>
                <button type="button" autoFocus onClick={() => setConfirmDiscard(false)}>继续编辑</button>
                <button type="button" onClick={onClose}>放弃</button>
              </div>
            </div>
          ) : (
            <div className={styles.editorFooter}>
              <p role="status" aria-live="polite">
                {error ?? "新增内容会直接写入正式 View，并保留审计记录。"}
              </p>
              <div>
                <button type="button" onClick={requestClose} disabled={saving}>取消</button>
                <button type="submit" disabled={!selectedObject || saving}>
                  {saving ? "正在保存…" : "新增"}
                </button>
              </div>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}

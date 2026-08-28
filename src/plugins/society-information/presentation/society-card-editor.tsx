"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CardTypeDefinition,
  DimensionDefinition,
  ViewCardState,
} from "@sydaris/plugin-sdk";

import styles from "./society-overview.module.css";

export type SocietyDimensionChanges = Record<string, string | null>;
export type SocietyRemovalReason = "ENTERED_BY_MISTAKE" | "WRONG_OBJECT";

type SocietyCardEditorProps = {
  card: ViewCardState;
  cardType: CardTypeDefinition;
  identityLabel: string;
  saving: boolean;
  removing?: boolean;
  error?: string;
  removeLabel?: string;
  onClose: () => void;
  onSave: (changes: SocietyDimensionChanges) => void;
  onRemove?: (reason: SocietyRemovalReason) => void;
};

function stringValue(value: unknown, fallback: unknown): string {
  const resolved = value ?? fallback;
  if (resolved === undefined || resolved === null) return "";
  return typeof resolved === "string" ? resolved : String(resolved);
}

function fieldValue(
  card: ViewCardState,
  dimension: DimensionDefinition,
): string {
  return stringValue(card.dimensions[dimension.key], dimension.defaultValue);
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m5 5 10 10M15 5 5 15" />
    </svg>
  );
}

function renderField(input: {
  dimension: DimensionDefinition;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { dimension, value, disabled, onChange } = input;
  const fieldId = `society-editor-${dimension.key}`;
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
      type={dimension.type === "date" ? "date" : "text"}
      min={dimension.constraints?.min?.toString()}
      max={dimension.constraints?.max?.toString()}
      minLength={dimension.constraints?.minLength}
      maxLength={dimension.constraints?.maxLength}
      pattern={dimension.constraints?.pattern}
      placeholder={dimension.presentation?.placeholder}
    />
  );
}

export function SocietyCardEditor({
  card,
  cardType,
  identityLabel,
  saving,
  removing = false,
  error,
  removeLabel,
  onClose,
  onSave,
  onRemove,
}: SocietyCardEditorProps) {
  const initialValues = useMemo(() => Object.fromEntries(
    cardType.dimensions.map((dimension) => [dimension.key, fieldValue(card, dimension)]),
  ), [card, cardType]);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeReason, setRemoveReason] = useState<SocietyRemovalReason>("ENTERED_BY_MISTAKE");
  const [closing, setClosing] = useState(false);
  const sheetRef = useRef<HTMLElement>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const changes = useMemo(() => Object.fromEntries(
    cardType.dimensions.flatMap((dimension) => {
      const before = initialValues[dimension.key] ?? "";
      const after = values[dimension.key] ?? "";
      if (before === after) return [];
      return [[dimension.key, after === "" && !dimension.required ? null : after]];
    }),
  ) as SocietyDimensionChanges, [cardType.dimensions, initialValues, values]);
  const hasChanges = Object.keys(changes).length > 0;
  const busy = saving || removing;

  const finishClose = useCallback(() => {
    if (busy || closing) return;
    setConfirmDiscard(false);
    setClosing(true);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    closeTimerRef.current = window.setTimeout(onClose, reducedMotion ? 0 : 180);
  }, [busy, closing, onClose]);

  const requestClose = useCallback(() => {
    if (busy || closing) return;
    if (hasChanges) {
      setConfirmDiscard(true);
      return;
    }
    finishClose();
  }, [busy, closing, finishClose, hasChanges]);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const firstField = sheetRef.current?.querySelector<HTMLElement>("input, textarea, select");
    firstField?.focus();
    return () => previous?.focus();
  }, [card.id]);

  useEffect(() => () => {
    if (closeTimerRef.current !== undefined) window.clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        if (confirmRemove) setConfirmRemove(false);
        else if (confirmDiscard) setConfirmDiscard(false);
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
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, confirmDiscard, confirmRemove, requestClose]);

  return (
    <div
      className={styles.editorScrim}
      data-closing={closing ? "true" : undefined}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) requestClose();
      }}
    >
      <section
        ref={sheetRef}
        className={styles.editorSheet}
        data-closing={closing ? "true" : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby="society-editor-title"
      >
        <header className={styles.editorHeader}>
          <div>
            <p>{cardType.label} Card</p>
            <h2 id="society-editor-title">编辑{identityLabel}</h2>
            <span>名称来自关联 Object；这里可以修改这张 Card 的全部正式字段。</span>
          </div>
          <button type="button" onClick={requestClose} disabled={busy || closing} aria-label="关闭编辑面板">
            <CloseIcon />
          </button>
        </header>

        <form
          className={styles.editorForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (hasChanges && !busy) onSave(changes);
          }}
        >
          <div className={styles.editorFields}>
            {cardType.dimensions.map((dimension) => (
              <label key={dimension.key} className={styles.editorField}>
                <span>{dimension.label}{dimension.required ? <b>必填</b> : null}</span>
                {renderField({
                  dimension,
                  value: values[dimension.key] ?? "",
                  disabled: busy,
                  onChange: (value) => setValues((current) => ({
                    ...current,
                    [dimension.key]: value,
                  })),
                })}
                {dimension.description ? (
                  <small id={`society-editor-${dimension.key}-description`}>
                    {dimension.description}
                  </small>
                ) : null}
              </label>
            ))}
          </div>

          {confirmRemove && onRemove ? (
            <div className={styles.removePrompt} role="alert">
              <div>
                <strong>确认{removeLabel ?? "移除这项内容"}？</strong>
                <p>这会修改正式 View；活动与平台 Card 会被删除，人员关系会从当前名单中解除。</p>
                {error ? <p role="alert">{error}</p> : null}
                <label>
                  移除原因
                  <select
                    value={removeReason}
                    disabled={removing}
                    onChange={(event) => setRemoveReason(event.target.value as SocietyRemovalReason)}
                  >
                    <option value="ENTERED_BY_MISTAKE">录入有误</option>
                    <option value="WRONG_OBJECT">关联了错误对象</option>
                  </select>
                </label>
              </div>
              <div>
                <button type="button" disabled={removing} onClick={() => setConfirmRemove(false)}>继续编辑</button>
                <button type="button" disabled={removing} onClick={() => onRemove(removeReason)}>
                  {removing ? "正在移除…" : "确认移除"}
                </button>
              </div>
            </div>
          ) : confirmDiscard ? (
            <div className={styles.discardPrompt} role="alert">
              <div>
                <strong>放弃未保存的修改？</strong>
                <p>关闭后，本次填写的内容不会保留。</p>
              </div>
              <div>
                <button type="button" autoFocus onClick={() => setConfirmDiscard(false)}>继续编辑</button>
                <button type="button" onClick={finishClose}>放弃修改</button>
              </div>
            </div>
          ) : (
            <div className={styles.editorFooter}>
              <p role="status" aria-live="polite">
                {error ?? (hasChanges ? "修改会立即写入正式 View，并保留审计记录。" : "尚未修改字段。")}
              </p>
              <div>
                {onRemove ? (
                  <button
                    type="button"
                    className={styles.editorRemoveButton}
                    disabled={busy || closing}
                    onClick={() => setConfirmRemove(true)}
                  >
                    移除
                  </button>
                ) : null}
                <button type="button" onClick={requestClose} disabled={busy || closing}>取消</button>
                <button type="submit" disabled={!hasChanges || busy || closing}>
                  {saving ? "正在保存…" : "保存修改"}
                </button>
              </div>
            </div>
          )}
        </form>
      </section>
    </div>
  );
}

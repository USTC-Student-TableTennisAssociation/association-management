"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  CardTypeDefinition,
  DimensionDefinition,
  ViewCardState,
} from "@/contracts";

import styles from "./society-overview.module.css";

export type SocietyDimensionChanges = Record<string, string | null>;

type SocietyCardEditorProps = {
  card: ViewCardState;
  cardType: CardTypeDefinition;
  identityLabel: string;
  saving: boolean;
  error?: string;
  onClose: () => void;
  onSave: (changes: SocietyDimensionChanges) => void;
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
  error,
  onClose,
  onSave,
}: SocietyCardEditorProps) {
  const initialValues = useMemo(() => Object.fromEntries(
    cardType.dimensions.map((dimension) => [dimension.key, fieldValue(card, dimension)]),
  ), [card, cardType]);
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const sheetRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    const firstField = sheetRef.current?.querySelector<HTMLElement>("input, textarea, select");
    firstField?.focus();
    return () => previous?.focus();
  }, [card.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, saving]);

  const changes = useMemo(() => Object.fromEntries(
    cardType.dimensions.flatMap((dimension) => {
      const before = initialValues[dimension.key] ?? "";
      const after = values[dimension.key] ?? "";
      if (before === after) return [];
      return [[dimension.key, after === "" && !dimension.required ? null : after]];
    }),
  ) as SocietyDimensionChanges, [cardType.dimensions, initialValues, values]);
  const hasChanges = Object.keys(changes).length > 0;

  return (
    <div
      className={styles.editorScrim}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        ref={sheetRef}
        className={styles.editorSheet}
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
          <button type="button" onClick={onClose} disabled={saving} aria-label="关闭编辑面板">
            <CloseIcon />
          </button>
        </header>

        <form
          className={styles.editorForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (hasChanges && !saving) onSave(changes);
          }}
        >
          <div className={styles.editorFields}>
            {cardType.dimensions.map((dimension) => (
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
                  <small id={`society-editor-${dimension.key}-description`}>
                    {dimension.description}
                  </small>
                ) : null}
              </label>
            ))}
          </div>

          <div className={styles.editorFooter}>
            <p role="status" aria-live="polite">
              {error ?? (hasChanges ? "修改会立即写入正式 View，并保留审计记录。" : "尚未修改字段。")}
            </p>
            <div>
              <button type="button" onClick={onClose} disabled={saving}>取消</button>
              <button type="submit" disabled={!hasChanges || saving}>
                {saving ? "正在保存…" : "保存修改"}
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

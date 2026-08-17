function localDateTimeAt(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = new Map(parts.map((part) => [part.type, part.value]));
  return `${value.get("year")}-${value.get("month")}-${value.get("day")} ${value.get("hour")}:${value.get("minute")}:${value.get("second")}`;
}

export function buildCurrentTimeInstruction(instant: Date, timezone: string): string {
  if (Number.isNaN(instant.getTime())) throw new Error("当前时刻不是有效日期");
  const localDateTime = localDateTimeAt(instant, timezone);
  return [
    `当前组织时间：${localDateTime}（${timezone}）。`,
    "它只用于解释相对时间，不能证明组织信息当前仍然有效。",
  ].join("\n");
}

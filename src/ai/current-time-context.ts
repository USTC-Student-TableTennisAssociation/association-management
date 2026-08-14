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
    "本轮时间锚点（由 Echo 服务端提供，不是组织事实证据）：",
    `- 当前时刻（ISO 8601）：${instant.toISOString()}`,
    `- 组织本地时间：${localDateTime}`,
    `- 组织时区：${timezone}`,
    "仅用该时间锚点解释“今天”“目前”“本学期”“刚才”等相对时间；不能仅凭当前时间断言某条组织信息现在仍然有效。",
  ].join("\n");
}

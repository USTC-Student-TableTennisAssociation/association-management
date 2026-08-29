import type { ToolProviderExtension } from "@/contracts";
import {
  COMPETITION_EDITION_PROJECT_CAPABILITY,
  COMPETITION_EDITION_PROJECTION_PROVIDER_ID,
  COMPETITION_TOOL_CAPABILITY_VERSION,
  type CompetitionEditionProjectInput,
  type CompetitionEditionProjectOutput,
} from "@/plugins/competition-records/tools/contracts";

const digitValues: Readonly<Record<string, number>> = {
  "零": 0,
  "〇": 0,
  "一": 1,
  "二": 2,
  "两": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
};
const unitValues: Readonly<Record<string, number>> = {
  "十": 10,
  "百": 100,
  "千": 1_000,
};

function chineseInteger(value: string): number | undefined {
  if (/^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  let total = 0;
  let digit = 0;
  for (const character of value) {
    if (character in digitValues) {
      digit = digitValues[character];
      continue;
    }
    const unit = unitValues[character];
    if (!unit) return undefined;
    total += (digit || 1) * unit;
    digit = 0;
  }
  const parsed = total + digit;
  return parsed > 0 ? parsed : undefined;
}

export function sequenceNumberFromTitle(title: string): number | undefined {
  const match = title.match(/第\s*(\d+|[零〇一二两三四五六七八九十百千]+)\s*(?:次|届|周|期|场)/u);
  return match ? chineseInteger(match[1]) : undefined;
}

export function projectCompetitionEditions(
  input: CompetitionEditionProjectInput,
): CompetitionEditionProjectOutput {
  return {
    sourceSystem: input.batch.sourceSystem,
    sourceSchemaVersion: input.batch.sourceSchemaVersion,
    mappingVersion: "1",
    sourceSnapshotAt: input.batch.sourceSnapshotAt,
    editions: input.batch.records.map((record) => {
      const sequenceNumber = sequenceNumberFromTitle(record.title);
      return {
        sourceSystem: input.batch.sourceSystem,
        sourceId: record.sourceId,
        name: record.title,
        participantCount: record.participantCount,
        ...(sequenceNumber ? { sequenceNumber } : {}),
        heldOn: record.heldOn,
      };
    }),
  };
}

export const competitionEditionProjectionProvider: ToolProviderExtension = {
  id: COMPETITION_EDITION_PROJECTION_PROVIDER_ID,
  version: "2.0.0",
  implementations: [{
    capability: {
      key: COMPETITION_EDITION_PROJECT_CAPABILITY,
      version: COMPETITION_TOOL_CAPABILITY_VERSION,
    },
    execute: async (_context, input) =>
      projectCompetitionEditions(input as CompetitionEditionProjectInput),
  }],
};

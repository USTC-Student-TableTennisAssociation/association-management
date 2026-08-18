export type SourceDocumentSelectionMode =
  | "outline"
  | "around"
  | "section"
  | "range"
  | "full";

export type SourceDocumentMetadata = {
  id: string;
  title: string;
  sha256: string;
  parser: string;
  pageCount: number;
  blockCount: number;
};

export type SourceDocumentOutlineEntry = {
  sourceBlockId: string;
  order: number;
  headingLevel: number;
  headingPath: string[];
  title: string;
  pages: number[];
};

export type SourceDocumentBlock = {
  sourceBlockId: string;
  order: number;
  blockType: string;
  headingLevel: number | null;
  headingPath: string[];
  pages: number[];
  markdown: string;
};

export type SourceDocumentReadResult = {
  document: SourceDocumentMetadata;
  selection: {
    mode: SourceDocumentSelectionMode;
    label: string;
    startOrder?: number;
    endOrder?: number;
  };
  /** S# is attached by the request-local Chat tool registry for content reads. */
  ref?: string;
  outline?: SourceDocumentOutlineEntry[];
  blocks: SourceDocumentBlock[];
  requestedMaxCharacters: number;
  returnedCharacters: number;
  isFullDocument: boolean;
  isCompleteSelection: boolean;
  continuationCursor?: string;
  semantics?: EvidenceSemantics;
};

export type SourceDocumentReference = {
  ref: string;
  label: string;
  document: SourceDocumentMetadata;
  selection: SourceDocumentReadResult["selection"];
  startBlockId: string;
  endBlockId: string;
  blockCount: number;
  pages: number[];
};

export type SourceDocumentReferenceBundle = {
  references: SourceDocumentReference[];
};
import type { EvidenceSemantics } from "@/evidence/types";

import { z } from "zod";

export const libraryProcessingProfileSchema = z.enum(["catalog", "coarse", "deep"]);
export type LibraryProcessingProfile = z.infer<typeof libraryProcessingProfileSchema>;

export const libraryNodeKindSchema = z.enum(["file", "folder"]);
export type LibraryNodeKind = z.infer<typeof libraryNodeKindSchema>;

export type LibraryPathEntry = {
  id: string;
  name: string;
};

export type LibraryNodeView = {
  id: string;
  kind: LibraryNodeKind;
  parentId?: string;
  name: string;
  processingProfile: LibraryProcessingProfile;
  processingStatus: "idle" | "queued" | "running" | "ready" | "failed";
  originalRelativePath?: string;
  mimeType?: string;
  byteSize?: string;
  sha256?: string;
  duplicateCount: number;
  updatedAt: string;
};

export type LibraryFolderView = {
  id: string;
  parentId?: string;
  name: string;
};

export type LibraryListing = {
  rootId: string;
  folder: LibraryFolderView;
  breadcrumbs: LibraryPathEntry[];
  folders: LibraryFolderView[];
  items: LibraryNodeView[];
  summary: {
    files: number;
    folders: number;
    catalog: number;
    coarse: number;
    deep: number;
    uniqueBlobs: number;
  };
};

export type LibraryRecursiveListing = {
  folders: LibraryFolderView[];
  items: LibraryNodeView[];
  matchedCount: number;
  offset: number;
  returnedCount: number;
  nextOffset?: number;
  truncated: boolean;
};

export type LibraryFilePreviewView = {
  id: string;
  name: string;
  originalRelativePath?: string;
  mimeType: string;
  available: boolean;
  parser?: string;
  excerpt?: string;
  truncated?: boolean;
  warning?: string;
};

export type LibraryImportBatchView = {
  id: string;
  uploadParentId: string;
};

export type LibraryImportFileResult = {
  nodeId: string;
  name: string;
  sha256: string;
  byteSize: string;
};

export type LibraryDeleteResult = {
  deletedNodes: number;
  deletedBlobs: number;
  deletedImportBatches: number;
  retainedSharedBlobs: number;
  storageWarnings: string[];
};

const createFolderOperationSchema = z.object({
  type: z.literal("CREATE_FOLDER"),
  folderRef: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(50),
  parent: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(255),
});

const moveNodesOperationSchema = z.object({
  type: z.literal("MOVE_NODES"),
  nodeIds: z.array(z.string().uuid()).min(1).max(100),
  target: z.string().min(1).max(100),
});

const setProfileOperationSchema = z.object({
  type: z.literal("SET_PROFILE"),
  nodeIds: z.array(z.string().uuid()).min(1).max(200),
  profile: libraryProcessingProfileSchema,
});

export const libraryPlanOperationSchema = z.discriminatedUnion("type", [
  createFolderOperationSchema,
  moveNodesOperationSchema,
  setProfileOperationSchema,
]);

export const libraryPlanPayloadSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
  operations: z.array(libraryPlanOperationSchema).min(1).max(100),
});

export type LibraryPlanOperation = z.infer<typeof libraryPlanOperationSchema>;

export type LibraryPlanPresentation = {
  id: string;
  status: "pending" | "rejected" | "applied" | "failed";
  reason: string;
  createdAt: string;
  failureReason?: string;
  operations: Array<LibraryPlanOperation & { description: string }>;
};

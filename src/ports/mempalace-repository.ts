import type { KgFact, PalaceStatus, SearchResult } from "../types.js";

export interface MemorySearchRequest {
  query: string;
  limit: number;
  timeoutMs?: number;
}

export interface KgTimelineRequest {
  daysBack: number;
}

export interface KgTimelineEvent {
  date: string;
  fact: string;
}

export interface KgEntityQueryRequest {
  entity: string;
  timeoutMs?: number;
}

export interface KgInvalidateRequest {
  subject: string;
  predicate: string;
  object: string;
}

export interface DiaryWriteRequest {
  agentName: string;
  entry: string;
  topic?: string;
  wing?: string;
  timeoutMs?: number;
}

export interface DiaryReadRequest {
  agentName: string;
  lastN?: number;
  topic?: string;
  timeoutMs?: number;
}

export type DiaryPersistenceState =
  | "unavailable"
  | "tool-present"
  | "write-ok-unverified"
  | "persistent";

export interface DiaryPersistenceProbeResult {
  state: DiaryPersistenceState;
  verified: boolean;
  error?: string;
}

export interface DiaryPersistenceProbeRequest {
  timeoutMs?: number;
}

export type MemPalaceRepositoryErrorCode =
  | "CapabilityMissing"
  | "ToolFailed"
  | "PersistenceUnverified"
  | "BackendUnavailable";

export class MemPalaceRepositoryError extends Error {
  constructor(
    readonly code: MemPalaceRepositoryErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = code;
  }
}

export class CapabilityMissing extends MemPalaceRepositoryError {
  constructor(capability: string) {
    super("CapabilityMissing", `MemPalace capability missing: ${capability}`);
  }
}

export class ToolFailed extends MemPalaceRepositoryError {
  constructor(toolName: string, cause?: unknown) {
    super("ToolFailed", `MemPalace tool failed: ${toolName}`, cause);
  }
}

export class PersistenceUnverified extends MemPalaceRepositoryError {
  constructor(message = "MemPalace diary write could not be verified as persistent", cause?: unknown) {
    super("PersistenceUnverified", message, cause);
  }
}

export class BackendUnavailable extends MemPalaceRepositoryError {
  constructor(cause?: unknown) {
    super("BackendUnavailable", "MemPalace backend unavailable", cause);
  }
}

export interface MemPalaceRepository {
  readonly canWriteDiary: boolean;
  readonly canReadDiary: boolean;
  readonly canInvalidateKg: boolean;
  readonly canPersistDiary: boolean;
  readonly diaryPersistenceState: DiaryPersistenceState;
  getPalaceStatus(): Promise<PalaceStatus>;
  searchMemory(request: MemorySearchRequest): Promise<SearchResult[]>;
  queryKgEntity(request: KgEntityQueryRequest): Promise<unknown>;
  addKgFact(fact: KgFact): Promise<unknown>;
  invalidateKgFact(request: KgInvalidateRequest): Promise<unknown>;
  readKgTimeline(request: KgTimelineRequest): Promise<KgTimelineEvent[]>;
  writeDiary(request: DiaryWriteRequest): Promise<unknown>;
  readDiary<T = unknown>(request: DiaryReadRequest): Promise<T>;
  verifyDiaryPersistence(request?: DiaryPersistenceProbeRequest): Promise<DiaryPersistenceProbeResult>;
}

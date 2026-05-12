import type {
  DiaryPersistenceProbeRequest,
  DiaryPersistenceProbeResult,
  DiaryPersistenceState,
  DiaryReadRequest,
  DiaryWriteRequest,
  KgEntityQueryRequest,
  KgInvalidateRequest,
  KgTimelineEvent,
  KgTimelineRequest,
  MemorySearchRequest,
  MemPalaceRepository,
} from "../ports/mempalace-repository.js";
import {
  BackendUnavailable,
  CapabilityMissing,
  PersistenceUnverified,
  ToolFailed,
} from "../ports/mempalace-repository.js";
import type { KgFact, PalaceStatus, SearchResult } from "../types.js";

interface McpToolClient {
  hasDiaryWrite: boolean;
  hasDiaryRead: boolean;
  hasKgInvalidate: boolean;
  callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
}

export class McpMemPalaceRepository implements MemPalaceRepository {
  private persistenceState: DiaryPersistenceState = "unavailable";
  private readonly diaryProbeTimeoutMs = 500;

  constructor(private readonly mcp: McpToolClient) {}

  get canWriteDiary(): boolean {
    return this.mcp.hasDiaryWrite;
  }

  get canReadDiary(): boolean {
    return this.mcp.hasDiaryRead;
  }

  get canInvalidateKg(): boolean {
    return this.mcp.hasKgInvalidate;
  }

  get canPersistDiary(): boolean {
    return this.persistenceState === "persistent";
  }

  get diaryPersistenceState(): DiaryPersistenceState {
    if (!this.canWriteDiary || !this.canReadDiary) return "unavailable";
    return this.persistenceState;
  }

  async getPalaceStatus(): Promise<PalaceStatus> {
    try {
      return await this.mcp.callTool<PalaceStatus>("mempalace_status", {});
    } catch (err) {
      throw mapMcpToolError("mempalace_status", err);
    }
  }

  async searchMemory(request: MemorySearchRequest): Promise<SearchResult[]> {
    try {
      const args = {
        query: request.query,
        limit: request.limit,
      };
      const raw =
        request.timeoutMs === undefined
          ? await this.mcp.callTool<{ results?: SearchResult[] }>("mempalace_search", args)
          : await this.mcp.callTool<{ results?: SearchResult[] }>(
              "mempalace_search",
              args,
              request.timeoutMs,
            );
      return raw.results ?? [];
    } catch (err) {
      throw mapMcpToolError("mempalace_search", err);
    }
  }

  async queryKgEntity(request: KgEntityQueryRequest): Promise<unknown> {
    try {
      const args = {
        entity: request.entity,
      };
      return request.timeoutMs === undefined
        ? await this.mcp.callTool<unknown>("mempalace_kg_query", args)
        : await this.mcp.callTool<unknown>("mempalace_kg_query", args, request.timeoutMs);
    } catch (err) {
      throw mapMcpToolError("mempalace_kg_query", err);
    }
  }

  async addKgFact(fact: KgFact): Promise<unknown> {
    try {
      return await this.mcp.callTool("mempalace_kg_add", {
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        valid_from: fact.valid_from,
        source_closet: fact.source_closet,
      });
    } catch (err) {
      throw mapMcpToolError("mempalace_kg_add", err);
    }
  }

  async invalidateKgFact(request: KgInvalidateRequest): Promise<unknown> {
    try {
      return await this.mcp.callTool("mempalace_kg_invalidate", {
        subject: request.subject,
        predicate: request.predicate,
        object: request.object,
      });
    } catch (err) {
      throw mapMcpToolError("mempalace_kg_invalidate", err);
    }
  }

  async readKgTimeline(request: KgTimelineRequest): Promise<KgTimelineEvent[]> {
    try {
      const raw = await this.mcp.callTool<KgTimelineEvent[]>("mempalace_kg_timeline", {
        days_back: request.daysBack,
      });
      return Array.isArray(raw) ? raw : [];
    } catch (err) {
      throw mapMcpToolError("mempalace_kg_timeline", err);
    }
  }

  async writeDiary(request: DiaryWriteRequest): Promise<unknown> {
    if (!this.canWriteDiary) throw new CapabilityMissing("mempalace_diary_write");
    try {
      const args = {
        agent_name: request.agentName,
        entry: request.entry,
        topic: request.topic,
        ...(request.wing ? { wing: request.wing } : {}),
      };
      return request.timeoutMs === undefined
        ? await this.mcp.callTool("mempalace_diary_write", args)
        : await this.mcp.callTool("mempalace_diary_write", args, request.timeoutMs);
    } catch (err) {
      throw mapMcpToolError("mempalace_diary_write", err);
    }
  }

  async readDiary<T = unknown>(request: DiaryReadRequest): Promise<T> {
    if (!this.canReadDiary) throw new CapabilityMissing("mempalace_diary_read");
    try {
      const args = {
        agent_name: request.agentName,
        ...(request.lastN === undefined ? {} : { last_n: request.lastN }),
        ...(request.topic ? { topic: request.topic } : {}),
      };
      return request.timeoutMs === undefined
        ? await this.mcp.callTool<T>("mempalace_diary_read", args)
        : await this.mcp.callTool<T>("mempalace_diary_read", args, request.timeoutMs);
    } catch (err) {
      throw mapMcpToolError("mempalace_diary_read", err);
    }
  }

  async verifyDiaryPersistence(request?: DiaryPersistenceProbeRequest): Promise<DiaryPersistenceProbeResult> {
    if (!this.canWriteDiary || !this.canReadDiary) {
      this.persistenceState = "unavailable";
      const missing = !this.canWriteDiary ? "mempalace_diary_write" : "mempalace_diary_read";
      return {
        state: this.persistenceState,
        verified: false,
        error: new CapabilityMissing(missing).message,
      };
    }

    this.persistenceState = "tool-present";
    const agentName = "remempalace-health";
    const topic = "health-probe";
    const entry = `remempalace diary persistence probe ${Date.now()} ${Math.random()
      .toString(16)
      .slice(2)}`;

    const timeoutMs = request?.timeoutMs ?? this.diaryProbeTimeoutMs;
    try {
      await this.writeDiary({ agentName, entry, topic, timeoutMs });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { state: this.persistenceState, verified: false, error };
    }

    this.persistenceState = "write-ok-unverified";

    try {
      const read = await this.readDiary<unknown>({
        agentName,
        lastN: 20,
        topic,
        timeoutMs,
      });
      if (diaryReadContains(read, entry, topic)) {
        this.persistenceState = "persistent";
        return { state: this.persistenceState, verified: true };
      }
      const error = new PersistenceUnverified().message;
      return { state: this.persistenceState, verified: false, error };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { state: this.persistenceState, verified: false, error };
    }
  }
}

function diaryReadContains(read: unknown, entry: string, topic: string): boolean {
  const entries = extractDiaryEntries(read);
  return entries.some((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    const content = record.content ?? record.entry;
    const itemTopic = record.topic;
    return content === entry && (itemTopic === undefined || itemTopic === topic);
  });
}

function extractDiaryEntries(read: unknown): unknown[] {
  if (Array.isArray(read)) return read;
  if (!read || typeof read !== "object") return [];
  const entries = (read as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries : [];
}

function mapMcpToolError(toolName: string, err: unknown): BackendUnavailable | ToolFailed {
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out|process died|ECONNRESET|EPIPE|spawn|ENOENT/i.test(message)) {
    return new BackendUnavailable(err);
  }
  return new ToolFailed(toolName, err);
}

import { extname, isAbsolute } from "node:path";

import type { ArtifactEntry } from "../artifacts/ArtifactReader.js";
import { AsarArtifactReader } from "../artifacts/AsarArtifactReader.js";
import { WorkbenchApiError, type WorkbenchFileEntry } from "./api.js";

/**
 * Run-scoped ASAR source snapshot. The reader copies the archive once into a
 * private snapshot and binds every tree and text read to those exact bytes, so
 * later target changes cannot alter what this run discloses.
 */

export interface SourceSnapshotLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_SOURCE_SNAPSHOT_LIMITS: SourceSnapshotLimits = {
  maxFileBytes: 1_000_000,
  maxTotalBytes: 32 * 1024 * 1024,
};

const TEXT_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".jsx",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".json",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".txt",
  ".md",
  ".xml",
  ".yml",
  ".yaml",
  ".svg",
  ".map",
]);

export interface RunSourceText {
  readonly path: string;
  readonly content: string;
  readonly size: number;
  readonly snapshotSha256: string;
}

export class RunAsarSourceSnapshot {
  readonly #reader: AsarArtifactReader;
  readonly #sha256: string;
  readonly #bytes: number;
  readonly #limits: SourceSnapshotLimits;
  readonly #entries = new Map<string, ArtifactEntry>();
  #entriesLoaded = false;
  #bytesServed = 0;

  constructor(
    reader: AsarArtifactReader,
    identity: { readonly sha256: string; readonly bytes: number },
    limits: SourceSnapshotLimits,
  ) {
    this.#reader = reader;
    this.#sha256 = identity.sha256;
    this.#bytes = identity.bytes;
    this.#limits = limits;
  }

  get identity(): {
    readonly format: "asar";
    readonly sha256: string;
    readonly bytes: number;
  } {
    return { format: "asar", sha256: this.#sha256, bytes: this.#bytes };
  }

  /** Direct children of `prefix` from the snapshot tree, snapshot-ordered. */
  async listChildren(
    prefix: string,
    limit: number,
  ): Promise<WorkbenchFileEntry[]> {
    const normalized = normalizeSnapshotPath(prefix);
    const entries = await this.#allEntries();
    const children: WorkbenchFileEntry[] = [];
    const parent = normalized === "" ? "" : `${normalized}/`;
    for (const [path, entry] of entries) {
      if (!path.startsWith(parent)) continue;
      const rest = path.slice(parent.length);
      if (rest === "" || rest.includes("/")) continue;
      if (entry.kind === "directory") {
        children.push({ name: rest, path, kind: "directory", extension: null });
      } else {
        children.push({
          name: rest,
          path,
          kind: "file",
          extension: extname(rest).toLowerCase() || null,
          ...(entry.kind === "symlink" ? { symlink: true } : {}),
          size: entry.declaredSize,
        });
      }
      if (children.length >= limit) break;
    }
    return children;
  }

  /** Read one text file from the fixed snapshot under the configured limits. */
  async readText(path: string): Promise<RunSourceText> {
    const normalized = normalizeSnapshotPath(path);
    if (!TEXT_EXTENSIONS.has(extname(normalized).toLowerCase()))
      throw new WorkbenchApiError(
        "source_not_text",
        "快照中仅允许读取文本类源码文件",
        [
          {
            path,
            message: `扩展名 ${extname(normalized) || "(无)"} 不在允许列表`,
          },
        ],
      );
    const entries = await this.#allEntries();
    const entry = entries.get(normalized);
    if (entry === undefined)
      throw new WorkbenchApiError("source_not_file", "快照中不存在该路径", [
        { path, message: "未在运行快照文件树中找到" },
      ]);
    if (entry.kind === "symlink")
      throw new WorkbenchApiError(
        "source_not_file",
        "快照符号链接的目标不随快照披露，拒绝读取",
        [{ path, message: "symlink entry" }],
      );
    if (entry.kind !== "file")
      throw new WorkbenchApiError("source_not_file", "请求对象不是文件", [
        { path, message: `kind ${entry.kind}` },
      ]);
    if (
      entry.declaredSize !== null &&
      entry.declaredSize > this.#limits.maxFileBytes
    )
      throw new WorkbenchApiError("source_too_large", "源码超过单次读取上限", [
        {
          path,
          message: `${String(entry.declaredSize)} 字节超过上限 ${String(this.#limits.maxFileBytes)}`,
        },
      ]);
    if (
      this.#bytesServed + (entry.declaredSize ?? 0) >
      this.#limits.maxTotalBytes
    )
      throw new WorkbenchApiError(
        "source_too_large",
        "超出本运行源码读取总额",
        [
          {
            path,
            message: `已读取 ${String(this.#bytesServed)} 字节，运行总额 ${String(this.#limits.maxTotalBytes)}`,
          },
        ],
      );
    let content: string;
    try {
      const stream = await this.#reader.open(entry);
      content = await readBoundedText(stream, this.#limits.maxFileBytes);
    } catch (cause: unknown) {
      throw new WorkbenchApiError("source_read_failed", describeError(cause), [
        { path, message: "快照成员读取失败" },
      ]);
    }
    this.#bytesServed += Buffer.byteLength(content, "utf8");
    return {
      path: normalized,
      content,
      size: Buffer.byteLength(content, "utf8"),
      snapshotSha256: this.#sha256,
    };
  }

  async close(): Promise<void> {
    await this.#reader.close();
  }

  async #allEntries(): Promise<Map<string, ArtifactEntry>> {
    if (this.#entriesLoaded) return this.#entries;
    for await (const entry of this.#reader.entries()) {
      if (entry.path !== "") this.#entries.set(entry.path, entry);
    }
    this.#entriesLoaded = true;
    return this.#entries;
  }
}

/** Capture the run's ASAR snapshot and pin its identity before any read. */
export const createRunSourceSnapshot = async (
  archivePath: string,
  limits: SourceSnapshotLimits = DEFAULT_SOURCE_SNAPSHOT_LIMITS,
): Promise<RunAsarSourceSnapshot> => {
  const reader = new AsarArtifactReader(archivePath);
  try {
    await reader.prepareContainer();
    const identity = reader.snapshotIdentity;
    if (identity === undefined) throw new Error("ASAR 快照身份缺失");
    return new RunAsarSourceSnapshot(
      reader,
      { sha256: identity.sha256, bytes: identity.bytes },
      limits,
    );
  } catch (cause: unknown) {
    await reader.close().catch(() => undefined);
    throw cause;
  }
};

export const normalizeSnapshotPath = (value: string): string => {
  const normalized = value
    .replaceAll("\\", "/")
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "");
  const parts = normalized.split("/").filter((part) => part !== "");
  if (isAbsolute(value) || parts.some((part) => part === "." || part === ".."))
    throw new WorkbenchApiError("invalid_path", "路径超出运行快照范围", [
      { path: value, message: "不接受绝对路径或路径穿越" },
    ]);
  return parts.join("/");
};

const readBoundedText = async (
  stream: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<string> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += data.length;
    if (total > maxBytes)
      throw new WorkbenchApiError("source_too_large", "源码超过单次读取上限", [
        { message: `超过 ${String(maxBytes)} 字节` },
      ]);
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

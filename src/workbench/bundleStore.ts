import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Evidence } from "../domain/evidence.js";
import { WorkbenchApiError } from "./api.js";
import type { WorkbenchBundleManifest } from "./types.js";

const COMPLETE_MARKER = "COMPLETE";
const TEMP_PREFIX = ".tmp-";
const INCOMPLETE_PREFIX = ".incomplete-";
const DIAGNOSTICS_LOG = "bundle-diagnostics.log";

export interface WorkbenchBundleCommitInput {
  readonly runId: string;
  readonly evidenceId: string;
  readonly targetSha256: string | null;
  readonly workflowId: string;
  readonly workflowVersion: string;
}

export interface WorkbenchBundleRecovery {
  readonly removed: readonly string[];
  readonly failed: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}

/**
 * Filesystem home of run evidence bundles. Large payloads live under
 * `<root>/<run-id>/`; the SQLite database only stores the committed manifest.
 * A bundle becomes visible only through one atomic rename of a fully written,
 * verified, marker-stamped temp directory, so an interrupted process can never
 * expose a bundle that looks complete but is not.
 */
export class WorkbenchBundleStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
    mkdirSync(root, { recursive: true });
  }

  get root(): string {
    return this.#root;
  }

  /** Write, verify, stamp, and atomically publish one run's evidence bundle. */
  async commit(
    input: WorkbenchBundleCommitInput,
    evidence: Evidence,
  ): Promise<WorkbenchBundleManifest> {
    const finalDirectory = join(this.#root, input.runId);
    const existing = this.readManifest(input.runId);
    if (existing !== null) return existing;
    const tempDirectory = join(
      this.#root,
      `${TEMP_PREFIX}${input.runId}-${randomBytes(4).toString("hex")}`,
    );
    try {
      mkdirSync(tempDirectory, { recursive: true });
      const payload = JSON.stringify(evidence);
      writeFileSync(join(tempDirectory, "evidence.json"), payload, "utf8");
      const digest = createHash("sha256").update(payload).digest("hex");
      if (
        readFileSync(join(tempDirectory, "evidence.json"), "utf8") !== payload
      )
        throw new Error("Bundle payload failed post-write verification");
      const manifest: WorkbenchBundleManifest = {
        bundle_version: 1,
        run_id: input.runId,
        evidence_id: input.evidenceId,
        evidence_sha256: digest,
        target_sha256: input.targetSha256,
        workflow_id: input.workflowId,
        workflow_version: input.workflowVersion,
        committed_at: new Date().toISOString(),
      };
      writeFileSync(
        join(tempDirectory, "bundle.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
      );
      writeFileSync(join(tempDirectory, COMPLETE_MARKER), "1", "utf8");
      try {
        renameSync(tempDirectory, finalDirectory);
      } catch (cause: unknown) {
        if (this.readManifest(input.runId) !== null)
          return this.readManifest(input.runId)!;
        throw cause;
      }
      return manifest;
    } catch (cause: unknown) {
      try {
        rmSync(tempDirectory, { recursive: true, force: true });
      } catch {
        // Left for the next startup orphan scan; the commit failed loudly.
      }
      throw cause;
    }
  }

  /** Manifest of the committed bundle, or null when the run has none. */
  readManifest(runId: string): WorkbenchBundleManifest | null {
    const path = join(this.#root, runId, "bundle.json");
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as WorkbenchBundleManifest;
    } catch {
      return null;
    }
  }

  /**
   * Evidence bytes from the run's bundle, digest-verified on every read.
   * Returns null when the run has no bundle; throws a typed API error when a
   * bundle exists but is incomplete or fails its digest.
   */
  readEvidence(runId: string): Evidence | null {
    const directory = join(this.#root, runId);
    if (!existsSync(join(directory, "bundle.json"))) return null;
    if (!existsSync(join(directory, COMPLETE_MARKER)))
      throw new WorkbenchApiError(
        "bundle_integrity_failed",
        "Evidence Bundle 不完整",
        [{ path: directory, message: "缺少完成标记" }],
      );
    const manifest = this.readManifest(runId);
    if (manifest === null)
      throw new WorkbenchApiError(
        "bundle_integrity_failed",
        "Evidence Bundle 清单不可读",
        [{ path: directory, message: "bundle.json 缺失或损坏" }],
      );
    const payload = readFileSync(join(directory, "evidence.json"), "utf8");
    const digest = createHash("sha256").update(payload).digest("hex");
    if (digest !== manifest.evidence_sha256)
      throw new WorkbenchApiError(
        "bundle_integrity_failed",
        "Evidence Bundle 摘要不匹配",
        [
          {
            path: join(directory, "evidence.json"),
            message: `期望 ${manifest.evidence_sha256}，实际 ${digest}`,
          },
        ],
      );
    return JSON.parse(payload) as Evidence;
  }

  /**
   * Startup scan: remove interrupted temp commits; quarantine directory-sized
   * bundles without a completion marker. Failures stay on disk and are
   * appended to the diagnostics log instead of being silently dropped.
   */
  async recoverOrphans(): Promise<WorkbenchBundleRecovery> {
    const removed: string[] = [];
    const failed: { path: string; message: string }[] = [];
    for (const name of safeList(this.#root)) {
      const path = join(this.#root, name);
      if (name.startsWith(TEMP_PREFIX)) {
        try {
          rmSync(path, { recursive: true, force: true });
          removed.push(path);
        } catch (cause: unknown) {
          failed.push({ path, message: describeError(cause) });
        }
        continue;
      }
      if (name.startsWith(".")) continue;
      if (!statSync(path).isDirectory()) continue;
      if (existsSync(join(path, COMPLETE_MARKER))) continue;
      const quarantined = join(this.#root, `${INCOMPLETE_PREFIX}${name}`);
      try {
        rmSync(quarantined, { recursive: true, force: true });
        renameSync(path, quarantined);
        removed.push(path);
      } catch (cause: unknown) {
        failed.push({ path, message: describeError(cause) });
      }
    }
    if (failed.length > 0) {
      try {
        appendFileSync(
          join(this.#root, DIAGNOSTICS_LOG),
          `${new Date().toISOString()} ${JSON.stringify(failed)}\n`,
          "utf8",
        );
      } catch {
        // The on-disk orphan itself remains the diagnosable state.
      }
    }
    return { removed, failed };
  }
}

const safeList = (root: string): string[] => {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
};

export const defaultBundleRoot = (databasePath: string): string =>
  join(dirname(databasePath), "bundles");

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

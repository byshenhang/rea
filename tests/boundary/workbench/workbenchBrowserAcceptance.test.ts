import { access, constants } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";
import { expect, it } from "vitest";

import {
  createWorkbenchServer,
  listenWorkbenchServer,
  type WorkbenchServerHandle,
} from "../../../src/workbench/server.js";
import { defaultWorkflow } from "../../../src/workbench/store.js";

const TOKEN = "workbench-browser-acceptance-token";

interface RunningServer {
  readonly handle: WorkbenchServerHandle;
  readonly base: string;
}

const startServer = async (): Promise<RunningServer> => {
  const databasePath = join(
    await mkdtemp(join(tmpdir(), "rea-workbench-browser-")),
    "workbench.sqlite",
  );
  const handle = createWorkbenchServer({ port: 0, token: TOKEN, databasePath });
  await listenWorkbenchServer(handle);
  const address = handle.server.address();
  if (address === null || typeof address === "string")
    throw new Error("workbench server did not bind a TCP port");
  return { handle, base: `http://127.0.0.1:${String(address.port)}` };
};

let browser: Browser | undefined;

const browserExecutable = async (): Promise<string> => {
  const home = process.env.HOME ?? "";
  const candidates = [
    process.env.REA_BROWSER_EXECUTABLE,
    home === ""
      ? undefined
      : join(
          home,
          "Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        ),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" && candidate !== "",
  );
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    "No Chrome-family executable found; set REA_BROWSER_EXECUTABLE",
  );
};

interface PageOptions {
  readonly base: string;
  /** Sequential prompt() answers; the queue resets before each flow. */
  readonly targetPath?: string;
}

const openPage = async (options: PageOptions): Promise<Page> => {
  const { base, targetPath } = options;
  if (browser === undefined) {
    browser = await chromium.launch({
      executablePath: await browserExecutable(),
      args: ["--no-sandbox"],
    });
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) =>
    console.log("[wb-browser] PAGEERROR:", String(error).slice(0, 200)),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      console.log(
        "[wb-browser] HTTP",
        response.status(),
        response.request().method(),
        response.url().slice(0, 140),
      );
  });
  page.on("console", (message) => {
    if (message.type() === "error")
      console.log("[wb-browser] CONSOLE-ERR:", message.text().slice(0, 200));
  });
  await page.addInitScript(`(() => {
    let answers = [];
    let calls = 0;
    window.prompt = () => {
      const answer = answers[calls];
      calls += 1;
      return answer ?? "";
    };
    window.__wbQueue = (next) => {
      answers = next;
      calls = 0;
    };
    window.__WB_TARGET__ = ${JSON.stringify(targetPath ?? "")};
  })();`);
  await page.goto(base);
  return page;
};

const registerTargetDirectory = async (
  base: string,
  path: string,
): Promise<void> => {
  const headers = {
    "X-REA-Workbench-Token": TOKEN,
    "Content-Type": "application/json",
  };
  const project = (await (
    await fetch(`${base}/api/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "浏览器验收项目" }),
    })
  ).json()) as { id: string };
  await fetch(`${base}/api/projects/${project.id}/targets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ path, format: "directory" }),
  });
};

const waitForTerminalState = async (
  base: string,
  runId: string,
  timeoutMs: number,
): Promise<string> => {
  const headers = { "X-REA-Workbench-Token": TOKEN };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = (await (
      await fetch(`${base}/api/runs/${runId}`, { headers })
    ).json()) as { state: string };
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(run.state))
      return run.state;
    if (Date.now() > deadline)
      throw new Error(`运行未在期限内结束: ${run.state}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const makeTarget = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "rea-workbench-browser-target-"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(dir, "main.js"),
    "export const acceptance = 'browser-target';\n",
  );
  return dir;
};

it("covers create project, register target, run, cancel, evidence, and reconnect in a real browser", async () => {
  const server = await startServer();
  try {
    const targetPath = await makeTarget();
    const page = await openPage({ base: server.base, targetPath });

    // 创建项目(通过 UI):prompt 队列 [名称, 说明]
    await page
      .getByTestId("loading")
      .waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("还没有项目").waitFor({ timeout: 15_000 });
    await page.evaluate(`window.__wbQueue(["浏览器验收项目", "端到端验收"])`);
    await page.getByRole("button", { name: "+ 新建项目" }).click();
    await page.getByText("浏览器验收项目").first().waitFor({ timeout: 15_000 });

    // 登记目标(通过 UI):prompt 队列 [绝对路径]
    await page.evaluate(`window.__wbQueue([window.__WB_TARGET__ ?? ""])`);
    await page.getByRole("button", { name: "+ 登记目标" }).click();
    await page.locator(".target").first().waitFor({ timeout: 15_000 });

    // 新建运行(通过 UI):prompt 队列 [完整性策略];空队列回退 "" -> 服务端默认 fail
    await page.getByRole("button", { name: "新建运行" }).click();

    // 运行视图出现且最终成功(工作台 UI 从服务端事件驱动状态)
    await page.getByText("运行工作台").waitFor({ timeout: 15_000 });
    const statePill = page.locator(".topbar .pill").first();
    await expect
      .poll(async () => (await statePill.getAttribute("data-status")) ?? "", {
        timeout: 120_000,
      })
      .toBe("succeeded");
    await page
      .getByTestId("timeline")
      .getByText("run.finished")
      .waitFor({ timeout: 15_000 });

    // Evidence 查看(通过 UI)
    await page.getByRole("button", { name: "Evidence", exact: true }).click();
    await page
      .getByTestId("evidence-content")
      .getByText("evidence_id", { exact: false })
      .waitFor({ timeout: 30_000 });

    // 取消路径:回到项目首页(运行视图没有新建入口),再发起一个运行并立即取消
    await page.evaluate(`window.__wbQueue(["fail"])`);
    await page.locator("[data-action='select-project']").first().click();
    await page.getByRole("button", { name: "新建运行" }).click();
    await page
      .getByRole("button", { name: "取消运行" })
      .click({ timeout: 30_000 });
    const cancelPill = page.locator(".topbar .pill").first();
    await expect
      .poll(async () => (await cancelPill.getAttribute("data-status")) ?? "", {
        timeout: 60_000,
      })
      .toBe("cancelled");
    await page
      .getByRole("button", { name: "重试运行" })
      .waitFor({ timeout: 15_000 });

    // SSE 断线重连:整页刷新后由 sessionStorage 恢复当前运行与游标,时间线
    // 重放既不丢也不重。
    await page.reload();
    await page
      .getByTestId("loading")
      .waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("运行工作台").waitFor({ timeout: 15_000 });
    await page
      .getByTestId("timeline")
      .getByText("run.finished")
      .first()
      .waitFor({ timeout: 30_000 });
    const sequences = await page
      .locator("[data-testid='timeline'] .event")
      .evaluateAll((nodes) =>
        nodes
          .map((node) => Number(node.getAttribute("data-sequence")))
          .filter((value) => Number.isFinite(value)),
      );
    const unique = new Set(sequences);
    expect(unique.size).toBe(sequences.length);
    expect([...unique].sort((left, right) => left - right)).toEqual(
      sequences.slice().sort((left, right) => left - right),
    );
  } finally {
    await browser?.close().catch(() => undefined);
    browser = undefined;
    await server.handle.close();
  }
}, 240_000);

it("restores the current run and event cursor across a page reload mid-run", async () => {
  const server = await startServer();
  try {
    const targetDir = await makeTarget();
    await registerTargetDirectory(server.base, targetDir);
    const headers = {
      "X-REA-Workbench-Token": TOKEN,
      "Content-Type": "application/json",
    };
    const project = (await (
      await fetch(`${server.base}/api/projects`, { headers })
    ).json()) as Array<{ id: string }>;
    const targets = (await (
      await fetch(`${server.base}/api/projects/${project[0]?.id}/targets`, {
        headers,
      })
    ).json()) as Array<{ id: string }>;
    const run = (await (
      await fetch(`${server.base}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          project_id: project[0]?.id,
          target_id: targets[0]?.id,
        }),
      })
    ).json()) as { id: string };

    const page = await openPage({ base: server.base });
    await page.addInitScript(`
      window.sessionStorage.setItem("rea-workbench:run-id", ${JSON.stringify(run.id)});
      window.sessionStorage.setItem("rea-workbench:event-cursor", ${JSON.stringify(`${run.id}:1`)});
    `);
    await page.reload();
    await page
      .getByTestId("loading")
      .waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("运行工作台").waitFor({ timeout: 15_000 });

    // The restored run page shows the server-side terminal state even though
    // the seeded cursor was behind: the SSE resume replays the rest.
    const statePill = page.locator(".topbar .pill").first();
    await expect
      .poll(async () => (await statePill.getAttribute("data-status")) ?? "", {
        timeout: 120_000,
      })
      .toBe("succeeded");
    const sequences = await page
      .locator("[data-testid='timeline'] .event")
      .evaluateAll((nodes) =>
        nodes
          .map((node) => Number(node.getAttribute("data-sequence")))
          .filter((value) => Number.isFinite(value)),
      );
    expect(sequences.length).toBeGreaterThan(0);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(await waitForTerminalState(server.base, run.id, 60_000)).toBe(
      "succeeded",
    );
  } finally {
    await browser?.close().catch(() => undefined);
    browser = undefined;
    await server.handle.close();
  }
}, 240_000);

it("renders error envelopes and unavailable diffs from real API failures", async () => {
  const server = await startServer();
  try {
    const targetDir = await makeTarget();
    await registerTargetDirectory(server.base, targetDir);
    const targetPath = await makeTarget();
    const page = await openPage({ base: server.base, targetPath });
    await page
      .getByTestId("loading")
      .waitFor({ state: "detached", timeout: 15_000 });

    // Run a successful analysis first so the run view exists.
    await page.getByRole("button", { name: "新建运行" }).click();
    const statePill = page.locator(".topbar .pill").first();
    await expect
      .poll(async () => (await statePill.getAttribute("data-status")) ?? "", {
        timeout: 120_000,
      })
      .toBe("succeeded");

    // Unavailable diff: compare against a nonexistent run -> server 404 shows
    // the unified envelope in the banner, not an opaque failure.
    await page.getByRole("button", { name: "差异" }).click();
    await page.locator("#diffAgainst").fill("nonexistent-run");
    await page.locator("[data-action='run-diff']").click();
    await page.locator(".banner").waitFor({ timeout: 15_000 });
    expect(await page.locator(".banner").textContent()).toContain(
      "run_not_found",
    );

    // Partial-result and cleanup notes only appear for real states; assert
    // the succeeded run shows no spurious state note.
    expect(await page.getByTestId("state-note").count()).toBe(0);
  } finally {
    await browser?.close().catch(() => undefined);
    browser = undefined;
    await server.handle.close();
  }
}, 240_000);

it("registers the pinned workflow for browser acceptance runs", () => {
  expect(defaultWorkflow().workflowId).toBe("rea.javascript-electron-static");
});

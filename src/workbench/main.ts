import { listenWorkbenchServer, createWorkbenchServer } from "./server.js";

const workbench = createWorkbenchServer();
const listenReport = await listenWorkbenchServer(workbench);
process.stdout.write(
  `REA Workbench 已启动: http://${workbench.host}:${String(workbench.port)}\n`,
);
process.stdout.write(`本地访问凭据: ${workbench.token}\n`);
process.stdout.write(`数据目录: ${workbench.store.databasePath}\n`);
process.stdout.write(`Bundle 目录: ${workbench.bundles.root}\n`);
if (
  listenReport.orphanBundlesRemoved > 0 ||
  listenReport.orphanBundlesFailed > 0
)
  process.stdout.write(
    `Bundle 孤儿清理: 移除 ${String(listenReport.orphanBundlesRemoved)}，失败 ${String(listenReport.orphanBundlesFailed)}（详情见 bundle-diagnostics.log）\n`,
  );

const shutdown = async (): Promise<void> => {
  await workbench.close();
  process.exit(0);
};
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

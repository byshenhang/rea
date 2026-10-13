import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assembles the browser script from the compiled ui modules. The modules are
 * authored as ordinary TypeScript with ES imports; this assembler strips the
 * module syntax and concatenates them into one classic script, so the browser
 * payload is exactly what the repository builds — no bundler, no new toolchain.
 *
 * Module order matters: state (types + transitions), client (typed API),
 * render (pure components), app (controller), then the bootstrap glue below.
 */

const MODULE_FILES = ["state.js", "client.js", "render.js", "app.js"] as const;

const BOOTSTRAP = `
const workbenchClient = createApiClient(window.__REA_WORKBENCH_TOKEN__);
const workbenchApp = new WorkbenchApp({
  root: document.getElementById("app"),
  client: workbenchClient,
  sessionStorage: window.sessionStorage,
});
void workbenchApp.start();
`;

interface AssembledModule {
  readonly code: string;
  readonly namespaceAliases: readonly string[];
}

/**
 * Strip ES module syntax into a classic-script body. Namespace imports
 * (`import * as api from ...`) become object aliases built from the module's
 * exported bindings, so call sites like `api.listProjects` keep working.
 */
const stripModuleSyntax = (
  code: string,
  exportedNames: readonly string[],
): AssembledModule => {
  const namespaceAliases = new Set<string>();
  const body = code
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("import ")) return true;
      const namespace = trimmed.match(/^import \* as (\w+) from/u);
      if (namespace !== null) {
        namespaceAliases.add(namespace[1] ?? "");
        return false;
      }
      return false;
    })
    .join("\n")
    .replace(/export \{[^}]*\};?/gu, "")
    .replace(/export default /gu, "")
    .replace(/export (?=(const|class|function|let|var|type|interface)\b)/gu, "")
    .replace(/export type \{[^}]*\};?/gu, "");
  return {
    code: body,
    namespaceAliases: [...namespaceAliases].filter((name) => name !== ""),
  };
};

const aliasDeclaration = (
  name: string,
  exportedNames: readonly string[],
): string =>
  `const ${name} = { ${exportedNames.map((exported) => exported).join(", ")} };`;

export const workbenchUiScript = (): string => {
  const here = uiModuleDirectory();
  const parts: string[] = ['window.__REA_WORKBENCH_TOKEN__="__TOKEN__";'];
  const exportedByModule = new Map<string, readonly string[]>();
  for (const file of MODULE_FILES) {
    const source = readFileSync(join(here, file), "utf8");
    exportedByModule.set(file, exportNames(source));
  }
  for (const file of MODULE_FILES) {
    const { code, namespaceAliases } = stripModuleSyntax(
      readFileSync(join(here, file), "utf8"),
      exportedByModule.get(file) ?? [],
    );
    parts.push(code);
    // client.js is consumed through the `api` namespace alias in app.js.
    if (file === "client.js")
      parts.push(aliasDeclaration("api", exportedByModule.get(file) ?? []));
    for (const alias of namespaceAliases) {
      if (alias === "api") continue;
      parts.push(aliasDeclaration(alias, exportedByModule.get(file) ?? []));
    }
  }
  parts.push(BOOTSTRAP);
  return parts.join("\n");
};

/**
 * Resolve the directory holding the compiled ui modules. The compiled server
 * lives beside them in dist; under source execution (vitest) fall back to the
 * repository dist output, which the boundary build step refreshes.
 */
const uiModuleDirectory = (): string => {
  const candidates = [
    fileURLToPath(new URL(".", import.meta.url)),
    join(process.cwd(), "dist", "workbench", "ui"),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(join(candidate, MODULE_FILES[0] ?? "state.js"), "utf8");
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    "Workbench UI modules not compiled; run npm run build:cached",
  );
};

/** Collect runtime export names (skip `export type`, which erases at build). */
const exportNames = (source: string): readonly string[] => {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /^export (?:const|class|function|let|var) (\w+)/gmu,
  )) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names];
};

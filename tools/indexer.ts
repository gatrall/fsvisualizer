import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

interface ParsedFile {
  id: string;
  filePath: string;
  imports: string[];
  reexports: string[];
  exportedSymbols: string[];
  tokens: Set<string>;
}

interface NodeData {
  id: string;
  label: string;
  filePath: string;
  modulePath: string;
  imports: string[];
  reexports: string[];
  importTargets: string[];
  reexportTargets: string[];
  importCount: number;
  reexportCount: number;
  exports: string[];
  exportCount: number;
  symbolUsers: Record<string, string[]>;
  isVirtual?: boolean;
}

interface EdgeData {
  id: string;
  source: string;
  target: string;
  kind: "import" | "reexport";
}

interface GraphOutput {
  root: string;
  generatedAt: string;
  elements: {
    nodes: Array<{ data: NodeData }>;
    edges: Array<{ data: EdgeData }>;
  };
}

interface CliOptions {
  root: string;
  out: string;
}

function printHelp(): void {
  console.log(`FeatureScript stdlib indexer\n\nUsage:\n  npm run index -- --root <PATH_TO_STDLIB> [--out public/graph.json]\n`);
}

function parseArgs(argv: string[]): CliOptions {
  let root = "";
  let out = "public/graph.json";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--root") {
      root = argv[i + 1] ?? "";
      i += 1;
      continue;
    }

    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      continue;
    }

    if (arg === "--out") {
      out = argv[i + 1] ?? out;
      i += 1;
      continue;
    }

    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!root) {
    throw new Error("Missing required argument: --root <PATH_TO_STDLIB>");
  }

  return {
    root: path.resolve(root),
    out: path.resolve(process.cwd(), out)
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function toPosixRelative(root: string, filePath: string): string {
  return normalizePath(path.relative(root, filePath));
}

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        out += "\n";
      }
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      if (ch === "\n") {
        out += "\n";
      }
      i += 1;
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function parseImports(source: string): { imports: string[]; reexports: string[] } {
  const imports: string[] = [];
  const reexports: string[] = [];
  const importSet = new Set<string>();
  const reexportSet = new Set<string>();
  const pattern = /\b(export\s+)?import\s*\(\s*path\s*:\s*"([^"]+)"\s*,\s*version\s*:\s*"[^"]*"\s*\)\s*;/gms;

  let match = pattern.exec(source);
  while (match) {
    const target = normalizePath(match[2].trim());

    if (target) {
      if (match[1]) {
        if (!reexportSet.has(target)) {
          reexportSet.add(target);
          reexports.push(target);
        }
      } else if (!importSet.has(target)) {
        importSet.add(target);
        imports.push(target);
      }
    }

    match = pattern.exec(source);
  }

  return { imports, reexports };
}

function parseExportedSymbols(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pattern = /\bexport\s+(function|type|predicate|enum|const)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  let match = pattern.exec(source);
  while (match) {
    const symbol = match[2];
    if (!seen.has(symbol)) {
      seen.add(symbol);
      out.push(symbol);
    }
    match = pattern.exec(source);
  }

  return out;
}

function extractIdentifierTokens(source: string): Set<string> {
  const noStrings = source.replace(/"([^"\\]|\\.)*"/g, " ");
  const tokens = new Set<string>();
  const pattern = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;

  let match = pattern.exec(noStrings);
  while (match) {
    tokens.add(match[0]);
    match = pattern.exec(noStrings);
  }

  return tokens;
}

async function collectFsFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase().endsWith(".fs")) {
        files.push(fullPath);
      }
    }
  }

  await walk(root);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function buildSuffixIndex(records: ParsedFile[]): Map<string, string[]> {
  const index = new Map<string, string[]>();

  for (const record of records) {
    const segments = record.filePath.split("/").filter(Boolean);

    for (let i = 0; i < segments.length; i += 1) {
      const suffix = segments.slice(i).join("/");
      const existing = index.get(suffix) ?? [];
      existing.push(record.id);
      index.set(suffix, existing);
    }
  }

  return index;
}

function resolveModuleTarget(modulePath: string, suffixIndex: Map<string, string[]>): string | undefined {
  const normalized = normalizePath(modulePath);

  const direct = suffixIndex.get(normalized);
  if (direct && direct.length === 1) {
    return direct[0];
  }

  const segments = normalized.split("/").filter(Boolean);
  for (let i = 1; i < segments.length; i += 1) {
    const suffix = segments.slice(i).join("/");
    const matches = suffixIndex.get(suffix);
    if (matches && matches.length === 1) {
      return matches[0];
    }
  }

  return undefined;
}

function chooseModulePath(aliases: Map<string, number> | undefined, fallback: string): string {
  if (!aliases || aliases.size === 0) {
    return fallback;
  }

  return [...aliases.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      if (b[0].length !== a[0].length) {
        return b[0].length - a[0].length;
      }
      return a[0].localeCompare(b[0]);
    })[0][0];
}

async function buildGraph(root: string): Promise<GraphOutput> {
  const fsFiles = await collectFsFiles(root);
  const parsedFiles: ParsedFile[] = [];

  for (const absoluteFilePath of fsFiles) {
    const raw = await readFile(absoluteFilePath, "utf8");
    const stripped = stripComments(raw);
    const filePath = toPosixRelative(root, absoluteFilePath);
    const parsedImports = parseImports(stripped);

    parsedFiles.push({
      id: filePath,
      filePath,
      imports: parsedImports.imports,
      reexports: parsedImports.reexports,
      exportedSymbols: parseExportedSymbols(stripped),
      tokens: extractIdentifierTokens(stripped)
    });
  }

  const suffixIndex = buildSuffixIndex(parsedFiles);
  const parsedById = new Map(parsedFiles.map((file) => [file.id, file]));
  const parsedFileIds = new Set(parsedFiles.map((file) => file.id));
  const nodes: Array<{ data: NodeData }> = [];
  const edges: Array<{ data: EdgeData }> = [];
  const edgeKeys = new Set<string>();
  const virtualNodes = new Map<string, { data: NodeData }>();
  const aliasCounts = new Map<string, Map<string, number>>();
  const targetsByFile = new Map<string, { importTargets: string[]; reexportTargets: string[] }>();
  const directConsumersByTarget = new Map<string, Set<string>>();
  let edgeNumber = 0;

  for (const file of parsedFiles) {
    const importTargets: string[] = [];
    const reexportTargets: string[] = [];

    for (const targetModulePath of file.imports) {
      const resolvedTarget = resolveModuleTarget(targetModulePath, suffixIndex) ?? targetModulePath;
      importTargets.push(resolvedTarget);

      const edgeKey = `import\u0000${file.id}\u0000${resolvedTarget}`;
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        edgeNumber += 1;
        edges.push({
          data: {
            id: `e${edgeNumber}`,
            source: file.id,
            target: resolvedTarget,
            kind: "import"
          }
        });
      }

      if (parsedFileIds.has(resolvedTarget)) {
        const consumers = directConsumersByTarget.get(resolvedTarget) ?? new Set<string>();
        consumers.add(file.id);
        directConsumersByTarget.set(resolvedTarget, consumers);
      }

      if (resolvedTarget !== targetModulePath && resolvedTarget !== file.id) {
        const aliasMap = aliasCounts.get(resolvedTarget) ?? new Map<string, number>();
        aliasMap.set(targetModulePath, (aliasMap.get(targetModulePath) ?? 0) + 1);
        aliasCounts.set(resolvedTarget, aliasMap);
      }

      if (!parsedFileIds.has(resolvedTarget)) {
        virtualNodes.set(resolvedTarget, {
          data: {
            id: resolvedTarget,
            label: path.posix.basename(resolvedTarget),
            filePath: "(unresolved module)",
            modulePath: targetModulePath,
            imports: [],
            reexports: [],
            importTargets: [],
            reexportTargets: [],
            importCount: 0,
            reexportCount: 0,
            exports: [],
            exportCount: 0,
            symbolUsers: {},
            isVirtual: true
          }
        });
      }
    }

    for (const targetModulePath of file.reexports) {
      const resolvedTarget = resolveModuleTarget(targetModulePath, suffixIndex) ?? targetModulePath;
      reexportTargets.push(resolvedTarget);

      const edgeKey = `reexport\u0000${file.id}\u0000${resolvedTarget}`;
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        edgeNumber += 1;
        edges.push({
          data: {
            id: `e${edgeNumber}`,
            source: file.id,
            target: resolvedTarget,
            kind: "reexport"
          }
        });
      }

      if (parsedFileIds.has(resolvedTarget)) {
        const consumers = directConsumersByTarget.get(resolvedTarget) ?? new Set<string>();
        consumers.add(file.id);
        directConsumersByTarget.set(resolvedTarget, consumers);
      }

      if (resolvedTarget !== targetModulePath && resolvedTarget !== file.id) {
        const aliasMap = aliasCounts.get(resolvedTarget) ?? new Map<string, number>();
        aliasMap.set(targetModulePath, (aliasMap.get(targetModulePath) ?? 0) + 1);
        aliasCounts.set(resolvedTarget, aliasMap);
      }

      if (!parsedFileIds.has(resolvedTarget)) {
        virtualNodes.set(resolvedTarget, {
          data: {
            id: resolvedTarget,
            label: path.posix.basename(resolvedTarget),
            filePath: "(unresolved module)",
            modulePath: targetModulePath,
            imports: [],
            reexports: [],
            importTargets: [],
            reexportTargets: [],
            importCount: 0,
            reexportCount: 0,
            exports: [],
            exportCount: 0,
            symbolUsers: {},
            isVirtual: true
          }
        });
      }
    }

    targetsByFile.set(file.id, { importTargets, reexportTargets });
  }

  for (const file of parsedFiles) {
    const targets = targetsByFile.get(file.id) ?? { importTargets: [], reexportTargets: [] };
    const symbolUsers: Record<string, string[]> = {};
    const directConsumers = directConsumersByTarget.get(file.id) ?? new Set<string>();

    for (const symbol of file.exportedSymbols) {
      const users = [...directConsumers]
        .filter((consumerId) => parsedById.get(consumerId)?.tokens.has(symbol))
        .sort((a, b) => a.localeCompare(b));

      if (users.length > 0) {
        symbolUsers[symbol] = users;
      }
    }

    nodes.push({
      data: {
        id: file.id,
        label: path.posix.basename(file.filePath),
        filePath: file.filePath,
        modulePath: chooseModulePath(aliasCounts.get(file.id), file.filePath),
        imports: file.imports,
        reexports: file.reexports,
        importTargets: targets.importTargets,
        reexportTargets: targets.reexportTargets,
        importCount: file.imports.length,
        reexportCount: file.reexports.length,
        exports: file.exportedSymbols,
        exportCount: file.exportedSymbols.length,
        symbolUsers
      }
    });
  }

  for (const virtualNode of virtualNodes.values()) {
    if (!nodes.some((node) => node.data.id === virtualNode.data.id)) {
      nodes.push(virtualNode);
    }
  }

  nodes.sort((a, b) => a.data.id.localeCompare(b.data.id));
  edges.sort((a, b) => a.data.id.localeCompare(b.data.id));

  return {
    root,
    generatedAt: new Date().toISOString(),
    elements: {
      nodes,
      edges
    }
  };
}

async function ensureDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const rootStat = await stat(options.root).catch(() => undefined);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`Root path does not exist or is not a directory: ${options.root}`);
  }

  const graph = await buildGraph(options.root);
  await ensureDirectory(options.out);
  await writeFile(options.out, `${JSON.stringify(graph, null, 2)}\n`, "utf8");

  console.log(`Indexed root: ${options.root}`);
  console.log(`Nodes: ${graph.elements.nodes.length}`);
  console.log(`Edges: ${graph.elements.edges.length}`);
  console.log(`Wrote: ${options.out}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Indexer failed: ${message}`);
  process.exitCode = 1;
});

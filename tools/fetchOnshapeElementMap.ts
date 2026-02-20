import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

interface CliOptions {
  out: string;
  documentId: string;
  workspaceId: string;
  authHeader?: string;
}

interface OnshapeElementRecord {
  name: string;
  id: string;
  elementType?: string;
}

const DEFAULT_OUT = "tools/onshape-element-map.json";
const DEFAULT_DOCUMENT_ID = "12312312345abcabcabcdeff";
const DEFAULT_WORKSPACE_ID = "a855e4161c814f2e9ab3698a";

function printHelp(): void {
  console.log(`Fetch Onshape Feature Studio element IDs for source linking.

Usage:
  npm run onshape-map -- [--out tools/onshape-element-map.json] [--document-id <id>] [--workspace-id <id>] [--auth-header "Basic ..."]

Authentication:
  Set one of:
  1) --auth-header "Basic <base64-access:secret>"
  2) ONSHAPE_AUTH_HEADER
  3) ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY
`);
}

function parseArgs(argv: string[]): CliOptions {
  let out = DEFAULT_OUT;
  let documentId = DEFAULT_DOCUMENT_ID;
  let workspaceId = DEFAULT_WORKSPACE_ID;
  let authHeader: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--out") {
      const value = argv[i + 1] ?? "";
      if (!value) {
        throw new Error("Missing value for --out <PATH>");
      }
      out = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      continue;
    }

    if (arg === "--document-id") {
      const value = argv[i + 1] ?? "";
      if (!value) {
        throw new Error("Missing value for --document-id <id>");
      }
      documentId = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--document-id=")) {
      documentId = arg.slice("--document-id=".length);
      continue;
    }

    if (arg === "--workspace-id") {
      const value = argv[i + 1] ?? "";
      if (!value) {
        throw new Error("Missing value for --workspace-id <id>");
      }
      workspaceId = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--workspace-id=")) {
      workspaceId = arg.slice("--workspace-id=".length);
      continue;
    }

    if (arg === "--auth-header") {
      const value = argv[i + 1] ?? "";
      if (!value) {
        throw new Error("Missing value for --auth-header \"Basic ...\"");
      }
      authHeader = value;
      i += 1;
      continue;
    }

    if (arg.startsWith("--auth-header=")) {
      authHeader = arg.slice("--auth-header=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    out: path.resolve(process.cwd(), out),
    documentId,
    workspaceId,
    authHeader
  };
}

function resolveAuthHeader(cliHeader?: string): string {
  if (cliHeader && cliHeader.trim().length > 0) {
    return cliHeader.trim();
  }

  const envHeader = process.env.ONSHAPE_AUTH_HEADER?.trim();
  if (envHeader) {
    return envHeader;
  }

  const accessKey = process.env.ONSHAPE_ACCESS_KEY?.trim();
  const secretKey = process.env.ONSHAPE_SECRET_KEY?.trim();
  if (accessKey && secretKey) {
    const credentials = Buffer.from(`${accessKey}:${secretKey}`, "utf8").toString("base64");
    return `Basic ${credentials}`;
  }

  throw new Error(
    "Missing Onshape auth. Provide --auth-header, or set ONSHAPE_AUTH_HEADER, or set ONSHAPE_ACCESS_KEY and ONSHAPE_SECRET_KEY."
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseElementRecords(payload: unknown): OnshapeElementRecord[] {
  if (!Array.isArray(payload)) {
    throw new Error("Unexpected Onshape API response: expected array.");
  }

  const out: OnshapeElementRecord[] = [];
  for (const entry of payload) {
    if (!isRecord(entry)) {
      continue;
    }

    const name = typeof entry.name === "string" ? entry.name : "";
    const id = typeof entry.id === "string" ? entry.id : "";
    const elementType = typeof entry.elementType === "string" ? entry.elementType : undefined;
    if (!name || !id) {
      continue;
    }

    out.push({ name, id, elementType });
  }

  return out;
}

async function ensureDirectory(filePath: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const authHeader = resolveAuthHeader(options.authHeader);

  const url = `https://cad.onshape.com/api/v6/documents/d/${encodeURIComponent(options.documentId)}/w/${encodeURIComponent(options.workspaceId)}/elements?withThumbnails=false`;
  const response = await fetch(url, {
    headers: {
      Authorization: authHeader,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Onshape API request failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const records = parseElementRecords(await response.json());
  const elementsByName: Record<string, string> = {};
  const duplicateNames: string[] = [];
  let featureStudioCount = 0;

  for (const record of records) {
    if (record.elementType !== "FEATURESTUDIO") {
      continue;
    }
    featureStudioCount += 1;
    if (!record.name.endsWith(".fs")) {
      continue;
    }

    const existing = elementsByName[record.name];
    if (existing && existing !== record.id) {
      duplicateNames.push(record.name);
      continue;
    }
    elementsByName[record.name] = record.id;
  }

  const output = {
    documentId: options.documentId,
    workspaceId: options.workspaceId,
    generatedAt: new Date().toISOString(),
    totalElements: records.length,
    featureStudioElements: featureStudioCount,
    fsElementCount: Object.keys(elementsByName).length,
    elementsByName
  };

  await ensureDirectory(options.out);
  await writeFile(options.out, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log(`Document: ${options.documentId}`);
  console.log(`Workspace: ${options.workspaceId}`);
  console.log(`Elements fetched: ${records.length}`);
  console.log(`Feature Studios: ${featureStudioCount}`);
  console.log(`.fs mappings: ${output.fsElementCount}`);
  if (duplicateNames.length > 0) {
    console.log(`Duplicate names skipped: ${duplicateNames.length}`);
  }
  console.log(`Wrote: ${options.out}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`onshape-map failed: ${message}`);
  process.exitCode = 1;
});

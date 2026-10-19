/**
 * Render the statusline from a JSON request on stdin.
 *
 * The composer is pure and lives in `statusline.ts`; this is the boundary that
 * reads a request and prints the lines, which is what a command, a test or a
 * preview needs. One object in, the lines out, and nothing hidden in between.
 *
 * Input:  {"host": {...}, "transcript": {...}, "project": "...", "branch": "...",
 *          "width": 120, "now": 1790000000}
 * Output: one line per line, as plain text.
 *
 * Run with: node plugins/llm-fleet/components/statusline-run.ts < request.json
 */

import { composeLines, renderedLines, type StatuslineInput } from "../plugins/llm-fleet/components/statusline.ts";

const WIDTH_FALLBACK = 100;
const MAX_REQUEST_BYTES = 1_048_576;

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += (chunk as Buffer).length;
    if (total > MAX_REQUEST_BYTES) {
      // A request that big is not a request. Refusing beats reading it all.
      throw new Error(`the request exceeded ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  let raw: string;
  try {
    raw = await readStandardInput();
  } catch (error) {
    process.stderr.write((error as Error).message + "\n");
    return 1;
  }
  if (!raw.trim()) {
    process.stderr.write("no request was sent on stdin\n");
    return 1;
  }
  let request: Partial<StatuslineInput>;
  try {
    request = JSON.parse(raw) as Partial<StatuslineInput>;
  } catch (error) {
    process.stderr.write(`the request is not JSON: ${(error as Error).name}\n`);
    return 1;
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    process.stderr.write("the request is not an object\n");
    return 1;
  }
  const width = Number.isFinite(request.width) ? (request.width as number) : WIDTH_FALLBACK;
  const input: StatuslineInput = {
    host: request.host ?? { state: "empty" },
    transcript: request.transcript ?? { state: "unavailable" },
    branch: request.branch ?? null,
    project: request.project ?? null,
    width,
    now: request.now,
  };
  if (process.argv.includes("--slots")) {
    process.stdout.write(JSON.stringify(composeLines(input), null, 2) + "\n");
    return 0;
  }
  process.stdout.write(renderedLines(input).join("\n") + "\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}

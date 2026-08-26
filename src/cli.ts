#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { loadConfig, saveConfig, resolveCredentials, isLoggedIn } from "./config.js";
import { createProject, findProjectRoot, projectPaths, readSymbolLibBlocks, symbolNameOf } from "./kicad.js";
import { search, downloadZip, getSamacId, PartResult } from "./cse.js";
import { importZipIntoProject } from "./import.js";

function fail(msg: string): never {
  process.stderr.write("error: " + msg + "\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Interactive helpers
// ---------------------------------------------------------------------------

interface TableCol {
  header: string;
  cap: number; // max width for fixed columns
  flex?: boolean; // take remaining terminal width (truncated)
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

function truncateTo(s: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(s) <= width) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

function padTo(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - displayWidth(s)));
}

function computeWidths(cols: TableCol[], rows: string[][]): { widths: number[]; flexIdx: number } {
  const termWidth = Math.max(50, Math.min(process.stdout.columns ?? 100, 200));
  const n = cols.length;
  const sepLen = 2;
  const FLEX_MIN = 8;

  const widths = cols.map((c, i) => {
    const natural = Math.max(displayWidth(c.header), ...rows.map((r) => displayWidth(r[i] ?? "")));
    return c.flex ? natural : Math.min(natural, c.cap);
  });

  const flexIdx = cols.findIndex((c) => c.flex);

  let fixedUsed = sepLen * (n - 1);
  for (let i = 0; i < n; i++) {
    if (i !== flexIdx) fixedUsed += widths[i];
  }

  if (flexIdx >= 0) {
    if (termWidth - fixedUsed < FLEX_MIN) {
      const target = termWidth - FLEX_MIN - sepLen * (n - 1);
      const fixedTotal = fixedUsed - sepLen * (n - 1);
      const scale = target / fixedTotal;
      for (let i = 0; i < n; i++) {
        if (i !== flexIdx) widths[i] = Math.max(1, Math.floor(widths[i] * scale));
      }
      fixedUsed = termWidth - FLEX_MIN;
    }
    widths[flexIdx] = Math.max(FLEX_MIN, Math.min(widths[flexIdx], termWidth - fixedUsed));
  }
  return { widths, flexIdx };
}

function formatRow(cells: string[], widths: number[], flexIdx: number): string {
  return cells
    .map((cell, i) => {
      const t = truncateTo(cell, widths[i]);
      return i === flexIdx || i === widths.length - 1 ? t : padTo(t, widths[i]);
    })
    .join("  ")
    .trimEnd();
}

function renderTable(cols: TableCol[], rows: string[][]): string[] {
  const { widths, flexIdx } = computeWidths(cols, rows);
  const lines: string[] = [];
  lines.push(formatRow(cols.map((c) => c.header), widths, flexIdx));
  lines.push(
    formatRow(
      cols.map((c, i) => "─".repeat(Math.max(1, Math.min(widths[i], displayWidth(c.header) + 4)))),
      widths,
      flexIdx
    )
  );
  for (const r of rows) lines.push(formatRow(r, widths, flexIdx));
  return lines;
}

function windowText(text: string, startChar: number, width: number): string {
  const chars = Array.from(text);
  let out = "";
  let w = 0;
  for (let i = startChar; i < chars.length; i++) {
    const cw = displayWidth(chars[i]);
    if (w + cw > width) break;
    out += chars[i];
    w += cw;
  }
  return out;
}

function selectFromTable(
  cols: TableCol[],
  rows: string[][],
  marquee: string[] | null = null
): Promise<number | null> {
  const total = rows.length;
  return new Promise((resolve) => {
    let idx = 0;
    let { widths, flexIdx } = computeWidths(cols, rows);
    let table = renderTable(cols, rows);
    let maxVisible = Math.max(5, Math.min(total, (process.stdout.rows ?? 24) - 4));

    const TICK_MS = 90;
    const STEP = 2;
    const PAUSE_TICKS = 6;

    let offset = 0;
    let direction = 1;
    let pause = 0;
    let timer: NodeJS.Timeout | null = null;

    const recalcLayout = () => {
      ({ widths, flexIdx } = computeWidths(cols, rows));
      table = renderTable(cols, rows);
      maxVisible = Math.max(5, Math.min(total, (process.stdout.rows ?? 24) - 4));
    };

    const onResize = () => {
      recalcLayout();
      resetMarquee();
      process.stdout.write("\x1b[2J\x1b[H");
      render();
    };

    const startOf = () =>
      Math.min(
        Math.max(0, idx - Math.floor(maxVisible / 2)),
        Math.max(0, total - maxVisible)
      );

    const rowLine = (k: number, withMarquee: boolean): string => {
      let line = table[k + 2];
      if (withMarquee && marquee && flexIdx >= 0) {
        const text = marquee[k] ?? "";
        if (displayWidth(text) > widths[flexIdx]) {
          const cells = rows[k].slice();
          cells[flexIdx] = windowText(text, offset, widths[flexIdx]);
          line = formatRow(cells, widths, flexIdx);
        }
      }
      return k === idx ? "\x1b[7m" + line + "\x1b[0m" : line;
    };

    const render = () => {
      const start = startOf();
      const promptLine = `Use \u2191/\u2193 to move, Enter to select, q to cancel  [${idx + 1}/${total}]`;
      readline.cursorTo(process.stdout, 0, 0);
      const out: string[] = [];
      out.push(table[0]);
      out.push(table[1]);
      for (let k = start; k < start + maxVisible; k++) {
        out.push(rowLine(k, k === idx));
      }
      out.push(promptLine);
      process.stdout.write(out.join("\n"));
      readline.clearLine(process.stdout, 1);
    };

    const tick = () => {
      if (!marquee || flexIdx < 0) return;
      const text = marquee[idx] ?? "";
      if (displayWidth(text) <= widths[flexIdx]) return;
      if (pause > 0) {
        pause--;
        return;
      }
      const chars = Array.from(text);
      const maxStart = Math.max(0, chars.length - 3);
      offset += direction * STEP;
      if (offset >= maxStart) {
        offset = maxStart;
        direction = -1;
        pause = PAUSE_TICKS;
      } else if (offset <= 0) {
        offset = 0;
        direction = 1;
        pause = PAUSE_TICKS;
      }
      const start = startOf();
      readline.cursorTo(process.stdout, 0, 2 + (idx - start));
      process.stdout.write(rowLine(idx, true));
      readline.clearLine(process.stdout, 1);
    };

    const resetMarquee = () => {
      offset = 0;
      direction = 1;
      pause = PAUSE_TICKS;
    };

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    render();
    timer = setInterval(tick, TICK_MS);
    process.stdout.on("resize", onResize);

    const onKey = (str: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        resolve(null);
        return;
      }
      switch (key.name) {
        case "up":
          idx = (idx - 1 + total) % total;
          resetMarquee();
          render();
          break;
        case "down":
          idx = (idx + 1) % total;
          resetMarquee();
          render();
          break;
        case "return":
        case "enter":
          cleanup();
          resolve(idx);
          break;
        case "q":
          cleanup();
          resolve(null);
          break;
      }
    };

    const cleanup = () => {
      if (timer) clearInterval(timer);
      process.stdout.removeListener("resize", onResize);
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    process.stdin.on("keypress", onKey);
  });
}

async function prompt(promptLine: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(promptLine, (a) => resolve(a)));
  } finally {
    rl.close();
  }
}

async function promptHidden(promptLine: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(promptLine);
    const wasRaw = process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin);
    let buf = "";
    const onKey = (str: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        resolve("");
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        process.stdout.write("\n");
        resolve(buf);
        return;
      }
      if (key.name === "backspace") {
        buf = buf.slice(0, -1);
        return;
      }
      if (str && str.length === 1 && str.charCodeAt(0) >= 32) {
        buf += str;
        process.stdout.write("*");
      }
    };
    const cleanup = () => {
      process.stdin.removeListener("keypress", onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };
    process.stdin.on("keypress", onKey);
    process.stdin.resume();
  });
}

async function confirm(q: string): Promise<boolean> {
  const a = await prompt(q + " [y/N] ");
  return /^y(es)?$/i.test(a.trim());
}

function partTableCols(): TableCol[] {
  return [
    { header: "#", cap: 3 },
    { header: "Part Number", cap: 36 },
    { header: "Manufacturer", cap: 24 },
    { header: "Package", cap: 20 },
    { header: "Model", cap: 5 },
    { header: "Description", cap: Infinity, flex: true },
  ];
}

function partTableRows(results: PartResult[]): string[][] {
  return results.map((r, i) => [
    String(i + 1),
    r.mpn,
    r.manufacturer,
    r.package,
    r.hasModel ? "\u2713" : "\u2717",
    r.description,
  ]);
}

async function choosePart(results: PartResult[]): Promise<PartResult | null> {
  const cols = partTableCols();
  const rows = partTableRows(results);

  if (process.stdin.isTTY && process.stdout.isTTY) {
    process.stdout.write("\n");
    const idx = await selectFromTable(cols, rows, results.map((r) => r.description));
    if (idx === null) return null;
    return results[idx];
  }

  for (const ln of renderTable(cols, rows)) process.stdout.write(ln + "\n");
  const answer = await prompt("Select a number (or q to cancel): ");
  if (/^q$/i.test(answer.trim())) return null;
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= results.length) return results[n - 1];
  return null;
}

function partLabel(r: PartResult): string {
  return r.manufacturer ? `${r.mpn} (${r.manufacturer})` : r.mpn;
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function cmdCreate(name: string | undefined, opts: { dir?: string }) {
  if (!name) fail("Project name is required.");
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) fail("Project name may only contain letters, numbers, '.', '_' and '-'.");
  const target = opts.dir ? path.resolve(opts.dir) : process.cwd();
  const paths = createProject(name, target);
  process.stdout.write(`Created project "${name}" in ${paths.root}\n`);
  process.stdout.write("  - project library registered: lib/lib.pretty (footprints)\n");
  process.stdout.write("  - project library registered: lib/lib.kicad_sym (symbols)\n");
  process.stdout.write("cd into it, then run 'kicad-manager search <term>' or 'kicad-manager add <mpn>'.\n");
}

async function cmdLogin(opts: { username?: string; password?: string }) {
  let username = opts.username ?? "";
  let password = opts.password ?? "";
  if (!username) {
    username = (await prompt("Component Search Engine username/email: ")).trim();
  }
  if (!password) {
    password = await promptHidden("Password: ");
  }
  if (!username || !password) fail("Both username and password are required.");
  saveConfig({ username, password });
  process.stdout.write(`Saved credentials to ~/.config/kicad-manager/config.json (chmod 600).\n`);
}

async function cmdSearch(term: string | undefined, opts: { json?: boolean; add?: boolean }) {
  if (!term) fail("Search term is required.");
  process.stdout.write(`Searching Component Search Engine for "${term}"...\n`);
  const results = await search(term);
  if (results.length === 0) {
    process.stdout.write("No results found.\n");
    return;
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Found ${results.length} result(s):\n\n`);
  const chosen = await choosePart(results);
  if (!chosen) {
    process.stdout.write("Cancelled.\n");
    return;
  }
  const wantAdd = opts.add ?? (await confirm(`\nAdd ${partLabel(chosen)} to the project?`));
  if (!wantAdd) {
    process.stdout.write(`Run 'kicad-manager add "${chosen.mpn}"' to add it.\n`);
    return;
  }
  await downloadAndInstall({ mpn: chosen.mpn, manufacturer: chosen.manufacturer }, partLabel(chosen));
}

async function cmdAdd(term: string | undefined, opts: { id?: string; manufacturer?: string }) {
  if (!term && !opts.id) fail("A part number (or --id) is required.");

  const root = findProjectRoot(process.cwd());
  if (!root) fail("Not inside a KiCad project. Run 'kicad-manager create <name>' first (and cd into it).");

  const creds = resolveCredentials();
  if (!isLoggedIn(creds)) {
    fail("Component Search Engine credentials not set. Run 'kicad-manager login' first.");
  }

  if (opts.id) {
    await downloadAndInstall({ samacId: opts.id }, `part ID ${opts.id}`);
    return;
  }

  const query = term as string;
  process.stdout.write(`Searching for "${query}"...\n`);
  const results = await search(query);
  if (results.length === 0) fail(`No results for "${query}".`);

  let chosen: PartResult | undefined;
  const termLower = query.toLowerCase();
  chosen = results.find((r) => r.mpn.toLowerCase() === termLower);
  if (!chosen && opts.manufacturer) {
    const mLower = opts.manufacturer.toLowerCase();
    chosen = results.find((r) => r.manufacturer.toLowerCase() === mLower);
  }
  if (!chosen && results.length === 1) chosen = results[0];
  if (!chosen) {
    process.stdout.write(`Multiple matches for "${term}":\n`);
    chosen = (await choosePart(results)) ?? undefined;
    if (!chosen) {
      process.stdout.write("Cancelled.\n");
      return;
    }
  }

  await downloadAndInstall({ mpn: chosen.mpn, manufacturer: chosen.manufacturer }, partLabel(chosen));
}

async function downloadAndInstall(
  part: { mpn: string; manufacturer: string } | { samacId: string },
  label: string
): Promise<void> {
  const root = findProjectRoot(process.cwd());
  if (!root) fail("Not inside a KiCad project.");
  const paths = projectPaths(root);

  const creds = resolveCredentials();
  let partId: string;
  if ("samacId" in part) {
    partId = part.samacId;
  } else {
    process.stdout.write(`Resolving download ID for ${part.mpn}...\n`);
    const id = await getSamacId(part.mpn, part.manufacturer);
    if (!id) {
      fail(`No downloadable ECAD model found for ${label}.`);
    }
    partId = id;
  }

  process.stdout.write(`Downloading ${label}...\n`);
  const zip = await downloadZip(partId, creds);
  process.stdout.write("Installing into project libraries...\n");
  const report = importZipIntoProject(zip, paths);

  for (const f of report.footprints) process.stdout.write(`  + footprint  ${path.join("lib", "lib.pretty", f)}\n`);
  for (const m of report.models) process.stdout.write(`  + 3D model   ${path.join("lib", "lib.pretty", m)}\n`);
  for (const s of report.symbols.added) process.stdout.write(`  + symbol     ${s}\n`);
  for (const s of report.symbols.replaced) process.stdout.write(`  ~ symbol     ${s} (updated)\n`);

  if (report.footprints.length === 0 && report.symbols.added.length === 0 && report.symbols.replaced.length === 0) {
    process.stdout.write("  (no KiCad footprint/symbol files found in the downloaded archive)\n");
  }
  process.stdout.write("Done.\n");
}

function cmdList() {
  const root = findProjectRoot(process.cwd());
  if (!root) fail("Not inside a KiCad project.");
  const paths = projectPaths(root);

  let footprintCount = 0;
  if (fs.existsSync(paths.pretty)) {
    footprintCount = fs.readdirSync(paths.pretty).filter((f) => f.endsWith(".kicad_mod")).length;
  }

  const symbols = readSymbolLibBlocks(paths.symLib)
    .map((b) => symbolNameOf(b))
    .filter((n): n is string => Boolean(n));

  process.stdout.write(`Footprints (lib/lib.pretty): ${footprintCount}\n`);
  if (symbols.length > 0) {
    process.stdout.write(`Symbols (lib/lib.kicad_sym):\n`);
    for (const s of symbols) process.stdout.write(`  - ${s}\n`);
  } else {
    process.stdout.write(`Symbols (lib/lib.kicad_sym): 0\n`);
  }
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name("kicad-manager")
  .description("Library Loader compatible CLI for KiCad (Component Search Engine integration)")
  .version("0.1.0");

program
  .command("create")
  .description("Create a new KiCad project with lib/lib.pretty & lib/lib.kicad_sym registered")
  .argument("[name]", "project name")
  .option("-d, --dir <dir>", "parent directory for the project (default: current dir)")
  .action((name, opts) => cmdCreate(name, opts));

program
  .command("login")
  .description("Store Component Search Engine credentials (username/password)")
  .option("-u, --username <user>", "CSE username/email")
  .option("-p, --password <pass>", "CSE password")
  .action((opts) => cmdLogin(opts));

program
  .command("search")
  .description("Search Component Search Engine and interactively pick a part")
  .argument("<term>", "search term (e.g. esp32)")
  .option("--json", "print raw JSON results instead of an interactive list")
  .option("--add", "skip the confirmation prompt and go straight to adding")
  .action((term, opts) => cmdSearch(term, opts));

program
  .command("add")
  .description("Add a part (symbol + footprint + 3D model) to the project libraries")
  .argument("[term]", "manufacturer part number or keyword")
  .option("--id <uid>", "SamacSys part ID for direct download (bypasses search)")
  .option("-m, --manufacturer <mfr>", "manufacturer filter")
  .action((term, opts) => cmdAdd(term, opts));

program
  .command("list")
  .description("List footprints and symbols in the current project")
  .action(() => cmdList());

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

main();

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { loadConfig, saveConfig, resolveCredentials, isLoggedIn } from "./config.js";
import { createProject, findProjectRoot, projectPaths, readSymbolLibBlocks, symbolNameOf } from "./kicad.js";
import { search, searchPage, downloadZip, getSamacId, partViewUrl, PartResult } from "./cse.js";
import { importZipIntoProject } from "./import.js";

const MAX_LAZY_PAGES = 40;

function fail(msg: string): never {
  process.stderr.write("error: " + msg + "\n");
  process.exit(1);
}

function openUrl(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

// ---------------------------------------------------------------------------
// Interactive helpers
// ---------------------------------------------------------------------------

interface TableCol {
  header: string;
  cap: number; // max width for fixed columns
  flex?: boolean; // take remaining terminal width (truncated)
  min?: number; // never shrink below this width
}

type Cell = string | { url: string; label: string };

interface Row {
  cells: Cell[];
  marquee: string;
  url: string;
}

function cellText(c: Cell, links: boolean): string {
  return typeof c === "string" ? c : links ? c.label : c.url;
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

function computeWidths(cols: TableCol[], rows: Row[], links: boolean): { widths: number[]; flexIdx: number } {
  const termWidth = Math.max(50, Math.min(process.stdout.columns ?? 100, 200));
  const n = cols.length;
  const sepLen = 2;
  const FLEX_MIN = 10;

  const widths = cols.map((c, i) => {
    const natural = Math.max(displayWidth(c.header), ...rows.map((r) => displayWidth(cellText(r.cells[i] ?? "", links))));
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
        if (i !== flexIdx) widths[i] = Math.max(cols[i].min ?? 1, Math.floor(widths[i] * scale));
      }
      fixedUsed = sepLen * (n - 1);
      for (let i = 0; i < n; i++) {
        if (i !== flexIdx) fixedUsed += widths[i];
      }
    }
    widths[flexIdx] = Math.max(FLEX_MIN, Math.min(widths[flexIdx], termWidth - fixedUsed));
  }
  return { widths, flexIdx };
}

function formatRow(cells: Cell[], widths: number[], flexIdx: number, links: boolean): string {
  return cells
    .map((cell, i) => {
      const plain = cellText(cell, links);
      const t = truncateTo(plain, widths[i]);
      const isLink = typeof cell !== "string";
      const rendered =
        isLink && links
          ? `\x1b]8;;${cell.url}\x1b\\\x1b[4;34m${t}\x1b[0m\x1b]8;;\x1b\\`
          : t;
      return i === flexIdx || i === widths.length - 1 ? rendered : padTo(rendered, widths[i]);
    })
    .join("  ")
    .trimEnd();
}

function renderTable(cols: TableCol[], rows: Row[], links = false): string[] {
  const { widths, flexIdx } = computeWidths(cols, rows, links);
  const lines: string[] = [];
  lines.push(formatRow(cols.map((c) => c.header), widths, flexIdx, links));
  lines.push(
    formatRow(
      cols.map((c, i) => "─".repeat(Math.max(1, Math.min(widths[i], displayWidth(c.header) + 4)))),
      widths,
      flexIdx,
      links
    )
  );
  for (const r of rows) lines.push(formatRow(r.cells, widths, flexIdx, links));
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
  rows: Row[],
  opts: {
    totalKnown?: number;
    loadMore?: () => Promise<Row[] | null>;
  } = {}
): Promise<number | null> {
  return new Promise((resolve) => {
    let idx = 0;
    let { widths, flexIdx } = computeWidths(cols, rows, true);
    let table = renderTable(cols, rows, true);
    let maxVisible = Math.max(5, Math.min(rows.length, (process.stdout.rows ?? 24) - 4));

    const TICK_MS = 90;
    const STEP = 2;
    const PAUSE_TICKS = 6;
    const SPINNER = ["\u28fe", "\u28fd", "\u28fb", "\u28f7", "\u28ef", "\u28df", "\u28bf", "\u287f"];

    let offset = 0;
    let direction = 1;
    let pause = 0;
    let loading = false;
    let canLoad = Boolean(opts.loadMore);
    let spinnerIdx = 0;
    let timer: NodeJS.Timeout | null = null;

    const total = () => rows.length;

    const recalcLayout = () => {
      ({ widths, flexIdx } = computeWidths(cols, rows, true));
      table = renderTable(cols, rows, true);
      maxVisible = Math.max(5, Math.min(rows.length, (process.stdout.rows ?? 24) - 4));
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
        Math.max(0, rows.length - maxVisible)
      );

    const rowLine = (k: number, withMarquee: boolean): string => {
      let line = table[k + 2];
      if (withMarquee && flexIdx >= 0) {
        const text = rows[k].marquee;
        if (displayWidth(text) > widths[flexIdx]) {
          const cells = rows[k].cells.slice();
          cells[flexIdx] = windowText(text, offset, widths[flexIdx]);
          line = formatRow(cells, widths, flexIdx, true);
        }
      }
      return k === idx ? "\x1b[7m" + line + "\x1b[0m" : line;
    };

    const promptLine = (): string => {
      const loaded = rows.length;
      const known = opts.totalKnown ?? 0;
      const pos = `[${idx + 1}/${loaded}${known > loaded ? ` \u00b7 ${known} total` : ""}]`;
      const base = `Use \u2191/\u2193 to move, Enter to select, o to open URL, q to cancel  ${pos}`;
      if (loading) return `${base}  Searching\u2026 ${SPINNER[spinnerIdx % SPINNER.length]}`;
      if (canLoad && idx >= loaded - 3) return `${base}  (\u2193 for more)`;
      return base;
    };

    const render = () => {
      const start = startOf();
      readline.cursorTo(process.stdout, 0, 0);
      const out: string[] = [];
      out.push(table[0]);
      out.push(table[1]);
      for (let k = start; k < start + maxVisible && k < rows.length; k++) {
        out.push(rowLine(k, k === idx));
      }
      out.push(promptLine());
      process.stdout.write(out.join("\n"));
      readline.clearLine(process.stdout, 1);
    };

    const promptScreenRow = (): number => 2 + Math.min(maxVisible, rows.length);

    const renderPromptOnly = () => {
      readline.cursorTo(process.stdout, 0, promptScreenRow());
      process.stdout.write(promptLine());
      readline.clearLine(process.stdout, 1);
    };

    const tick = () => {
      if (loading) {
        spinnerIdx++;
        renderPromptOnly();
        return;
      }
      if (flexIdx < 0) return;
      const text = rows[idx].marquee;
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

    const doLoad = async () => {
      if (loading || !opts.loadMore || !canLoad) return;
      loading = true;
      renderPromptOnly();
      const newRows = await opts.loadMore();
      if (newRows && newRows.length > 0) {
        rows.push(...newRows);
        recalcLayout();
      } else {
        canLoad = false;
      }
      loading = false;
      render();
    };

    const maybeLoad = () => {
      if (!canLoad || loading) return;
      if (idx >= rows.length - 3) void doLoad();
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
          idx = (idx - 1 + rows.length) % rows.length;
          resetMarquee();
          render();
          break;
        case "down":
          if (idx < rows.length - 1) {
            idx++;
            resetMarquee();
            render();
            maybeLoad();
          } else {
            maybeLoad();
          }
          break;
        case "o":
          if (rows[idx].url) {
            openUrl(rows[idx].url);
            resetMarquee();
            render();
          }
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

function partTableCols(includeIndex: boolean): TableCol[] {
  const cols: TableCol[] = [];
  if (includeIndex) cols.push({ header: "#", cap: 3 });
  cols.push(
    { header: "Part Number", cap: 32, min: 10 },
    { header: "Manufacturer", cap: 20, min: 8 },
    { header: "URL", cap: 34, min: 4 },
    { header: "Model", cap: 5, min: 5 },
    { header: "Description", cap: Infinity, flex: true }
  );
  return cols;
}

function partRows(results: PartResult[], includeIndex: boolean, startIndex = 0): Row[] {
  return results.map((r, i) => {
    const cells: Cell[] = [];
    if (includeIndex) cells.push(String(startIndex + i + 1));
    cells.push(
      r.mpn,
      r.manufacturer,
      { url: partViewUrl(r.mpn, r.manufacturer), label: "open" },
      r.hasModel ? "\u2713" : "\u2717",
      r.description
    );
    return { cells, marquee: r.description, url: partViewUrl(r.mpn, r.manufacturer) };
  });
}

function choosePartStatic(results: PartResult[]): Promise<PartResult | null> {
  const cols = partTableCols(true);
  const rows = partRows(results, true);
  for (const ln of renderTable(cols, rows)) process.stdout.write(ln + "\n");
  return (async () => {
    const answer = await prompt("Select a number (or q to cancel): ");
    if (/^q$/i.test(answer.trim())) return null;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= results.length) return results[n - 1];
    return null;
  })();
}

interface LazyOpts {
  maxRows: number;
  manufacturer?: string;
  exactTerm?: string;
}

async function choosePartLazy(term: string, opts: LazyOpts): Promise<PartResult | null> {
  const matches = (r: PartResult) =>
    !opts.manufacturer || r.manufacturer.toLowerCase() === opts.manufacturer.toLowerCase();

  const first = await searchPage(term, 1);
  const totalKnown = first.total;

  const exact = opts.exactTerm
    ? first.results.find((r) => r.mpn.toLowerCase() === opts.exactTerm!.toLowerCase() && matches(r))
    : undefined;
  if (exact) return exact;

  const all: PartResult[] = [];
  const addResults = (rs: PartResult[]) => {
    for (const r of rs) {
      if (matches(r)) all.push(r);
    }
  };
  addResults(first.results);
  if (all.length === 0) return null;

  let page = 1;
  let exhausted = false;
  const rows = partRows(all, false);

  const loadMore = async (): Promise<Row[] | null> => {
    if (exhausted) return null;
    if (Number.isFinite(opts.maxRows) && all.length >= opts.maxRows) {
      exhausted = true;
      return null;
    }
    let added: PartResult[] = [];
    for (let guard = 0; guard < MAX_LAZY_PAGES; guard++) {
      page++;
      const p = await searchPage(term, page);
      if (p.results.length === 0) {
        exhausted = true;
        break;
      }
      const filtered = p.results.filter(matches);
      if (filtered.length > 0) {
        const room = Number.isFinite(opts.maxRows) ? opts.maxRows - all.length : Infinity;
        added = filtered.slice(0, room);
        break;
      }
    }
    if (added.length === 0) {
      exhausted = true;
      return null;
    }
    const newRows = partRows(added, false);
    all.push(...added);
    return newRows;
  };

  const cols = partTableCols(false);
  const idx = await selectFromTable(cols, rows, { totalKnown, loadMore });
  if (idx === null) return null;
  return all[idx];
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

interface SearchOpts {
  limit?: string;
  all?: boolean;
}

function searchLimit(opts: SearchOpts): number | null {
  if (opts.all) return Infinity;
  if (opts.limit) {
    const n = parseInt(opts.limit, 10);
    if (Number.isInteger(n) && n > 0) return n;
    fail(`Invalid --limit value: ${opts.limit}`);
  }
  return null;
}

function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function cmdSearch(term: string | undefined, opts: { json?: boolean; add?: boolean; limit?: string; all?: boolean }) {
  if (!term) fail("Search term is required.");

  if (opts.json) {
    process.stdout.write(`Searching Component Search Engine for "${term}"...\n`);
    const { results, total } = await search(term, { limit: searchLimit(opts) ?? 75 });
    if (results.length === 0) {
      process.stdout.write("No results found.\n");
      return;
    }
    process.stdout.write(JSON.stringify({ total, count: results.length, results }, null, 2) + "\n");
    return;
  }

  if (isTty()) {
    process.stdout.write(`Searching Component Search Engine for "${term}"...\n`);
    const chosen = await choosePartLazy(term, { maxRows: searchLimit(opts) ?? Infinity });
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
    return;
  }

  process.stdout.write(`Searching Component Search Engine for "${term}"...\n`);
  const { results, total } = await search(term, { limit: searchLimit(opts) ?? 75 });
  if (results.length === 0) {
    process.stdout.write("No results found.\n");
    return;
  }
  if (total > results.length) {
    process.stdout.write(`Found ${results.length} of ${total} result(s) (use --all to fetch all):\n\n`);
  } else {
    process.stdout.write(`Found ${results.length} result(s):\n\n`);
  }
  const chosen = await choosePartStatic(results);
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

async function cmdAdd(
  term: string | undefined,
  opts: { id?: string; manufacturer?: string; limit?: string; all?: boolean }
) {
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

  if (isTty()) {
    const chosen = await choosePartLazy(query, {
      maxRows: searchLimit(opts) ?? Infinity,
      manufacturer: opts.manufacturer,
      exactTerm: query,
    });
    if (!chosen) {
      process.stdout.write("Cancelled.\n");
      return;
    }
    await downloadAndInstall({ mpn: chosen.mpn, manufacturer: chosen.manufacturer }, partLabel(chosen));
    return;
  }

  const { results, total } = await search(query, { limit: searchLimit(opts) ?? 75 });
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
    if (total > results.length) {
      process.stdout.write(`No exact match in first ${results.length} of ${total} results. Try --all for a full search.\n`);
    }
    process.stdout.write(`Multiple matches for "${term}":\n`);
    chosen = (await choosePartStatic(results)) ?? undefined;
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
  .option("--limit <n>", "maximum number of results to fetch (default: 75)")
  .option("--all", "fetch all search results")
  .action((term, opts) => cmdSearch(term, opts));

program
  .command("add")
  .description("Add a part (symbol + footprint + 3D model) to the project libraries")
  .argument("[term]", "manufacturer part number or keyword")
  .option("--id <uid>", "SamacSys part ID for direct download (bypasses search)")
  .option("-m, --manufacturer <mfr>", "manufacturer filter")
  .option("--limit <n>", "maximum number of search results to fetch (default: 75)")
  .option("--all", "search through all results")
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

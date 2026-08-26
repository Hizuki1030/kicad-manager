import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { ProjectPaths, extractSymbolForms, mergeSymbols } from "./kicad.js";

export interface ImportReport {
  footprints: string[];
  models: string[];
  symbols: { added: string[]; replaced: string[] };
}

const MODEL_EXTS = new Set(["stp", "wrl", "stl", "step"]);

export function importZipIntoProject(zipBuffer: Buffer, paths: ProjectPaths): ImportReport {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  const report: ImportReport = { footprints: [], models: [], symbols: { added: [], replaced: [] } };
  const symbolForms: string[] = [];

  fs.mkdirSync(paths.pretty, { recursive: true });

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const base = path.basename(entry.entryName);
    const ext = path.extname(base).toLowerCase().replace(/^\./, "");
    if (!ext) continue;

    if (ext === "kicad_mod") {
      fs.writeFileSync(path.join(paths.pretty, base), entry.getData());
      report.footprints.push(base);
    } else if (MODEL_EXTS.has(ext)) {
      fs.writeFileSync(path.join(paths.pretty, base), entry.getData());
      report.models.push(base);
    } else if (ext === "kicad_sym") {
      const content = entry.getData().toString("utf8");
      symbolForms.push(...extractSymbolForms(content));
    }
  }

  if (symbolForms.length > 0) {
    const merged = mergeSymbols(paths.symLib, symbolForms);
    report.symbols = merged;
  }

  return report;
}

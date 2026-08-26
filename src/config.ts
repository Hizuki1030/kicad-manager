import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface Config {
  username?: string;
  password?: string;
}

const configDir = path.join(os.homedir(), ".config", "kicad-manager");

export function configPath(): string {
  return path.join(configDir, "config.json");
}

export function loadConfig(): Config {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: Config): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.chmodSync(configDir, 0o700);
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", {
    mode: 0o600,
  });
}

export interface Credentials {
  username: string;
  password: string;
}

export function resolveCredentials(): Credentials {
  const cfg = loadConfig();
  return {
    username: process.env.CSE_USERNAME ?? cfg.username ?? "",
    password: process.env.CSE_PASSWORD ?? cfg.password ?? "",
  };
}

export function isLoggedIn(creds: Credentials): boolean {
  return creds.username.length > 0 && creds.password.length > 0;
}

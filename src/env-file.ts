import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parse } from "dotenv";

const resolveDefaultEnvPath = (): string => path.resolve(process.cwd(), ".env");

const readEnvFile = (envPath = resolveDefaultEnvPath()): string => {
  if (!existsSync(envPath)) {
    return "";
  }

  return readFileSync(envPath, "utf8");
};

export const loadDotEnvIntoProcess = (envPath = resolveDefaultEnvPath()): void => {
  const contents = readEnvFile(envPath);
  const parsed = parse(contents);
  for (const [key, value] of Object.entries(parsed)) {
    process.env[key] = value;
  }
};

export const updateEnvFile = (
  updates: Record<string, string>,
  envPath = resolveDefaultEnvPath(),
): Record<string, string> => {
  const contents = readEnvFile(envPath);
  const lines = contents === "" ? [] : contents.split(/\r?\n/);
  const keys = Object.keys(updates);
  const remaining = new Set(keys);
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      return line;
    }

    const key = match[1];
    if (!key || !(key in updates)) {
      return line;
    }

    remaining.delete(key);
    return `${key}=${updates[key]}`;
  });

  for (const key of remaining) {
    nextLines.push(`${key}=${updates[key]}`);
  }

  const output = nextLines.join("\n").replace(/\n*$/, "\n");
  writeFileSync(envPath, output, "utf8");

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }

  return updates;
};

export const getCurrentEnvSnapshot = (envPath = resolveDefaultEnvPath()): Record<string, string> => {
  return parse(readEnvFile(envPath));
};

export const getDefaultEnvPath = (): string => resolveDefaultEnvPath();

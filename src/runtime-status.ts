import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RuntimeStatusSnapshot = {
  updatedAt: string;
  pid: number;
  agentEnabled: boolean;
  cronExpression: string;
  running: boolean;
  configSummary: string[];
  lastResults: Array<{
    id: string;
    name: string;
    status: "idle" | "cart_pending" | "payment_pending";
    decisionAction: string;
    reasoning: string;
    bookingDetails?: string;
    bookingUrl?: string;
  }>;
};

const resolveDefaultRuntimeStatusPath = (): string =>
  path.resolve(process.cwd(), ".runtime", "agent-status.json");

export const writeRuntimeStatus = (
  snapshot: RuntimeStatusSnapshot,
  statusPath = resolveDefaultRuntimeStatusPath(),
): void => {
  mkdirSync(path.dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
};

export const readRuntimeStatus = (
  statusPath = resolveDefaultRuntimeStatusPath(),
): RuntimeStatusSnapshot | null => {
  if (!existsSync(statusPath)) {
    return null;
  }

  return JSON.parse(readFileSync(statusPath, "utf8")) as RuntimeStatusSnapshot;
};

export const getDefaultRuntimeStatusPath = (): string => resolveDefaultRuntimeStatusPath();

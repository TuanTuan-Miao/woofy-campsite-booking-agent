import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { getCurrentEnvSnapshot, updateEnvFile } from "../src/env-file.js";

describe("env-file", () => {
  it("updates existing keys and appends new ones", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "woofy-env-"));
    const envPath = path.join(dir, ".env");
    writeFileSync(envPath, "CAMPGROUND_ID=123\nARRIVAL_DATE=2026-07-17\n", "utf8");

    updateEnvFile(
      {
        CAMPGROUND_ID: "456",
        NIGHTS: "3",
      },
      envPath,
    );

    const contents = readFileSync(envPath, "utf8");
    expect(contents).toContain("CAMPGROUND_ID=456");
    expect(contents).toContain("ARRIVAL_DATE=2026-07-17");
    expect(contents).toContain("NIGHTS=3");

    const snapshot = getCurrentEnvSnapshot(envPath);
    expect(snapshot.CAMPGROUND_ID).toBe("456");
    expect(snapshot.NIGHTS).toBe("3");
  });
});

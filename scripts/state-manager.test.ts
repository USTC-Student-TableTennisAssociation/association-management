import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const manager = path.join(import.meta.dirname, "state-manager.mjs");
const temporaryProjects: string[] = [];

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeProject(): string {
  const project = mkdtempSync(path.join(tmpdir(), "sydaris-state-manager-"));
  temporaryProjects.push(project);
  mkdirSync(path.join(project, "scripts"), { recursive: true });
  mkdirSync(path.join(project, ".sydaris-library", "blobs", "aa"), { recursive: true });
  mkdirSync(path.join(project, ".cold-start", "library-runs", "run-1", "empty"), {
    recursive: true,
  });
  writeFileSync(path.join(project, ".env"), "DATABASE_URL=postgresql://test\n", "utf8");
  writeFileSync(path.join(project, "fake-database"), "database-before\n", "utf8");
  writeFileSync(
    path.join(project, ".sydaris-library", "blobs", "aa", "source"),
    "library-before\n",
    "utf8",
  );
  writeFileSync(
    path.join(project, ".cold-start", "library-runs", "run-1", "checkpoint.json"),
    "cold-before\n",
    "utf8",
  );
  writeExecutable(
    path.join(project, "scripts", "database-snapshot.zsh"),
    `#!/bin/zsh
set -euo pipefail
root="\${0:A:h:h}"
destination="$1"
mkdir -p "\${destination:h}"
cp "$root/fake-database" "$destination"
(cd "\${destination:h}" && shasum -a 256 "\${destination:t}" > "\${destination:t}.sha256")
`,
  );
  writeExecutable(
    path.join(project, "scripts", "database-restore.zsh"),
    `#!/bin/zsh
set -euo pipefail
root="\${0:A:h:h}"
source_path="$1"
cp "$source_path" "$root/fake-database"
if [[ -f "$root/fail-file-install" && "$source_path" != *"/autosave-"* ]]; then
  rm -rf "$root"/.cold-start.sydaris-stage-*
fi
`,
  );
  return project;
}

function managerEnvironment(project: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SYDARIS_STATE_PROJECT_ROOT: project,
    SYDARIS_STATE_SKIP_ACTIVE_CHECK: "true",
    SYDARIS_LIBRARY_STORAGE_ROOT: "",
    SYDARIS_COLD_START_OUTPUT_ROOT: "",
    SYDARIS_STATE_STORAGE_ROOT: "",
  };
}

function runManager(project: string, ...args: string[]): string {
  return execFileSync(process.execPath, [manager, ...args], {
    env: managerEnvironment(project),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const project of temporaryProjects.splice(0)) {
    rmSync(project, { recursive: true, force: true });
  }
});

describe("Sydaris state manager", () => {
  it("saves and loads database, library, and cold-start state together", () => {
    const project = createFakeProject();
    runManager(project, "save", "--", "before");

    writeFileSync(path.join(project, "fake-database"), "database-after\n", "utf8");
    rmSync(path.join(project, ".sydaris-library"), { recursive: true, force: true });
    mkdirSync(path.join(project, ".sydaris-library"), { recursive: true });
    writeFileSync(path.join(project, ".sydaris-library", "new-file"), "new\n", "utf8");
    writeFileSync(
      path.join(project, ".cold-start", "library-runs", "run-1", "checkpoint.json"),
      "cold-after\n",
      "utf8",
    );
    runManager(project, "save", "after");

    const loadOutput = runManager(project, "load", "--", "before", "--yes");
    expect(loadOutput).toContain("状态已加载：before");
    expect(readFileSync(path.join(project, "fake-database"), "utf8"))
      .toBe("database-before\n");
    expect(readFileSync(
      path.join(project, ".sydaris-library", "blobs", "aa", "source"),
      "utf8",
    )).toBe("library-before\n");
    expect(readFileSync(
      path.join(project, ".cold-start", "library-runs", "run-1", "checkpoint.json"),
      "utf8",
    )).toBe("cold-before\n");
    expect(readdirSync(path.join(project, ".sydaris-states")))
      .toEqual(expect.arrayContaining(["before", "after"]));
    expect(readdirSync(path.join(project, ".sydaris-states"))
      .some((name) => name.startsWith("autosave-"))).toBe(true);

    expect(runManager(project, "verify", "before")).toContain("状态校验通过：before");
    expect(runManager(project, "list")).toContain("before");
  });

  it("rejects a state whose database dump was changed", () => {
    const project = createFakeProject();
    runManager(project, "save", "checkpoint");
    writeFileSync(
      path.join(project, ".sydaris-states", "checkpoint", "database.dump"),
      "tampered\n",
      "utf8",
    );
    const result = spawnSync(process.execPath, [manager, "verify", "checkpoint"], {
      env: managerEnvironment(project),
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SHA-256 校验失败");
  });

  it("rolls database and files back when installation fails after database restore", () => {
    const project = createFakeProject();
    runManager(project, "save", "target");

    writeFileSync(path.join(project, "fake-database"), "database-current\n", "utf8");
    writeFileSync(
      path.join(project, ".sydaris-library", "blobs", "aa", "source"),
      "library-current\n",
      "utf8",
    );
    writeFileSync(
      path.join(project, ".cold-start", "library-runs", "run-1", "checkpoint.json"),
      "cold-current\n",
      "utf8",
    );
    writeFileSync(path.join(project, "fail-file-install"), "1\n", "utf8");

    const result = spawnSync(process.execPath, [manager, "load", "target", "--yes"], {
      env: managerEnvironment(project),
      encoding: "utf8",
    });
    const autosave = readdirSync(path.join(project, ".sydaris-states"))
      .find((name) => name.startsWith("autosave-"));
    expect(autosave).toBeDefined();
    expect(readFileSync(
      path.join(project, ".sydaris-states", autosave!, "database.dump"),
      "utf8",
    )).toBe("database-current\n");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("已自动恢复到切换前状态");
    expect(readFileSync(path.join(project, "fake-database"), "utf8"))
      .toBe("database-current\n");
    expect(readFileSync(
      path.join(project, ".sydaris-library", "blobs", "aa", "source"),
      "utf8",
    )).toBe("library-current\n");
    expect(readFileSync(
      path.join(project, ".cold-start", "library-runs", "run-1", "checkpoint.json"),
      "utf8",
    )).toBe("cold-current\n");
  });
});

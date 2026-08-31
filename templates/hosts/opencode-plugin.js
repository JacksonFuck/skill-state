/**
 * skill-state — OpenCode equivalent of Claude SessionStart / PreCompact.
 * Auto-loaded from ~/.config/opencode/plugins/. Silent when the project
 * has no .skill-state/STATE.json. Fail-open on any CLI error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI = join(homedir(), ".claude", "skills", "skill-state", "bin", "cli.mjs");

let cache = { path: "", mtime: -1, text: "" };

function runCli(directory, subcommand) {
  return execFileSync("node", [CLI, subcommand], {
    cwd: directory,
    env: { ...process.env, CLAUDE_PROJECT_DIR: directory },
    encoding: "utf8",
    timeout: 10000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function contextText(directory) {
  const statePath = join(directory, ".skill-state", "STATE.json");
  if (!existsSync(statePath)) {
    cache = { path: statePath, mtime: -1, text: "" };
    return "";
  }
  const mtime = statSync(statePath).mtimeMs;
  if (cache.path === statePath && cache.mtime === mtime) return cache.text;
  try {
    const out = runCli(directory, "context").trim();
    if (!out) {
      cache = { path: statePath, mtime, text: "" };
      return "";
    }
    const parsed = JSON.parse(out);
    const text = parsed?.hookSpecificOutput?.additionalContext ?? "";
    cache = { path: statePath, mtime, text };
    return text;
  } catch {
    cache = { path: statePath, mtime, text: "" };
    return "";
  }
}

export default async function skillStatePlugin({ directory, worktree }) {
  const root = directory || worktree || process.cwd();
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      const text = contextText(root);
      if (!text) return;
      if (Array.isArray(output.system) && output.system.length > 0) {
        output.system[0] = `${output.system[0]}\n\n${text}`;
      } else {
        output.system.push(text);
      }
    },
    "experimental.session.compacting": async (_input, output) => {
      try {
        const warn = runCli(root, "flush-check").trim();
        if (warn) output.context.push(warn);
      } catch {
        /* fail-open */
      }
    },
  };
}

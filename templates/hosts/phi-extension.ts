/**
 * skill-state — Phi equivalent of Claude SessionStart / PreCompact.
 * Loaded from ~/.phi/agent/extensions/. Silent when the project has no
 * .skill-state/STATE.json. Fail-open on any CLI error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "phi-code";

const CLI = join(homedir(), ".claude", "skills", "skill-state", "bin", "cli.mjs");

let cache = { path: "", mtime: -1, text: "" };

function projectRoot(): string {
	return process.cwd();
}

function runCli(subcommand: string): string {
	return execFileSync("node", [CLI, subcommand], {
		cwd: projectRoot(),
		env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot() },
		encoding: "utf8",
		timeout: 10000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function contextText(): string {
	const root = projectRoot();
	const statePath = join(root, ".skill-state", "STATE.json");
	if (!existsSync(statePath)) {
		cache = { path: statePath, mtime: -1, text: "" };
		return "";
	}
	const mtime = statSync(statePath).mtimeMs;
	if (cache.path === statePath && cache.mtime === mtime) return cache.text;
	try {
		const out = runCli("context").trim();
		if (!out) {
			cache = { path: statePath, mtime, text: "" };
			return "";
		}
		const parsed = JSON.parse(out) as {
			hookSpecificOutput?: { additionalContext?: string };
		};
		const text = parsed?.hookSpecificOutput?.additionalContext ?? "";
		cache = { path: statePath, mtime, text };
		return text;
	} catch {
		cache = { path: statePath, mtime, text: "" };
		return "";
	}
}

export default function skillStateExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const text = contextText();
		if (text && ctx.hasUI) {
			ctx.ui.notify("skill-state Σ injetado (PRÓXIMO PASSO no system prompt)", "info");
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		try {
			const warn = runCli("flush-check").trim();
			if (warn && ctx.hasUI) ctx.ui.notify(warn, "warning");
		} catch {
			/* fail-open: compaction must not stall on a missing CLI */
		}
		cache = { path: "", mtime: -1, text: "" };
		contextText();
	});

	pi.on("before_agent_start", (event) => {
		const text = contextText();
		if (!text) return {};
		return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
	});
}

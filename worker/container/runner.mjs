// Runs one cloud turn inside the session's container:
// sync the git branch, run the Agent SDK against the shared transcript store, checkpoint, report.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { sessionId, prompt, repo, ref, branch, cwd, control, user } = input;
// In the container the Worker authenticates this channel itself; RELAY_AUTH is for running the runner elsewhere.
const auth = process.env.RELAY_AUTH ? { authorization: process.env.RELAY_AUTH } : {};

async function call(method, path, body) {
	const response = await fetch(`${control}${path}`, {
		method,
		headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
	return response;
}

/** The Agent SDK mirrors every transcript batch here, and reads it back to resume. */
const sessionStore = {
	async append(key, entries) {
		await call("POST", "/transcript", { subpath: key.subpath ?? "", entries });
	},
	async load(key) {
		const response = await call("GET", `/transcript?subpath=${encodeURIComponent(key.subpath ?? "")}`);
		const entries = (await response.text())
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line).entry);
		return entries.length ? entries : null;
	},
	async listSubkeys() {
		return (await call("GET", "/subkeys")).json();
	},
};

function git(...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(...args) {
	try {
		return git(...args);
	} catch (error) {
		return null;
	}
}

/** Puts the working tree on the session branch at its newest pushed commit. Returns notes for the agent. */
function syncWorkspace() {
	mkdirSync(cwd, { recursive: true });
	if (!existsSync(join(cwd, ".git"))) {
		if (repo) git("clone", repo, ".");
		else git("init", "-b", "main");
	}
	if (!tryGit("config", "user.email")) {
		git("config", "user.name", `Claude Relay (${user})`);
		git("config", "user.email", "claude-relay@users.noreply.github.com");
	}
	if (!repo) return [];

	const notes = [];
	git("fetch", "origin");
	const remoteHasBranch = Boolean(tryGit("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`));
	const current = tryGit("rev-parse", "--abbrev-ref", "HEAD");
	if (current !== branch) {
		if (remoteHasBranch) git("checkout", "-B", branch, `origin/${branch}`);
		else {
			if (ref) git("checkout", ref);
			git("checkout", "-b", branch);
		}
	} else if (remoteHasBranch && tryGit("merge", "--ff-only", `origin/${branch}`) === null) {
		notes.push(
			`origin/${branch} has commits that could not be fast-forwarded into this working tree. ` +
				"Reconcile them (for example with git pull --rebase) before continuing.",
		);
	}
	return notes;
}

/** Commits whatever the turn left behind and pushes the branch, so another machine can pick it up. */
function checkpoint() {
	git("add", "-A");
	if (tryGit("diff", "--cached", "--quiet") === null) {
		git("commit", "-q", "-m", "relay: checkpoint after cloud turn");
	}
	if (!repo) return null;
	try {
		git("push", "-u", "origin", branch);
		return null;
	} catch (error) {
		return `Could not push ${branch}: ${String(error.stderr || error.message).trim().slice(-500)}`;
	}
}

let outcome;
try {
	const notes = syncWorkspace();
	const options = {
		cwd,
		sessionStore,
		...(input.resume ? { resume: sessionId } : { sessionId }),
		...(input.model ? { model: input.model } : {}),
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
		settingSources: ["project"],
		systemPrompt: {
			type: "preset",
			preset: "claude_code",
			append: [
				"You are running unattended in a cloud sandbox managed by Claude Relay.",
				repo ? `The repository is checked out on branch ${branch}.` : "There is no remote repository for this session.",
				"When this turn ends, the runner commits all changes and pushes the branch, so the user can continue on another machine. Do not open pull requests unless asked.",
				...notes,
			].join("\n"),
		},
		env: { ...process.env },
	};

	let result;
	let mirrorErrors = 0;
	for await (const message of query({ prompt, options })) {
		if (message.type === "result") result = message;
		if (message.type === "system" && message.subtype === "mirror_error") mirrorErrors++;
	}
	const pushError = checkpoint();
	const problems = [
		result?.subtype !== "success" ? `Turn ended with ${result?.subtype ?? "no result"}` : null,
		mirrorErrors ? `${mirrorErrors} transcript batch(es) failed to reach the store` : null,
		pushError,
	].filter(Boolean);
	outcome = {
		ok: result?.subtype === "success" && !result.is_error,
		result: result?.result ?? null,
		error: problems.join("; ") || null,
	};
} catch (error) {
	console.error(error);
	// A failed query still leaves edits behind; keep them reachable.
	let pushError = null;
	try {
		if (existsSync(join(cwd, ".git"))) pushError = checkpoint();
	} catch {}
	outcome = { ok: false, error: [String(error?.message ?? error).slice(0, 2000), pushError].filter(Boolean).join("; ") };
}

try {
	await call("POST", "/done", outcome);
} catch (error) {
	console.error("Could not report the outcome:", error.message);
}
console.log(JSON.stringify(outcome));
process.exit(outcome.ok ? 0 : 1);

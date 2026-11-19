#!/usr/bin/env node
// Claude Relay CLI. No dependencies; needs Node 18+, git, and (for `relay local`) Claude Code.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "claude-relay");
const configPath = join(configDir, "config.json");
const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const baseUrl = (process.env.RELAY_URL || config.url || "").replace(/\/+$/, "");
const token = process.env.RELAY_TOKEN || config.token;

const usage = `Claude Relay: one Claude Code session, driven from the cloud or any machine.

Setup
  relay init <worker-url> [login-token]   Save where the Worker lives and who you are
  relay login                             Store your Claude subscription token (from: claude setup-token)
  relay whoami

Sessions
  relay new [--repo <https-url>] [--ref <branch>] [--title <t>] ["prompt"]
  relay ls
  relay status <id>
  relay send <id> "prompt"                Run the next turn in the cloud
  relay watch <id>                        Follow a session live
  relay local <id> [--yes] [-- claude args]
                                          Take the session over in Claude Code here; syncs back when you exit
  relay stop <id>                         Interrupt the running cloud turn
  relay release <id> [--force]            Give up (or break) a local checkout
  relay rm <id>

Team (admin)
  relay user add <name> | relay user ls | relay user rm <name>

Ids can be shortened to any unique prefix.`;

function die(message) {
	console.error(`relay: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const flags = {};
	const rest = [];
	let passthrough = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			passthrough = argv.slice(i + 1);
			break;
		}
		if (["--yes", "--force", "--no-watch"].includes(arg)) flags[arg.slice(2)] = true;
		else if (["--repo", "--ref", "--title", "--token"].includes(arg)) flags[arg.slice(2)] = argv[++i];
		else if (arg.startsWith("--")) die(`Unknown option ${arg}`);
		else rest.push(arg);
	}
	return { flags, rest, passthrough };
}

async function api(method, path, body, { raw = false } = {}) {
	if (!baseUrl || !token) die("Not set up. Run: relay init <worker-url> <login-token>");
	const response = await fetch(`${baseUrl}/api${path}`, {
		method,
		headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (raw) return response;
	const text = await response.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		data = { error: text.slice(0, 300) };
	}
	if (!response.ok) {
		const error = new Error(data.error || `${response.status} ${response.statusText}`);
		error.status = response.status;
		throw error;
	}
	return data;
}

async function resolveId(prefix) {
	if (!prefix) die("Which session? Run: relay ls");
	if (/^[0-9a-f-]{36}$/.test(prefix)) return prefix;
	const matches = (await api("GET", "/sessions")).filter((s) => s.id.startsWith(prefix));
	if (matches.length === 1) return matches[0].id;
	die(matches.length ? `"${prefix}" matches ${matches.length} sessions` : `No session starts with "${prefix}"`);
}

async function ask(question) {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return (await rl.question(question)).trim();
	} finally {
		rl.close();
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- rendering ----------

const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function clip(text, max = 400) {
	const one = String(text).replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max)}…` : one;
}

function render({ subpath, entry }) {
	if (subpath || entry.isMeta || entry.isSidechain || !entry.message) return;
	const content = entry.message.content;
	const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content || [];
	for (const block of blocks) {
		if (block.type === "text" && block.text?.trim()) {
			console.log(entry.type === "user" ? `\n${bold("you ›")} ${block.text.trim()}` : `\n${block.text.trim()}`);
		} else if (block.type === "tool_use") {
			const input = block.input || {};
			console.log(dim(`  ⏵ ${block.name} ${clip(input.command || input.file_path || input.pattern || input.description || JSON.stringify(input), 160)}`));
		}
	}
}

function describe(info) {
	const holder = info.holder ? `${info.holder.kind} (${info.holder.user}${info.holder.host ? ` @ ${info.holder.host}` : ""})` : "nobody";
	return `${info.id.slice(0, 8)}  ${info.status}  driver: ${holder}${info.branch ? `  branch: ${info.branch}` : ""}`;
}

async function readTranscript(id, after = 0) {
	const response = await api("GET", `/sessions/${id}/transcript?after=${after}`, null, { raw: true });
	if (!response.ok) throw new Error(`transcript: ${response.status}`);
	return (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** Prints the transcript as it grows, until nobody is driving the session. */
async function watch(id) {
	let after = 0;
	for (;;) {
		const info = await api("GET", `/sessions/${id}/info`);
		const rows = await readTranscript(id, after);
		for (const row of rows) {
			render(row);
			after = row.seq;
		}
		const active = info.status === "running" || info.holder?.kind === "local";
		if (!active && rows.length === 0) {
			console.log(`\n${dim(describe(info))}`);
			if (info.lastError) console.log(`${bold("problem:")} ${info.lastError}`);
			return info;
		}
		await sleep(active ? 1500 : 500);
	}
}

// ---------- local transcript files ----------

function projectDir(cwd) {
	const root = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	// Claude Code names a project's directory after its path, with every non-alphanumeric as "-".
	return join(root, "projects", realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-"));
}

function transcriptFile(cwd, id, subpath) {
	return subpath ? join(projectDir(cwd), id, `${subpath}.jsonl`) : join(projectDir(cwd), `${id}.jsonl`);
}

function localSubpaths(cwd, id) {
	const dir = join(projectDir(cwd), id, "subagents");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => `subagents/${name.slice(0, -".jsonl".length)}`);
}

function statePath(id) {
	return join(configDir, "sessions", `${id}.json`);
}

function saveState(id, state) {
	mkdirSync(dirname(statePath(id)), { recursive: true });
	writeFileSync(statePath(id), JSON.stringify(state));
}

/** Writes the shared transcript where Claude Code expects it. Returns how many lines each file holds. */
async function pullTranscript(id, cwd) {
	const bySubpath = new Map();
	for (const { subpath, entry } of await readTranscript(id)) {
		if (!bySubpath.has(subpath)) bySubpath.set(subpath, []);
		bySubpath.get(subpath).push(JSON.stringify(entry));
	}
	const offsets = {};
	for (const [subpath, lines] of bySubpath) {
		const file = transcriptFile(cwd, id, subpath);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
		offsets[subpath] = lines.length;
	}
	return offsets;
}

/** Sends lines Claude Code has appended since the last push. Only whole lines are sent. */
async function pushTranscript(id, cwd, offsets) {
	let sent = 0;
	for (const subpath of ["", ...localSubpaths(cwd, id)]) {
		const file = transcriptFile(cwd, id, subpath);
		if (!existsSync(file)) continue;
		const text = readFileSync(file, "utf8");
		const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
		const from = offsets[subpath] ?? 0;
		for (let i = from; i < lines.length; ) {
			const batch = [];
			let bytes = 0;
			while (i < lines.length && batch.length < 100 && bytes < 4_000_000) {
				bytes += lines[i].length;
				batch.push(JSON.parse(lines[i++]));
			}
			await api("POST", `/sessions/${id}/transcript`, { subpath, entries: batch });
			offsets[subpath] = i;
			sent += batch.length;
		}
	}
	return sent;
}

// ---------- git ----------

function git(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(cwd, ...args) {
	try {
		return git(cwd, ...args);
	} catch {
		return null;
	}
}

const sameRepo = (a, b) => {
	const norm = (u) => u.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
	return norm(a) === norm(b);
};

/** Finds or clones the checkout and puts it on the session branch. Returns the directory to run Claude in. */
function prepareCheckout(info) {
	if (!info.repo) return process.cwd();
	let top = tryGit(process.cwd(), "rev-parse", "--show-toplevel");
	const origin = top && tryGit(top, "remote", "get-url", "origin");
	if (!top || !origin || !sameRepo(origin, info.repo)) {
		const target = join(process.cwd(), basename(info.repo).replace(/\.git$/, ""));
		if (existsSync(target)) top = target;
		else {
			console.error(`Cloning ${info.repo} into ${target}`);
			execFileSync("git", ["clone", info.repo, target], { stdio: "inherit" });
			top = target;
		}
	}
	if (git(top, "status", "--porcelain")) {
		throw new Error(`${top} has uncommitted changes. Commit or stash them first.`);
	}
	git(top, "fetch", "origin");
	const remote = tryGit(top, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${info.branch}`);
	const local = tryGit(top, "rev-parse", "--verify", "--quiet", `refs/heads/${info.branch}`);
	if (local) {
		git(top, "checkout", info.branch);
		if (remote && tryGit(top, "merge", "--ff-only", `origin/${info.branch}`) === null) {
			throw new Error(`Local ${info.branch} has diverged from origin. Reconcile it, then run this again.`);
		}
	} else if (remote) git(top, "checkout", "-b", info.branch, "--track", `origin/${info.branch}`);
	else git(top, "checkout", "-b", info.branch);
	return top;
}

/** After the local leg: get the work onto the branch the cloud will pull. */
async function handBackCode(info, cwd, yes) {
	if (!info.repo) return;
	const dirty = git(cwd, "status", "--porcelain");
	const upstream = tryGit(cwd, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${info.branch}`);
	const ahead = upstream ? Number(git(cwd, "rev-list", "--count", `origin/${info.branch}..HEAD`)) : 1;
	if (!dirty && !ahead) return;
	const what = [dirty ? `${dirty.split("\n").length} changed file(s)` : null, ahead && upstream ? `${ahead} unpushed commit(s)` : null]
		.filter(Boolean)
		.join(" and ") || "this branch";
	const go = yes || (process.stdin.isTTY && !/^n/i.test(await ask(`Commit and push ${what} to ${info.branch} so the cloud can continue? [Y/n] `)));
	if (!go) {
		console.error(`Left as is. The cloud will not see this work until ${info.branch} is pushed.`);
		return;
	}
	if (dirty) {
		git(cwd, "add", "-A");
		git(cwd, "commit", "-q", "-m", "relay: checkpoint after local session");
	}
	execFileSync("git", ["push", "-u", "origin", info.branch], { cwd, stdio: "inherit" });
}

// ---------- commands ----------

async function cmdLocal(prefix, flags, passthrough) {
	const id = await resolveId(prefix);
	const info = await api("POST", `/sessions/${id}/checkout`, { host: hostname(), force: flags.force });
	let cwd;
	const offsets = {};
	try {
		cwd = prepareCheckout(info);
		Object.assign(offsets, await pullTranscript(id, cwd));
		saveState(id, { cwd, offsets });
	} catch (error) {
		await api("POST", `/sessions/${id}/release`, {}).catch(() => {});
		die(error.message);
	}

	const started = Object.keys(offsets).length > 0;
	const args = [...(started ? ["--resume", id] : ["--session-id", id]), ...passthrough];
	console.error(dim(`relay: ${started ? "resuming" : "starting"} ${id.slice(0, 8)} in ${cwd}; teammates can follow along live`));

	// Mirror new transcript lines to the cloud while Claude Code runs.
	let pushing = Promise.resolve();
	const sync = () => {
		pushing = pushing
			.then(() => pushTranscript(id, cwd, offsets))
			.then(() => saveState(id, { cwd, offsets }))
			.catch((error) => console.error(dim(`relay: sync failed, will retry (${error.message})`)));
		return pushing;
	};
	const timer = setInterval(sync, 3000);
	// Ctrl-C belongs to Claude Code while it has the terminal.
	const ignore = () => {};
	process.on("SIGINT", ignore);
	const child = spawn(process.env.RELAY_CLAUDE_BIN || "claude", args, { cwd, stdio: "inherit" });
	const code = await new Promise((resolve) => {
		child.on("error", (error) => {
			console.error(`relay: could not start claude: ${error.message}`);
			resolve(127);
		});
		child.on("exit", (status) => resolve(status ?? 1));
	});
	clearInterval(timer);
	process.off("SIGINT", ignore);

	await sync();
	try {
		await pushTranscript(id, cwd, offsets);
		saveState(id, { cwd, offsets });
	} catch (error) {
		console.error(`relay: the transcript is not fully synced (${error.message}).`);
		console.error("The session stays checked out to you. Run the same command again to retry.");
		process.exit(1);
	}
	try {
		await handBackCode(info, cwd, flags.yes);
	} catch (error) {
		console.error(`relay: could not push the code (${error.message}). Push ${info.branch} yourself.`);
	}
	await api("POST", `/sessions/${id}/release`, {});
	console.error(`relay: synced and released. Continue in the cloud with: relay send ${id.slice(0, 8)} "…"`);
	process.exit(code);
}

async function main() {
	const [command, ...argv] = process.argv.slice(2);
	const { flags, rest, passthrough } = parseArgs(argv);

	switch (command) {
		case "init": {
			if (!rest[0]) die("Usage: relay init <worker-url> [login-token]");
			const login = rest[1] || (await ask("Login token: "));
			mkdirSync(configDir, { recursive: true });
			writeFileSync(configPath, JSON.stringify({ url: rest[0].replace(/\/+$/, ""), token: login }, null, 2), { mode: 0o600 });
			console.log(`Saved ${configPath}`);
			return;
		}
		case "login": {
			const claude = flags.token || process.env.CLAUDE_CODE_OAUTH_TOKEN || (await ask("Paste the token printed by `claude setup-token`: "));
			if (!claude) die("No token given");
			await api("PUT", "/me/claude-token", { token: claude });
			console.log("Stored. Cloud turns you start will run on your Claude subscription.");
			return;
		}
		case "whoami": {
			const me = await api("GET", "/me");
			console.log(`${me.name} @ ${baseUrl}  Claude token: ${me.hasClaudeToken ? "stored" : "missing (run: relay login)"}`);
			return;
		}
		case "user": {
			if (rest[0] === "ls") for (const u of await api("GET", "/users")) console.log(`${u.name}\t${u.hasClaudeToken ? "claude token stored" : "no claude token"}`);
			else if (rest[0] === "add" && rest[1]) {
				const created = await api("PUT", `/users/${rest[1]}`);
				console.log(`Give ${created.name} this, shown once:\n  relay init ${baseUrl} ${created.token}`);
			} else if (rest[0] === "rm" && rest[1]) await api("DELETE", `/users/${rest[1]}`);
			else die("Usage: relay user add <name> | ls | rm <name>");
			return;
		}
		case "new": {
			const prompt = rest.join(" ") || undefined;
			const created = await api("POST", "/sessions", { repo: flags.repo, ref: flags.ref, title: flags.title, prompt });
			console.log(`Session ${created.id}`);
			if (created.warning) console.log(`Created, but the first turn did not start: ${created.warning}`);
			else if (prompt && !flags["no-watch"]) await watch(created.id);
			return;
		}
		case "ls": {
			for (const s of await api("GET", "/sessions")) {
				console.log(`${s.id.slice(0, 8)}  ${s.status.padEnd(7)}  ${(s.holder || "-").padEnd(16)}  ${clip(s.title, 60)}`);
			}
			return;
		}
		case "status": {
			const info = await api("GET", `/sessions/${await resolveId(rest[0])}/info`);
			console.log(describe(info));
			if (info.repo) console.log(`repo: ${info.repo}`);
			if (info.lastError) console.log(`problem: ${info.lastError}`);
			return;
		}
		case "send": {
			const id = await resolveId(rest[0]);
			const prompt = rest.slice(1).join(" ");
			if (!prompt) die('Usage: relay send <id> "prompt"');
			await api("POST", `/sessions/${id}/turns`, { prompt });
			if (!flags["no-watch"]) {
				const info = await watch(id);
				if (info.status === "failed") process.exit(1);
			}
			return;
		}
		case "watch":
			await watch(await resolveId(rest[0]));
			return;
		case "local":
			return cmdLocal(rest[0], flags, passthrough);
		case "stop":
			console.log(describe(await api("POST", `/sessions/${await resolveId(rest[0])}/interrupt`, {})));
			return;
		case "release":
			console.log(describe(await api("POST", `/sessions/${await resolveId(rest[0])}/release`, { force: flags.force })));
			return;
		case "rm":
			await api("DELETE", `/sessions/${await resolveId(rest[0])}`);
			return;
		default:
			console.log(usage);
			if (command && command !== "help" && command !== "--help") process.exit(1);
	}
}

main().catch((error) => die(error.message));

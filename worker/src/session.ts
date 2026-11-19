import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { CONTROL_HOST } from "./outbound";

const repoDir = "/workspace/repo";
const taskDir = "/workspace/task";
const inactivityTimeout = 15 * 60 * 1000;
const taskCheckInterval = 60 * 1000;
const caPath = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
// All HTTPS from the container is intercepted and re-signed by this CA.
const trustEnv = {
	NODE_EXTRA_CA_CERTS: caPath,
	GIT_SSL_CAINFO: caPath,
	CURL_CA_BUNDLE: caPath,
	SSL_CERT_FILE: caPath,
};
// D1/DO SQLite caps a value at 2 MB; larger transcript entries are split.
const CHUNK = 500_000;

// Runs the command in its own process group, records pid and exit code in files.
const taskScript = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
	"$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`;
const taskRunningScript = `read -r pid boot <"$1" &&
	[ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&
	kill -0 "$pid"`;
const killScript = `read -r pid boot <"$1" && kill -TERM -- "-$pid"`;

export type Holder = { kind: "cloud" | "local"; user: string; host?: string; since: number };

export type SessionInfo = {
	id: string;
	title: string;
	repo: string | null;
	ref: string | null;
	branch: string | null;
	owner: string;
	createdAt: number;
	updatedAt: number;
	status: "idle" | "running" | "failed";
	holder: Holder | null;
	lastResult: string | null;
	lastError: string | null;
	lastSeq: number;
};

type Meta = Omit<SessionInfo, "lastSeq">;

export class SessionDO extends DurableObject<Env> {
	private filesApi: Files | undefined;
	private setup: Promise<void> | undefined;
	private setupUser: string | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const container = ctx.container;
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS entries(
				seq INTEGER PRIMARY KEY AUTOINCREMENT, subpath TEXT NOT NULL, uuid TEXT,
				data TEXT NOT NULL, parts INTEGER NOT NULL DEFAULT 0);
			CREATE UNIQUE INDEX IF NOT EXISTS entries_uuid ON entries(subpath, uuid) WHERE uuid IS NOT NULL;
			CREATE TABLE IF NOT EXISTS chunks(
				seq INTEGER NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(seq, idx));
		`);
		// The timeout does not survive a Durable Object restart.
		if (container?.running) {
			void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(inactivityTimeout));
		}
	}

	// Looked up lazily so the API still works where no container exists (local dev without Docker).
	private get container(): Container {
		const container = this.ctx.container;
		if (!container) throw new Error("No container is configured");
		return container;
	}

	private get files(): Files {
		this.filesApi ??= new Files(this.container);
		return this.filesApi;
	}

	// ---------- state ----------

	private meta(): Meta | undefined {
		return this.ctx.storage.kv.get<Meta>("meta");
	}

	private lastSeq(): number {
		const row = this.ctx.storage.sql.exec("SELECT MAX(seq) AS s FROM entries").toArray()[0];
		return (row?.s as number | null) ?? 0;
	}

	private info(): SessionInfo | undefined {
		const meta = this.meta();
		return meta ? { ...meta, lastSeq: this.lastSeq() } : undefined;
	}

	private async save(patch: Partial<Meta>): Promise<SessionInfo> {
		const meta = { ...this.meta()!, ...patch, updatedAt: Date.now() };
		this.ctx.storage.kv.put("meta", meta);
		const info = { ...meta, lastSeq: this.lastSeq() };
		this.broadcast({ type: "state", info });
		await this.env.REGISTRY.getByName("registry").upsertSession({
			id: meta.id,
			title: meta.title,
			repo: meta.repo,
			branch: meta.branch,
			owner: meta.owner,
			status: meta.status,
			holder: meta.holder ? `${meta.holder.kind}:${meta.holder.user}` : null,
			createdAt: meta.createdAt,
			updatedAt: meta.updatedAt,
		});
		return info;
	}

	private broadcast(message: unknown): void {
		const text = JSON.stringify(message);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(text);
			} catch {
				// The socket is closing.
			}
		}
	}

	// ---------- HTTP surface (reached only through the Worker or Outbound) ----------

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const user = request.headers.get("x-relay-user") ?? "";
		const runner = request.headers.get("x-relay-actor") === "runner";
		const route = `${request.method} ${url.pathname}`;

		if (route === "POST /init") {
			if (this.meta()) return json({ error: "exists" }, 409);
			const body = await request.json<{ id: string; title: string; repo?: string; ref?: string }>();
			const now = Date.now();
			this.ctx.storage.kv.put("meta", {
				id: body.id,
				title: body.title,
				repo: body.repo ?? null,
				ref: body.ref ?? null,
				branch: body.repo ? `relay/${body.id.slice(0, 8)}` : null,
				owner: user,
				createdAt: now,
				updatedAt: now,
				status: "idle",
				holder: null,
				lastResult: null,
				lastError: null,
			} satisfies Meta);
			return json(await this.save({}));
		}

		const meta = this.meta();
		if (!meta) return json({ error: "No such session" }, 404);

		switch (route) {
			case "GET /info":
				return json(this.info());

			case "GET /ws": {
				if (request.headers.get("upgrade") !== "websocket") return json({ error: "Expected a WebSocket" }, 426);
				const pair = new WebSocketPair();
				// Hibernating sockets do not keep the container running.
				this.ctx.acceptWebSocket(pair[1]);
				pair[1].send(JSON.stringify({ type: "state", info: this.info() }));
				let after = Number(url.searchParams.get("after") ?? 0);
				for (;;) {
					const page = this.readEntries(after, undefined, 200);
					for (const e of page) pair[1].send(JSON.stringify({ type: "entry", ...e }));
					if (page.length < 200) break;
					after = page[page.length - 1].seq;
				}
				return new Response(null, { status: 101, webSocket: pair[0] });
			}

			case "GET /transcript": {
				const subpath = url.searchParams.get("subpath") ?? undefined;
				let after = Number(url.searchParams.get("after") ?? 0);
				const encoder = new TextEncoder();
				const stream = new ReadableStream<Uint8Array>({
					pull: (controller) => {
						const page = this.readEntries(after, subpath, 100);
						for (const e of page) controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
						if (page.length < 100) controller.close();
						else after = page[page.length - 1].seq;
					},
				});
				return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
			}

			case "GET /subkeys": {
				const rows = this.ctx.storage.sql
					.exec("SELECT DISTINCT subpath FROM entries WHERE subpath != ''")
					.toArray();
				return json(rows.map((r) => r.subpath));
			}

			case "POST /transcript": {
				// Only whoever is driving may write: the cloud runner during a turn, or the local holder.
				const allowed = runner
					? meta.status === "running"
					: meta.holder?.kind === "local" && meta.holder.user === user;
				if (!allowed) return json({ error: "You do not hold this session", holder: meta.holder }, 409);
				const body = await request.json<{ subpath?: string; entries: unknown[] }>();
				const appended = this.appendEntries(body.subpath ?? "", body.entries);
				return json({ appended, lastSeq: this.lastSeq() });
			}

			case "POST /turns": {
				const body = await request.json<{ prompt: string }>();
				if (!body.prompt?.trim()) return json({ error: "Empty prompt" }, 400);
				return this.startTurn(body.prompt, user);
			}

			case "POST /done": {
				if (!runner) return json({ error: "Forbidden" }, 403);
				const body = await request.json<{ ok: boolean; result?: string; error?: string }>();
				await this.finishTurn(body.ok, body.result ?? null, body.error ?? null);
				return json({ ok: true });
			}

			case "POST /interrupt": {
				if (meta.status !== "running") return json({ error: "Nothing is running" }, 409);
				if (this.ctx.container?.running) {
					await this.run(["/bin/sh", "-c", killScript, "kill", `${taskDir}/pid`], "/", {});
				}
				await this.finishTurn(false, null, `Interrupted by ${user}`);
				return json(this.info());
			}

			case "POST /checkout": {
				const body = await request.json<{ host?: string; force?: boolean }>();
				if (meta.status === "running") {
					return json({ error: "A cloud turn is running. Wait for it or interrupt it first." }, 409);
				}
				const held = meta.holder?.kind === "local" && meta.holder.user !== user;
				if (held && !body.force) {
					return json({ error: `Held locally by ${meta.holder!.user}`, holder: meta.holder }, 409);
				}
				return json(await this.save({ holder: { kind: "local", user, host: body.host, since: Date.now() } }));
			}

			case "POST /release": {
				const body = await request.json<{ force?: boolean }>().catch(() => ({ force: false }));
				if (meta.holder?.kind !== "local") return json(this.info());
				if (meta.holder.user !== user && !body.force) {
					return json({ error: `Held by ${meta.holder.user}` }, 409);
				}
				return json(await this.save({ holder: null }));
			}

			case "DELETE /": {
				if (this.ctx.container?.running) await this.container.destroy();
				for (const ws of this.ctx.getWebSockets()) ws.close(1000, "Session deleted");
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.deleteAll();
				await this.env.REGISTRY.getByName("registry").deleteSession(meta.id);
				return json({ ok: true });
			}
		}
		return json({ error: "Not found" }, 404);
	}

	webSocketMessage(): void {}
	webSocketClose(ws: WebSocket): void {
		try {
			ws.close();
		} catch {
			// Already closed.
		}
	}

	// ---------- transcript ----------

	private appendEntries(subpath: string, entries: unknown[]): number {
		let appended = 0;
		for (const entry of entries) {
			const uuid =
				entry !== null && typeof entry === "object" && typeof (entry as { uuid?: unknown }).uuid === "string"
					? (entry as { uuid: string }).uuid
					: null;
			const data = JSON.stringify(entry);
			const parts = data.length > CHUNK ? Math.ceil(data.length / CHUNK) : 0;
			// A retried batch can re-deliver entries: the unique index drops duplicates by uuid.
			const row = this.ctx.storage.sql
				.exec(
					"INSERT OR IGNORE INTO entries(subpath, uuid, data, parts) VALUES(?, ?, ?, ?) RETURNING seq",
					subpath,
					uuid,
					parts ? "" : data,
					parts,
				)
				.toArray()[0];
			if (!row) continue;
			const seq = row.seq as number;
			for (let i = 0; i < parts; i++) {
				this.ctx.storage.sql.exec(
					"INSERT INTO chunks(seq, idx, data) VALUES(?, ?, ?)",
					seq,
					i,
					data.slice(i * CHUNK, (i + 1) * CHUNK),
				);
			}
			appended++;
			this.broadcast({ type: "entry", seq, subpath, entry });
		}
		return appended;
	}

	private readEntries(
		after: number,
		subpath: string | undefined,
		limit: number,
	): { seq: number; subpath: string; entry: unknown }[] {
		const rows =
			subpath === undefined
				? this.ctx.storage.sql.exec("SELECT * FROM entries WHERE seq > ? ORDER BY seq LIMIT ?", after, limit)
				: this.ctx.storage.sql.exec(
						"SELECT * FROM entries WHERE seq > ? AND subpath = ? ORDER BY seq LIMIT ?",
						after,
						subpath,
						limit,
					);
		return rows.toArray().map((r) => {
			let data = r.data as string;
			if (r.parts) {
				data = this.ctx.storage.sql
					.exec("SELECT data FROM chunks WHERE seq = ? ORDER BY idx", r.seq)
					.toArray()
					.map((c) => c.data as string)
					.join("");
			}
			return { seq: r.seq as number, subpath: r.subpath as string, entry: JSON.parse(data) };
		});
	}

	// ---------- cloud turns ----------

	private startTurn(prompt: string, user: string): Promise<Response> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const meta = this.meta()!;
			if (meta.holder?.kind === "local") {
				return json({ error: `Checked out locally by ${meta.holder.user}`, holder: meta.holder }, 409);
			}
			if (meta.status === "running") return json({ error: "A turn is already running" }, 409);
			const registry = this.env.REGISTRY.getByName("registry");
			if (!(await registry.getClaudeToken(user))) {
				return json({ error: "No Claude token stored for you. Run: relay login" }, 400);
			}

			await this.startSandbox(user);
			await this.files.remove(taskDir, { recursive: true, force: true });
			await this.files.mkdir(taskDir, { recursive: true });
			await this.files.mkdir(repoDir, { recursive: true });
			await this.files.writeFile(
				`${taskDir}/input.json`,
				JSON.stringify({
					sessionId: meta.id,
					resume: this.lastSeq() > 0,
					prompt,
					user,
					repo: meta.repo,
					ref: meta.ref,
					branch: meta.branch,
					model: this.env.MODEL || null,
					control: `http://${CONTROL_HOST}`,
					cwd: repoDir,
				}),
			);
			await this.container.exec(
				["/bin/sh", "-c", taskScript, "runner", taskDir, "node", "/opt/relay/runner.mjs", `${taskDir}/input.json`],
				{
					cwd: "/workspace",
					env: {
						...trustEnv,
						HOME: "/root",
						// A placeholder: Outbound swaps in the real token on the way out.
						CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-held-by-the-worker",
						CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
						IS_SANDBOX: "1",
					},
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			await this.ctx.storage.setAlarm(Date.now() + taskCheckInterval);
			const info = await this.save({
				status: "running",
				holder: { kind: "cloud", user, since: Date.now() },
				lastError: null,
			});
			return json(info, 202);
		});
	}

	private async finishTurn(ok: boolean, result: string | null, error: string | null): Promise<void> {
		if (this.meta()?.status !== "running") return;
		await this.save({
			status: ok ? "idle" : "failed",
			holder: null,
			lastResult: result ?? this.meta()!.lastResult,
			lastError: error,
		});
	}

	/** Each check counts as activity, which keeps the container alive during a long turn. */
	async alarm(): Promise<void> {
		const meta = this.meta();
		if (!meta || meta.status !== "running") return;
		if (!this.container.running) {
			await this.finishTurn(false, null, "The container stopped before the turn finished");
			return;
		}
		const state = await this.taskState();
		if (state === "running") {
			await this.ctx.storage.setAlarm(Date.now() + taskCheckInterval);
			return;
		}
		// The runner reports its own outcome; reaching here means it died without doing so.
		const stderr = (await this.readOptionalText(`${taskDir}/stderr.log`)) ?? "";
		await this.finishTurn(false, null, `Runner exited without reporting (${state}): ${stderr.slice(-2000)}`);
	}

	private async taskState(): Promise<"running" | "exited" | "lost"> {
		if ((await this.readOptionalText(`${taskDir}/exit-code`)) !== undefined) return "exited";
		if ((await this.readOptionalText(`${taskDir}/pid`)) === undefined) return "running";
		const probe = await this.run(["/bin/sh", "-c", taskRunningScript, "probe", `${taskDir}/pid`], "/", {});
		if (probe.exitCode === 0) return "running";
		return (await this.readOptionalText(`${taskDir}/exit-code`)) !== undefined ? "exited" : "lost";
	}

	private async startSandbox(user: string): Promise<void> {
		// Set up a new container, a running one after this object restarts, or a change of driver.
		if (this.setup === undefined || !this.container.running || this.setupUser !== user) {
			this.setupUser = user;
			this.setup = this.setUpSandbox(user).catch((error) => {
				this.setup = undefined;
				throw error;
			});
		}
		await this.setup;
	}

	private async setUpSandbox(user: string): Promise<void> {
		if (!this.container.running) {
			this.container.start({
				image: this.container.images.agent,
				instance: this.env.INSTANCE || "standard-1",
				enableInternet: false,
			});
		}
		try {
			// Registering again replaces the handler, so the props follow whoever sent the turn.
			const outbound = this.ctx.exports.Outbound({ props: { sessionId: this.meta()!.id, user } });
			await this.container.interceptAllOutboundHttp(outbound);
			await this.container.interceptOutboundHttps("*", outbound);
			await this.container.setInactivityTimeout(inactivityTimeout);
		} catch (error) {
			await this.container.destroy();
			throw error;
		}
	}

	private async readOptionalText(path: string): Promise<string | undefined> {
		try {
			return await (await this.files.readFile(path)).text();
		} catch (error) {
			if (SandboxFileError.is(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async run(command: string[], cwd: string, env: Record<string, string>) {
		const process = await this.container.exec(command, { cwd, env });
		const output = await process.output();
		return { exitCode: output.exitCode, stdout: new TextDecoder().decode(output.stdout) };
	}
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

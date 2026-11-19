import ui from "./ui.html";

export { Outbound } from "./outbound";
export { RegistryDO } from "./registry";
export { SessionDO } from "./session";

const userName = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/" && request.method === "GET") {
			return new Response(ui, { headers: { "content-type": "text/html; charset=utf-8" } });
		}
		if (!url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);

		const user = await authenticate(request, url, env);
		if (!user) return json({ error: "Unauthorized" }, 401);
		const registry = env.REGISTRY.getByName("registry");
		const path = url.pathname.slice("/api".length);
		const route = `${request.method} ${path}`;

		if (route === "GET /me") {
			return json({ name: user, hasClaudeToken: Boolean(await registry.getClaudeToken(user)) });
		}
		if (route === "PUT /me/claude-token") {
			const { token } = await request.json<{ token: string | null }>();
			await registry.setClaudeToken(user, token?.trim() || null);
			return json({ ok: true });
		}

		if (path === "/users" || path.startsWith("/users/")) {
			if (user !== "admin") return json({ error: "Admin only" }, 403);
			if (route === "GET /users") return json(await registry.listUsers());
			const name = path.slice("/users/".length);
			if (!userName.test(name) || name === "admin") return json({ error: "Invalid user name" }, 400);
			if (request.method === "PUT") {
				// Creates the user or rotates their login token. The token is shown once.
				const token = `relay_${randomHex(24)}`;
				await registry.putUser(name, await sha256(token));
				return json({ name, token });
			}
			if (request.method === "DELETE") {
				await registry.deleteUser(name);
				return json({ ok: true });
			}
		}

		if (route === "GET /sessions") return json(await registry.listSessions());
		if (route === "POST /sessions") {
			const body = await request.json<{ title?: string; repo?: string; ref?: string; prompt?: string }>();
			if (body.repo && !/^https:\/\/[^\s]+$/.test(body.repo)) {
				return json({ error: "repo must be an https:// clone URL" }, 400);
			}
			const id = crypto.randomUUID();
			const title = (body.title || body.prompt || "Untitled").trim().slice(0, 80);
			const session = env.SESSION.getByName(id);
			let response = await session.fetch(
				internal(user, "POST", "/init", { id, title, repo: body.repo, ref: body.ref }),
			);
			if (response.ok && body.prompt) {
				response = await session.fetch(internal(user, "POST", "/turns", { prompt: body.prompt }));
				// The session exists even if its first turn could not start.
				if (!response.ok) {
					const failure = await response.json<{ error: string }>();
					return json({ id, warning: failure.error }, 201);
				}
			}
			return response;
		}

		const match = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path);
		if (match && sessionId.test(match[1])) {
			const headers = new Headers(request.headers);
			// Identity headers are set here only; never trust the client's.
			headers.set("x-relay-user", user);
			headers.delete("x-relay-actor");
			const target = new Request(`http://session${match[2] ?? "/"}${url.search}`, {
				method: request.method,
				headers,
				body: request.body,
			});
			return env.SESSION.getByName(match[1]).fetch(target);
		}
		return json({ error: "Not found" }, 404);
	},
} satisfies ExportedHandler<Env>;

function internal(user: string, method: string, path: string, body: unknown): Request {
	return new Request(`http://session${path}`, {
		method,
		headers: { "content-type": "application/json", "x-relay-user": user },
		body: JSON.stringify(body),
	});
}

async function authenticate(request: Request, url: URL, env: Env): Promise<string | null> {
	const header = request.headers.get("authorization");
	// Browsers cannot set headers on a WebSocket, so the UI passes the token in the query.
	const token = header?.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
	if (!token) return null;
	const hash = await sha256(token);
	// Comparing hashes keeps the comparison independent of where the tokens differ.
	if (env.ADMIN_TOKEN && hash === (await sha256(env.ADMIN_TOKEN))) return "admin";
	return env.REGISTRY.getByName("registry").authenticate(hash);
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

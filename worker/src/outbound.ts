import { WorkerEntrypoint } from "cloudflare:workers";

export const CONTROL_HOST = "relay.internal";

type Props = { sessionId: string; user: string };

/**
 * Every HTTP and HTTPS request leaving a session's container passes through here.
 * Credentials are added on the way out, so neither the Claude subscription token
 * nor the GitHub token ever exists inside the sandbox.
 */
export class Outbound extends WorkerEntrypoint<Env, Props> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const { sessionId, user } = this.ctx.props;

		// The runner's control channel: transcript store and turn status.
		if (url.hostname === CONTROL_HOST) {
			const headers = new Headers(request.headers);
			headers.set("x-relay-actor", "runner");
			headers.set("x-relay-user", user);
			const target = new Request(`http://session${url.pathname}${url.search}`, {
				method: request.method,
				headers,
				body: request.body,
			});
			return this.env.SESSION.getByName(sessionId).fetch(target);
		}

		if (url.hostname === "api.anthropic.com") {
			if (url.protocol !== "https:") return deny(url, "is reachable only over HTTPS");
			const token = await this.env.REGISTRY.getByName("registry").getClaudeToken(user);
			if (!token) {
				return new Response(`No Claude token stored for ${user}. Run: relay login\n`, { status: 401 });
			}
			const headers = new Headers(request.headers);
			headers.delete("x-api-key");
			headers.set("authorization", `Bearer ${token}`);
			return fetch(new Request(request, { headers, redirect: "manual" }));
		}

		if (url.hostname === "github.com" && this.env.GITHUB_TOKEN) {
			if (url.protocol !== "https:") return deny(url, "is reachable only over HTTPS");
			const headers = new Headers(request.headers);
			headers.set("authorization", `Basic ${btoa(`x-access-token:${this.env.GITHUB_TOKEN}`)}`);
			return fetch(new Request(request, { headers, redirect: "manual" }));
		}

		// Everything else (package registries, docs) passes through without credentials.
		return fetch(request);
	}
}

function deny(url: URL, why: string): Response {
	return new Response(`${url.hostname} ${why}\n`, { status: 403 });
}

import { DurableObject } from "cloudflare:workers";

export type SessionSummary = {
	id: string;
	title: string;
	repo: string | null;
	branch: string | null;
	owner: string;
	status: string;
	holder: string | null;
	createdAt: number;
	updatedAt: number;
};

/** One instance (named "registry"): users, their Claude tokens, and the session index. */
export class RegistryDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS users(
				name TEXT PRIMARY KEY, token_hash TEXT UNIQUE, claude_token TEXT, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS sessions(
				id TEXT PRIMARY KEY, title TEXT NOT NULL, repo TEXT, branch TEXT, owner TEXT NOT NULL,
				status TEXT NOT NULL, holder TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
		`);
	}

	authenticate(tokenHash: string): string | null {
		const row = this.ctx.storage.sql
			.exec("SELECT name FROM users WHERE token_hash = ?", tokenHash)
			.toArray()[0];
		return row ? (row.name as string) : null;
	}

	/** Creates the user, or rotates the login token if the user exists. */
	putUser(name: string, tokenHash: string | null): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO users(name, token_hash, created_at) VALUES(?, ?, ?)
			 ON CONFLICT(name) DO UPDATE SET token_hash = COALESCE(excluded.token_hash, token_hash)`,
			name,
			tokenHash,
			Date.now(),
		);
	}

	deleteUser(name: string): void {
		this.ctx.storage.sql.exec("DELETE FROM users WHERE name = ?", name);
	}

	listUsers(): { name: string; hasClaudeToken: boolean }[] {
		return this.ctx.storage.sql
			.exec("SELECT name, claude_token IS NOT NULL AS has FROM users ORDER BY name")
			.toArray()
			.map((r) => ({ name: r.name as string, hasClaudeToken: Boolean(r.has) }));
	}

	setClaudeToken(name: string, token: string | null): void {
		this.putUser(name, null);
		this.ctx.storage.sql.exec("UPDATE users SET claude_token = ? WHERE name = ?", token, name);
	}

	getClaudeToken(name: string): string | null {
		const row = this.ctx.storage.sql
			.exec("SELECT claude_token FROM users WHERE name = ?", name)
			.toArray()[0];
		return (row?.claude_token as string | null) ?? null;
	}

	upsertSession(s: SessionSummary): void {
		this.ctx.storage.sql.exec(
			`INSERT INTO sessions(id, title, repo, branch, owner, status, holder, created_at, updated_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status,
			   holder = excluded.holder, branch = excluded.branch, updated_at = excluded.updated_at`,
			s.id,
			s.title,
			s.repo,
			s.branch,
			s.owner,
			s.status,
			s.holder,
			s.createdAt,
			s.updatedAt,
		);
	}

	deleteSession(id: string): void {
		this.ctx.storage.sql.exec("DELETE FROM sessions WHERE id = ?", id);
	}

	listSessions(): SessionSummary[] {
		return this.ctx.storage.sql
			.exec("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 200")
			.toArray()
			.map((r) => ({
				id: r.id as string,
				title: r.title as string,
				repo: r.repo as string | null,
				branch: r.branch as string | null,
				owner: r.owner as string,
				status: r.status as string,
				holder: r.holder as string | null,
				createdAt: r.created_at as number,
				updatedAt: r.updated_at as number,
			}));
	}
}

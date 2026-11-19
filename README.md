# Claude Relay

One Claude Code session that moves between a Cloudflare container and any machine,
with a single shared history. Kick off a job in the cloud, take it over in the real
`claude` terminal on your laptop, hand it back, and let teammates watch or take a turn.

```
relay CLI / web UI
      │
   Worker ─────────── login tokens, routing, web UI
      │
   SessionDO (one per session)
      ├── transcript  (SQLite, the single source of truth for the conversation)
      ├── lease       (who is driving: cloud, or one local machine)
      └── container   (Agent SDK + repo checkout; runs cloud turns)
            │
         Outbound ─── adds the Claude and GitHub tokens on the way out
```

- **Conversation** travels through the transcript store. The cloud writes to it through the
  Agent SDK's `SessionStore`; `relay local` writes it into `~/.claude/projects/` for Claude Code
  and mirrors new lines back every few seconds.
- **Code** travels on a git branch, `relay/<id>`. Each side commits and pushes when it hands off.
- **Credentials** stay in the Worker. The container only ever holds a placeholder.

## Deploy

Needs a Cloudflare account on the Workers Paid plan (Containers), Docker running locally, and Node 18+.

```bash
cd worker && npm install && (cd container && npm install)
```

```bash
npx wrangler secret put ADMIN_TOKEN
```

```bash
npx wrangler secret put GITHUB_TOKEN
```

```bash
npx wrangler deploy
```

`ADMIN_TOKEN` is any long random string; it is your login. `GITHUB_TOKEN` is optional (a
fine-grained token with contents read/write on the repos you will use); without it the cloud can
only clone public repos and cannot push.

## Set up a machine

```bash
npm install -g ./cli
```

```bash
relay init https://claude-relay.<your-subdomain>.workers.dev <ADMIN_TOKEN>
```

```bash
claude setup-token
```

```bash
relay login
```

`claude setup-token` prints a one-year token for your Claude subscription; `relay login` stores it
in the Worker. Cloud turns you start run on it.

## Use

```bash
relay new --repo https://github.com/you/project "add rate limiting to the API"
```

```bash
relay local 4e55
```

```bash
relay send 4e55 "now write the tests"
```

`relay local` checks the session out to you, puts your checkout on the session branch, opens
Claude Code with the full history, and on exit syncs the transcript, offers to commit and push,
and releases the session. `relay watch <id>` or the web UI at the Worker's URL follows any session
live, including one being driven from someone's terminal.

## Team

```bash
relay user add sam
```

This prints a `relay init …` line for Sam. Each person then runs `claude setup-token` and
`relay login` with their own subscription: a cloud turn runs on the token of whoever sent it.
Only one driver at a time; `relay release <id> --force` breaks a stale checkout.

## Status

Tested end to end without Cloudflare (`wrangler dev` plus the container's runner run by hand):
cloud turn → takeover in the real `claude` CLI → cloud turn again, with history and code intact;
lease rules; CLI; web UI.

Not yet run on Cloudflare itself: the container image build, starting turns inside the container,
and the outbound credential swap. Expect to debug the first deploy.

Known limits:
- Sessions without `--repo` keep their files only while the container lives.
- Each cloud turn commits everything to the session branch; open the PR yourself.
- Cloud turns run with all permissions inside the sandbox, with open outbound internet.
- Subagent transcripts sync on a best-effort basis.
- One `GITHUB_TOKEN` is shared by all users.

# Remote jobs for Pi

Install once for your Pi user:

```sh
pi install git:github.com/Yiki21/pi-remote-jobs@v0.1.0
```

The npm package name is reserved in the source as `pi-remote-jobs`; npm publication is pending.

Run `/reload` in existing Pi sessions. New sessions load it automatically. The package registers one tool, `remote`.
File tools remain local. Linux execution hosts need SSH key authentication, bash, rsync, GNU coreutils and systemd.
The SSH user must be allowed to create system services. The plugin does not install software or alter sshd.

## Configure a project

Create `.pi/remote.json` in a trusted project:

```json
{
  "hosts": [
    { "name": "build-server", "root": "/data/my-project", "cpus": "0-11" }
  ],
  "code_sync": { "paths": ["scripts/"], "exclude": ["__pycache__/"], "max_size": "5M" }
}
```

Host names are aliases in `~/.ssh/config`. `root` defaults to the local project root, so use distinct remote roots
for distinct projects. `local: true` runs on the Pi machine and always uses the local project root.
`reserve_gb` subtracts from available memory when selecting a host. `drain: true` excludes a host from new automatic
placements. CPU affinity defaults to all host CPUs; set `cpus` for reserved cores.

The nearest parent `.pi` directory defines the project boundary. A nested project without `remote.json` fails
without contacting a host. Configuration is read on every call; adding or draining hosts needs no reload.
There is no global server fallback. Environment variables do not override project selection.

The optional `env` object adds non-secret environment variables to jobs. Never put credentials there.
`unit_prefix` normally derives from the local project root; leave it unchanged while jobs are running.
The default job environment includes `WORK=<remote-root>/.work`, `TMPDIR=$WORK/tmp` and a tool PATH.
Remote root paths currently must be absolute and contain no spaces or shell metacharacters.

## Agent usage

```js
remote({cmd: "python3 scripts/check.py", sync: ["src/component"], fetch: [".work/report.json"]})
remote({action: "wait", job: "build-server.0123456789"})
remote({action: "log", job: "build-server.0123456789", lines: 100})
remote({action: "hosts"})
```

The tool chooses a reachable host with the most available memory, then pins it per project and session.
An explicit `host` affects only that call. A disappeared pinned host is replaced for new submissions.
Jobs keep running after a connection drops or Pi exits. A call waits up to 290 seconds; the job has no tool-imposed
time limit. Resume with `wait`. An unknown submission outcome returns its job id; inspect it before resubmitting.

Paths in `sync` and `fetch` are relative to the local project root. Sync directories are mirrored with `--delete`;
fetch overwrites matching local files. Only name paths you own. Configured code directories are refreshed at most
once per minute. Nothing is synced by default. Use `stop` only for your own jobs; Docker containers started by the
job must be removed separately.

Host preparation and project-specific build rules belong to the project's own scripts and docs.
This package does not change subagent concurrency or model caching.

## Verification

Run the isolated configuration checks with Pi's installed loader:

```sh
node selftest.mjs /absolute/path/to/pi-coding-agent
```

These checks make no model requests and send no SSH commands. Execution and file transfer were also exercised
against a configured Linux build host and from a real background subagent.

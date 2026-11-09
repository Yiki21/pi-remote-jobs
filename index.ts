import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, normalize, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionToolContext,
  truncateTail,
} from "@earendil-works/pi-coding-agent";

interface Details {
  action: string;
  host?: string;
  job?: string;
  state?: string;
  rc?: number;
  pinned?: string;
}

// ---------- configuration ----------

/** Find the nearest configured project. Stop at a nested .pi boundary, even without remote.json. */
export function projectConfig(cwd: string): { root: string; config: string } {
  let root = realpathSync(cwd);
  for (;;) {
    const dir = `${root}/${CONFIG_DIR_NAME}`;
    if (existsSync(dir)) {
      const config = `${dir}/remote.json`;
      if (!existsSync(config))
        throw new Error(
          `Remote is not configured for ${root}. Create ${config}; no command was sent.`,
        );
      return { root, config };
    }
    const parent = dirname(root);
    if (parent === root)
      throw new Error(
        `Remote is not configured for ${cwd}. Create ${CONFIG_DIR_NAME}/remote.json in this project; no command was sent.`,
      );
    root = parent;
  }
}

function createProject(ROOT: string, REGISTRY: string) {
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
  const HEX_RE = /^[0-9a-f]{8,16}$/;
  const MAX_WAIT_S = 290;
  const DEFAULT_WAIT_S = 240;
  const TAIL_LINES = 60;
  const MAX_OUTPUT_BYTES = 12 * 1024;
  const SSH_CONCURRENCY = 4;
  const PATH_ENV =
    "/root/.local/bin:/root/.local/share/pnpm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

  interface HostEntry {
    name: string;
    local?: boolean;
    reserve_gb?: number;
    drain?: boolean;
    root?: string;
    cpus?: string;
  }

  interface Registry {
    hosts: HostEntry[];
    code_sync: { paths: string[]; exclude: string[]; max_size: string };
  }

  function loadRegistry(): Registry {
    if (!existsSync(REGISTRY))
      throw new Error(`host registry missing: ${REGISTRY}`);
    const raw = JSON.parse(readFileSync(REGISTRY, "utf8"));
    if (!Array.isArray(raw?.hosts) || !raw.hosts.length)
      throw new Error(`hosts must be a nonempty array in ${REGISTRY}`);
    const hosts: HostEntry[] = raw.hosts;
    if (new Set(hosts.map((h) => h.name)).size !== hosts.length)
      throw new Error("duplicate host name");
    if (!/^\/[A-Za-z0-9._/-]+$/.test(ROOT))
      throw new Error(
        "project root must be an absolute path without spaces or shell metacharacters",
      );
    for (const h of hosts) {
      if (typeof h?.name !== "string" || !NAME_RE.test(h.name))
        throw new Error(`bad host name in ${REGISTRY}: ${JSON.stringify(h)}`);
      if (h.local !== undefined && typeof h.local !== "boolean")
        throw new Error("local must be boolean");
      if (h.drain !== undefined && typeof h.drain !== "boolean")
        throw new Error("drain must be boolean");
      if (
        h.reserve_gb !== undefined &&
        (!Number.isFinite(h.reserve_gb) || h.reserve_gb < 0)
      )
        throw new Error("invalid reserve_gb");
      if (h.cpus !== undefined && !/^[0-9,-]+$/.test(h.cpus))
        throw new Error(`bad cpus for ${h.name}`);
      if (h.root !== undefined && !/^\/[A-Za-z0-9._/-]+$/.test(h.root))
        throw new Error(`bad root for ${h.name}`);
    }
    unitPrefix();
    jobEnv();
    const cs = raw?.code_sync ?? {};
    if (
      cs.paths !== undefined &&
      (!Array.isArray(cs.paths) ||
        !cs.paths.every((p) => typeof p === "string"))
    )
      throw new Error("invalid code_sync.paths");
    if (
      cs.exclude !== undefined &&
      (!Array.isArray(cs.exclude) ||
        !cs.exclude.every((p) => typeof p === "string"))
    )
      throw new Error("invalid code_sync.exclude");
    return {
      hosts,
      code_sync: {
        paths: Array.isArray(cs.paths) ? cs.paths : [],
        exclude: Array.isArray(cs.exclude) ? cs.exclude : [],
        max_size: typeof cs.max_size === "string" ? cs.max_size : "5M",
      },
    };
  }

  const rootOf = (h: HostEntry) => (h.local ? ROOT : (h.root ?? ROOT));
  const unitPrefix = () => {
    const value = JSON.parse(readFileSync(REGISTRY, "utf8")).unit_prefix;
    if (value !== undefined && !/^[a-zA-Z][a-zA-Z0-9-]{0,40}$/.test(value))
      throw new Error("invalid unit_prefix");
    return (
      value ??
      `pi-rj-${createHash("sha256").update(ROOT).digest("hex").slice(0, 10)}`
    );
  };
  const jobEnv = () => {
    const env = JSON.parse(readFileSync(REGISTRY, "utf8")).env ?? {};
    return Object.entries(env)
      .map(([k, v]) => {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ||
          typeof v !== "string" ||
          /[\n\r]/.test(v)
        )
          throw new Error("invalid remote env");
        return `-E '${k}=${v.replaceAll("'", "'\\''")}'`;
      })
      .join(" ");
  };

  // ---------- process helpers ----------

  interface Proc {
    code: number;
    stdout: string;
    stderr: string;
  }

  function exec(
    cmd: string,
    args: string[],
    opts: {
      input?: string;
      timeoutMs: number;
      signal?: AbortSignal;
      cwd?: string;
    },
  ): Promise<Proc> {
    return new Promise((resolveP) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      let done = false;
      const finish = (code: number, extra = "") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolveP({ code, stdout: out, stderr: err + extra });
      };
      const onAbort = () => {
        child.kill("SIGTERM");
        finish(130, "\n[aborted]");
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(
          124,
          `\n[timed out after ${Math.round(opts.timeoutMs / 1000)} s]`,
        );
      }, opts.timeoutMs);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (d) => {
        if (out.length < 4_000_000) out += d.toString();
      });
      child.stderr.on("data", (d) => {
        if (err.length < 200_000) err += d.toString();
      });
      child.on("error", (e) => finish(127, String(e)));
      child.on("close", (code) => finish(code ?? 1));
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input ?? "");
    });
  }

  const SSH_OPTS = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];
  const NO_MUX = ["-o", "ControlMaster=no", "-o", "ControlPath=none"];
  const MUX_ERR =
    /Session open refused|mux_client|control socket|ControlSocket|master.*(refused|closed)/i;
  const CONN_ERR =
    /Connection (refused|reset|closed|timed out)|timed out|No route to host|Could not resolve|kex_exchange|Broken pipe|Network is unreachable/i;

  // Per-host limiter: the lane runner hosts many sessions in one process; keep ssh fan-in bounded.
  const slots = new Map<string, { busy: number; queue: Array<() => void> }>();
  async function withSlot<T>(host: string, fn: () => Promise<T>): Promise<T> {
    let s = slots.get(host);
    if (!s) {
      s = { busy: 0, queue: [] };
      slots.set(host, s);
    }
    const slot = s;
    if (slot.busy >= SSH_CONCURRENCY)
      await new Promise<void>((r) => slot.queue.push(r));
    slot.busy++;
    try {
      return await fn();
    } finally {
      slot.busy--;
      slot.queue.shift()?.();
    }
  }

  const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          r();
        },
        { once: true },
      );
    });

  /** Run a bash script on a host (stdin), with mux fallback and one reconnect retry. */
  async function onHost(
    h: HostEntry,
    script: string,
    timeoutMs: number,
    signal?: AbortSignal,
    retryConn = true,
  ): Promise<Proc> {
    if (h.local)
      return exec("bash", ["-s"], { input: script, timeoutMs, signal });
    return withSlot(h.name, async () => {
      let r = await exec("ssh", [...SSH_OPTS, h.name, "bash -s"], {
        input: script,
        timeoutMs,
        signal,
      });
      if (
        r.code === 255 &&
        retryConn &&
        (MUX_ERR.test(r.stderr) || CONN_ERR.test(r.stderr)) &&
        !signal?.aborted
      ) {
        await sleep(1500, signal);
        r = await exec("ssh", [...SSH_OPTS, ...NO_MUX, h.name, "bash -s"], {
          input: script,
          timeoutMs,
          signal,
        });
      }
      return r;
    });
  }

  async function rsync(
    h: HostEntry,
    args: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Proc> {
    return withSlot(h.name, async () => {
      const run = (extra: string[]) =>
        exec(
          "rsync",
          ["-e", ["ssh", ...SSH_OPTS, ...extra].join(" "), ...args],
          { cwd: ROOT, timeoutMs, signal },
        );
      let r = await run([]);
      if (
        r.code !== 0 &&
        (MUX_ERR.test(r.stderr) || CONN_ERR.test(r.stderr)) &&
        !signal?.aborted
      ) {
        await sleep(1500, signal);
        r = await run(NO_MUX);
      }
      return r;
    });
  }

  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const sshErr = (h: HostEntry, r: Proc) =>
    `${h.name}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ") || `exit ${r.code}`}`;

  // ---------- host state ----------

  interface Probe {
    host: HostEntry;
    ok: boolean;
    avail_gb?: number;
    nproc?: number;
    jobs?: number;
    disk_gb?: number;
    error?: string;
  }

  const PROBE = (
    h: HostEntry,
  ) => `echo AVAIL=$(awk '/MemAvailable/{print int($2/1048576)}' /proc/meminfo)
	echo NPROC=$(nproc --all)
	echo JOBS=$(systemctl list-units --no-legend --plain '${unitPrefix()}-*' 2>/dev/null | grep -c ' running ')
	echo DISK=$(df -BG --output=avail '${rootOf(h)}' 2>/dev/null | tail -1 | tr -dc 0-9)
	`;

  async function probe(h: HostEntry, signal?: AbortSignal): Promise<Probe> {
    const r = await onHost(h, PROBE(h), 15_000, signal, false);
    if (r.code !== 0) return { host: h, ok: false, error: sshErr(h, r) };
    const kv = Object.fromEntries(
      r.stdout
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.split("=")[0], Number(l.split("=")[1])]),
    );
    return {
      host: h,
      ok: true,
      avail_gb: kv.AVAIL,
      nproc: kv.NPROC,
      jobs: kv.JOBS,
      disk_gb: kv.DISK,
    };
  }

  function score(p: Probe): number {
    return (p.avail_gb ?? 0) - (p.host.reserve_gb ?? 0);
  }

  async function pickHost(
    reg: Registry,
    exclude: Set<string>,
    signal?: AbortSignal,
  ): Promise<Probe> {
    const cands = reg.hosts.filter((h) => !h.drain && !exclude.has(h.name));
    if (cands.length === 0)
      throw new Error(
        `no usable host in ${REGISTRY} (all drained or excluded)`,
      );
    const probes = await Promise.all(cands.map((h) => probe(h, signal)));
    const ok = probes.filter((p) => p.ok);
    if (ok.length === 0)
      throw new Error(
        `no reachable host: ${probes.map((p) => p.error).join("; ")}`,
      );
    ok.sort((a, b) => score(b) - score(a) || (a.jobs ?? 0) - (b.jobs ?? 0));
    return ok[0];
  }

  // Pinned host per session (in memory), reconstructed from the branch after a restart.
  const pins = new Map<string, string>();

  function pinnedFromBranch(ctx: ExtensionToolContext): string | undefined {
    try {
      const branch = ctx.sessionManager.getBranch();
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i];
        const m =
          entry.type === "message"
            ? (entry.message as {
                role: string;
                toolName?: string;
                details?: { project?: string; pinned?: string };
              })
            : undefined;
        if (
          m?.role === "toolResult" &&
          m?.toolName === "remote" &&
          m?.details?.project === ROOT &&
          m?.details?.pinned
        )
          return m.details.pinned;
      }
    } catch {}
    return undefined;
  }

  function sessionKey(ctx: ExtensionToolContext): string {
    try {
      return (
        ctx.sessionManager.getSessionId() ||
        ctx.sessionManager.getSessionFile() ||
        "default"
      );
    } catch {
      return "default";
    }
  }

  // ---------- paths ----------

  function checkRel(p: string, forSync: boolean): string {
    if (p.split("/").includes("..") || p.startsWith("-"))
      throw new Error(`unsafe path: ${p}`);
    const n = normalize(p.trim()).replace(/\/+$/, "");
    let existing = resolve(ROOT, n);
    while (!existsSync(existing) && existing !== ROOT)
      existing = dirname(existing);
    const real = realpathSync(existing);
    if (real !== ROOT && !real.startsWith(ROOT + "/"))
      throw new Error(`path escapes project through a symlink: ${p}`);
    if (
      !n ||
      n === "." ||
      n.startsWith("/") ||
      n.startsWith("..") ||
      n.includes("/../") ||
      /[\s'"`$\\]/.test(n)
    )
      throw new Error(
        `path must be relative to ${ROOT}, without spaces or '..': ${JSON.stringify(p)}`,
      );
    if (forSync && ["tasks", ".work", "docs", "scripts"].includes(n))
      throw new Error(
        `refusing to sync a whole top-level tree: ${n} (name the task dir, e.g. src/component)`,
      );
    if (forSync && !existsSync(`${ROOT}/${n}`))
      throw new Error(`sync path does not exist locally: ${ROOT}/${n}`);
    return n;
  }

  const lastCodeSync = new Map<string, number>();

  async function syncTo(
    h: HostEntry,
    reg: Registry,
    paths: string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (h.local) return undefined;
    const root = rootOf(h);
    const mk = await onHost(
      h,
      `mkdir -p '${root}/.work/tmp' '${root}/.work/remote-jobs' '${root}/.work/controls' '${root}/.work/logs' '${root}/.work/jobs'`,
      30_000,
      signal,
    );
    if (mk.code !== 0) return sshErr(h, mk);
    if (
      reg.code_sync.paths.length &&
      Date.now() - (lastCodeSync.get(h.name) ?? 0) > 60_000
    ) {
      reg.code_sync.paths.forEach((p) => checkRel(p, false));
      const ex = reg.code_sync.exclude.flatMap((e) => ["--exclude", e]);
      const r = await rsync(
        h,
        [
          "-aR",
          `--max-size=${reg.code_sync.max_size}`,
          ...ex,
          ...reg.code_sync.paths,
          `${h.name}:${root}/`,
        ],
        600_000,
        signal,
      );
      if (r.code !== 0) return `code sync: ${sshErr(h, r)}`;
      lastCodeSync.set(h.name, Date.now());
    }
    if (paths.length) {
      const r = await rsync(
        h,
        ["-aR", "--delete", ...paths, `${h.name}:${root}/`],
        1_800_000,
        signal,
      );
      if (r.code !== 0) return `sync ${paths.join(" ")}: ${sshErr(h, r)}`;
    }
    return undefined;
  }

  // ---------- jobs ----------

  async function fetchBack(
    h: HostEntry,
    paths: string[] | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    if (h.local || !paths?.length) return "";
    const root = rootOf(h);
    const r = await rsync(
      h,
      [
        "-aR",
        "--ignore-missing-args",
        ...paths.map((p) => `${h.name}:${root}/./${p}`),
        `${ROOT}/`,
      ],
      1_800_000,
      signal,
    );
    return r.code === 0
      ? `fetched back to ${ROOT}: ${paths.join(" ")}`
      : `FETCH FAILED (${sshErr(h, r)}); retry with {action:"fetch", host:"${h.name}", paths:[...]}`;
  }

  const finished = (s: JobStatus) => s.state === "exited" || s.state === "lost";

  function parseJob(
    job: string,
    reg: Registry,
  ): { host: HostEntry; hex: string } {
    const i = job.lastIndexOf(".");
    const name = job.slice(0, i);
    const hex = job.slice(i + 1);
    if (i < 1 || !HEX_RE.test(hex))
      throw new Error(`bad job id: ${job} (expected <host>.<hex>)`);
    const host = reg.hosts.find((h) => h.name === name);
    if (!host)
      throw new Error(
        `host ${name} of job ${job} is no longer in ${REGISTRY} (destroyed or removed); the job is gone`,
      );
    return { host, hex };
  }

  function startScript(
    h: HostEntry,
    hex: string,
    cmd: string,
    fetch: string[],
  ): string {
    const root = rootOf(h);
    return `set -eu
	R='${root}'; J="$R/.work/remote-jobs/${hex}"
	mkdir -p "$J" "$R/.work/tmp"
	printf %s '${b64(cmd)}' | base64 -d > "$J/cmd.sh"
	printf %s '${b64(fetch.join("\n"))}' | base64 -d > "$J/fetch"
	date +%s > "$J/start"
	n=$(nproc --all); C='${h.cpus ?? ""}'
	if [ -z "$C" ]; then C=0-$((n-1)); fi
	systemd-run --quiet --collect --unit="${unitPrefix()}-${hex}" -p Nice=10 -p AllowedCPUs="$C" --working-directory="$R" \\
			-E WORK="$R/.work" -E TMPDIR="$R/.work/tmp" ${jobEnv()} -E PATH='${PATH_ENV}' \\
			/bin/bash -c 'bash "$1/cmd.sh" > "$1/log" 2>&1; echo $? > "$1/rc.tmp"; mv "$1/rc.tmp" "$1/rc"' _ "$J"
	echo STARTED
	`;
  }

  function statusScript(h: HostEntry, hex: string, tail: number): string {
    return `J='${rootOf(h)}/.work/remote-jobs/${hex}'
	[ -d "$J" ] || { echo STATE=missing; exit 0; }
	now=$(date +%s); st=$(cat "$J/start" 2>/dev/null || echo "$now"); echo "ELAPSED=$((now-st))"
	if [ ! -f "$J/rc" ]; then
			a=$(systemctl is-active "${unitPrefix()}-${hex}" 2>/dev/null || true)
			case "$a" in active|activating|deactivating|reloading) echo STATE=running ;;
					*) if [ -f "$J/rc" ]; then :; else echo STATE=lost; echo "UNIT=$a"; fi ;; esac
	fi
	[ -f "$J/rc" ] && { echo STATE=exited; echo "RC=$(cat "$J/rc")"; }
	[ -s "$J/fetch" ] && echo "FETCH=$(base64 -w0 < "$J/fetch")"
	if [ ${tail} -gt 0 ]; then echo ---TAIL---; tail -n ${tail} "$J/log" 2>/dev/null | cut -c1-400; fi
	exit 0
	`;
  }

  interface JobStatus {
    state: "running" | "exited" | "lost" | "missing" | "unreachable";
    rc?: number;
    elapsed?: number;
    tail: string;
    error?: string;
    fetch?: string[];
  }

  async function jobStatus(
    h: HostEntry,
    hex: string,
    tail: number,
    signal?: AbortSignal,
  ): Promise<JobStatus> {
    const r = await onHost(h, statusScript(h, hex, tail), 30_000, signal);
    if (r.code !== 0)
      return { state: "unreachable", tail: "", error: sshErr(h, r) };
    const [head, ...rest] = r.stdout.split("---TAIL---\n");
    const kv = Object.fromEntries(
      head
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return {
      state: (kv.STATE as JobStatus["state"]) ?? "lost",
      rc: kv.RC !== undefined ? Number(kv.RC) : undefined,
      elapsed: kv.ELAPSED !== undefined ? Number(kv.ELAPSED) : undefined,
      tail: rest.join("---TAIL---\n"),
      fetch: kv.FETCH
        ? Buffer.from(kv.FETCH, "base64")
            .toString("utf8")
            .split("\n")
            .filter(Boolean)
        : undefined,
    };
  }

  async function waitJob(
    h: HostEntry,
    hex: string,
    waitS: number,
    signal?: AbortSignal,
    onTick?: (s: JobStatus) => void,
  ): Promise<JobStatus> {
    const deadline =
      Date.now() + Math.min(Math.max(waitS, 0), MAX_WAIT_S) * 1000;
    let delay = 1000;
    let misses = 0;
    for (;;) {
      const s = await jobStatus(h, hex, 0, signal);
      if (s.state === "unreachable") misses++;
      else misses = 0;
      const final =
        s.state === "exited" ||
        s.state === "lost" ||
        s.state === "missing" ||
        misses >= 3;
      if (final || Date.now() >= deadline || signal?.aborted) {
        const full = await jobStatus(h, hex, TAIL_LINES, signal);
        return full.state === "unreachable" ? s : full;
      }
      onTick?.(s);
      await sleep(Math.min(delay, Math.max(deadline - Date.now(), 0)), signal);
      delay = Math.min(delay * 1.5, 15_000);
    }
  }

  const fmtDur = (s?: number) =>
    s === undefined
      ? "?"
      : s < 90
        ? `${s}s`
        : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;

  function render(
    job: string,
    h: HostEntry,
    s: JobStatus,
    note?: string,
    fetched?: string,
  ): string {
    const lines: string[] = [];
    if (note) lines.push(note);
    const head = `job ${job} on ${h.name}: `;
    switch (s.state) {
      case "exited":
        lines.push(`${head}exited ${s.rc} after ${fmtDur(s.elapsed)}`);
        break;
      case "running":
        lines.push(
          `${head}still running after ${fmtDur(s.elapsed)} -> call remote({action:"wait", job:"${job}"})`,
        );
        break;
      case "lost":
        lines.push(
          `${head}LOST (unit ended without an exit code: host rebooted or unit killed) after ${fmtDur(s.elapsed)}; rerun it`,
        );
        break;
      case "missing":
        lines.push(
          `${head}MISSING (no job dir; host was replaced or cleaned); rerun it`,
        );
        break;
      case "unreachable":
        lines.push(
          `${head}host UNREACHABLE (${s.error}); if the host was destroyed, rerun the command (a new host is picked)`,
        );
        break;
    }
    if (fetched) lines.push(fetched);
    if (s.tail.trim())
      lines.push(
        `--- last ${TAIL_LINES} lines of ${rootOf(h)}/.work/remote-jobs/${job.split(".").pop()}/log ---`,
        s.tail.trimEnd(),
      );
    return clip(lines.join("\n"));
  }

  function clip(text: string): string {
    const t = truncateTail(text, { maxBytes: MAX_OUTPUT_BYTES, maxLines: 400 });
    return t.truncated
      ? `[output clipped to the last ${t.outputLines} lines; use action "log"]\n${t.content}`
      : t.content;
  }

  // ---------- tool ----------

  const DESCRIPTION = `Run commands on a host configured in this project's .pi/remote.json. Commands use the remote project root as cwd, WORK=<root>/.work and TMPDIR=$WORK/tmp. Local file tools stay local.
	run (default): {cmd, sync?, fetch?, host?, wait_s?}. Sync named project-relative paths before running; sync directories are mirrored with --delete. Configured code_sync paths are also copied. Fetch named paths back on completion. Jobs run as systemd units with no tool-imposed lifetime; a call waits up to 240 seconds by default, 290 max. Use wait with the returned job id to continue.
	wait: {job, wait_s?}; log: {job, lines?, grep?}; stop: {job} stops the unit, not Docker containers it started; fetch: {paths, host?}; hosts: show configured hosts and available resources.
	Auto-selects a reachable host and pins it per project and session; explicit host applies only to that call. If the pinned host disappears before a new job starts, another host is selected; rebuild artifacts there. A lost connection after submission is an unknown outcome: inspect the returned job before retrying. Requires Linux hosts with bash, Python, rsync and systemd. Unconfigured projects fail before contacting any host.`;

  const Params = Type.Object({
    action: Type.Optional(
      StringEnum(["run", "wait", "log", "stop", "fetch", "hosts"] as const, {
        description: "default run",
      }),
    ),
    cmd: Type.Optional(
      Type.String({
        description:
          "bash command executed in the configured remote project root",
      }),
    ),
    sync: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "project-relative paths to mirror to the host before run, e.g. src/component",
      }),
    ),
    host: Type.Optional(
      Type.String({
        description: "host name from the registry, or auto (default)",
      }),
    ),
    wait_s: Type.Optional(
      Type.Number({
        description: `seconds to wait (default ${DEFAULT_WAIT_S}, max ${MAX_WAIT_S})`,
      }),
    ),
    job: Type.Optional(
      Type.String({ description: "job id <host>.<hex> for wait/log/stop" }),
    ),
    lines: Type.Optional(
      Type.Number({
        description: "log: number of lines (default 200, max 2000)",
      }),
    ),
    grep: Type.Optional(
      Type.String({ description: "log: extended regex filter" }),
    ),
    fetch: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "run: project-relative paths copied back here when the job ends, e.g. .work/jobs/oracle-<slug>",
      }),
    ),
    paths: Type.Optional(
      Type.Array(Type.String(), {
        description: "action fetch: project-relative paths on the host",
      }),
    ),
  });

  const result = (text: string, details: Details, isError = false) => ({
    content: [{ type: "text" as const, text }],
    details: { ...details, project: ROOT },
    isError,
  });

  return {
    name: "remote",
    label: "Remote",
    description: DESCRIPTION,
    promptSnippet:
      "Run builds, gates and docker work on a build host; no hand-written ssh",
    parameters: Params,
    async execute(
      _id: string,
      params: Static<typeof Params>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<Details> | undefined,
      ctx: ExtensionToolContext,
    ) {
      const action = params.action ?? "run";
      const reg = loadRegistry();
      const key = sessionKey(ctx);

      if (action === "hosts") {
        const probes = await Promise.all(
          reg.hosts.map((h) => probe(h, signal)),
        );
        const pinned = pins.get(key) ?? pinnedFromBranch(ctx);
        const rows = probes.map((p) => {
          const flags = [
            p.host.local ? "local" : "",
            p.host.drain ? "DRAINED" : "",
            p.host.name === pinned ? "pinned here" : "",
          ]
            .filter(Boolean)
            .join(",");
          return p.ok
            ? `${p.host.name}: up  free ${p.avail_gb} GB (reserve ${p.host.reserve_gb ?? 0})  ${p.nproc} cores  ${p.jobs} jobs  disk ${p.disk_gb} GB free ${flags}`
            : `${p.host.name}: DOWN ${p.error} ${flags}`;
        });
        return result(rows.join("\n"), { action, pinned });
      }

      if (action === "run") {
        const cmd = params.cmd?.trim();
        if (!cmd) throw new Error("run needs cmd");
        const sync = (params.sync ?? []).map((p) => checkRel(p, true));
        const back = (params.fetch ?? []).map((p) => checkRel(p, false));
        let note: string | undefined;
        let h: HostEntry | undefined;
        const want =
          params.host && params.host !== "auto" ? params.host : undefined;
        const tried = new Set<string>();
        if (want) {
          h = reg.hosts.find((x) => x.name === want);
          if (!h)
            throw new Error(
              `host ${want} is not in ${REGISTRY}; hosts: ${reg.hosts.map((x) => x.name).join(", ")}`,
            );
        } else {
          const pinned = pins.get(key) ?? pinnedFromBranch(ctx);
          const ph = reg.hosts.find((x) => x.name === pinned);
          if (pinned && (!ph || ph.drain)) {
            note = `NOTE: pinned host ${pinned} is ${ph ? "drained" : "no longer in the registry"}; moved to another host. Images and files built there are not available: rebuild them.`;
            tried.add(pinned);
          } else if (ph) h = ph;
        }
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!h) h = (await pickHost(reg, tried, signal)).host;
          if (!want) pins.set(key, h.name);
          const pinned = want
            ? (pins.get(key) ?? pinnedFromBranch(ctx))
            : h.name;
          const err = await syncTo(h, reg, sync, signal);
          if (err && !want && CONN_ERR.test(err) && attempt < 2) {
            note = `NOTE: host ${h.name} is unreachable (${err}); moved to another host. Images and files built there are not available: rebuild them.`;
            tried.add(h.name);
            h = undefined;
            continue;
          }
          if (err)
            return result(
              `sync failed: ${err}`,
              { action, host: h.name, pinned },
              true,
            );
          const hex = randomBytes(5).toString("hex");
          const job = `${h.name}.${hex}`;
          const st = await onHost(
            h,
            startScript(h, hex, cmd, back),
            60_000,
            signal,
            false,
          );
          if (st.code !== 0 || !st.stdout.includes("STARTED")) {
            return result(
              `Submission outcome unknown for ${job}: ${sshErr(h, st)}. Inspect {action:"wait", job:"${job}"} before retrying; the remote job may be running.`,
              { action, host: h.name, job, pinned, state: "unknown" },
              true,
            );
          }
          const host = h;
          onUpdate?.({
            content: [
              { type: "text", text: `job ${job} started on ${host.name}` },
            ],
            details: { action, host: host.name, job, state: "running", pinned },
          });
          const s = await waitJob(
            host,
            hex,
            params.wait_s ?? DEFAULT_WAIT_S,
            signal,
            (x) =>
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `job ${job} on ${host.name}: running ${fmtDur(x.elapsed)}`,
                  },
                ],
                details: {
                  action,
                  host: host.name,
                  job,
                  state: x.state,
                  pinned,
                },
              }),
          );
          const got = finished(s) ? await fetchBack(host, s.fetch, signal) : "";
          return result(
            render(job, host, s, note, got),
            { action, host: host.name, job, state: s.state, rc: s.rc, pinned },
            s.state === "exited" ? s.rc !== 0 : s.state !== "running",
          );
        }
        throw new Error("no reachable host after 3 attempts");
      }

      if (action === "wait" || action === "stop" || action === "log") {
        if (!params.job) throw new Error(`${action} needs job`);
        const { host, hex } = parseJob(params.job, reg);
        const pinned = pins.get(key) ?? pinnedFromBranch(ctx);
        if (action === "wait") {
          const s = await waitJob(
            host,
            hex,
            params.wait_s ?? DEFAULT_WAIT_S,
            signal,
            (x) =>
              onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `job ${params.job}: running ${fmtDur(x.elapsed)}`,
                  },
                ],
                details: {
                  action,
                  host: host.name,
                  job: params.job,
                  state: x.state,
                  pinned,
                },
              }),
          );
          const got = finished(s) ? await fetchBack(host, s.fetch, signal) : "";
          return result(
            render(params.job, host, s, undefined, got),
            {
              action,
              host: host.name,
              job: params.job,
              state: s.state,
              rc: s.rc,
              pinned,
            },
            s.state === "exited" ? s.rc !== 0 : s.state !== "running",
          );
        }
        if (action === "stop") {
          const r = await onHost(
            host,
            `systemctl stop '${unitPrefix()}-${hex}' 2>&1 || true`,
            120_000,
            signal,
          );
          if (r.code !== 0)
            return result(
              `stop failed: ${sshErr(host, r)}`,
              { action, host: host.name, job: params.job, pinned },
              true,
            );
          const s = await jobStatus(host, hex, 20, signal);
          if (s.state === "lost") ((s.state = "exited"), (s.rc = s.rc ?? 143));
          return result(
            `${render(params.job, host, s)}\nStopped the unit. Containers the job started with docker run keep running: remove yours with docker rm -f <name>.`,
            {
              action,
              host: host.name,
              job: params.job,
              state: s.state,
              pinned,
            },
          );
        }
        const n = Math.min(Math.max(Math.floor(params.lines ?? 200), 1), 2000);
        const J = `${rootOf(host)}/.work/remote-jobs/${hex}`;
        const filter = params.grep
          ? `printf %s '${b64(params.grep)}' | base64 -d > "$J/.grep"; grep -n -E -f "$J/.grep" "$J/log"`
          : `cat "$J/log"`;
        const r = await onHost(
          host,
          `J='${J}'; [ -f "$J/log" ] || { echo "(no log at $J/log)"; exit 0; }\n{ ${filter}; } | tail -n ${n} | cut -c1-1000\necho "--- $(wc -l < "$J/log") lines total in $J/log"\n`,
          60_000,
          signal,
        );
        if (r.code !== 0)
          return result(
            `log failed: ${sshErr(host, r)}`,
            { action, host: host.name, job: params.job, pinned },
            true,
          );
        const t = truncateTail(r.stdout, {
          maxBytes: 48 * 1024,
          maxLines: 2000,
        });
        return result(
          t.truncated
            ? `[clipped to last ${t.outputLines} lines]\n${t.content}`
            : t.content,
          { action, host: host.name, job: params.job, pinned },
        );
      }

      if (action === "fetch") {
        const paths = (params.paths ?? []).map((p) => checkRel(p, false));
        if (!paths.length) throw new Error("fetch needs paths");
        const name =
          params.host && params.host !== "auto"
            ? params.host
            : (pins.get(key) ?? pinnedFromBranch(ctx));
        const h = reg.hosts.find((x) => x.name === name);
        if (!h)
          throw new Error(
            `no host to fetch from (pinned: ${name ?? "none"}); pass host`,
          );
        if (h.local)
          return result(
            `${h.name} is this machine; the paths are already local under ${ROOT}`,
            { action, host: h.name, pinned: name },
          );
        const root = rootOf(h);
        const r = await rsync(
          h,
          [
            "-aR",
            "--ignore-missing-args",
            ...paths.map((p) => `${h.name}:${root}/./${p}`),
            `${ROOT}/`,
          ],
          1_800_000,
          signal,
        );
        if (r.code !== 0)
          return result(
            `fetch failed: ${sshErr(h, r)}`,
            { action, host: h.name, pinned: name },
            true,
          );
        return result(
          `fetched from ${h.name}: ${paths.map((p) => `${ROOT}/${p}`).join(", ")}`,
          { action, host: h.name, pinned: name },
        );
      }

      throw new Error(`unknown action ${action}`);
    },
  };
}

export default function (pi: ExtensionAPI) {
  const projects = new Map<string, ReturnType<typeof createProject>>();
  const template = createProject("/project", "/project/.pi/remote.json");
  pi.registerTool({
    ...template,
    async execute(
      id: string,
      params: Static<typeof template.parameters>,
      signal: AbortSignal | undefined,
      update: AgentToolUpdateCallback<Details> | undefined,
      ctx: ExtensionToolContext,
    ) {
      if (!ctx.isProjectTrusted())
        throw new Error(
          "Trust this project before using its remote configuration.",
        );
      const { root, config } = projectConfig(ctx.cwd);
      let tool = projects.get(root);
      if (!tool) {
        tool = createProject(root, config);
        projects.set(root, tool);
      }
      return tool.execute(id, params, signal, update, ctx);
    },
  });
}

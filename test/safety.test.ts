import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { buildChildEnv } from "../src/omp/env";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import {
	ApprovalBroker,
	type ApprovalBrokerOptions,
	type ApprovalOutcome,
	type ApprovalStore,
	type ApprovalTimers,
	approvalActionId,
	parseApprovalActionId,
} from "../src/safety/approval";
import { buildHostTools, checkUploadable, type HostToolDef } from "../src/safety/host-tools";
import { buildFloorsPrompt, floorsArgs, floorsSystemPrompt } from "../src/safety/prompt";
import { FakeSlackTransport } from "../src/slack/fake-transport";
import { makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";

const CHANNEL = "D1";
const ORIGIN = `slack/dm/${CHANNEL}`;
const clock = { now: () => Date.now() };

/** Resolves `shown` once the approval buttons (non-empty blocks) have been attached to a message. */
class ButtonTransport extends FakeSlackTransport {
	shown = Promise.withResolvers<{ ts: string; blocks: readonly unknown[] }>();
	#armed = Promise.withResolvers<void>();

	override async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		await super.updateMessage(args);
		if (args.blocks && args.blocks.length > 0) this.shown.resolve({ ts: args.ts, blocks: args.blocks });
		else this.#armed.resolve();
	}

	/** Settles after the final (blocks removed) update of a request. */
	concluded(): Promise<void> {
		return this.#armed.promise;
	}
}

class ManualTimers implements ApprovalTimers {
	callbacks = new Map<number, () => void>();
	#next = 1;
	set(fn: () => void): unknown {
		const id = this.#next++;
		this.callbacks.set(id, fn);
		return id;
	}
	clear(handle: unknown): void {
		this.callbacks.delete(handle as number);
	}
	fireAll(): void {
		for (const fn of [...this.callbacks.values()]) fn();
	}
}

const quietLog = () => createLogger({ sink: () => undefined, clock, redact });

/** In-memory ApprovalStore with the same double-click and expiry semantics as the SQLite one. */
function memoryApprovalStore(): ApprovalStore {
	const rows = new Map<
		string,
		{
			status: "pending" | "approved" | "denied" | "expired" | "replied";
			channel: string;
			messageTs: string;
			expiresAt: number;
			originKey: string | null;
			replyTs: string | null;
		}
	>();
	return {
		createApproval: (input) => {
			rows.set(input.approvalId, {
				status: "pending",
				channel: input.channel,
				messageTs: input.messageTs,
				expiresAt: input.expiresAt,
				originKey: input.originKey ?? null,
				replyTs: null,
			});
		},
		getApproval: (id) => rows.get(id),
		replyApproval: (id, replyTs, _text, now) => {
			const row = rows.get(id);
			if (row === undefined || row.status !== "pending" || row.expiresAt <= now) return false;
			row.status = "replied";
			row.replyTs = replyTs;
			return true;
		},
		decideApproval: (id, status) => {
			const row = rows.get(id);
			if (row === undefined || row.status !== "pending") return false;
			row.status = status;
			return true;
		},
		expirePendingApprovals: (now, due = true) => {
			const expired: Array<{ approvalId: string; channel: string; messageTs: string }> = [];
			for (const [id, row] of rows) {
				if (row.status !== "pending") continue;
				if (due && row.expiresAt > now) continue;
				row.status = "expired";
				expired.push({ approvalId: id, channel: row.channel, messageTs: row.messageTs });
			}
			return expired;
		},
	};
}

function click(ts: string, decision: "approve" | "deny", user = OWNER) {
	return {
		user: { id: user },
		channel: { id: CHANNEL },
		message: { ts },
		actions: [{ action_id: approvalActionId(decision, CHANNEL, ts), value: decision }],
	};
}

describe("prompt and child environment", () => {
	test("--append-system-prompt carries the floors and names this bot home's secrets directory", () => {
		const args = floorsArgs("/bot/home/secrets");
		expect(args[0]).toBe("--append-system-prompt");
		expect(args[1]).toBe(buildFloorsPrompt("/bot/home/secrets"));
		expect(args[1]).toContain("/bot/home/secrets");
		expect(args[1]).toContain("ompbot_request_approval");
		expect(args[1]).toContain("slack_send_file");
	});

	test("the child env loses SLACK_*/OMPBOT_* keys and refuses them as extras", () => {
		const env = buildChildEnv(
			{ OMP_WIKI_NOTE_DISABLE: "1" },
			{ PATH: "/bin", SLACK_BOT_TOKEN: "xoxb-TEST-0", OMPBOT_HOME: "/h", KEEP: "yes" },
		);
		expect(env).toEqual({ PATH: "/bin", KEEP: "yes", OMP_WIKI_NOTE_DISABLE: "1" });
		expect(() => buildChildEnv({ SLACK_APP_TOKEN: "x" }, {})).toThrow();
	});
});

describe("floors prompt answer format", () => {
	test("Slack chat origins get the answer-format section; only the owner DM gets the monitor tools; others get neither", () => {
		for (const originKey of ["slack/dm/D1", "slack/ch/C1", "slack/ch/C1/t/100.1"] as const) {
			const prompt = buildFloorsPrompt("/bot/home/secrets", originKey);
			expect(prompt).toContain("## 답변 형식 / Answer format");
			expect(prompt.includes("ompbot_monitor_add")).toBe(originKey === "slack/dm/D1");
		}
		for (const originKey of ["monitor/3", "ompbot/work/lane1", "review/skills", undefined] as const) {
			const prompt = buildFloorsPrompt("/bot/home/secrets", originKey);
			expect(prompt).not.toContain("답변 형식");
			expect(prompt).not.toContain("ompbot_monitor_add");
		}
	});

	test("herdr off: no chat prompt mentions herdr; herdr on: byte-identical to base 1ad1bbc", () => {
		const base = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "herdr-on-base.json"), "utf8")) as {
			prompts: Record<string, string>;
		};
		const origins = Object.keys(base.prompts);
		expect(origins.length).toBe(3);
		for (const originKey of origins) {
			expect(buildFloorsPrompt("/h/secrets", originKey)).not.toContain("herdr");
			expect(floorsSystemPrompt("/h/secrets", originKey)).not.toContain("herdr");
			expect(floorsArgs("/h/secrets", originKey)[1]).not.toContain("herdr");
			expect(buildFloorsPrompt("/h/secrets", originKey, true)).toBe(base.prompts[originKey] as string);
			expect(floorsSystemPrompt("/h/secrets", originKey, undefined, undefined, true)).toBe(
				base.prompts[originKey] as string,
			);
			expect(floorsArgs("/h/secrets", originKey, undefined, undefined, true)[1]).toBe(
				base.prompts[originKey] as string,
			);
		}
	});

	test("the send-file guidance names the conversation thread and the mermaid/SVG/HTML push for every origin", () => {
		for (const originKey of [undefined, "slack/dm/D1", "monitor/3"] as const) {
			const prompt = buildFloorsPrompt("/s", originKey);
			expect(prompt).toContain("지금 대화 스레드로 업로드");
			expect(prompt).toContain("mermaid·SVG·HTML");
		}
	});
});

describe("approval action ids", () => {
	test("round trip, and malformed ids are rejected", () => {
		const id = approvalActionId("approve", "D0ABC123", "1800000000.000007");
		expect(id).toBe("ompbot:approval:approve:D0ABC123:1800000000.000007");
		expect(parseApprovalActionId(id)).toEqual({ decision: "approve", channel: "D0ABC123", ts: "1800000000.000007" });
		expect(parseApprovalActionId(approvalActionId("deny", "C1", "1.2"))?.decision).toBe("deny");
		for (const bad of [
			"ompbot:approval:maybe:D1:1.2",
			"ompbot:approval:approve:D1",
			"ompbot:approval:approve:D1:1.2:extra",
			"other:approval:approve:D1:1.2",
			"ompbot:approval:approve::1.2",
			"",
		]) {
			expect(parseApprovalActionId(bad)).toBeUndefined();
		}
	});
});

describe("ApprovalBroker", () => {
	let transport: ButtonTransport;
	let timers: ManualTimers;
	let broker: ApprovalBroker;

	const make = (extra: Partial<ApprovalBrokerOptions> = {}) =>
		new ApprovalBroker({
			transport,
			ownerUserId: OWNER,
			log: quietLog(),
			timers,
			store: memoryApprovalStore(),
			...extra,
		});

	beforeEach(() => {
		transport = new ButtonTransport();
		timers = new ManualTimers();
		broker = make();
	});

	test("buttons carry the ompbot action ids of the request message; the owner's approve resolves it", async () => {
		const result = broker.request(CHANNEL, "git push --force");
		const { ts, blocks } = await transport.shown.promise;
		const ids = JSON.stringify(blocks);
		expect(ids).toContain(approvalActionId("approve", CHANNEL, ts));
		expect(ids).toContain(approvalActionId("deny", CHANNEL, ts));
		expect(broker.handleAction({ actionId: approvalActionId("approve", CHANNEL, ts), userId: OWNER })).toBe(true);
		expect(await result).toBe("approved");
		// The decision removes the buttons.
		const last = transport.calls.filter((c) => c.method === "updateMessage").at(-1);
		expect(last).toMatchObject({ ts, blocks: [] });
		expect(broker.pendingCount).toBe(0);
	});

	test("deny resolves as denied", async () => {
		const result = broker.request(CHANNEL, "rm -rf build");
		const { ts } = await transport.shown.promise;
		broker.handleAction({ actionId: approvalActionId("deny", CHANNEL, ts), userId: OWNER });
		expect(await result).toBe("denied");
	});

	test("a click by a non-owner is ignored and the request stays pending until the owner clicks", async () => {
		const result = broker.request(CHANNEL, "deploy");
		const { ts } = await transport.shown.promise;
		expect(broker.handleAction({ actionId: approvalActionId("approve", CHANNEL, ts), userId: "UOTHER" })).toBe(false);
		expect(broker.pendingCount).toBe(1);
		broker.handleAction({ actionId: approvalActionId("deny", CHANNEL, ts), userId: OWNER });
		expect(await result).toBe("denied");
	});

	test("clicks for another message, a repeated click and foreign action ids do nothing", async () => {
		const result = broker.request(CHANNEL, "x");
		const { ts } = await transport.shown.promise;
		expect(broker.handleAction({ actionId: approvalActionId("approve", CHANNEL, "9.9"), userId: OWNER })).toBe(false);
		expect(broker.handleAction({ actionId: "something:else", userId: OWNER })).toBe(false);
		expect(broker.pendingCount).toBe(1);
		expect(broker.handleAction({ actionId: approvalActionId("approve", CHANNEL, ts), userId: OWNER })).toBe(true);
		await result;
		expect(broker.handleAction({ actionId: approvalActionId("approve", CHANNEL, ts), userId: OWNER })).toBe(false);
	});

	test("no click before the timeout resolves as timeout (denied) and clears the buttons", async () => {
		const result: Promise<ApprovalOutcome> = broker.request(CHANNEL, "slow");
		await transport.shown.promise;
		timers.fireAll();

		expect(await result).toBe("timeout");
		const last = transport.calls.filter((c) => c.method === "updateMessage").at(-1);
		expect(last).toMatchObject({ blocks: [] });
		expect(timers.callbacks.size).toBe(0);
	});

	test("an aborted tool call counts as denied", async () => {
		const abort = new AbortController();
		const result = broker.request(CHANNEL, "cancelled", abort.signal);
		await transport.shown.promise;
		abort.abort();
		expect(await result).toBe("denied");
	});

	test("a failure to attach the buttons is denied, never approved", async () => {
		transport.failNext.updateMessage = [new Error("boom")];
		expect(await broker.request(CHANNEL, "x")).toBe("denied");
	});

	test("token-like text in the summary is masked before it is posted", async () => {
		const result = broker.request(CHANNEL, "use xoxb-TEST-SECRET-0 to push");
		await transport.shown.promise;
		expect(JSON.stringify(transport.calls)).not.toContain("xoxb-TEST-SECRET-0");
		timers.fireAll();
		await result;
	});

	test("a summary-only request (the skill-review path) renders exactly the header and the summary", async () => {
		const result = broker.request(CHANNEL, "📝 스킬 제안 1건 — 승인하면 lint-fix를 설치합니다.");
		await transport.shown.promise;
		expect(transport.calls.find((c) => c.method === "postMessage")).toMatchObject({
			text: "🔐 승인 요청\n📝 스킬 제안 1건 — 승인하면 lint-fix를 설치합니다.",
		});
		timers.fireAll();
		await result;
	});

	test("structured detail renders labeled sections in order; empty sections and tokens are handled", async () => {
		const result = broker.request(CHANNEL, "main 브랜치 강제 푸시", undefined, {
			action: "git push --force origin main",
			why: "rebase 이력 정리",
			impact: "토큰 xoxb-TEST-SECRET-0 노출 위험과 원격 커밋 3개 손실",
			rollback: "force push는 원격 히스토리를 덮어써 되돌릴 수 없음",
		});
		await transport.shown.promise;
		expect(transport.calls.find((c) => c.method === "postMessage")?.text).toBe(
			[
				"🔐 승인 요청",
				"main 브랜치 강제 푸시",
				"• 할 일: git push --force origin main",
				"• 이유: rebase 이력 정리",
				`• 영향: 토큰 ${redact("xoxb-TEST-SECRET-0")} 노출 위험과 원격 커밋 3개 손실`,
				"• 되돌릴 수 없는 이유: force push는 원격 히스토리를 덮어써 되돌릴 수 없음",
			].join("\n"),
		);
		expect(JSON.stringify(transport.calls)).not.toContain("xoxb-TEST-SECRET-0");
		timers.fireAll();
		await result;
	});

	test("blank detail sections are omitted, so an all-empty detail equals a summary-only card", async () => {
		const result = broker.request(CHANNEL, "요약만 있는 요청", undefined, { action: "   ", impact: "" });
		await transport.shown.promise;
		expect(transport.calls.filter((c) => c.method === "postMessage").at(-1)?.text).toBe(
			"🔐 승인 요청\n요약만 있는 요청",
		);
		timers.fireAll();
		await result;
	});
});

describe("host tools", () => {
	let dir: string;
	let userHome: string;
	let homeDir: string;
	let workspaceDir: string;
	let transport: ButtonTransport;
	let timers: ManualTimers;
	let tools: HostToolDef[];

	const tool = (name: string): HostToolDef => {
		const found = tools.find((t) => t.name === name);
		if (!found) throw new Error(`no tool ${name}`);
		return found;
	};
	const ctx = { signal: new AbortController().signal };

	function build(originKey = ORIGIN, extra: Partial<Parameters<typeof buildHostTools>[0]> = {}): HostToolDef[] {
		return buildHostTools({
			originKey,
			transport,
			broker: new ApprovalBroker({
				transport,
				ownerUserId: OWNER,
				log: quietLog(),
				timers,
				store: memoryApprovalStore(),
			}),
			ompExecutable: "/omp",
			log: quietLog(),
			homeDir,
			workspaceDir,
			userHome,
			...extra,
		});
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-safety-"));
		userHome = join(dir, "user");
		homeDir = join(userHome, ".ompbot");
		workspaceDir = join(homeDir, "workspace");
		mkdirSync(join(homeDir, "secrets"), { recursive: true });
		mkdirSync(workspaceDir, { recursive: true });
		writeFileSync(join(homeDir, "secrets", "slack-bot-token"), "xoxb-TEST-SECRET-0\n");
		transport = new ButtonTransport();
		timers = new ManualTimers();
		tools = build();
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("host tools are registered with object schemas (dispatch, upload, approval)", () => {
		expect(tools.map((t) => t.name)).toEqual(["ompbot_dispatch", "slack_send_file", "ompbot_request_approval"]);
		for (const t of tools) expect(t.parameters.type).toBe("object");
	});

	test("slack_send_file uploads to the origin DM channel (main view, no thread)", async () => {
		const report = join(workspaceDir, "report.txt");
		writeFileSync(report, "all green\n");
		const text = await tool("slack_send_file").execute({ path: report, title: "Report" }, ctx);
		expect(text).toContain("report.txt");
		const uploads = transport.calls.filter((c) => c.method === "uploadFile");
		expect(uploads).toMatchObject([{ channel: CHANNEL, filePath: report, title: "Report" }]);
		expect("threadTs" in (uploads[0] ?? {})).toBe(false);
	});

	test("slack_send_file lands in the thread the host resolves, per execute call", async () => {
		const report = join(workspaceDir, "flow.html");
		writeFileSync(report, "<html>flow</html>\n");
		let current: string | undefined = "1700.000001";
		tools = build(ORIGIN, { threadTs: () => current });
		const text = await tool("slack_send_file").execute({ path: report }, ctx);
		expect(text).toContain("conversation thread");
		expect(transport.calls.find((c) => c.method === "uploadFile")).toMatchObject({
			channel: CHANNEL,
			threadTs: "1700.000001",
			filePath: report,
		});
		// The thread follows the origin's current conversation, resolved when the tool runs.
		current = "1700.000002";
		await tool("slack_send_file").execute({ path: report }, ctx);
		expect(transport.calls.filter((c) => c.method === "uploadFile").at(-1)).toMatchObject({
			threadTs: "1700.000002",
		});
		// An unresolvable thread falls back to the main view.
		current = undefined;
		await tool("slack_send_file").execute({ path: report }, ctx);
		expect("threadTs" in (transport.calls.filter((c) => c.method === "uploadFile").at(-1) ?? {})).toBe(false);
	});

	test("ompbot_dispatch is registered for chat origins only (lanes and monitors never get it)", () => {
		const chat = build().find((tool) => tool.name === "ompbot_dispatch");
		expect(chat).toBeDefined();
		expect(chat?.parameters).toMatchObject({ additionalProperties: false });
		const lane = build("ompbot/work/readme-line").find((tool) => tool.name === "ompbot_dispatch");
		const monitor = build("monitor/m1").find((tool) => tool.name === "ompbot_dispatch");
		expect(lane).toBeUndefined();
		expect(monitor).toBeUndefined();
		// No ompExecutable → not registered (defensive: daemon always passes one for chat origins).
		const withoutOmp = build(ORIGIN, { ompExecutable: undefined });
		expect(withoutOmp.find((tool) => tool.name === "ompbot_dispatch")).toBeUndefined();
		// A thread session is a chat surface too: dispatch registers and the parent channel resolves.
		const thread = build("slack/ch/C123/t/1800000000.000100").find((tool) => tool.name === "ompbot_dispatch");
		expect(thread).toBeDefined();
	});

	test("a relative path resolves against the workspace", async () => {
		writeFileSync(join(workspaceDir, "rel.txt"), "x");
		await tool("slack_send_file").execute({ path: "rel.txt" }, ctx);
		expect(transport.calls.find((c) => c.method === "uploadFile")).toMatchObject({
			filePath: join(workspaceDir, "rel.txt"),
		});
	});

	test("secrets, links into secrets, token-bearing files, directories and missing files are refused with no upload", async () => {
		const secret = join(homeDir, "secrets", "slack-bot-token");
		symlinkSync(secret, join(workspaceDir, "innocent.txt"));
		writeFileSync(join(workspaceDir, "notes.txt"), "token is xoxb-TEST-SECRET-0\n");
		for (const path of [
			secret,
			join(workspaceDir, "innocent.txt"),
			join(workspaceDir, "notes.txt"),
			workspaceDir,
			join(workspaceDir, "missing.txt"),
		]) {
			await expect(tool("slack_send_file").execute({ path }, ctx)).rejects.toThrow();
		}
		await expect(tool("slack_send_file").execute({}, ctx)).rejects.toThrow();
		expect(transport.count("uploadFile")).toBe(0);
	});

	test("checkUploadable also protects ~/.ssh under the user's home", () => {
		mkdirSync(join(userHome, ".ssh"), { recursive: true });
		writeFileSync(join(userHome, ".ssh", "id_ed25519"), "key");
		expect(() => checkUploadable(join(userHome, ".ssh", "id_ed25519"), { homeDir, workspaceDir, userHome })).toThrow();
	});

	test("checkUploadable protects the hub, git credentials, netrc and gh config, and token-shaped GitHub content", () => {
		const deps = { homeDir, workspaceDir, userHome };
		const files = [
			join(userHome, ".gajaeway-hub", "state.json"),
			join(userHome, ".git-credentials"),
			join(userHome, ".netrc"),
			join(userHome, ".config", "gh", "hosts.yml"),
		];
		for (const file of files) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "harmless\n");
			expect(() => checkUploadable(file, deps)).toThrow(/protected directory/);
		}
		writeFileSync(join(workspaceDir, "gh.txt"), `token ghp_${"A".repeat(36)}\n`);
		expect(() => checkUploadable(join(workspaceDir, "gh.txt"), deps)).toThrow(/token-like secret/);
	});

	test("upload tools need an owner DM origin", async () => {
		tools = build("slack/channel/C1");
		writeFileSync(join(workspaceDir, "a.txt"), "x");
		await expect(tool("slack_send_file").execute({ path: "a.txt" }, ctx)).rejects.toThrow();
		await expect(tool("ompbot_request_approval").execute({ summary: "s" }, ctx)).rejects.toThrow();
	});

	test("ompbot_request_approval returns approved / denied / denied (timeout) from the buttons", async () => {
		const broker = new ApprovalBroker({
			transport,
			ownerUserId: OWNER,
			log: quietLog(),
			timers,
			store: memoryApprovalStore(),
		});
		tools = buildHostTools({
			originKey: ORIGIN,
			transport,
			broker,
			log: quietLog(),
			homeDir,
			workspaceDir,
			userHome,
		});
		const approval = tool("ompbot_request_approval").execute({ summary: "drop table" }, ctx);
		const { ts } = await transport.shown.promise;
		broker.handleAction({ actionId: approvalActionId("approve", CHANNEL, ts), userId: OWNER });
		expect(await approval).toBe("approved");

		transport.shown = Promise.withResolvers();
		const timedOut = tool("ompbot_request_approval").execute({ summary: "again" }, ctx);
		await transport.shown.promise;
		timers.fireAll();
		expect(await timedOut).toBe("denied (timeout)");
	});

	test("ompbot_request_approval forwards the optional sections; unfilled ones never appear", async () => {
		const broker = new ApprovalBroker({
			transport,
			ownerUserId: OWNER,
			log: quietLog(),
			timers,
			store: memoryApprovalStore(),
		});
		tools = buildHostTools({
			originKey: ORIGIN,
			transport,
			broker,
			log: quietLog(),
			homeDir,
			workspaceDir,
			userHome,
		});
		const approval = tool("ompbot_request_approval").execute(
			{
				summary: "배포 스크립트 실행",
				action: "bash deploy.sh --prod",
				why: "버전 1.2.3 출시",
				impact: "",
			},
			ctx,
		);
		await transport.shown.promise;
		const text = transport.calls.find((c) => c.method === "postMessage")?.text ?? "";
		expect(text).toContain("🔐 승인 요청\n배포 스크립트 실행");
		expect(text).toContain("• 할 일: bash deploy.sh --prod");
		expect(text).toContain("• 이유: 버전 1.2.3 출시");
		expect(text).not.toContain("• 영향");
		expect(text).not.toContain("되돌릴 수 없는 이유");
		timers.fireAll();
		expect(await approval).toBe("denied (timeout)");
	});
});

describe("approval through the daemon (adapter owner gate, logs)", () => {
	let home: TestHome;
	let daemon: Daemon | undefined;
	let logs: string[];

	beforeEach(() => {
		home = makeHome("ompbot-safety-daemon-");
		logs = [];
		daemon = undefined;
	});
	afterEach(async () => {
		await daemon?.stop();
		home.remove();
	});

	test("a non-owner click does nothing; the owner's click resolves the tool and logs approval_click", async () => {
		const transport = new ButtonTransport();
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: home.config,
			transport,
			log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		const approval = daemon
			.hostToolsFor(ORIGIN)
			.find((t) => t.name === "ompbot_request_approval")
			?.execute({ summary: "force push" }, { signal: new AbortController().signal });
		if (!approval) throw new Error("tool missing");
		const { ts } = await transport.shown.promise;

		await transport.emitBlockAction(click(ts, "approve", "UOTHER"));
		expect(await Promise.race([approval, Promise.resolve("still pending")])).toBe("still pending");
		expect(logs.some((line) => line.includes("event=approval_click "))).toBe(false);

		await transport.emitBlockAction(click(ts, "approve"));
		expect(await approval).toBe("approved");
		expect(
			logs.some(
				(line) =>
					line.includes("event=approval_click") && line.includes(`user=${OWNER}`) && line.includes("action=approve"),
			),
		).toBe(true);
		await transport.concluded();
	});
});

describe("file upload thread routing (daemon)", () => {
	let home: TestHome;
	let daemon: Daemon | undefined;

	beforeEach(() => {
		home = makeHome("ompbot-upload-thread-");
		daemon = undefined;
	});
	afterEach(async () => {
		await daemon?.stop();
		home.remove();
	});

	test("a DM upload lands in the origin's newest inbound thread; a lane's upload in the lane thread", async () => {
		const transport = new FakeSlackTransport();
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: home.config,
			transport,
			log: quietLog(),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
		await transport.emitMessage({
			type: "message",
			channel: CHANNEL,
			channel_type: "im",
			user: OWNER,
			text: "흐름 다이어그램 그려줘",
			ts: "1700.000001",
		});
		const file = join(home.config.workspaceDir, "flow.html");
		writeFileSync(file, "<html>flow</html>\n");
		const ctx = { signal: new AbortController().signal };
		const send = daemon.hostToolsFor(ORIGIN).find((t) => t.name === "slack_send_file");
		if (!send) throw new Error("tool missing");
		await send.execute({ path: file }, ctx);
		expect(transport.calls.filter((c) => c.method === "uploadFile").at(-1)).toMatchObject({
			channel: CHANNEL,
			threadTs: "1700.000001",
			filePath: file,
		});

		daemon.store.insertLane({
			name: "l1",
			title: "레인",
			threadRef: `${CHANNEL}:1700.000009`,
			originKey: "ompbot/work/l1",
			cwd: home.config.workspaceDir,
			sessionDir: join(home.config.homeDir, "sessions", "l1"),
			meta: { startedAt: 0, lastProgressAt: 0, steerSeq: 0 },
		});
		const laneSend = daemon.hostToolsFor("ompbot/work/l1").find((t) => t.name === "slack_send_file");
		if (!laneSend) throw new Error("lane tool missing");
		await laneSend.execute({ path: file }, ctx);
		expect(transport.calls.filter((c) => c.method === "uploadFile").at(-1)).toMatchObject({
			channel: CHANNEL,
			threadTs: "1700.000009",
		});
	});

	test("while a turn runs, an upload lands in the turn's thread even after a newer inbound in another thread", async () => {
		const transport = new WaitingTransport();
		const sessions = new FakeSessionStore();
		const drivers: FakeOmpDriver[] = [];
		daemon = new Daemon({
			config: home.config,
			transport,
			log: quietLog(),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => {
				const driver = new FakeOmpDriver({ sessionDir, store: sessions, holdTurns: true });
				drivers.push(driver);
				return driver;
			},
		});
		await daemon.start();
		const running = await daemon.inject({ origin: ORIGIN, asOwner: true, text: "long task" });
		await transport.waitForPosts((text) => text.startsWith("⏳"), 1);
		// A plain message while the turn runs is steered into it but keeps its own (newer) inbound thread, so
		// "newest inbound" and "the running turn's thread" diverge exactly here.
		const steered = await daemon.inject({ origin: ORIGIN, asOwner: true, text: "meanwhile" });
		await transport.waitForPosts((text) => text.startsWith("⏳"), 2);
		expect(steered.threadRef).not.toBe(running.threadRef);

		const file = join(home.config.workspaceDir, "diagram.svg");
		writeFileSync(file, "<svg>flow</svg>\n");
		const send = daemon.hostToolsFor(ORIGIN).find((t) => t.name === "slack_send_file");
		if (!send) throw new Error("tool missing");
		await send.execute({ path: file }, { signal: new AbortController().signal });
		expect(transport.calls.filter((c) => c.method === "uploadFile").at(-1)).toMatchObject({
			channel: CHANNEL,
			threadTs: running.threadRef.split(":")[1],
		});

		drivers[0]?.release();
		await transport.waitForPosts((text) => text.startsWith("ECHO"));
	});
});

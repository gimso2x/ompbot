import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	copyFileSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { monitorOrigin } from "../src/monitors/ledger";
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
import {
	buildHostTools,
	checkUploadable,
	type HostToolDef,
	UPLOAD_SCAN_CARRY_CHARS,
	UPLOAD_SCAN_CHUNK_BYTES,
} from "../src/safety/host-tools";
import {
	backgroundResumeLine,
	buildFloorsPrompt,
	floorsSystemPrompt,
	OMPBOT_BUN,
	OMPBOT_MAIN,
	ompbotCli,
	WAIT_INTERIM_LINE,
} from "../src/safety/prompt";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { hasButtons, makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";
import { FakeSlackTransport } from "./helpers/slack-fake-transport";

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
		if (args.blocks !== undefined && hasButtons(args.blocks)) this.shown.resolve({ ts: args.ts, blocks: args.blocks });
		else this.#armed.resolve();
	}

	/** Settles after the final (buttons removed) update of a request. */
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
			summary: string;
			originThreadRef: string | null;
			mirrorRef: string | null;
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
				summary: input.summary,
				originThreadRef: input.originThreadRef ?? null,
				mirrorRef: null,
			});
		},
		getApproval: (id) => rows.get(id),
		setApprovalMirrorRef: (id, mirrorRef) => {
			const row = rows.get(id);
			if (row?.status !== "pending") return false;
			row.mirrorRef = mirrorRef;
			return true;
		},
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
			const expired: ReturnType<ApprovalStore["expirePendingApprovals"]> = [];
			for (const [id, row] of rows) {
				if (row.status !== "pending") continue;
				if (due && row.expiresAt > now) continue;
				row.status = "expired";
				expired.push({
					approvalId: id,
					channel: row.channel,
					messageTs: row.messageTs,
					summary: row.summary,
					originThreadRef: row.originThreadRef,
					mirrorRef: row.mirrorRef,
				});
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

/** The owner's zone: the base-commit prompt fixtures were taken with it. */
const SEOUL = { timezone: { name: "Asia/Seoul", offset: "+09:00" } };

describe("prompt and child environment", () => {
	test("the appended system prompt carries the floors and names this bot home's secrets directory", () => {
		const prompt = floorsSystemPrompt("/bot/home/secrets");
		expect(prompt).toBe(buildFloorsPrompt("/bot/home/secrets"));
		expect(prompt).toContain("/bot/home/secrets");
		expect(prompt).toContain("ompbot_request_approval");
		expect(prompt).toContain("slack_send_file");
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

	test("the thread lookup line names this home's ledger, not ~/.ompbot/ompbot.db", () => {
		for (const originKey of ["slack/dm/D1", "discord/dm/123456789012345678"]) {
			const prompt = buildFloorsPrompt("/home/u/.ompbot-songbak/secrets", originKey);
			expect(prompt).toContain("`/home/u/.ompbot-songbak/ompbot.db`");
			expect(prompt).not.toContain("~/.ompbot/ompbot.db");
		}
	});

	test("chat sessions are told a note next to `wait` reaches the owner right away; monitor sessions are not", () => {
		for (const originKey of ["slack/dm/D1", "slack/ch/C1", "slack/ch/C1/t/100.1"]) {
			expect(buildFloorsPrompt("/s", originKey)).toContain(WAIT_INTERIM_LINE);
		}
		for (const originKey of ["monitor/3", monitorOrigin("mabc12345")]) {
			expect(buildFloorsPrompt("/s", originKey)).not.toContain(WAIT_INTERIM_LINE);
			expect(floorsSystemPrompt("/s", originKey)).not.toContain(WAIT_INTERIM_LINE);
		}
	});

	test("Slack and Discord chat sessions are told to run long jobs detached and resume through an inject into this conversation", () => {
		const cases = [
			["slack/ch/C1/t/100.1", "--origin slack/ch/C1 --thread 100.1 --as-owner"],
			["slack/dm/D1", "--origin slack/dm/D1 --as-owner"],
			["slack/dm/D1/t/200.2", "--origin slack/dm/D1 --thread 200.2 --as-owner"],
			["discord/ch/1/t/2", "--origin discord/ch/1 --thread 2 --as-owner"],
			["discord/dm/3", "--origin discord/dm/3 --as-owner"],
		] as const;
		for (const [originKey, target] of cases) {
			const line = backgroundResumeLine(originKey, {});
			expect(line).toContain(`\`${OMPBOT_BUN} ${OMPBOT_MAIN} inject ${target} --text '[자동 후속]`);
			expect(buildFloorsPrompt("/s", originKey)).toContain(backgroundResumeLine(originKey) as string);
			// A second install (OMPBOT_HOME set) names its own home, else the inject reaches the default ~/.ompbot socket.
			expect(backgroundResumeLine(originKey, { OMPBOT_HOME: "/h/.ompbot-x" })).toContain(
				`\`env OMPBOT_HOME=/h/.ompbot-x ${OMPBOT_BUN} ${OMPBOT_MAIN} inject ${target} --text '[자동 후속]`,
			);
		}
		expect(ompbotCli({ OMPBOT_HOME: "" })).toBe(`${OMPBOT_BUN} ${OMPBOT_MAIN}`);
		expect(ompbotCli({ OMPBOT_HOME: "/h/a b" })).toBe(`env 'OMPBOT_HOME=/h/a b' ${OMPBOT_BUN} ${OMPBOT_MAIN}`);
		expect(OMPBOT_MAIN).toBe(join(import.meta.dir, "..", "src", "main.ts"));
		// A detached systemd unit has no ~/.bun/bin on PATH: the line names this bun by absolute path (11-11 exit 127).
		expect(OMPBOT_BUN).toBe(process.execPath);
		expect(isAbsolute(OMPBOT_BUN)).toBe(true);
		// `inject` addresses Slack and Discord conversations only: no line where it could not reach (monitors, lanes).
		for (const originKey of ["telegram/dm/1", "monitor/3", "ompbot/work/lane1", "slack/thread/C1:1.2"]) {
			expect(backgroundResumeLine(originKey)).toBeUndefined();
			expect(buildFloorsPrompt("/s", originKey)).not.toContain("[자동 후속]");
		}
	});

	test("herdr off: no chat prompt mentions herdr; herdr on: byte-identical to base 1ad1bbc", () => {
		const base = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "herdr-on-base.json"), "utf8")) as {
			prompts: Record<string, string>;
		};
		// The fixture keeps the checkout-dependent CLI path and the home-dependent ledger path as placeholders.
		const fixed = (prompt: string): string =>
			prompt.replaceAll(ompbotCli(), "<bun> <ompbot>/src/main.ts").replaceAll("`/h/ompbot.db`", "`<home>/ompbot.db`");
		const origins = Object.keys(base.prompts);
		expect(origins.length).toBe(3);
		for (const originKey of origins) {
			expect(buildFloorsPrompt("/h/secrets", originKey)).not.toContain("herdr");
			expect(floorsSystemPrompt("/h/secrets", originKey)).not.toContain("herdr");
			// The owner's `timezone: "Asia/Seoul"` gives the base commit's text byte for byte.
			expect(fixed(buildFloorsPrompt("/h/secrets", originKey, true, false, false, SEOUL))).toBe(
				base.prompts[originKey] as string,
			);
			expect(fixed(floorsSystemPrompt("/h/secrets", originKey, undefined, undefined, true, false, false, SEOUL))).toBe(
				base.prompts[originKey] as string,
			);
		}
	});

	test("`ask` is allowed only for chat and lane sessions whose dialogs the owner answers; forbidden elsewhere", () => {
		const ALLOWED = "may use the `ask` tool";
		const FORBIDDEN = "never use the `ask` tool";
		for (const originKey of ["slack/dm/D1", "slack/ch/C1", "slack/ch/C1/t/100.1", "ompbot/work/lane1"]) {
			const prompt = buildFloorsPrompt("/s", originKey, false, true);
			expect(prompt).toContain(ALLOWED);
			expect(prompt).toContain("추천 선택지(없으면 첫 선택지)가 자동 선택");
			expect(prompt).not.toContain(FORBIDDEN);
			// The daemon's omp child of the same origin, with an answerer (run.ts passes `answerDialogsFor(origin)`).
			expect(floorsSystemPrompt("/s", originKey, undefined, undefined, false, true)).toContain(ALLOWED);
		}
		for (const originKey of ["monitor/3", "review/skills", undefined]) {
			const prompt = buildFloorsPrompt("/s", originKey, false, true);
			expect(prompt).toContain(FORBIDDEN);
			expect(prompt).not.toContain(ALLOWED);
		}
		// The claude driver (run.ts: `floorsSystemPrompt` without an answerer) gets the ban even for a chat origin.
		const claude = floorsSystemPrompt("/s", "slack/dm/D1", undefined, () => undefined, true);
		expect(claude).toContain(FORBIDDEN);
		expect(claude).not.toContain(ALLOWED);
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
			timezone: "Asia/Seoul",
			channels: registryOf(new SlackChannel(transport)),
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
		expect(last).toMatchObject({ ts });
		expect(last?.method === "updateMessage" && last.blocks !== undefined && !hasButtons(last.blocks)).toBe(true);
		expect(broker.pendingCount).toBe(0);
	});

	test("the card: header, summary, sections as fields and the buttons; after approval header and fields stay with a result line", async () => {
		const result = broker.ask(CHANNEL, "배포를 진행할까요?", {
			detail: { action: "git push origin main", why: "릴리스", impact: "운영 반영" },
		});
		const { ts, blocks } = await transport.shown.promise;
		const header = { type: "header", text: { type: "plain_text", text: "🔐 승인 요청", emoji: true } };
		const summary = { type: "section", text: { type: "mrkdwn", text: "배포를 진행할까요?" } };
		const fields = {
			type: "section",
			fields: [
				{ type: "mrkdwn", text: "*할 일*\ngit push origin main" },
				{ type: "mrkdwn", text: "*이유*\n릴리스" },
				{ type: "mrkdwn", text: "*영향*\n운영 반영" },
			],
		};
		expect(blocks).toEqual([
			header,
			summary,
			fields,
			{
				type: "actions",
				elements: [
					expect.objectContaining({
						text: { type: "plain_text", text: "승인" },
						action_id: approvalActionId("approve", CHANNEL, ts),
					}),
					expect.objectContaining({
						text: { type: "plain_text", text: "거부" },
						action_id: approvalActionId("deny", CHANNEL, ts),
					}),
				],
			},
			{ type: "context", elements: [{ type: "mrkdwn", text: expect.stringContaining("거부로 처리됩니다") }] },
		]);
		// The notification text is the full card as before; the summary section above carries no `• 라벨:` lines.
		const cardText =
			"🔐 승인 요청\n배포를 진행할까요?\n• 할 일: git push origin main\n• 이유: 릴리스\n• 영향: 운영 반영";
		expect(transport.calls.find((c) => c.method === "updateMessage")).toMatchObject({ ts, text: cardText });

		broker.handleAction({ actionId: approvalActionId("approve", CHANNEL, ts), userId: OWNER });
		expect(await result).toBe("approved");
		const last = transport.calls.filter((c) => c.method === "updateMessage").at(-1);
		const text = last?.method === "updateMessage" ? last.text : "";
		expect(text.startsWith(`${cardText}\n`)).toBe(true);
		const resultLine = text.slice(cardText.length + 1);
		expect(resultLine).toMatch(/^✅ 승인됨 · \d{2}:\d{2}$/);
		expect(last).toMatchObject({
			ts,
			blocks: [header, summary, fields, { type: "context", elements: [{ type: "mrkdwn", text: resultLine }] }],
		});
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
		expect(last?.method === "updateMessage" && last.blocks !== undefined && !hasButtons(last.blocks)).toBe(true);
		expect(last?.method === "updateMessage" ? last.text : "").toMatch(/\n⌛ 시간 초과: 거부로 처리됨 · \d{2}:\d{2}$/);
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

	test("a gh publish command without `external` still gets the 🌐 title and a leading exposure section", async () => {
		const result = broker.request(CHANNEL, "업스트림에 버그 이슈 등록", undefined, {
			action: "gh issue create --repo can1357/oh-my-pi --title 'x' --body-file /tmp/b.md",
		});
		await transport.shown.promise;
		const post = transport.calls.find((c) => c.method === "postMessage");
		expect(post?.text).toBe(
			[
				"🌐 외부 공개 승인 요청",
				"업스트림에 버그 이슈 등록",
				"• 🌐 외부 공개: GitHub에 게시합니다. 공개 저장소면 누구나 봅니다(감지: gh issue create)",
				"• 할 일: gh issue create --repo can1357/oh-my-pi --title 'x' --body-file /tmp/b.md",
			].join("\n"),
		);
		expect(post?.blocks?.[0]).toMatchObject({ type: "header", text: { text: "🌐 외부 공개 승인 요청" } });
		timers.fireAll();
		await result;
	});

	test("an explicit `external` wins over detection; read-only gh and local git stay a plain card", async () => {
		const explicit = broker.request(CHANNEL, "메일 발송", undefined, {
			external: "외부 메일 a@example.com",
			action: "gh pr comment 1 --body hi",
		});
		await transport.shown.promise;
		expect(transport.calls.find((c) => c.method === "postMessage")?.text).toContain(
			"• 🌐 외부 공개: 외부 메일 a@example.com\n",
		);
		timers.fireAll();
		await explicit;
		for (const action of ["gh issue view 18559", "gh api repos/a/b/issues", "git push --force origin main"]) {
			transport = new ButtonTransport();
			broker = make();
			const plain = broker.request(CHANNEL, "확인", undefined, { action });
			await transport.shown.promise;
			const text = transport.calls.find((c) => c.method === "postMessage")?.text;
			expect(text?.startsWith("🔐 승인 요청\n"), action).toBe(true);
			timers.fireAll();
			await plain;
		}
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
			channels: registryOf(new SlackChannel(transport)),
			broker: new ApprovalBroker({
				timezone: "Asia/Seoul",
				channels: registryOf(new SlackChannel(transport)),
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

	test("a Slack origin's upload and approval tools are the base commit's definitions byte for byte", () => {
		const base = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "slack-prompt-base.json"), "utf8")) as {
			tools: Array<{ name: string; label: string; description: string; parameters: unknown }>;
		};
		const shown = (name: string) => {
			const found = tool(name);
			return { name: found.name, label: found.label, description: found.description, parameters: found.parameters };
		};
		expect(base.tools.map((t) => t.name)).toEqual(["slack_send_file", "ompbot_request_approval"]);
		for (const expected of base.tools) expect(JSON.stringify(shown(expected.name))).toBe(JSON.stringify(expected));
	});

	test("a Discord origin's upload tool is discord_send_file with the platform named in its description", () => {
		tools = build("discord/dm/123456789012345678");
		const names = tools.map((t) => t.name);
		expect(names).toContain("discord_send_file");
		expect(names).not.toContain("slack_send_file");
		expect(tool("discord_send_file").description).toContain("owner's Discord");
		const slackUpload = build().find((t) => t.name === "slack_send_file");
		expect(tool("discord_send_file").parameters).toEqual(slackUpload?.parameters ?? {});
	});

	test("a Teams origin gets no upload tool: the Teams port cannot send files (qa-i #110)", () => {
		for (const origin of ["teams/dm/t0123456789abcdef", "teams/ch/tfedcba9876543210"]) {
			expect(build(origin).map((t) => t.name)).toEqual(["ompbot_dispatch", "ompbot_request_approval"]);
		}
	});

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

	describe("checkUploadable: private keys moved out of a protected directory", () => {
		// Assembled at run time so no key-shaped literal sits in the source (gitleaks).
		const keyText = () =>
			[`-----BEGIN OPENSSH ${"PRIVATE"} KEY-----`, "b3BlbnNzaC1rZXktdjE", "-----END KEY-----", ""].join("\n");
		const deps = () => ({ homeDir, workspaceDir, userHome });
		const sshKey = () => {
			mkdirSync(join(userHome, ".ssh"), { recursive: true });
			const key = join(userHome, ".ssh", "id_ed25519");
			writeFileSync(key, keyText());
			return key;
		};

		test("(a) a hard link of a protected private key is refused by inode", () => {
			const link = join(workspaceDir, "harmless.txt");
			linkSync(sshKey(), link);
			expect(statSync(link).nlink).toBe(2);
			expect(() => checkUploadable(link, deps())).toThrow(/hard link to a file in a protected directory/);
		});

		test("(b) a copy of the private key is refused by its content", () => {
			const copy = join(workspaceDir, "copy.txt");
			copyFileSync(sshKey(), copy);
			expect(statSync(copy).nlink).toBe(1);
			expect(() => checkUploadable(copy, deps())).toThrow(/token-like secret/);
		});

		test("(c) hard links between files outside protected directories pass", () => {
			sshKey();
			const a = join(workspaceDir, "a.txt");
			const b = join(workspaceDir, "b.txt");
			writeFileSync(a, "ordinary\n");
			linkSync(a, b);
			expect(statSync(b).nlink).toBe(2);
			expect(checkUploadable(b, deps())).toBe(b);
		});

		test("(d) a plain file with link count 1 passes", () => {
			const plain = join(workspaceDir, "plain.txt");
			writeFileSync(plain, "ordinary\n");
			expect(statSync(plain).nlink).toBe(1);
			expect(checkUploadable(plain, deps())).toBe(plain);
		});

		test("(e) a file holding an xoxc- token is refused", () => {
			const file = join(workspaceDir, "cookie.txt");
			writeFileSync(file, `token ${["xo", "xc-", "1234567890", "-abcdefghijKLMNOP"].join("")}\n`);
			expect(() => checkUploadable(file, deps())).toThrow(/token-like secret/);
		});
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

	test("checkUploadable scans files past 3MB: a token at the head or only at the tail is refused", () => {
		const deps = { homeDir, workspaceDir, userHome };
		const padding = "harmless line\n".repeat(Math.ceil((3 * 1024 * 1024 + 1) / 14));
		writeFileSync(join(workspaceDir, "head.txt"), `token xoxb-TEST-0\n${padding}`);
		expect(() => checkUploadable(join(workspaceDir, "head.txt"), deps)).toThrow(/token-like secret/);
		writeFileSync(join(workspaceDir, "tail.txt"), `${padding}token xoxb-TEST-0\n`);
		expect(() => checkUploadable(join(workspaceDir, "tail.txt"), deps)).toThrow(/token-like secret/);
		writeFileSync(join(workspaceDir, "clean.txt"), padding);
		expect(checkUploadable(join(workspaceDir, "clean.txt"), deps)).toBe(join(workspaceDir, "clean.txt"));
	});

	test("checkUploadable catches a token split across a scan chunk boundary, without false hits there", () => {
		const deps = { homeDir, workspaceDir, userHome };
		const file = join(workspaceDir, "split.txt");
		for (const token of ["xoxb-TEST-0", `ghp_${"A".repeat(36)}`]) {
			// The chunk boundary falls inside the token.
			writeFileSync(file, `${"a ".repeat(UPLOAD_SCAN_CHUNK_BYTES / 2 - 1)} ${token}\n${"b ".repeat(1000)}`);
			expect(() => checkUploadable(file, deps)).toThrow(/token-like secret/);
		}
		// `ask-…` is not an `sk-` key even when the carried-over tail starts at its `s`.
		const head = "a".repeat(UPLOAD_SCAN_CHUNK_BYTES - UPLOAD_SCAN_CARRY_CHARS);
		writeFileSync(file, `${head}sk-${"b".repeat(UPLOAD_SCAN_CARRY_CHARS - 3)}${"c ".repeat(1000)}`);
		expect(checkUploadable(file, deps)).toBe(file);
	});

	describe("checkUploadable: short `sk-` runs in binary data are not keys", () => {
		const padding = "\u0001".repeat(3 * 1024 * 1024 + 1);
		const short = [`\u0000sk-a\u0000`, `\u0000sk-${"b".repeat(19)}\u0000`];

		test("NUL-wrapped `sk-a` and `sk-` + 19 characters in a file over 3MB pass", () => {
			const deps = { homeDir, workspaceDir, userHome };
			const file = join(workspaceDir, "binary.bin");
			writeFileSync(file, `${padding.slice(0, 1024)}${short.join("")}${padding}`);
			expect(checkUploadable(file, deps)).toBe(file);
		});

		test("`sk-` + 20, `sk-ant-` + 20 and an `xoxb-` token past 3MB are refused", () => {
			const deps = { homeDir, workspaceDir, userHome };
			const file = join(workspaceDir, "binary.bin");
			for (const token of [`sk-${"b".repeat(20)}`, `sk-ant-${"b".repeat(20)}`, "xoxb-TEST-0"]) {
				writeFileSync(file, `${padding}\u0000${token}\u0000`);
				expect(() => checkUploadable(file, deps)).toThrow(/token-like secret/);
			}
		});

		test("chat masking is unchanged: the short runs are still redacted", () => {
			expect(short.map(redact)).toEqual(["\u0000[REDACTED]\u0000", "\u0000[REDACTED]\u0000"]);
		});
	});

	test("checkUploadable protects npm, kube, docker and gcloud credentials; other files in the home pass", () => {
		const deps = { homeDir, workspaceDir, userHome };
		const files = [
			join(userHome, ".npmrc"),
			join(userHome, ".kube", "config"),
			join(userHome, ".docker", "config.json"),
			join(userHome, ".config", "gcloud", "credentials.db"),
		];
		for (const file of files) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "harmless\n");
			expect(() => checkUploadable(file, deps)).toThrow(/protected directory/);
		}
		const plain = join(userHome, "notes.txt");
		writeFileSync(plain, "harmless\n");
		expect(checkUploadable(plain, deps)).toBe(plain);
	});

	test("upload tools need an owner DM origin", async () => {
		tools = build("slack/channel/C1");
		writeFileSync(join(workspaceDir, "a.txt"), "x");
		await expect(tool("slack_send_file").execute({ path: "a.txt" }, ctx)).rejects.toThrow();
		await expect(tool("ompbot_request_approval").execute({ summary: "s" }, ctx)).rejects.toThrow();
	});

	test("ompbot_request_approval returns approved / denied / denied (timeout) from the buttons", async () => {
		const broker = new ApprovalBroker({
			timezone: "Asia/Seoul",
			channels: registryOf(new SlackChannel(transport)),
			ownerUserId: OWNER,
			log: quietLog(),
			timers,
			store: memoryApprovalStore(),
		});
		tools = buildHostTools({
			originKey: ORIGIN,
			channels: registryOf(new SlackChannel(transport)),
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
			timezone: "Asia/Seoul",
			channels: registryOf(new SlackChannel(transport)),
			ownerUserId: OWNER,
			log: quietLog(),
			timers,
			store: memoryApprovalStore(),
		});
		tools = buildHostTools({
			originKey: ORIGIN,
			channels: registryOf(new SlackChannel(transport)),
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
			channels: [new SlackBinding(new SlackChannel(transport))],
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
			channels: [new SlackBinding(new SlackChannel(transport))],
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
		const steerDelivered = Promise.withResolvers<void>();
		daemon = new Daemon({
			config: home.config,
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({
				sink: (line) => {
					if (line.includes("event=steer_delivered")) steerDelivered.resolve();
				},
				clock,
				redact,
			}),
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
		// Released only after the steer landed: a turn ending before it would run "meanwhile" as a new (held) turn.
		await steerDelivered.promise;
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

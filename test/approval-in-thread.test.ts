// Approval cards in the asking thread (doc/plans/slack-approval-in-thread.md F1): the escalation card stays the
// canonical one, a mirror card with the same buttons lands in the asking thread, one decision settles both, and a
// timed-out card offers `다시 요청`. Broker tests drive timeouts with manual timers; daemon tests click through the
// Slack adapter. Waits are on transport calls and log lines (bounded), never sleeps.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon/daemon";
import { createLogger } from "../src/log";
import { FakeOmpDriver, FakeSessionStore } from "../src/omp/fake-driver";
import { redact } from "../src/redact";
import {
	ApprovalBroker,
	type ApprovalResult,
	type ApprovalStore,
	type ApprovalTimers,
	approvalActionId,
	parseApprovalActionId,
} from "../src/safety/approval";
import { SlackBinding } from "../src/slack/binding";
import { SlackChannel } from "../src/slack/channel";
import { type FakeCall, FakeSlackTransport } from "../src/slack/fake-transport";
import { SlackCallError } from "../src/slack/transport";
import { openStore, type Store } from "../src/store/db";
import { hasButtons, makeHome, OWNER, type TestHome, WaitingTransport } from "./helpers/bot-home";
import { registryOf } from "./helpers/channels";

const ESC = "C0ESCALATE1";
const REQ = "C0REQUEST01";
const THREAD = "7.7";
const WAIT_MS = 4_000;

type Post = Extract<FakeCall, { method: "postMessage" }>;
type Update = Extract<FakeCall, { method: "updateMessage" }>;

const typeOf = (block: unknown): unknown =>
	typeof block === "object" && block !== null && "type" in block ? block.type : undefined;

/** Action ids of the buttons in a message's blocks (`[]` without an actions block). */
function actionIds(blocks: readonly unknown[] | undefined): string[] {
	const actions = blocks?.find((block) => typeOf(block) === "actions");
	if (typeof actions !== "object" || actions === null || !("elements" in actions)) return [];
	return (actions.elements as Array<{ action_id: string }>).map((element) => element.action_id);
}

/** The grey note line (last `context` block) of a card, as JSON text; `""` when there is none. */
function contextText(blocks: readonly unknown[] | undefined): string {
	const last = blocks?.at(-1);
	if (typeOf(last) !== "context" || typeof last !== "object" || last === null || !("elements" in last)) return "";
	return JSON.stringify(last.elements);
}

/** Fake transport whose calls wake bounded waiters; `failMirror` makes the mirror card post (thread + buttons) fail. */
class WatchTransport extends FakeSlackTransport {
	failMirror = false;
	readonly #waiters = new Set<() => void>();

	override async postMessage(args: {
		channel: string;
		text: string;
		threadTs?: string | undefined;
		blocks?: readonly unknown[] | undefined;
	}): Promise<{ ts: string }> {
		if (this.failMirror && args.threadTs !== undefined && hasButtons(args.blocks)) {
			throw new SlackCallError("definitive", "slack_platform_error:not_in_channel");
		}
		const result = await super.postMessage(args);
		this.#wake();
		return result;
	}

	override async updateMessage(args: {
		channel: string;
		ts: string;
		text: string;
		blocks?: readonly unknown[] | undefined;
	}): Promise<void> {
		await super.updateMessage(args);
		this.#wake();
	}

	#wake(): void {
		for (const waiter of [...this.#waiters]) waiter();
	}

	posts(): Post[] {
		return this.calls.filter((call): call is Post => call.method === "postMessage");
	}

	edits(channel: string, ts: string): Update[] {
		return this.calls.filter(
			(call): call is Update => call.method === "updateMessage" && call.channel === channel && call.ts === ts,
		);
	}

	until(done: () => boolean, what: string): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!done()) return;
			clearTimeout(timer);
			this.#waiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(check);
			reject(new Error(`timed out waiting for ${what}`));
		}, WAIT_MS);
		this.#waiters.add(check);
		check();
		return promise;
	}
}

class ManualTimers implements ApprovalTimers {
	readonly callbacks = new Map<number, () => void>();
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

describe("broker: mirror card in the asking thread", () => {
	let dir: string;
	let store: Store;
	let transport: WatchTransport;
	let timers: ManualTimers;
	let lines: string[];
	let logWaiters: Set<() => void>;

	/** Resolves once a log line matches (bounded): the broker logs `approval_mirrored` after recording the mirror. */
	function untilLog(match: RegExp): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!lines.some((line) => match.test(line))) return;
			clearTimeout(timer);
			logWaiters.delete(check);
			resolve();
		};
		const timer = setTimeout(() => {
			logWaiters.delete(check);
			reject(new Error(`timed out waiting for ${match}`));
		}, WAIT_MS);
		logWaiters.add(check);
		check();
		return promise;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompbot-approval-thread-"));
		store = openStore({ path: join(dir, "ompbot.db"), clock: { now: () => 1_000 }, redact });
		transport = new WatchTransport();
		timers = new ManualTimers();
		lines = [];
		logWaiters = new Set();
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	/** `null`: no escalation channel configured. */
	function broker(escalationChannel: string | null = ESC): ApprovalBroker {
		return new ApprovalBroker({
			channels: registryOf(new SlackChannel(transport)),
			ownerUserId: OWNER,
			escalationChannel: escalationChannel ?? undefined,
			log: createLogger({
				sink: (line) => {
					lines.push(line);
					for (const waiter of [...logWaiters]) waiter();
				},
				clock: { now: () => 0 },
				redact,
			}),
			store: store as unknown as ApprovalStore,
			clock: { now: () => 2_000 },
			timers,
		});
	}

	const origin = { originKey: `slack/ch/${REQ}/t/${THREAD}`, channel: REQ, threadTs: THREAD };
	const detail = { action: "git push --force origin main", impact: "main 이력이 바뀜" };
	const canonicalPost = () => transport.posts().find((p) => p.channel === ESC && p.threadTs === undefined);
	const mirrorPost = () => transport.posts().find((p) => p.channel === REQ && p.threadTs === THREAD);

	/** Asks with an origin thread and waits until both cards are up; returns the canonical and mirror ts. */
	async function askInThread(b: ApprovalBroker, signal?: AbortSignal) {
		const result = b.ask(REQ, "force push main\n자세히", { origin, detail, signal });
		await untilLog(/event=approval_mirror(ed|_failed) /);
		const canonical = canonicalPost();
		if (canonical === undefined) throw new Error("no canonical card");
		return { result, canonicalTs: canonical.ts, mirrorTs: mirrorPost()?.ts };
	}

	test("AC-1: the mirror card lands in the asking thread with the same title and fields, buttons carrying the canonical key, no owner mention; the row records mirror_ref", async () => {
		const b = broker();
		const { result, canonicalTs, mirrorTs } = await askInThread(b);
		const canonical = canonicalPost() as Post;
		const mirror = mirrorPost() as Post;
		expect(canonical.text.split("\n")[0]).toBe(`🔐 승인 요청 <@${OWNER}>`);
		expect(JSON.stringify(transport.edits(ESC, canonicalTs).at(-1)?.blocks)).toContain(`<@${OWNER}>`);
		expect(mirror.text).not.toContain(`<@${OWNER}>`);
		expect(JSON.stringify(mirror.blocks)).not.toContain(`<@${OWNER}>`);
		expect(JSON.stringify(mirror.blocks)).not.toContain("요청 위치");
		// Same header and field section as the canonical card.
		const canonicalBlocks = transport.edits(ESC, canonicalTs).at(-1)?.blocks ?? [];
		expect(mirror.blocks?.[0]).toEqual(canonicalBlocks[0]);
		expect(mirror.blocks?.find((b) => typeof b === "object" && b !== null && "fields" in b)).toEqual(
			canonicalBlocks.find((b) => typeof b === "object" && b !== null && "fields" in b),
		);
		expect(actionIds(mirror.blocks)).toEqual([
			approvalActionId("approve", ESC, canonicalTs),
			approvalActionId("deny", ESC, canonicalTs),
		]);
		expect(contextText(mirror.blocks)).toContain("버튼으로 답해 주세요(이 스레드의 글 답장은 승인으로 세지 않음)");
		expect(contextText(mirror.blocks)).toContain(`https://slack.test/archives/${ESC}/p${canonicalTs.replace(".", "")}`);
		expect(b.handleAction({ actionId: approvalActionId("approve", ESC, canonicalTs), userId: OWNER })).toBe(true);
		expect(await result).toBe("approved");
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.mirrorRef).toBe(`${REQ}:${mirrorTs}`);
		// No pointer line once the mirror is up.
		expect(transport.posts().filter((p) => p.text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
	});

	test("AC-1: a failed mirror post falls back to the pointer line; the row keeps no mirror_ref", async () => {
		transport.failMirror = true;
		const b = broker();
		const { result, canonicalTs } = await askInThread(b);
		await transport.until(() => transport.posts().some((p) => p.text.startsWith("🔐 승인 요청을")), "pointer");
		const pointers = transport.posts().filter((p) => p.text.startsWith("🔐 승인 요청을"));
		expect(pointers).toHaveLength(1);
		expect(pointers[0]).toMatchObject({ channel: REQ, threadTs: THREAD });
		expect(pointers[0]?.text).toStartWith(`🔐 승인 요청을 <#${ESC}>에 올렸습니다 — force push main`);
		expect(hasButtons(pointers[0]?.blocks)).toBe(false);
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.mirrorRef).toBeNull();
		b.handleAction({ actionId: approvalActionId("deny", ESC, canonicalTs), userId: OWNER });
		expect(await result).toBe("denied");
	});

	test("AC-2: no origin, an origin without a thread, no escalation channel or the escalation channel itself: one card, no mirror", async () => {
		const settleAll = async (pending: Promise<ApprovalResult>) => {
			await transport.until(
				() => transport.calls.some((c) => c.method === "updateMessage" && hasButtons(c.blocks)),
				"buttons",
			);
			timers.fireAll();
			await pending;
		};
		// No origin: the card stays in the request channel, nothing else is posted.
		await settleAll(broker().ask(REQ, "a"));
		expect(transport.posts().map((p) => [p.channel, p.threadTs])).toEqual([[REQ, undefined]]);

		// An origin without a thread (channel top level): the escalation card + today's pointer line, no mirror.
		transport.calls.length = 0;
		const top = broker();
		const pendingTop = top.ask(REQ, "b", { origin: { originKey: `slack/ch/${REQ}`, channel: REQ } });
		await transport.until(() => transport.posts().some((p) => p.text.startsWith("🔐 승인 요청을")), "pointer");
		expect(transport.posts().map((p) => [p.channel, p.threadTs, hasButtons(p.blocks)])).toEqual([
			[ESC, undefined, false],
			[REQ, undefined, false],
		]);
		timers.fireAll();
		await pendingTop;

		// No escalation channel, and an escalation channel equal to the request channel: one card in the thread's channel.
		for (const escalation of [null, REQ]) {
			transport.calls.length = 0;
			const b = broker(escalation);
			await settleAll(b.ask(REQ, "c", { origin }));
			expect(transport.posts().map((p) => p.channel)).toEqual([REQ]);
			expect(transport.posts().filter((p) => p.text.startsWith("🔐 승인 요청을"))).toHaveLength(0);
		}
	});

	test("AC-3: a mirror click and a canonical click settle once; the second click only logs", async () => {
		const b = broker();
		const { result, canonicalTs } = await askInThread(b);
		const approve = approvalActionId("approve", ESC, canonicalTs);
		// The mirror's button carries the canonical key, so a mirror click is this very call.
		expect(actionIds(mirrorPost()?.blocks)[0]).toBe(approve);
		expect(b.handleAction({ actionId: approve, userId: OWNER })).toBe(true);
		expect(b.handleAction({ actionId: approve, userId: OWNER })).toBe(false);
		expect(await result).toBe("approved");
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.status).toBe("approved");
		expect(lines.filter((l) => l.includes("event=approval_click "))).toHaveLength(1);
		expect(lines.some((l) => l.includes("reason=already_decided"))).toBe(true);
	});

	test("AC-3: two clicks at once (mirror + canonical) decide the ledger once", async () => {
		const b = broker();
		const { result, canonicalTs } = await askInThread(b);
		const approve = approvalActionId("approve", ESC, canonicalTs);
		const deny = approvalActionId("deny", ESC, canonicalTs);
		const clicks = await Promise.all([
			Promise.resolve().then(() => b.handleAction({ actionId: approve, userId: OWNER })),
			Promise.resolve().then(() => b.handleAction({ actionId: deny, userId: OWNER })),
		]);
		expect(clicks).toEqual([true, false]);
		expect(await result).toBe("approved");
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.status).toBe("approved");
		expect(lines.filter((l) => l.includes("event=approval_click "))).toHaveLength(1);
		expect(
			lines.filter((l) => l.includes("reason=already_decided") || l.includes("reason=ledger_not_pending")),
		).toHaveLength(1);
	});

	for (const [name, act, line] of [
		[
			"approve",
			(b: ApprovalBroker, key: string) =>
				b.handleAction({ actionId: approvalActionId("approve", ESC, key.split(":")[1] ?? ""), userId: OWNER }),
			"✅ 승인됨",
		],
		[
			"deny",
			(b: ApprovalBroker, key: string) =>
				b.handleAction({ actionId: approvalActionId("deny", ESC, key.split(":")[1] ?? ""), userId: OWNER }),
			"⛔ 거부됨",
		],
		[
			"replied",
			(b: ApprovalBroker, key: string) => b.handleCardReply({ approvalId: key, ts: "9.9", text: "그 브랜치만" }),
			"💬 답장으로 처리됨: 그 브랜치만",
		],
	] as const) {
		test(`AC-4/AC-5: ${name} redraws canonical and mirror with the same result line, no buttons`, async () => {
			const b = broker();
			const { result, canonicalTs, mirrorTs } = await askInThread(b);
			act(b, `${ESC}:${canonicalTs}`);
			await result;
			const canonical = transport.edits(ESC, canonicalTs).at(-1);
			const mirror = transport.edits(REQ, mirrorTs ?? "").at(-1);
			expect(contextText(canonical?.blocks)).toContain(line);
			expect(contextText(mirror?.blocks)).toBe(contextText(canonical?.blocks));
			expect(actionIds(canonical?.blocks)).toEqual([]);
			expect(actionIds(mirror?.blocks)).toEqual([]);
		});
	}

	test("AC-4/AC-5: an aborted wait redraws both cards with the abort line and no button", async () => {
		const controller = new AbortController();
		const b = broker();
		const { result, canonicalTs, mirrorTs } = await askInThread(b, controller.signal);
		controller.abort();
		expect(await result).toBe("denied");
		const canonical = transport.edits(ESC, canonicalTs).at(-1);
		const mirror = transport.edits(REQ, mirrorTs ?? "").at(-1);
		expect(contextText(canonical?.blocks)).toContain("기다리던 작업이 중단돼 만료됨");
		expect(contextText(mirror?.blocks)).toBe(contextText(canonical?.blocks));
		expect(actionIds(canonical?.blocks)).toEqual([]);
		expect(actionIds(mirror?.blocks)).toEqual([]);
	});

	test("AC-5: a timed-out card keeps one `다시 요청` button on both cards, carrying the canonical key", async () => {
		const b = broker();
		const { result, canonicalTs, mirrorTs } = await askInThread(b);
		timers.fireAll();
		expect(await result).toBe("timeout");
		const retry = `ompbot:approval:retry:${ESC}:${canonicalTs}`;
		const canonical = transport.edits(ESC, canonicalTs).at(-1);
		const mirror = transport.edits(REQ, mirrorTs ?? "").at(-1);
		expect(actionIds(canonical?.blocks)).toEqual([retry]);
		expect(actionIds(mirror?.blocks)).toEqual([retry]);
		expect(contextText(mirror?.blocks)).toBe(contextText(canonical?.blocks));
		expect(contextText(canonical?.blocks)).toContain("⌛ 시간 초과: 거부로 처리됨");
		expect(store.getApproval(`${ESC}:${canonicalTs}`)?.status).toBe("expired");
		// The broker leaves the retry click to the daemon.
		expect(parseApprovalActionId(retry)).toEqual({ decision: "retry", channel: ESC, ts: canonicalTs });
		expect(b.handleAction({ actionId: retry, userId: OWNER })).toBe(false);
	});

	test("AC-5: a timed-out card with no asking thread gets no retry button", async () => {
		const b = broker(null);
		const pending = b.ask(REQ, "d");
		await transport.until(
			() => transport.calls.some((c) => c.method === "updateMessage" && hasButtons(c.blocks)),
			"buttons",
		);
		timers.fireAll();
		expect(await pending).toBe("timeout");
		const card = transport.posts()[0] as Post;
		expect(actionIds(transport.edits(REQ, card.ts).at(-1)?.blocks)).toEqual([]);
	});

	test("AC-4/AC-5: a restart expiry redraws the mirror of rows that recorded one; old rows only their card; retry only with an asking thread", async () => {
		const row = (id: string, summary: string, threadRef?: string) =>
			store.createApproval({
				approvalId: `${ESC}:${id}`,
				channel: ESC,
				messageTs: id,
				summary,
				createdAt: 1_000,
				expiresAt: 999_000,
				...(threadRef === undefined ? {} : { originKey: origin.originKey, originThreadRef: threadRef }),
			});
		row("1.1", "with mirror", `${REQ}:${THREAD}`);
		expect(store.setApprovalMirrorRef(`${ESC}:1.1`, `${REQ}:8.8`)).toBe(true);
		row("2.2", "old row", `${REQ}:${THREAD}`);
		row("3.3", "no thread");
		row("4.4", "❓ 질문 카드", `${REQ}:${THREAD}`);
		expect(await broker().expireStale(false)).toBe(4);
		const retryOf = (ts: string) => [`ompbot:approval:retry:${ESC}:${ts}`];
		expect(actionIds(transport.edits(ESC, "1.1").at(-1)?.blocks)).toEqual(retryOf("1.1"));
		expect(actionIds(transport.edits(REQ, "8.8").at(-1)?.blocks)).toEqual(retryOf("1.1"));
		expect(transport.edits(REQ, "8.8").at(-1)?.text).toBe(transport.edits(ESC, "1.1").at(-1)?.text);
		expect(actionIds(transport.edits(ESC, "2.2").at(-1)?.blocks)).toEqual(retryOf("2.2"));
		expect(actionIds(transport.edits(ESC, "3.3").at(-1)?.blocks)).toEqual([]);
		expect(actionIds(transport.edits(ESC, "4.4").at(-1)?.blocks)).toEqual([]);
		// Only row 1.1 has a mirror: five edits in all, one per card.
		expect(transport.calls.filter((c) => c.method === "updateMessage")).toHaveLength(5);
		// mirror_ref is written only on a pending row.
		expect(store.setApprovalMirrorRef(`${ESC}:2.2`, `${REQ}:9.9`)).toBe(false);
	});
});

describe("daemon: 다시 요청 on a timed-out approval card", () => {
	const DM = "D1";
	const ORIGIN = `slack/dm/${DM}`;
	const ASK_THREAD = "1700.000001";
	let home: TestHome;
	let daemon: Daemon;
	let transport: WaitingTransport;
	let logs: string[];

	beforeEach(async () => {
		home = makeHome("ompbot-approval-retry-");
		logs = [];
		transport = new WaitingTransport();
		const sessions = new FakeSessionStore();
		daemon = new Daemon({
			config: { ...home.config, escalationChannel: ESC },
			channels: [new SlackBinding(new SlackChannel(transport))],
			log: createLogger({ sink: (line) => logs.push(line), clock: { now: () => Date.now() }, redact }),
			ompVersion: "omp-test 0",
			bootId: "boot",
			driverFactory: (_origin, sessionDir) => new FakeOmpDriver({ sessionDir, store: sessions }),
		});
		await daemon.start();
	});

	afterEach(async () => {
		await daemon.stop();
		home.remove();
	});

	/** A settled approval row with its canonical card in the escalation channel and (optionally) a mirror in the thread. */
	async function seed(options: { mirror?: boolean; expire?: boolean; threadRef?: string } = {}) {
		const canonical = await transport.postMessage({ channel: ESC, text: `🔐 승인 요청 <@${OWNER}>\nforce push main` });
		const approvalId = `${ESC}:${canonical.ts}`;
		const now = Date.now();
		daemon.store.createApproval({
			approvalId,
			channel: ESC,
			messageTs: canonical.ts,
			summary: "force push main\n자세히",
			createdAt: now,
			expiresAt: now + 60_000,
			originKey: ORIGIN,
			originThreadRef: options.threadRef ?? `${DM}:${ASK_THREAD}`,
		});
		let mirrorTs: string | undefined;
		if (options.mirror !== false) {
			mirrorTs = (
				await transport.postMessage({ channel: DM, threadTs: ASK_THREAD, text: "🔐 승인 요청\nforce push main" })
			).ts;
			daemon.store.setApprovalMirrorRef(approvalId, `${DM}:${mirrorTs}`);
		}
		if (options.expire !== false) daemon.store.decideApproval(approvalId, "expired", now);
		return { canonicalTs: canonical.ts, mirrorTs };
	}

	function retry(canonicalTs: string, from: { channel: string; ts: string }, user = OWNER): Promise<void> {
		return transport.emitBlockAction({
			user: { id: user },
			channel: { id: from.channel },
			message: { ts: from.ts },
			actions: [{ action_id: `ompbot:approval:retry:${ESC}:${canonicalTs}`, value: "retry" }],
		});
	}

	const markers = () => transport.posts((text) => text === "🔘 다시 요청 (버튼)");
	const retryInbounds = () =>
		daemon.store.listInbound().filter((row) => row.textRef.trim().startsWith("다시 요청: force push main"));
	const lastEdit = (channel: string, ts: string) =>
		transport.calls
			.filter((c): c is Update => c.method === "updateMessage" && c.channel === channel && c.ts === ts)
			.at(-1);

	test("AC-6: a retry click puts one 🔘 marker and one owner '다시 요청: …' in the asking thread and redraws both cards without buttons", async () => {
		const { canonicalTs, mirrorTs } = await seed();
		await retry(canonicalTs, { channel: DM, ts: mirrorTs ?? "" });
		expect(markers()).toHaveLength(1);
		expect(markers()[0]).toMatchObject({ channel: DM, threadTs: ASK_THREAD });
		const inbound = retryInbounds();
		expect(inbound).toHaveLength(1);
		expect(inbound[0]).toMatchObject({ originKey: ORIGIN, threadRef: `${DM}:${ASK_THREAD}` });
		expect(inbound[0]?.textRef).toContain("ompbot_request_approval");
		for (const [channel, ts] of [
			[ESC, canonicalTs],
			[DM, mirrorTs ?? ""],
		] as const) {
			const edit = lastEdit(channel, ts);
			expect(actionIds(edit?.blocks)).toEqual([]);
			expect(contextText(edit?.blocks)).toMatch(/"text":"▶ 다시 요청됨 · \d\d:\d\d"/);
		}
		expect(logs.some((l) => l.includes("event=action_ignored"))).toBe(false);
	});

	test("AC-6: canonical and mirror clicked at once: one inbound, the second is a logged duplicate", async () => {
		const { canonicalTs, mirrorTs } = await seed();
		await Promise.all([
			retry(canonicalTs, { channel: ESC, ts: canonicalTs }),
			retry(canonicalTs, { channel: DM, ts: mirrorTs ?? "" }),
		]);
		expect(markers()).toHaveLength(1);
		expect(retryInbounds()).toHaveLength(1);
		expect(
			logs.filter((l) => l.includes("event=approval_retry_ignored") && l.includes("reason=duplicate")),
		).toHaveLength(1);
	});

	test("AC-6: a row that is not expired, a missing row and an asking thread that does not parse: no inbound, approval_retry_ignored, ⚠️ note", async () => {
		const pending = await seed({ expire: false, mirror: false });
		await retry(pending.canonicalTs, { channel: ESC, ts: pending.canonicalTs });
		expect(contextText(lastEdit(ESC, pending.canonicalTs)?.blocks)).toContain("⚠️ 다시 요청할 수 없음");
		const badThread = await seed({ threadRef: "not-a-thread", mirror: false });
		await retry(badThread.canonicalTs, { channel: ESC, ts: badThread.canonicalTs });
		expect(contextText(lastEdit(ESC, badThread.canonicalTs)?.blocks)).toContain("⚠️ 다시 요청할 수 없음");
		await retry("9999.000001", { channel: ESC, ts: "9999.000001" });
		expect(lastEdit(ESC, "9999.000001")?.text).toContain("⚠️ 다시 요청할 수 없음");
		expect(markers()).toHaveLength(0);
		expect(retryInbounds()).toHaveLength(0);
		expect(logs.filter((l) => l.includes("event=approval_retry_ignored"))).toHaveLength(3);
		expect(daemon.store.getApproval(`${ESC}:${pending.canonicalTs}`)?.status).toBe("pending");
	});

	test("AC-6: the marker post fails: no inbound, approval_retry_inject_rejected, both cards say it did not go in", async () => {
		const { canonicalTs, mirrorTs } = await seed();
		transport.failNext.postMessage = [new SlackCallError("definitive", "slack_platform_error:channel_not_found")];
		await retry(canonicalTs, { channel: DM, ts: mirrorTs ?? "" });
		expect(retryInbounds()).toHaveLength(0);
		expect(logs.filter((l) => l.includes("event=approval_retry_inject_rejected"))).toHaveLength(1);
		for (const [channel, ts] of [
			[ESC, canonicalTs],
			[DM, mirrorTs ?? ""],
		] as const) {
			const edit = lastEdit(channel, ts);
			expect(actionIds(edit?.blocks)).toEqual([]);
			expect(contextText(edit?.blocks)).toContain("⚠️ 다시 요청을 넣지 못함");
		}
	});

	test("AC-6: a click by anyone but the owner is denied before it reaches the daemon", async () => {
		const { canonicalTs, mirrorTs } = await seed();
		await retry(canonicalTs, { channel: DM, ts: mirrorTs ?? "" }, "UOTHER");
		expect(logs.some((l) => l.includes("event=action_denied"))).toBe(true);
		expect(markers()).toHaveLength(0);
		expect(retryInbounds()).toHaveLength(0);
	});
});

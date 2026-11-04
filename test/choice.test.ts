import { describe, expect, test } from "bun:test";
import type { ActionButton, ChannelPort, MessageRef, OutboundMessage, PostTarget } from "../src/channel/port";
import { createLogger } from "../src/log";
import type { OmpDialogAnswerer, OmpDialogResponse } from "../src/omp/driver";
import { tapExtensionUi } from "../src/omp/rpc-driver";
import { redact } from "../src/redact";
import {
	ApprovalBroker,
	type ApprovalStore,
	type ApprovalTimers,
	choiceActionId,
	parseApprovalActionId,
	parseChoiceActionId,
} from "../src/safety/approval";
import { answerDialogOnSlack } from "../src/safety/choice";

const OWNER = "U_OWNER";
const ORIGIN = { originKey: "slack/dm/D1", channel: "D1", threadTs: "100.1" };
const clock = { now: () => 1_800_000_000_000 };

/** Collects values and lets a test await the first one matching a predicate (already seen or arriving later). */
class Seen<T> {
	readonly items: T[] = [];
	#waiters: Array<{ match: (item: T) => boolean; resolve: (item: T) => void }> = [];

	push(item: T): void {
		this.items.push(item);
		for (const waiter of [...this.#waiters]) {
			if (!waiter.match(item)) continue;
			this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
			waiter.resolve(item);
		}
	}

	waitFor(match: (item: T) => boolean, timeoutMs = 2_000): Promise<T> {
		const found = this.items.find(match);
		if (found !== undefined) return Promise.resolve(found);
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(() => reject(new Error("expected item did not arrive")), timeoutMs);
		this.#waiters.push({
			match,
			resolve: (item) => {
				clearTimeout(timer);
				resolve(item);
			},
		});
		return promise;
	}
}

interface CardWrite {
	kind: "post" | "edit";
	target: PostTarget;
	ts: string;
	msg: OutboundMessage;
}

class RecordingPort implements ChannelPort {
	readonly platform = "slack" as const;
	readonly capabilities = { permalink: false, reactions: false };
	readonly writes = new Seen<CardWrite>();
	#next = 1;

	async post(target: PostTarget, msg: OutboundMessage): Promise<MessageRef> {
		const ts = `${200 + this.#next++}.0`;
		this.writes.push({ kind: "post", target, ts, msg });
		return { platform: "slack", conversationId: target.conversationId, messageId: ts };
	}
	async edit(ref: MessageRef, msg: OutboundMessage): Promise<void> {
		this.writes.push({ kind: "edit", target: { conversationId: ref.conversationId }, ts: ref.messageId, msg });
	}
	async react(): Promise<void> {}
	async uploadFile(): Promise<{ fileId: string }> {
		return { fileId: "F1" };
	}
	async permalink(): Promise<string | undefined> {
		return undefined;
	}
	mentionUser(userId: string): string {
		return `<@${userId}>`;
	}
}

class ManualTimers implements ApprovalTimers {
	readonly armed = new Map<number, { fn: () => void; ms: number }>();
	#next = 1;
	set(fn: () => void, ms: number): unknown {
		const id = this.#next++;
		this.armed.set(id, { fn, ms });
		return id;
	}
	clear(handle: unknown): void {
		this.armed.delete(handle as number);
	}
	fireAll(): void {
		for (const { fn } of [...this.armed.values()]) fn();
	}
}

function memoryStore(): ApprovalStore & { rows: Map<string, { status: string; replyText: string | null }> } {
	const rows = new Map<
		string,
		{
			status: string;
			channel: string;
			messageTs: string;
			originKey: string | null;
			replyTs: string | null;
			replyText: string | null;
		}
	>();
	return {
		rows,
		createApproval: (input) => {
			rows.set(input.approvalId, {
				status: "pending",
				channel: input.channel,
				messageTs: input.messageTs,
				originKey: input.originKey ?? null,
				replyTs: null,
				replyText: null,
			});
		},
		getApproval: (id) => rows.get(id),
		replyApproval: (id, replyTs, text) => {
			const row = rows.get(id);
			if (row?.status !== "pending") return false;
			Object.assign(row, { status: "replied", replyTs, replyText: text });
			return true;
		},
		decideApproval: (id, status) => {
			const row = rows.get(id);
			if (row?.status !== "pending") return false;
			row.status = status;
			return true;
		},
		expirePendingApprovals: () => {
			const expired: Array<{ approvalId: string; channel: string; messageTs: string }> = [];
			for (const [id, row] of rows) {
				if (row.status !== "pending") continue;
				row.status = "expired";
				expired.push({ approvalId: id, channel: row.channel, messageTs: row.messageTs });
			}
			return expired;
		},
	};
}

/** omp's stdout as a live stream through `tapExtensionUi`, answered by real choice cards on a recording port. */
function harness() {
	const port = new RecordingPort();
	const timers = new ManualTimers();
	const store = memoryStore();
	const logs = new Seen<string>();
	const broker = new ApprovalBroker({
		port,
		ownerUserId: OWNER,
		log: createLogger({ sink: (line) => logs.push(line), clock, redact }),
		store,
		clock,
		timers,
	});
	const replies = new Seen<Record<string, unknown>>();
	const answered: Array<Promise<OmpDialogResponse | undefined>> = [];
	const answerer: OmpDialogAnswerer = (request, signal) => {
		const response = answerDialogOnSlack(broker, ORIGIN, request, signal);
		answered.push(response);
		return response;
	};
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const tap = tapExtensionUi(
		stream,
		() => undefined,
		(frame) => replies.push(frame),
		answerer,
	);
	const send = (frame: Record<string, unknown>): void =>
		controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ type: "extension_ui_request", ...frame })}\n`));
	/** The card's first version: buttons attached, or the post itself for a reply-only card. */
	const card = (withButtons: boolean) =>
		port.writes.waitFor((w) =>
			withButtons ? w.kind === "edit" && (w.msg.buttons?.length ?? 0) > 0 : w.kind === "post",
		);
	const finalEdit = (ts: string) =>
		port.writes.waitFor((w) => w.kind === "edit" && w.ts === ts && w.msg.buttons?.length === 0);
	const click = (button: ActionButton | undefined) =>
		broker.handleAction({ actionId: button?.actionId ?? "missing", userId: OWNER });
	/** The n-th card is open (registered, buttons attached): the broker logs `choice_requested` right after. */
	const requested = (n: number) =>
		logs.waitFor(() => logs.items.filter((line) => line.includes("choice_requested")).length >= n);
	const close = async () => {
		controller.close();
		await tap;
	};
	return { port, timers, store, broker, replies, answered, send, card, finalEdit, click, requested, close };
}

const reply = (id: string, body: Record<string, unknown>) => ({ type: "extension_ui_response", id, ...body });

describe("choice action ids", () => {
	test("round trip; approval ids and malformed ids are not choice ids, choice ids are not approval ids", () => {
		const id = choiceActionId(3, "D0ABC", "1800000000.000007");
		expect(id).toBe("ompbot:choice:3:D0ABC:1800000000.000007");
		expect(parseChoiceActionId(id)).toEqual({ index: 3, channel: "D0ABC", ts: "1800000000.000007" });
		expect(parseApprovalActionId(id)).toBeUndefined();
		expect(parseChoiceActionId("ompbot:approval:approve:D1:1.2")).toBeUndefined();
		expect(parseChoiceActionId("ompbot:choice:x:D1:1.2")).toBeUndefined();
		expect(parseChoiceActionId("ompbot:choice:1:D1")).toBeUndefined();
	});
});

describe("omp dialogs answered on Slack choice cards", () => {
	test("select: a button card in the asking thread; the n-th click answers omp with options[n]", async () => {
		const h = harness();
		h.send({ method: "select", id: "u1", title: "배포 방식", options: ["blue-green", "canary", "rolling"] });
		const posted = await h.card(false);
		expect(posted.target).toEqual({ conversationId: "D1", threadId: "100.1" });
		const shown = await h.card(true);
		expect(shown.msg.buttons?.map((b) => b.label)).toEqual(["blue-green", "canary", "rolling"]);
		expect(shown.msg.buttons?.map((b) => b.actionId)).toEqual([0, 1, 2].map((n) => choiceActionId(n, "D1", shown.ts)));
		expect(shown.msg.buttonsNote).toContain("까지 답이 없으면 취소로 처리됩니다");
		// Only the owner's click counts.
		expect(h.broker.handleAction({ actionId: shown.msg.buttons?.[1]?.actionId ?? "", userId: "U_OTHER" })).toBe(false);
		expect(h.click(shown.msg.buttons?.[1])).toBe(true);
		expect(await h.replies.waitFor((r) => r.id === "u1")).toEqual(reply("u1", { value: "canary" }));
		expect((await h.finalEdit(shown.ts)).msg.text).toContain("✅ 선택: canary");
		expect(h.store.rows.get(`D1:${shown.ts}`)).toMatchObject({ status: "replied", replyText: "canary" });
		// A second click on the closed card does nothing.
		expect(h.click(shown.msg.buttons?.[0])).toBe(false);
		await h.close();
		expect(h.replies.items).toHaveLength(1);
	});

	test("select with more than 5 options: a numbered list, answered by number, label or free text", async () => {
		const options = ["a", "b", "c", "d", "e", "f"];
		const h = harness();
		h.send({ method: "select", id: "u1", title: "고르기", options });
		const posted = await h.card(false);
		expect(posted.msg.buttons).toBeUndefined();
		expect(posted.msg.text).toContain("6. f");
		expect(posted.msg.text).toContain("번호로 이 스레드에 답장해 주세요");
		await h.requested(1);
		expect(h.broker.answerDialog(ORIGIN.originKey, " 6 ")).toBe(true);
		expect(await h.replies.waitFor((r) => r.id === "u1")).toEqual(reply("u1", { value: "f" }));
		h.send({ method: "select", id: "u2", title: "고르기", options });
		await h.requested(2);
		expect(h.broker.answerDialog(ORIGIN.originKey, "c")).toBe(true);
		expect(await h.replies.waitFor((r) => r.id === "u2")).toEqual(reply("u2", { value: "c" }));
		h.send({ method: "select", id: "u3", title: "고르기", options });
		await h.requested(3);
		expect(h.broker.answerDialog(ORIGIN.originKey, "둘 다 아님")).toBe(true);
		expect(await h.replies.waitFor((r) => r.id === "u3")).toEqual(reply("u3", { value: "둘 다 아님" }));
		await h.close();
	});

	test("confirm: 예 answers confirmed true, 아니오 answers confirmed false", async () => {
		const h = harness();
		h.send({ method: "confirm", id: "c1", title: "계속할까요", message: "테스트가 2개 실패합니다" });
		const first = await h.card(true);
		expect(first.msg.buttons?.map((b) => b.label)).toEqual(["예", "아니오"]);
		expect(h.click(first.msg.buttons?.[0])).toBe(true);
		expect(await h.replies.waitFor((r) => r.id === "c1")).toEqual(reply("c1", { confirmed: true }));
		h.send({ method: "confirm", id: "c2", title: "계속할까요", message: "다시" });
		const second = await h.port.writes.waitFor(
			(w) => w.kind === "edit" && w.ts !== first.ts && (w.msg.buttons?.length ?? 0) > 0,
		);
		expect(h.click(second.msg.buttons?.[1])).toBe(true);
		expect(await h.replies.waitFor((r) => r.id === "c2")).toEqual(reply("c2", { confirmed: false }));
		await h.close();
	});

	test("input: a reply in the card's thread answers { value }; editor takes the conversation reply", async () => {
		const h = harness();
		h.send({ method: "input", id: "i1", title: "브랜치 이름", placeholder: "feature/..." });
		const posted = await h.card(false);
		expect(posted.msg.text).toContain("이 스레드에 답장해 주세요");
		expect(posted.msg.text).toContain("까지 답이 없으면 취소로 처리됩니다");
		await h.requested(1);
		const settled = h.broker.handleCardReply({ approvalId: `D1:${posted.ts}`, ts: "300.1", text: "feature/ask" });
		expect(settled).toEqual({ kind: "settled" });
		expect(await h.replies.waitFor((r) => r.id === "i1")).toEqual(reply("i1", { value: "feature/ask" }));
		// A later reply in the closed card's thread goes back to the asking conversation.
		expect(h.broker.handleCardReply({ approvalId: `D1:${posted.ts}`, ts: "300.2", text: "late" })).toEqual({
			kind: "route",
			originKey: ORIGIN.originKey,
		});
		h.send({ method: "editor", id: "e1", title: "커밋 메시지", prefill: "wip" });
		await h.requested(2);
		expect(h.broker.answerDialog(ORIGIN.originKey, "feat: ask cards")).toBe(true);
		expect(await h.replies.waitFor((r) => r.id === "e1")).toEqual(reply("e1", { value: "feat: ask cards" }));
		await h.close();
	});

	test("secret input: the card warns and omp gets cancelled at once", async () => {
		const h = harness();
		h.send({ method: "input", id: "s1", title: "API 키", secret: true });
		const posted = await h.card(false);
		expect(posted.msg.text).toContain("비밀값은 슬랙에 쓰지 마세요");
		expect(await h.replies.waitFor((r) => r.id === "s1")).toEqual(reply("s1", { cancelled: true }));
		expect((await h.finalEdit(posted.ts)).msg.text).toContain("🚫 취소됨");
		expect(h.broker.openDialogs(ORIGIN.originKey)).toBe(0);
		await h.close();
	});

	test("deadline: a select without a default times out cancelled; an ask answers its recommended options", async () => {
		const h = harness();
		h.send({ method: "select", id: "t1", title: "고르기", options: ["A", "B"], timeout: 30_000 });
		const shown = await h.card(true);
		// The card's deadline comes just before omp's own timeout.
		expect([...h.timers.armed.values()].map((t) => t.ms)).toEqual([29_000]);
		h.timers.fireAll();
		expect(await h.replies.waitFor((r) => r.id === "t1")).toEqual(reply("t1", { cancelled: true, timedOut: true }));
		expect((await h.finalEdit(shown.ts)).msg.text).toContain("⌛ 시간 초과: 취소로 처리됨");

		h.send({
			method: "ask",
			id: "t2",
			questions: [
				{ id: "q1", question: "환경", options: [{ label: "dev" }, { label: "prod" }], recommended: 0 },
				{ id: "q2", question: "알림", options: [{ label: "on" }, { label: "off" }], multi: true, recommended: 1 },
			],
		});
		const ask = await h.port.writes.waitFor(
			(w) => w.kind === "edit" && w.ts !== shown.ts && (w.msg.buttons?.length ?? 0) > 0,
		);
		expect(ask.msg.buttonsNote).toContain("추천 선택지로 처리됩니다");
		h.timers.fireAll();
		expect(await h.replies.waitFor((r) => r.id === "t2")).toEqual(
			reply("t2", {
				answers: [
					{ id: "q1", selectedOptions: ["dev"] },
					{ id: "q2", selectedOptions: ["off"] },
				],
			}),
		);
		expect((await h.finalEdit(ask.ts)).msg.text).toContain("⌛ 시간 초과: 추천 선택지로 처리됨");
		await h.close();
	});

	test("omp's cancel ends the waiting card; a later click writes nothing to omp", async () => {
		const h = harness();
		h.send({ method: "select", id: "x1", title: "고르기", options: ["A", "B"] });
		const shown = await h.card(true);
		h.send({ method: "cancel", id: "x-cancel", targetId: "x1" });
		expect((await h.finalEdit(shown.ts)).msg.text).toContain("🚫 취소됨");
		expect(h.click(shown.msg.buttons?.[0])).toBe(false);
		await h.answered[0];
		// A later dialog is answered normally; its reply is the only one ever written.
		h.send({ method: "confirm", id: "x2", title: "다음", message: "?" });
		const next = await h.port.writes.waitFor(
			(w) => w.kind === "edit" && w.ts !== shown.ts && (w.msg.buttons?.length ?? 0) > 0,
		);
		expect(h.click(next.msg.buttons?.[0])).toBe(true);
		await h.replies.waitFor((r) => r.id === "x2");
		expect(h.replies.items).toEqual([reply("x2", { confirmed: true })]);
		await h.close();
	});

	test("ask: a button answers the single-select question, a reply fills the multi one", async () => {
		const h = harness();
		h.send({
			method: "ask",
			id: "a1",
			questions: [
				{ id: "q1", header: "배포", question: "어디로?", options: [{ label: "dev" }, { label: "prod" }] },
				{
					id: "q2",
					question: "무엇을 알릴까?",
					options: [{ label: "slack" }, { label: "mail" }, { label: "sms" }],
					multi: true,
				},
			],
		});
		const shown = await h.card(true);
		expect(shown.msg.buttons?.map((b) => b.label)).toEqual(["1. dev", "1. prod"]);
		expect(shown.msg.text).toContain("번호를 쉼표로 답장해 주세요");
		expect(h.click(shown.msg.buttons?.[1])).toBe(true);
		// The card stays open for the multi question; its buttons are gone with the answered question.
		const partial = await h.port.writes.waitFor(
			(w) => w.kind === "edit" && w.ts === shown.ts && w.msg.text.includes("→ prod"),
		);
		expect(partial.msg.buttons ?? []).toEqual([]);
		expect(h.broker.openDialogs(ORIGIN.originKey)).toBe(1);
		expect(h.broker.answerDialog(ORIGIN.originKey, "1, 3")).toBe(true);
		expect(await h.replies.waitFor((r) => r.id === "a1")).toEqual(
			reply("a1", {
				answers: [
					{ id: "q1", selectedOptions: ["prod"] },
					{ id: "q2", selectedOptions: ["slack", "sms"] },
				],
			}),
		);
		h.send({
			method: "ask",
			id: "a2",
			questions: [{ id: "q1", question: "이름?", options: [{ label: "기본" }] }],
		});
		await h.port.writes.waitFor((w) => w.kind === "edit" && w.ts !== shown.ts && (w.msg.buttons?.length ?? 0) > 0);
		expect(h.broker.answerDialog(ORIGIN.originKey, "직접 지을게요")).toBe(true);
		expect(await h.replies.waitFor((r) => r.id === "a2")).toEqual(
			reply("a2", { answers: [{ id: "q1", selectedOptions: [], customInput: "직접 지을게요" }] }),
		);
		await h.close();
	});

	test("two open cards: a conversation reply answers neither", async () => {
		const h = harness();
		h.send({ method: "input", id: "i1", title: "첫째" });
		h.send({ method: "input", id: "i2", title: "둘째" });
		await h.requested(2);
		expect(h.broker.answerDialog(ORIGIN.originKey, "뭐든")).toBe(false);
		await h.close();
	});

	test("a daemon restart expires a choice card left open, like an approval card", async () => {
		const h = harness();
		h.send({ method: "select", id: "r1", title: "고르기", options: ["A", "B"] });
		const shown = await h.card(true);
		const rebooted = new ApprovalBroker({
			port: h.port,
			ownerUserId: OWNER,
			log: createLogger({ sink: () => undefined, clock, redact }),
			store: h.store,
			clock,
		});
		expect(await rebooted.expireStale(false)).toBe(1);
		const expired = await h.finalEdit(shown.ts);
		expect(expired.msg.text).toContain("재시작으로 만료됨");
		await h.close();
	});
});

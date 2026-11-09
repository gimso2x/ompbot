import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/log";
import { monitorOrigin } from "../src/monitors/ledger";
import { redact } from "../src/redact";
import { SlackAdapter } from "../src/slack/adapter";
import { FakeSlackTransport } from "../src/slack/fake-transport";
import { openStore, type Store } from "../src/store/db";

const LOG = "C0LOGCHAN01";
const clock = { now: () => 1_000_000 };

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-log-routing-"));
	store = openStore({ path: join(dir, "ompbot.db"), clock, redact, logChannel: LOG });
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

/** One dispatched owner message on `originKey` answered with `text`; returns the copies written to the log channel. */
function answer(originKey: string, threadRef: string, text: string, opRef = "op1"): string[] {
	store.ensureOrigin(originKey, `sess/${originKey}`);
	const platformMessageId = `${threadRef}:${opRef}`;
	store.recordInbound({ originKey, platformMessageId, textRef: "do it", threadRef });
	store.markDispatched(platformMessageId, { opRef, entryCursor: null });
	store.recordAnswer({ originKey, opRef, threadRef, parts: [text] });
	return copies();
}

const copies = () =>
	store
		.listDeliveries()
		.filter((row) => row.threadRef === `${LOG}:-`)
		.map((row) => row.body);

describe("completion copies to the log channel", () => {
	test.each(["✅ 완료: 배포 끝", ":white_check_mark: 완료 — 배포 끝"])(
		"a first line starting `%s` is copied once",
		(first) => {
			const body = `${first}\n\n세부 내용`;
			const written = answer("slack/ch/C0WORK00001", "C0WORK00001:1700.000001", body);
			expect(written).toHaveLength(1);
			expect(written[0]).toBe(`📒 완료 보고 사본 · <#C0WORK00001>{{thread-link:C0WORK00001:1700.000001}}\n${body}`);
			// The original answer is delivered unchanged to its own thread.
			expect(store.listDeliveries({ originKey: "slack/ch/C0WORK00001" }).map((row) => row.body)).toContain(body);
		},
	);

	test("a DM answer is labelled DM; a top-level answer carries no thread link; the first non-empty line counts", () => {
		expect(answer("slack/dm/D1", "D1:1700.000001", "\n\n✅ 완료\nok")[0]).toStartWith(
			"📒 완료 보고 사본 · DM{{thread-link:D1:1700.000001}}\n",
		);
		expect(answer("slack/dm/D1", "D1:-", "✅ 완료\nok2", "op2")[1]).toStartWith("📒 완료 보고 사본 · DM\n");
	});

	test("a work lane's answer is copied with the lane name", () => {
		expect(answer("ompbot/work/demo", "D1:1700.000002", "✅ 완료: 레인 끝")[0]).toStartWith(
			"📒 완료 보고 사본 · 작업 레인 demo{{thread-link:D1:1700.000002}}\n",
		);
	});

	test("the marker anywhere but the first line, or a different first line, is not copied", () => {
		expect(answer("slack/dm/D1", "D1:1.1", "작업했습니다\n✅ 완료")).toEqual([]);
		expect(answer("slack/dm/D1", "D1:2.2", "완료했습니다", "op2")).toEqual([]);
		expect(answer("slack/dm/D1", "D1:3.3", "  ✅ 완료됨", "op3")).toHaveLength(1);
	});

	test("commands, notices and monitor answers are never copied", () => {
		// A chat command's reply (op ref `new:…`) even if it starts with the marker.
		expect(answer("slack/dm/D1", "D1:1.1", "✅ 완료 새 대화", "new:1")).toEqual([]);
		// A turn failure notice.
		store.ensureOrigin("slack/dm/D1", "sess");
		store.recordInbound({ originKey: "slack/dm/D1", platformMessageId: "D1:4.4", textRef: "x", threadRef: "D1:4.4" });
		store.markDispatched("D1:4.4", { opRef: "opf", entryCursor: null });
		store.recordTurnFailure({ originKey: "slack/dm/D1", opRef: "opf", threadRef: "D1:4.4", notice: "✅ 완료 아님" });
		expect(copies()).toEqual([]);
		// A monitor's answer.
		const monitor = store.monitors.addMonitor({
			name: "daily",
			trigger: { kind: "cron", schedule: "* * * * *", timezone: "UTC" },
			instruction: "x",
			overlap: "queue",
			enabled: true,
		});
		expect(monitor.id).toBeTruthy();
		expect(answer(monitorOrigin(monitor.id), "D1:-", "✅ 완료 모니터")).toEqual([]);
	});

	test("recording the same answer again adds no second copy; without logChannel nothing is copied", () => {
		answer("slack/dm/D1", "D1:1.1", "✅ 완료 한 번");
		store.recordAnswer({ originKey: "slack/dm/D1", opRef: "op1", threadRef: "D1:1.1", parts: ["✅ 완료 한 번"] });
		expect(copies()).toHaveLength(1);

		const plain = openStore({ path: join(dir, "plain.db"), clock, redact });
		try {
			plain.ensureOrigin("slack/dm/D1", "sess");
			plain.recordAnswer({ originKey: "slack/dm/D1", opRef: "op1", threadRef: "D1:1.1", parts: ["✅ 완료"] });
			expect(plain.listDeliveries()).toHaveLength(1);
		} finally {
			plain.close();
		}
	});
});

function makeAdapter(transport: FakeSlackTransport, recorded: string[]): SlackAdapter {
	const adapter = new SlackAdapter({
		transport,
		core: {
			onInbound: (message) => {
				recorded.push(message.text);
				return {};
			},
			onCommand: () => "",
			onAction: () => undefined,
		},
		deliveries: { claimDue: () => [], confirm: () => undefined, fail: () => undefined, defer: () => undefined },
		ownerUserId: "UOWNER",
		clock: { now: () => 1_000 },
		log: createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact }),
		logChannel: LOG,
	});
	void adapter.start();
	return adapter;
}

describe("log channel in the Slack adapter", () => {
	test("an owner message in the log channel never becomes a turn, even with a mention", async () => {
		const transport = new FakeSlackTransport("UBOT");
		const recorded: string[] = [];
		const adapter = makeAdapter(transport, recorded);
		await adapter.handleMessage({
			type: "message",
			channel: LOG,
			channel_type: "channel",
			user: "UOWNER",
			text: "<@UBOT> 이거 해줘",
			ts: "1700.000001",
		});
		await adapter.handleMessage({
			type: "message",
			channel: LOG,
			channel_type: "channel",
			user: "UOWNER",
			text: "답글",
			ts: "1700.000002",
			thread_ts: "1700.000001",
		});
		expect(recorded).toEqual([]);
		// Other channels still work for a mention.
		await adapter.handleMessage({
			type: "message",
			channel: "C0OTHER0001",
			channel_type: "channel",
			user: "UOWNER",
			text: "<@UBOT> 이거 해줘",
			ts: "1700.000003",
		});
		expect(recorded).toEqual(["이거 해줘"]);
	});

	test("the thread-link placeholder of a copy becomes a permalink when it is posted, and is dropped when none exists", async () => {
		const transport = new FakeSlackTransport("UBOT");
		const queue = [
			{
				deliveryId: 1,
				originKey: "slack/ch/C0WORK00001",
				threadRef: `${LOG}:-`,
				body: "📒 완료 보고 사본 · <#C0WORK00001>{{thread-link:C0WORK00001:1700.000001}}\n✅ 완료",
				redelivered: false,
				finishUntracked: false,
			},
		];
		const adapter = new SlackAdapter({
			transport,
			core: { onInbound: () => ({}), onCommand: () => "", onAction: () => undefined },
			deliveries: {
				claimDue: () => queue.splice(0),
				confirm: () => undefined,
				fail: () => undefined,
				defer: () => undefined,
			},
			ownerUserId: "UOWNER",
			clock: { now: () => 1_000 },
			log: createLogger({ sink: () => undefined, clock: { now: () => 0 }, redact }),
		});
		await adapter.pumpDeliveries();
		const first = transport.calls.find((c) => c.method === "postMessage");
		expect(first && "text" in first ? first.text : "").toBe(
			"📒 완료 보고 사본 · <#C0WORK00001> · <https://slack.test/archives/C0WORK00001/p1700000001|스레드 보기>\n✅ 완료",
		);
		transport.failNext.getPermalink = [new Error("nope")];
		queue.push({
			deliveryId: 2,
			originKey: "slack/ch/C0WORK00001",
			threadRef: `${LOG}:-`,
			body: "📒 완료 보고 사본 · <#C0WORK00001>{{thread-link:C0WORK00001:1700.000001}}\n✅ 완료",
			redelivered: false,
			finishUntracked: false,
		});
		await adapter.pumpDeliveries();
		const posts = transport.calls.filter((c) => c.method === "postMessage");
		const second = posts[1];
		expect(second && "text" in second ? second.text : "").toBe("📒 완료 보고 사본 · <#C0WORK00001>\n✅ 완료");
	});
});

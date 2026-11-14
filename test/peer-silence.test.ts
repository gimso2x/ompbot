// Peer silence alert, ledger side (doc/plans/peer-silence-alert.md 설계 2~4): which confirmed deliveries become peer
// calls, what answers them, and the one alert per thread and peer that survives a store reopen.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mentionToken } from "../src/channel/port";
import { openStore, PEER_SILENCE_OP_PREFIX, type PeerCallPolicy, type Store } from "../src/store/db";

const CONV = "345678901234567890";
const THREAD = "1300000000000000000";
const THREAD_B = "1300000000000000555";
const LOG = "345678901234567777";
const BOARD = "345678901234567888";
const DM = "345678901234567999";
const PEER = "567890123456789012";
const PEER_B = "567890123456789013";
const SELF = "456789012345678901";
const OWNER = "678901234567890123";
const MINUTE = 60_000;

const POLICY: PeerCallPolicy = {
	peers: [
		{ userId: PEER, name: "뮤즈" },
		{ userId: PEER_B, name: "떡" },
	],
	skipConversations: [LOG, BOARD],
	ownerUserId: OWNER,
	silenceMs: 10 * MINUTE,
};

let dir: string;
let dbPath: string;
let now: number;
const opened: Store[] = [];

function open(policy: PeerCallPolicy | undefined = POLICY): Store {
	const store = openStore({ timezone: "Asia/Seoul", path: dbPath, clock: { now: () => now }, redact: (s) => s });
	store.setPeerCallPolicy(policy);
	opened.push(store);
	return store;
}

function reopen(store: Store): Store {
	store.close();
	opened.splice(opened.indexOf(store), 1);
	return open();
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompbot-peer-silence-"));
	dbPath = join(dir, "ompbot.db");
	now = 1_800_000_000_000;
});

afterEach(() => {
	for (const store of opened.splice(0)) store.close();
	rmSync(dir, { recursive: true, force: true });
});

const threadOrigin = (conv = CONV, thread = THREAD) => `discord/ch/${conv}/t/${thread}`;

/** One answer delivery; `send`: claimed and confirmed like the DeliveryPump does after the post. */
function answer(
	store: Store,
	body: string,
	opts: { opRef?: string; threadRef?: string; originKey?: string; send?: boolean } = {},
): number {
	const originKey = opts.originKey ?? threadOrigin();
	store.ensureOrigin(originKey, `/s/${opts.opRef ?? "op"}`);
	const [row] = store.recordAnswer({
		originKey,
		opRef: opts.opRef ?? `op${now}`,
		threadRef: opts.threadRef ?? `${CONV}:${THREAD}`,
		parts: [body],
	});
	if (row === undefined) throw new Error("no delivery");
	if (opts.send !== false) {
		expect(store.claimDue().map((r) => r.deliveryId)).toContain(row.deliveryId);
		store.confirmDelivery(row.deliveryId);
	}
	return row.deliveryId;
}

function calls(): Array<{ thread_ref: string; peer_user_id: string; delivery_id: number; state: string }> {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.query("SELECT thread_ref, peer_user_id, delivery_id, state FROM peer_calls ORDER BY call_id")
			.all() as Array<{ thread_ref: string; peer_user_id: string; delivery_id: number; state: string }>;
	} finally {
		db.close();
	}
}

const alerts = (store: Store) => store.listDeliveries().filter((row) => row.opRef.startsWith(PEER_SILENCE_OP_PREFIX));

describe("AC-1: a peer post in time means no alert", () => {
	test("a post of the peer after the call answers it; nothing is alerted past the silence", () => {
		const store = open();
		const id = answer(store, `<@${PEER}> 이거 봐 줘`);
		expect(calls()).toEqual([
			{ thread_ref: `${CONV}:${THREAD}`, peer_user_id: PEER, delivery_id: id, state: "pending" },
		]);
		now += 3 * MINUTE;
		expect(store.notePeerSeen({ threadRef: `${CONV}:${THREAD}`, peerUserId: PEER, at: now })).toBe(1);
		now += 20 * MINUTE;
		expect(store.alertSilentPeers()).toBe(0);
		expect(alerts(store)).toEqual([]);
		expect(calls().map((c) => c.state)).toEqual(["answered"]);
	});

	test("a post written before the call, another peer's post or one in another thread answers nothing", () => {
		const store = open();
		const before = now - MINUTE;
		answer(store, `<@!${PEER}> 확인 부탁`);
		expect(store.notePeerSeen({ threadRef: `${CONV}:${THREAD}`, peerUserId: PEER, at: before })).toBe(0);
		expect(store.notePeerSeen({ threadRef: `${CONV}:${THREAD}`, peerUserId: PEER_B, at: now })).toBe(0);
		expect(store.notePeerSeen({ threadRef: `${CONV}:${THREAD_B}`, peerUserId: PEER, at: now })).toBe(0);
		expect(calls().map((c) => c.state)).toEqual(["pending"]);
	});

	test("the alert waits the whole silence: one minute short of it nothing is due", () => {
		const store = open();
		answer(store, `${mentionToken(PEER)} 다음 단계`);
		now += 9 * MINUTE;
		expect(store.alertSilentPeers()).toBe(0);
		expect(calls().map((c) => c.state)).toEqual(["pending"]);
	});
});

describe("AC-2: one alert per thread and peer", () => {
	test("calls in a row without an answer make one alert that mentions the owner in the thread", () => {
		const store = open();
		const first = answer(store, `<@${PEER}> 첫 호출`, { opRef: "op1" });
		now += 2 * MINUTE;
		answer(store, `<@${PEER}> 두 번째`, { opRef: "op2" });
		now += 3 * MINUTE;
		answer(store, `<@${PEER}> 세 번째`, { opRef: "op3" });
		now += 8 * MINUTE;
		expect(store.alertSilentPeers()).toBe(1);
		const [alert, ...more] = alerts(store);
		expect(more).toEqual([]);
		expect(alert?.threadRef).toBe(`${CONV}:${THREAD}`);
		expect(alert?.originKey).toBe(threadOrigin());
		expect(alert?.state).toBe("pending");
		expect(alert?.body).toBe(`<@${OWNER}> ⚠️ 뮤즈 무응답 13분 — VM이 잠든 것 같으니 앱을 열어 주세요`);
		// The first call (call_id 1, delivery `first`) names the alert.
		expect(calls()[0]?.delivery_id).toBe(first);
		expect(alert?.opRef).toBe(`${PEER_SILENCE_OP_PREFIX}1`);
		expect(calls().map((c) => c.state)).toEqual(["alerted", "alerted", "alerted"]);
		now += 60 * MINUTE;
		expect(store.alertSilentPeers()).toBe(0);
		expect(alerts(store)).toHaveLength(1);
	});

	test("the alert post itself is no call, and a later call starts a new silence", () => {
		const store = open();
		answer(store, `<@${PEER}> 호출`, { opRef: "op1" });
		now += 10 * MINUTE;
		expect(store.alertSilentPeers()).toBe(1);
		const [alert] = alerts(store);
		if (alert === undefined) throw new Error("no alert");
		expect(store.claimDue().map((r) => r.deliveryId)).toEqual([alert.deliveryId]);
		store.confirmDelivery(alert.deliveryId);
		expect(calls()).toHaveLength(1);
		answer(store, `<@${PEER}> 다시`, { opRef: "op2" });
		now += 10 * MINUTE;
		expect(store.alertSilentPeers()).toBe(1);
		expect(alerts(store)).toHaveLength(2);
	});

	test("two peers in one post, or one peer in two threads, are separate alerts", () => {
		const store = open();
		answer(store, `<@${PEER}> <@${PEER_B}> 둘 다`, { opRef: "op1" });
		answer(store, `<@${PEER}> 저쪽`, {
			opRef: "op2",
			threadRef: `${CONV}:${THREAD_B}`,
			originKey: threadOrigin(CONV, THREAD_B),
		});
		now += 10 * MINUTE;
		expect(store.alertSilentPeers()).toBe(3);
		expect(
			alerts(store)
				.map((a) => `${a.threadRef} ${a.body.includes("뮤즈") ? "뮤즈" : "떡"}`)
				.sort(),
		).toEqual([`${CONV}:${THREAD} 떡`, `${CONV}:${THREAD} 뮤즈`, `${CONV}:${THREAD_B} 뮤즈`]);
	});
});

describe("AC-3: what is never a call", () => {
	test("a delivery not yet sent, one that failed or one gone ambiguous records nothing", () => {
		const store = open();
		answer(store, `<@${PEER}> 대기`, { opRef: "pending", send: false });
		const failed = answer(store, `<@${PEER}> 실패`, { opRef: "failed", send: false });
		const ambiguous = answer(store, `<@${PEER}> 모호`, { opRef: "ambiguous", send: false });
		const claimed = store.claimDue().map((r) => r.deliveryId);
		expect(claimed).toContain(failed);
		store.failDelivery(failed, "403");
		store.markAmbiguous(ambiguous, "timeout");
		expect(calls()).toEqual([]);
	});

	test("channel root, DM, #log and board posts, a log copy and a peer failure notice record nothing", () => {
		const store = open();
		store.setLogChannel({ discord: LOG });
		answer(store, `<@${PEER}> 루트`, { opRef: "root", threadRef: `${CONV}:-` });
		answer(store, `<@${PEER}> DM`, { opRef: "dm", threadRef: `${DM}:${THREAD}`, originKey: `discord/dm/${DM}` });
		answer(store, `<@${PEER}> 로그`, {
			opRef: "log",
			threadRef: `${LOG}:${THREAD}`,
			originKey: threadOrigin(LOG, THREAD),
		});
		answer(store, `<@${PEER}> 게시판`, {
			opRef: "board",
			threadRef: `${BOARD}:${THREAD}`,
			originKey: threadOrigin(BOARD, THREAD),
		});
		answer(store, `<@${PEER}> 사본`, { opRef: "copied:log-copy" });
		store.ensureOrigin(threadOrigin(), "/s/failed");
		const notice = store.recordTurnFailure({
			originKey: threadOrigin(),
			opRef: "failed:1",
			threadRef: `${CONV}:${THREAD}`,
			notice: `<@${PEER}> <@${SELF}> 응답 실패(boom) — 다시 요청하거나 직접 검토해 주세요`,
		});
		if (notice === undefined) throw new Error("no notice");
		store.claimDue();
		store.confirmDelivery(notice.deliveryId);
		expect(calls()).toEqual([]);
	});

	test("a completion report's #log copy records nothing while its thread answer is a call", () => {
		const store = open();
		store.setLogChannel({ discord: LOG });
		answer(store, `✅ 완료 <@${PEER}> 넘겨받아 줘`, { opRef: "done" });
		expect(store.listDeliveries().map((row) => row.opRef)).toEqual(["done", "done:log-copy"]);
		store.claimDue().forEach((row) => {
			if (row.state === "inflight") store.confirmDelivery(row.deliveryId);
		});
		expect(calls().map((c) => c.thread_ref)).toEqual([`${CONV}:${THREAD}`]);
	});

	test("a Slack thread and a post that mentions no peer record nothing", () => {
		const store = open();
		answer(store, `<@${PEER}> 슬랙`, { opRef: "slack", threadRef: "C0TEST0001:1700000000.000100", originKey: "o1" });
		answer(store, `<@${SELF}> 혼잣말`, { opRef: "self" });
		expect(calls()).toEqual([]);
	});

	test("with the alert off nothing is recorded and pending calls are dropped", () => {
		const store = open();
		answer(store, `<@${PEER}> 켜진 상태`, { opRef: "on" });
		store.setPeerCallPolicy(undefined);
		expect(calls().map((c) => c.state)).toEqual(["skipped"]);
		answer(store, `<@${PEER}> 꺼진 상태`, { opRef: "off" });
		expect(calls()).toHaveLength(1);
		now += 60 * MINUTE;
		expect(store.alertSilentPeers()).toBe(0);
		store.setPeerCallPolicy(POLICY);
		expect(store.alertSilentPeers()).toBe(0);
		expect(alerts(store)).toEqual([]);
	});
});

describe("AC-4: a store reopen neither repeats nor loses an alert", () => {
	test("a pending call survives a reopen and alerts after it", () => {
		let store = open();
		answer(store, `<@${PEER}> 재시작 전`);
		now += 5 * MINUTE;
		store = reopen(store);
		expect(calls().map((c) => c.state)).toEqual(["pending"]);
		now += 5 * MINUTE;
		expect(store.alertSilentPeers()).toBe(1);
		expect(alerts(store)).toHaveLength(1);
	});

	test("an alert recorded before a reopen is not recorded again and its delivery still goes out", () => {
		let store = open();
		answer(store, `<@${PEER}> 호출`);
		now += 10 * MINUTE;
		expect(store.alertSilentPeers()).toBe(1);
		const [alert] = alerts(store);
		if (alert === undefined) throw new Error("no alert");
		store = reopen(store);
		now += 10 * MINUTE;
		expect(store.alertSilentPeers()).toBe(0);
		expect(alerts(store).map((a) => `${a.deliveryId} ${a.state}`)).toEqual([`${alert.deliveryId} pending`]);
		expect(store.claimDue().map((r) => r.deliveryId)).toEqual([alert.deliveryId]);
	});

	test("a call answered by a backfilled post after the reopen is not alerted", () => {
		let store = open();
		answer(store, `<@${PEER}> 호출`);
		const answeredAt = now + 2 * MINUTE;
		now += 30 * MINUTE;
		store = reopen(store);
		expect(store.notePeerSeen({ threadRef: `${CONV}:${THREAD}`, peerUserId: PEER, at: answeredAt })).toBe(1);
		expect(store.alertSilentPeers()).toBe(0);
		expect(alerts(store)).toEqual([]);
	});
});

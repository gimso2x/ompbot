import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { TaskLedger } from "../src/tasks/ledger";

let db: Database;
let ledger: TaskLedger;

beforeEach(() => {
	db = new Database(":memory:", { strict: true });
	ledger = new TaskLedger(db, { timezone: "Asia/Seoul", clock: { now: () => Date.parse("2026-11-04T00:00:00Z") } });
	const insert = (id: string, acceptance: string, notices: string) =>
		db.run(
			`INSERT INTO tasks (task_id, title, risk, origin_key, thread_ref, host, repo, worktree, branch, agent, status,
				acceptance_json, created_at, updated_at, notices_json)
			 VALUES (?, 't', 'L1', 'slack/dm/U1', ?, NULL, '/r', '/w', 'b', ?, 'working', ?, 1, 1, ?)`,
			[id, `C1:${id}`, id.toLowerCase(), acceptance, notices],
		);
	insert("T-20261104-01", JSON.stringify([{ id: "AC-1", text: "one" }]), JSON.stringify({ remind: 5 }));
	insert("T-20261104-02", "{not json", "{}");
	insert("T-20261104-03", "[]", "{not json");
	insert("T-20261104-04", '{"id":"AC-1"}', "[1]");
});

afterEach(() => db.close());

test("rows with broken acceptance_json or notices_json read as [] and {} instead of throwing", () => {
	expect(ledger.list().map((row) => [row.taskId, row.acceptance, row.notices])).toEqual([
		["T-20261104-01", [{ id: "AC-1", text: "one" }], { remind: 5 }],
		["T-20261104-02", [], {}],
		["T-20261104-03", [], {}],
		["T-20261104-04", [], {}],
	]);
	expect(ledger.listActive()).toHaveLength(4);
	expect(ledger.get("T-20261104-02")?.acceptance).toEqual([]);
	expect(ledger.getByAgent("t-20261104-03", null)?.notices).toEqual({});
});

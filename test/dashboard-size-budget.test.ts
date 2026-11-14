import { describe, expect, test } from "bun:test";
import { renderDashboardPage } from "../src/dashboard/html";
import type { DashboardSnapshot } from "../src/dashboard/snapshot";

// Budgets and their measured baseline live in docs/performance.md. Raise a budget only by editing that page in the same change.
const KIB = 1024;
const STYLE_GZIP_BUDGET = 12 * KIB;
const SCRIPT_GZIP_BUDGET = 60 * KIB;

const off = { ok: false as const, error: "not in this test" };

const EMPTY: DashboardSnapshot = {
	generatedAt: "2026-11-12T10:00:00+09:00",
	timezone: "Asia/Seoul",
	daemon: {
		ok: true,
		running: true,
		ompVersion: "1",
		origins: 1,
		busy: 0,
		ledger: { pending: 0, inflight: 0, confirmed: 0, ambiguous: 0, expired: 0 },
		inbound: { pending: 0, dispatched: 0, answered: 0, failed_notified: 0, discarded: 0 },
		monitors: { count: 0, next: null },
		openGates: [],
	},
	turns: off,
	tasks: { ok: true, items: [] },
	lanes: off,
	herdr: { ok: true, hosts: [] },
	approvals: off,
	monitors: off,
	alerts: off,
	gates: off,
	backup: off,
	jobs: off,
};

describe("dashboard size budget", () => {
	// The inline <style> and <script> ship on every page load whatever the data, so they carry the budget.
	const page = renderDashboardPage(EMPTY);
	const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1];
	const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1];

	test("the inline style stays within its gzip budget", () => {
		if (style === undefined) throw new Error("no inline <style> in the page");
		expect(Bun.gzipSync(style).length).toBeLessThanOrEqual(STYLE_GZIP_BUDGET);
	});

	test("the inline script stays within its gzip budget", () => {
		if (script === undefined) throw new Error("no inline <script> in the page");
		expect(Bun.gzipSync(script).length).toBeLessThanOrEqual(SCRIPT_GZIP_BUDGET);
	});
});

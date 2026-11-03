import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boardCardLink } from "../src/dispatch/board";

const MACHINES = {
	machines: [
		{ id: "local", name: "devbox", kind: "local" },
		{ id: "476d2405", name: "wsl", kind: "ssh" },
	],
};

describe("boardCardLink (herdr-web-ui card key)", () => {
	let server: ReturnType<typeof Bun.serve>;
	let fail = false;
	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request) =>
				fail || new URL(request.url).pathname !== "/api/machines"
					? new Response("no", { status: 500 })
					: Response.json(MACHINES),
		});
	});
	afterAll(() => server.stop(true));
	const board = () => ({ url: "https://board.test/task/", api: `http://127.0.0.1:${server.port}/` });

	test("this host's pane is keyed by the pane id alone; another host by <machine id>:<pane id>", async () => {
		expect(await boardCardLink(board(), null, "w2V:pA")).toBe("https://board.test/task/?card=w2V:pA");
		expect(await boardCardLink(board(), "wsl", "w1:p3")).toBe("https://board.test/task/?card=476d2405:w1:p3");
	});

	test("unknown pane, unknown host or an unreadable machine list fall back to the board root", async () => {
		const errors: string[] = [];
		const onError = (error: string) => errors.push(error);
		expect(await boardCardLink(board(), null, undefined, { onError })).toBe("https://board.test/task/");
		expect(errors).toEqual([]); // no lookup without a pane
		expect(await boardCardLink(board(), "host2", "w1:p1", { onError })).toBe("https://board.test/task/");
		fail = true;
		try {
			expect(await boardCardLink(board(), null, "w1:p1", { onError })).toBe("https://board.test/task/");
		} finally {
			fail = false;
		}
		expect(errors).toEqual(["no board machine for host2", "machines HTTP 500"]);
	});
});

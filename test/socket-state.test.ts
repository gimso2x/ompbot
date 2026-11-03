import { describe, expect, test } from "bun:test";
import { SocketConnectionState } from "../src/slack/socket-transport";

describe("SocketConnectionState", () => {
	test("starts down since construction", () => {
		expect(new SocketConnectionState(100).snapshot()).toEqual({ state: "down", since: 100 });
	});

	test("hello (connected) goes up", () => {
		const s = new SocketConnectionState(100);
		s.on("connected", 200);
		expect(s.snapshot()).toEqual({ state: "up", since: 200 });
	});

	test("error events never change state or since, up or down", () => {
		const s = new SocketConnectionState(100);
		s.on("error", 150);
		expect(s.snapshot()).toEqual({ state: "down", since: 100 });
		s.on("connected", 200);
		s.on("error", 300);
		expect(s.snapshot()).toEqual({ state: "up", since: 200 });
	});

	test("reconnecting goes down on the up->down edge only; repeated reconnecting keeps since", () => {
		const s = new SocketConnectionState(100);
		s.on("connected", 200);
		s.on("reconnecting", 300);
		expect(s.snapshot()).toEqual({ state: "down", since: 300 });
		s.on("reconnecting", 400);
		s.on("error", 450);
		s.on("reconnecting", 500);
		expect(s.snapshot()).toEqual({ state: "down", since: 300 });
		s.on("connected", 600);
		expect(s.snapshot()).toEqual({ state: "up", since: 600 });
	});

	test("reconnecting before the first hello keeps the construction time", () => {
		const s = new SocketConnectionState(100);
		s.on("reconnecting", 900);
		expect(s.snapshot()).toEqual({ state: "down", since: 100 });
	});
});

import { expect, test } from "bun:test";
import { TeamsConnector } from "../../src/teams/transport";

function connector(activityBody: string): TeamsConnector {
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("https://token.test/"))
			return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
		return new Response(activityBody, { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return new TeamsConnector({
		appId: "app",
		clientSecret: () => "secret",
		tokenTenant: "tenant",
		tokenUrl: "https://token.test/token",
		fetchImpl,
		allowServiceUrl: () => true,
	});
}

test("sendActivity: a null body (typing) yields no id instead of throwing", async () => {
	const result = await connector("null").sendActivity("https://svc.test/", "conv", { type: "typing" });
	expect(result).toEqual({ id: undefined });
});

test("sendActivity: the posted activity id is returned", async () => {
	const result = await connector('{"id":"a1"}').sendActivity("https://svc.test/", "conv", { type: "message" });
	expect(result).toEqual({ id: "a1" });
});

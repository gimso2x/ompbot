import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcOmpDriver } from "../../src/omp/rpc-driver";

export interface PickedModel {
	/** `provider/id` as omp reports it. */
	model?: string;
	/** Why nothing was picked; printed as the skip reason. */
	reason?: string;
}

/**
 * Pick the model for the real-omp e2e files from what the pinned omp actually offers, so provider-side
 * model expiry degrades to a skip instead of mid-run dispatch failures. OMPBOT_E2E_OMP_MODEL pins the id
 * (skip reason when not offered) and OMPBOT_E2E_OMP_PROVIDER narrows the provider; without overrides the
 * cheap default id `glm-5.3-flash` is preferred, falling back to the first offered model. Costs no tokens:
 * only `getAvailableModels` on a throwaway child that never prompts.
 */
export async function pickE2eModel(
	ompExecutable: string,
	overrides: { provider?: string; model?: string } = {
		provider: process.env.OMPBOT_E2E_OMP_PROVIDER,
		model: process.env.OMPBOT_E2E_OMP_MODEL,
	},
): Promise<PickedModel> {
	const root = mkdtempSync(join(tmpdir(), "ompbot-model-probe-"));
	const driver = new RpcOmpDriver({
		ompExecutable,
		cwd: join(root, "workspace"),
		sessionDir: join(root, "sessions", "probe"),
		env: { OMP_WIKI_NOTE_DISABLE: "1" },
	});
	try {
		await driver.start();
		const offered = await driver.availableModels();
		const provider = overrides.provider;
		const candidates = provider === undefined ? offered : offered.filter((model) => model.startsWith(`${provider}/`));
		const pin = overrides.model;
		const idOf = (model: string): string => model.slice(model.indexOf("/") + 1);
		if (pin !== undefined) {
			const hit = candidates.find((model) => idOf(model) === pin);
			if (hit) return { model: hit };
			const shown = candidates.slice(0, 5).join(", ");
			return {
				reason: `OMPBOT_E2E_OMP_MODEL=${pin} is not offered by omp (available: ${shown}${candidates.length > 5 ? ", …" : ""})`,
			};
		}
		const chosen = candidates.find((model) => idOf(model) === "glm-5.3-flash") ?? candidates[0];
		if (chosen !== undefined) return { model: chosen };
		return { reason: provider === undefined ? "omp offers no model" : `omp offers no model from provider ${provider}` };
	} catch (error) {
		return { reason: `model probe failed: ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		await driver.stop().catch(() => {});
		rmSync(root, { recursive: true, force: true });
	}
}

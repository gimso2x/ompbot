import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `provider/id` the mock models.yml registers. */
export const MOCK_MODEL = "mock/scripted";

export interface OmpMockEnv {
	root: string;
	/** Throwaway omp agent dir (`PI_CODING_AGENT_DIR`) holding only the mock `models.yml`. */
	agentDir: string;
	workspace: string;
	sessionsRoot: string;
	/** Child env extras for `RpcOmpDriver({ env })`: isolates omp from the user's `~/.omp/agent`. */
	env: Record<string, string>;
	close(): void;
}

/** omp `models.yml` registering only `mock/scripted` at `baseUrl` (pi-coding-agent `src/config/custom-models.ts` shape). */
export function mockModelsYml(baseUrl: string): string {
	return [
		"providers:",
		"  mock:",
		`    baseUrl: ${baseUrl}`,
		"    api: openai-completions",
		"    auth: apiKey",
		"    apiKey: mock-literal-key",
		"    models:",
		"      - id: scripted",
		"        name: Scripted Mock",
		"        reasoning: false",
		"        input: [text]",
		"        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }",
		"        contextWindow: 128000",
		"        maxTokens: 4096",
		"",
	].join("\n");
}

/**
 * Temp root with an isolated omp agent dir: omp resolves its agent dir (config.yml, models.yml, extensions, auth,
 * sessions index) from `PI_CODING_AGENT_DIR` (pi-utils `src/dirs.ts`), so the user's settings, extensions and
 * credentials are never loaded and nothing is written under `~/.omp/agent`. HOME also points into the temp root so
 * user-level discovery (`~/.claude`, `~/.agents` skills, rules and context files) finds nothing.
 */
export function createOmpMockEnv(baseUrl: string): OmpMockEnv {
	const root = mkdtempSync(join(tmpdir(), "ompbot-omp-mock-"));
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	const sessionsRoot = join(root, "sessions");
	const home = join(root, "home");
	for (const dir of [agentDir, workspace, sessionsRoot, home]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(agentDir, "models.yml"), mockModelsYml(baseUrl));
	// Skills off: each discovered skill costs one background "compress description" request to the smol model.
	writeFileSync(join(agentDir, "config.yml"), "skills:\n  enabled: false\n");
	return {
		root,
		agentDir,
		workspace,
		sessionsRoot,
		env: { HOME: home, PI_CODING_AGENT_DIR: agentDir, OMP_WIKI_NOTE_DISABLE: "1" },
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}

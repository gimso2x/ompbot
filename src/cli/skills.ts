import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { agentSkillsRoot, NAME_PATTERN, rollbackSkill } from "../review/skills";

export const SKILLS_USAGE = `  skills rollback <name>         restore an installed skill's previous revision (every install keeps the replaced
                                 SKILL.md under revisions/)
`;

/**
 * `ompbot skills rollback <이름>`: restores the newest saved revision of an installed skill. Installs copy the
 * previous SKILL.md to `revisions/` first, so this is always one command — the safety net of the review loop.
 */
export function skillsCommand(args: string[], env: Record<string, string | undefined> = process.env): number {
	const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
	const [sub, name] = positionals;
	if (sub !== "rollback" || typeof name !== "string" || name === "") {
		process.stderr.write(`usage: ompbot skills rollback <name>\n${SKILLS_USAGE}`);
		return 2;
	}
	if (!NAME_PATTERN.test(name)) {
		process.stderr.write(`skills: invalid skill name: ${name}\n`);
		return 2;
	}
	// The skills root is the real agent directory; the test-hook override follows the OMPBOT_SWEEP_MS pattern.
	const root =
		env.OMPBOT_TEST_HOOKS === "1" && env.OMPBOT_SKILLS_DIR !== undefined ? env.OMPBOT_SKILLS_DIR : agentSkillsRoot();
	let revision: string;
	try {
		revision = rollbackSkill(join(root, name));
	} catch (error) {
		process.stderr.write(`skills rollback failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	process.stdout.write(`skill rollback name=${name} revision=${basename(revision)}\n`);
	return 0;
}

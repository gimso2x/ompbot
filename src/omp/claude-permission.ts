import { isInside } from "../safety/inside";

/**
 * First-cut permission policy for the Claude Code driver: file edits inside the
 * session workspace and harmless tool calls run without asking; dangerous Bash
 * escalates to an owner approval card; Bash touching the bot's secrets
 * directory is refused outright (it is a floor, not a judgment call).
 */

/** Tools that edit files; allowed only when every target path stays inside the workspace. */
export const EDIT_TOOLS: Record<string, true> = {
	Edit: true,
	Write: true,
	MultiEdit: true,
	NotebookEdit: true,
};

/** Input keys that name file paths, per editing tool. */
const EDIT_PATH_KEYS: Record<string, string[]> = {
	Edit: ["file_path"],
	Write: ["file_path"],
	MultiEdit: ["file_path"],
	NotebookEdit: ["notebook_path"],
};

/** Bash patterns that always go to an owner approval card (rule-guards parity). */
const DANGEROUS_BASH: RegExp[] = [
	/rm\s+(?=[^;\n|]*\s)(?:[^;\n|]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s+(?:-[a-zA-Z]*f[a-zA-Z]*|--force))?/,
	/rm\s+(?:[^;\n|]*\s)?(?:-[a-zA-Z]*f[a-zA-Z]*\s)+(?:-[a-zA-Z]*[rR]|--recursive)\b/,
	/\bmkfs(\.\w+)?\b/,
	/\bdd\b[^;\n|]*\bof=\/dev\//,
	/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
	/\b(shutdown|reboot|halt|poweroff)\b/,
	/\bgit\s+push\b[^;\n|]*(--force|-f)\b/,
	/\bgit\s+reset\s+--hard\b/,
	/\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*\b/,
	/\bgit\s+branch\s+-D\b/,
	/\b(sudo|systemctl|service|docker|podman|pm2)\b/,
	/\b(curl|wget)\b[^;\n|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/,
	/\bkillall\b|\bkill\s+-9\b/,
	/\bchmod\s+(-R\s+)?777\b/,
];

/** Bash touching the bot secrets directory is refused without a card (hard floor 3). */
export function bashTouchesSecrets(command: string, secretsDir: string): boolean {
	if (secretsDir === "") return false;
	const flat = command.replace(/["']/g, "");
	return flat.includes(secretsDir);
}

/** Whether every path the edit tool targets stays inside `cwd`. */
export function editsInside(toolName: string, input: Record<string, unknown>, cwd: string): boolean {
	const keys = EDIT_PATH_KEYS[toolName];
	if (keys === undefined) return false;
	for (const key of keys) {
		const value = input[key];
		if (typeof value !== "string" || value === "") return false;
		if (!isInside(value, cwd)) return false;
	}
	return true;
}

/** The permission answer the driver writes back to the CLI. */
export type PermissionDecision =
	| { behavior: "allow"; updatedInput: Record<string, unknown> }
	| { behavior: "deny"; message: string };

export interface ClassifyInput {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
	/** Bot secrets directory; Bash referencing it is denied outright. */
	secretsDir?: string;
	/** Asks the owner (Slack approval card). Absent → dangerous Bash is denied. */
	ask?: (request: { toolName: string; command: string; description?: string }) => Promise<boolean>;
}

/**
 * Decision for one `can_use_tool` control request. Edit tools inside the
 * workspace and every non-Bash tool are allowed; Bash is allowed unless it
 * touches the secrets dir (deny) or matches a dangerous pattern (owner card,
 * `ask` returning true approves it).
 */
export async function classifyPermission(classify: ClassifyInput): Promise<PermissionDecision> {
	const { toolName, input, cwd } = classify;
	if (toolName === "Bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (command === "") return deny("Bash call without a command");
		if (classify.secretsDir !== undefined && bashTouchesSecrets(command, classify.secretsDir)) {
			return deny(
				`비밀 디렉터리(${classify.secretsDir}) 접근은 금지되어 있습니다. / secrets directory access is forbidden`,
			);
		}
		if (!isDangerousBash(command)) return allow(input);
		if (classify.ask === undefined) {
			return deny(
				"위험 명령이라 자동 거부됐습니다 (승인 채널 없음). / dangerous command auto-denied (no approval channel)",
			);
		}
		const approved = await classify.ask({
			toolName,
			command,
			description: typeof input.description === "string" && input.description !== "" ? input.description : undefined,
		});
		return approved ? allow(input) : deny("오너가 승인하지 않았습니다. / the owner did not approve this command");
	}
	if (EDIT_TOOLS[toolName] === true) {
		if (editsInside(toolName, input, cwd)) return allow(input);
		return {
			behavior: "deny",
			message:
				"작업 디렉터리 밖의 파일 편집은 오너 승인이 필요합니다. / editing files outside the workspace needs owner approval",
		};
	}
	return allow(input);
}

export function isDangerousBash(command: string): boolean {
	return DANGEROUS_BASH.some((pattern) => pattern.test(command));
}

function allow(input: Record<string, unknown>): PermissionDecision {
	return { behavior: "allow", updatedInput: input };
}

function deny(message: string): PermissionDecision {
	return { behavior: "deny", message };
}

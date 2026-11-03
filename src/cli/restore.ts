import { join } from "node:path";
import { parseArgs } from "node:util";
import { callDaemon } from "../daemon/ipc";
import { RestoreError, runRestore } from "../ops/restore";

export const RESTORE_USAGE = `  restore <backup-db-path> [--yes]
                                 replace ompbot.db with a backup while the daemon is stopped: copy → quick_check → current
                                 db/-wal/-shm move to backups/pre-restore-<stamp>/ → rename. Source: backups/ompbot-
                                 YYYYMMDD-HHMMSS.db or an absolute file. Without --yes only prints the plan (exit 3);
                                 refuses (exit 1) while a daemon runs
`;

/** `ompbot restore`; resolves with the exit code. */
export async function restoreCommand(args: string[], homeDir: string): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(args);
	} catch (error) {
		process.stderr.write(`restore: ${error instanceof Error ? error.message : String(error)}\n${RESTORE_USAGE}`);
		return 2;
	}
	const [source, ...extra] = parsed.positionals;
	if (source === undefined || extra.length > 0) {
		process.stderr.write(`restore needs exactly one <backup-db-path>\n${RESTORE_USAGE}`);
		return 2;
	}
	const socketPath = join(homeDir, "ompbot.sock");
	try {
		const result = await runRestore({
			homeDir,
			source,
			yes: parsed.values.yes === true,
			probeDaemon: () => callDaemon(socketPath, { op: "status" }, 3_000),
		});
		const { plan } = result;
		if (!result.applied) {
			process.stdout.write(
				`restore plan: replace ${plan.target} with ${plan.source}; current files [${plan.moves.join(", ") || "none"}] move to ${plan.preRestoreDir}. Re-run with --yes to apply.\n`,
			);
			return 3;
		}
		process.stdout.write(
			`restore_done source=${plan.source} previous=${plan.moves.length > 0 ? plan.preRestoreDir : "-"}\n`,
		);
		return 0;
	} catch (error) {
		if (error instanceof RestoreError) {
			process.stderr.write(`restore failed: ${error.message}\n`);
			return error.code === "bad_source" ? 2 : 1;
		}
		throw error;
	}
}

function parse(args: string[]) {
	return parseArgs({ args, options: { yes: { type: "boolean" } }, allowPositionals: true, strict: true });
}

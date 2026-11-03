import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const UNITS_USAGE = `  units render [--out <dir>] [--dry-run]
                                 fill packaging/*.service|*.timer with this bun, this checkout and HOME (plus
                                 OMPBOT_HOME when set) and write them to --out (default ~/.config/systemd/user);
                                 --dry-run prints '# <file>' + content instead; an existing file with other content is
                                 never overwritten (exit 2, nothing written); never runs systemctl
`;

/** The checkout this file belongs to: src/cli/units.ts → repo root. */
const REPO_DIR = resolve(import.meta.dir, "..", "..");
const PACKAGING_DIR = join(REPO_DIR, "packaging");

interface UnitValues {
	bun: string;
	repoDir: string;
	home: string;
	/** Absolute; set only when the caller's environment has OMPBOT_HOME. */
	ompbotHome?: string;
}

interface RenderedUnit {
	name: string;
	text: string;
}

/** Fills `@BUN@`, `@REPO_DIR@`, `@HOME@`, `@PATH@`; `.service` units also get `Environment=OMPBOT_HOME=` when set. */
function renderUnit(name: string, template: string, values: UnitValues): string {
	const path = [
		...new Set([
			dirname(values.bun),
			join(values.home, ".local", "bin"),
			join(values.home, ".bun", "bin"),
			"/usr/local/bin",
			"/usr/bin",
			"/bin",
		]),
	].join(":");
	let text = template
		.replaceAll("@BUN@", values.bun)
		.replaceAll("@REPO_DIR@", values.repoDir)
		.replaceAll("@HOME@", values.home)
		.replaceAll("@PATH@", path);
	if (values.ompbotHome !== undefined && name.endsWith(".service")) {
		text = text.replace(/^\[Service\]\n/m, `[Service]\nEnvironment=OMPBOT_HOME=${values.ompbotHome}\n`);
	}
	return text;
}

/** Every unit template under packaging/, rendered, in file-name order. */
function renderUnits(values: UnitValues): RenderedUnit[] {
	return readdirSync(PACKAGING_DIR)
		.filter((name) => name.endsWith(".service") || name.endsWith(".timer"))
		.sort()
		.map((name) => ({ name, text: renderUnit(name, readFileSync(join(PACKAGING_DIR, name), "utf8"), values) }));
}

function usage(message: string): number {
	process.stderr.write(`units: ${message}\n${UNITS_USAGE}`);
	return 2;
}

/** `ompbot units render`: writes only when no target differs, so an installed unit is never silently replaced. */
export function unitsCommand(args: string[], env: Record<string, string | undefined>): number {
	const [sub, ...rest] = args;
	if (sub !== "render") return usage(sub === undefined ? "missing subcommand" : `unknown subcommand ${sub}`);
	let values: { out?: string; "dry-run"?: boolean };
	try {
		({ values } = parseArgs({ args: rest, options: { out: { type: "string" }, "dry-run": { type: "boolean" } } }));
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}
	const home = homedir();
	const units = renderUnits({
		bun: process.execPath,
		repoDir: REPO_DIR,
		home,
		...(env.OMPBOT_HOME === undefined ? {} : { ompbotHome: resolve(env.OMPBOT_HOME) }),
	});
	if (values["dry-run"] === true) {
		for (const unit of units) process.stdout.write(`# ${unit.name}\n${unit.text}`);
		return 0;
	}

	const outDir = resolve(values.out ?? join(home, ".config", "systemd", "user"));
	const plan = units.map((unit) => {
		const path = join(outDir, unit.name);
		const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
		return { ...unit, path, state: existing === undefined ? "new" : existing === unit.text ? "same" : "differs" };
	});
	const differing = plan.filter((unit) => unit.state === "differs");
	if (differing.length > 0) {
		for (const unit of differing) process.stderr.write(`units differs file=${unit.path}\n`);
		process.stderr.write(
			`units: ${differing.length} installed unit(s) differ from the rendered ones; nothing written (compare with --dry-run, move them away to replace)\n`,
		);
		return 2;
	}
	mkdirSync(outDir, { recursive: true });
	for (const unit of plan) {
		if (unit.state === "new") writeFileSync(unit.path, unit.text, { mode: 0o644 });
		process.stdout.write(`units ${unit.state === "new" ? "written" : "unchanged"} file=${unit.path}\n`);
	}
	process.stdout.write(
		[
			"next (not run by ompbot):",
			"  systemctl --user daemon-reload",
			"  systemctl --user enable --now ompbot",
			"  systemctl --user enable --now ompbot-backup.timer ompbot-gc.timer",
			"",
		].join("\n"),
	);
	return 0;
}

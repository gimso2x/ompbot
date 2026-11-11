import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const UNITS_USAGE = `  units render [--out <dir>] [--dry-run] [--instance <name>]
                                 fill packaging/*.service|*.timer with this bun, this checkout and HOME (plus
                                 OMPBOT_HOME when set) and write them to --out (default ~/.config/systemd/user);
                                 --dry-run prints '# <file>' + content instead; an existing file with other content is
                                 never overwritten (exit 2, nothing written); never runs systemctl;
                                 --instance <name> (^[a-z][a-z0-9-]{0,23}$, needs OMPBOT_HOME) renders a second install
                                 as ompbot-<name>[-backup|-gc].service|timer, without the dashboard unit
`;

const INSTANCE_NAME = /^[a-z][a-z0-9-]{0,23}$/;

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

/** `ompbot.service` → `ompbot-<instance>.service`, `ompbot-gc.timer` → `ompbot-<instance>-gc.timer`. */
const instanceUnitName = (name: string, instance: string): string =>
	name.replace(/^ompbot(?=[-.])/, `ompbot-${instance}`);

/**
 * Every unit template under packaging/, rendered, in file-name order. With `instance` the units are renamed
 * (file names, the `After=`/`Description=` references) and the dashboard unit is left out.
 */
function renderUnits(values: UnitValues, instance?: string): RenderedUnit[] {
	return readdirSync(PACKAGING_DIR)
		.filter((name) => name.endsWith(".service") || name.endsWith(".timer"))
		.filter((name) => instance === undefined || name !== "ompbot-dashboard.service")
		.sort()
		.map((name) => {
			const text = renderUnit(name, readFileSync(join(PACKAGING_DIR, name), "utf8"), values);
			if (instance === undefined) return { name, text };
			return {
				name: instanceUnitName(name, instance),
				text: text
					.replace(/^Description=ompbot(?=[ :])/m, `Description=ompbot-${instance}`)
					.replace(
						/^(After=|Unit=)(ompbot-\S+)$/gm,
						(_m, key: string, unit: string) => `${key}${instanceUnitName(unit, instance)}`,
					),
			};
		});
}

function usage(message: string): number {
	process.stderr.write(`units: ${message}\n${UNITS_USAGE}`);
	return 2;
}

/** `ompbot units render`: writes only when no target differs, so an installed unit is never silently replaced. */
export function unitsCommand(args: string[], env: Record<string, string | undefined>): number {
	const [sub, ...rest] = args;
	if (sub !== "render") return usage(sub === undefined ? "missing subcommand" : `unknown subcommand ${sub}`);
	let values: { out?: string; "dry-run"?: boolean; instance?: string };
	try {
		({ values } = parseArgs({
			args: rest,
			options: { out: { type: "string" }, "dry-run": { type: "boolean" }, instance: { type: "string" } },
		}));
	} catch (error) {
		return usage(error instanceof Error ? error.message : String(error));
	}
	if (env.OMPBOT_HOME === "") return usage("OMPBOT_HOME is set but empty; unset it to use ~/.ompbot");
	const instance = values.instance;
	if (instance !== undefined) {
		if (!INSTANCE_NAME.test(instance)) return usage(`--instance must match ${INSTANCE_NAME.source}`);
		// `ompbot-backup.service` etc. already name the default install's units: such an instance would overwrite them.
		if (["backup", "gc", "dashboard"].includes(instance))
			return usage(`--instance ${instance} collides with the default install's ompbot-${instance} units`);
		if (env.OMPBOT_HOME === undefined)
			return usage("--instance needs OMPBOT_HOME (a second install needs its own home)");
	}
	const home = homedir();
	const units = renderUnits(
		{
			bun: process.execPath,
			repoDir: REPO_DIR,
			home,
			...(env.OMPBOT_HOME === undefined ? {} : { ompbotHome: resolve(env.OMPBOT_HOME) }),
		},
		instance,
	);
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
	const base = instance === undefined ? "ompbot" : `ompbot-${instance}`;
	process.stdout.write(
		[
			"next (not run by ompbot):",
			"  systemctl --user daemon-reload",
			`  systemctl --user enable --now ${base}`,
			`  systemctl --user enable --now ${base}-backup.timer ${base}-gc.timer`,
			"",
		].join("\n"),
	);
	return 0;
}

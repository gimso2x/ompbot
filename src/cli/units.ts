import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export const UNITS_USAGE = `  units render [--out <dir>] [--dry-run] [--instance <name>]
                                 fill packaging/*.service|*.timer with this bun, this checkout and HOME (plus
                                 OMPBOT_HOME when set) and write them to --out (default ~/.config/systemd/user);
                                 --dry-run prints '# <file>' + content instead; an existing file with other content is
                                 never overwritten (exit 2, nothing written); never runs systemctl;
                                 --instance <name> (^[a-z][a-z0-9-]{0,23}$, needs OMPBOT_HOME) renders a second install
                                 as ompbot-<name>[-backup|-gc].service|timer, without the dashboard unit; backup, gc,
                                 dashboard and names ending in -backup/-gc/-dashboard are taken by other units' names
`;

const CONTROL_CHARS = /\p{Cc}/u;
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
	// systemd expands `%` specifiers in ExecStart= and Environment=; replacers are functions so `$&` in a path stays literal.
	const fill = (value: string) => () => value.replaceAll("%", "%%");
	let text = template
		.replaceAll("@BUN@", fill(values.bun))
		.replaceAll("@REPO_DIR@", fill(values.repoDir))
		.replaceAll("@HOME@", fill(values.home))
		.replaceAll("@PATH@", fill(path));
	if (values.ompbotHome !== undefined && name.endsWith(".service")) {
		// systemd splits an unquoted value at spaces and expands `%`; a plain path stays unquoted so installed units match.
		const assignment = `OMPBOT_HOME=${values.ompbotHome}`;
		const line = /^[\w/.,:@+=-]+$/.test(assignment)
			? `Environment=${assignment}`
			: `Environment="${assignment.replace(/[\\"]/g, "\\$&").replaceAll("%", "%%")}"`;
		text = text.replace(/^\[Service\]\n/m, () => `[Service]\n${line}\n`);
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

/** A symlink whose target is missing: `existsSync` says false, yet a write through it creates the target. */
function isDanglingLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink() && !existsSync(path);
	} catch {
		return false;
	}
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
	// An empty OMPBOT_HOME is unset, as in config.ts: the default ~/.ompbot, no Environment= line.
	const ompbotHome = env.OMPBOT_HOME === undefined || env.OMPBOT_HOME === "" ? undefined : resolve(env.OMPBOT_HOME);
	if (ompbotHome !== undefined && CONTROL_CHARS.test(ompbotHome))
		return usage("OMPBOT_HOME contains a control character; a unit file cannot carry it");
	if (values.out === "") return usage("--out is empty; leave it out to use ~/.config/systemd/user");
	const instance = values.instance;
	if (instance !== undefined) {
		if (!INSTANCE_NAME.test(instance)) return usage(`--instance must match ${INSTANCE_NAME.source}`);
		// `ompbot-backup.service` etc. already name the default install's units: such an instance would overwrite them.
		if (["backup", "gc", "dashboard"].includes(instance))
			return usage(`--instance ${instance} collides with the default install's ompbot-${instance} units`);
		// `ompbot-a-backup.service` is instance `a`'s backup unit: an instance `a-backup` would share its file names.
		const suffix = /-(backup|gc|dashboard)$/.exec(instance)?.[1];
		if (suffix !== undefined)
			return usage(`--instance ${instance} ends in -${suffix}, the name of another instance's ${suffix} units`);
		if (ompbotHome === undefined) return usage("--instance needs OMPBOT_HOME (a second install needs its own home)");
	}
	// An empty HOME is unset (as OMPBOT_HOME above): a relative one would put PATH entries and --out under the cwd.
	const home = env.HOME || homedir();
	if (CONTROL_CHARS.test(home)) return usage("HOME contains a control character; a unit file cannot carry it");
	const units = renderUnits(
		{
			bun: process.execPath,
			repoDir: REPO_DIR,
			home,
			...(ompbotHome === undefined ? {} : { ompbotHome }),
		},
		instance,
	);
	if (values["dry-run"] === true) {
		for (const unit of units) process.stdout.write(`# ${unit.name}\n${unit.text}`);
		return 0;
	}

	const outDir = resolve(values.out ?? join(home, ".config", "systemd", "user"));
	// The nearest existing ancestor must be a directory, or mkdir fails halfway with a raw EEXIST/ENOTDIR.
	if (isDanglingLink(outDir)) return usage(`--out ${outDir} is a symlink to a missing path`);
	let existing = outDir;
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	if (!statSync(existing).isDirectory()) return usage(`--out ${outDir}: ${existing} is not a directory`);
	for (const unit of units) {
		const path = join(outDir, unit.name);
		if (isDanglingLink(path)) return usage(`--out ${outDir}: ${path} is a symlink to a missing path`);
		if (existsSync(path) && !statSync(path).isFile()) return usage(`--out ${outDir}: ${path} is not a file`);
	}
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

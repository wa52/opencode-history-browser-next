import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	LAUNCHER_FILE,
	LAUNCHER_NAME,
	PLUGIN_ID,
	REDIRECT_BACKUP_BASENAME,
	REDIRECT_MARKER,
	REPOSITORY_SPEC,
} from "./identity.js";
import {
	commandExists,
	commandLaunch,
	resolveOpenCodeCommand,
} from "./opencode-cli.js";
import {
	buildBackupForwarder,
	hasForeignHistoryRedirect,
	ownsRedirect,
} from "./redirect.js";

async function ensureBrowserLauncher({ root, writeLog }) {
	if (process.platform !== "win32") return;
	await mkdir(dirname(LAUNCHER_FILE), { recursive: true });
	const nodeExecutable = resolveNodeExecutable();
	const script = [
		'Set shell = CreateObject("WScript.Shell")',
		'shell.Environment("Process")("OPENCODE_BROWSER_MODE") = "1"',
		`shell.Run Chr(34) & "${nodeExecutable.replaceAll('"', '""')}" & Chr(34) & " " & Chr(34) & "${join(root, "standalone.js").replaceAll('"', '""')}" & Chr(34), 0, False`,
		"",
	].join("\r\n");
	const candidates = [
		join(homedir(), "Desktop"),
		process.env.OneDrive ? join(process.env.OneDrive, "Desktop") : "",
	].filter((desktop, index, values) => desktop && existsSync(desktop) && values.indexOf(desktop) === index);
	await writeFile(LAUNCHER_FILE, script, "utf8");
	await Promise.all(candidates.map((desktop) => writeFile(join(desktop, LAUNCHER_NAME), script, "utf8")));
	await writeLog("info", "launcher.installed", { launcher: LAUNCHER_FILE, nodeExecutable });
}

async function ensureCommandRedirect({ writeLog }) {
	if (process.platform !== "win32") return;
	const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
	const npmDir = join(appData, "npm");
	const launcher = LAUNCHER_FILE;
	const cmd = join(npmDir, "opencode.cmd");
	const cliCmd = join(npmDir, `${REDIRECT_BACKUP_BASENAME}.cmd`);
	const ps1 = join(npmDir, "opencode.ps1");
	const cliPs1 = join(npmDir, `${REDIRECT_BACKUP_BASENAME}.ps1`);
	const currentCmd = existsSync(cmd) ? await readFile(cmd, "utf8") : "";
	const currentPs1 = existsSync(ps1) ? await readFile(ps1, "utf8") : "";
	if ([currentCmd, currentPs1].some((current) => hasForeignHistoryRedirect(current, REDIRECT_MARKER))) {
		throw new Error("The legacy History Browser redirect is active. Uninstall it before installing the next edition.");
	}
	const directCommand = await resolveOpenCodeCommand();
	if (currentCmd) {
		if (!ownsRedirect(currentCmd, REDIRECT_MARKER)) {
			await writeFile(cliCmd, currentCmd, "utf8");
		} else if (!existsSync(cliCmd)) {
			await writeFile(cliCmd, buildBackupForwarder(".cmd", directCommand), "utf8");
		}
		await writeFile(cmd, [
			"@ECHO off",
			`REM ${REDIRECT_MARKER}`,
			'IF NOT "%~1"=="" GOTO cli',
			`START "" /B wscript.exe "${launcher}"`,
			"EXIT /B 0",
			":cli",
			`CALL "${cliCmd}" %*`,
			"",
		].join("\r\n"), "utf8");
	}
	if (currentPs1) {
		if (!ownsRedirect(currentPs1, REDIRECT_MARKER)) {
			await writeFile(cliPs1, currentPs1, "utf8");
		} else if (!existsSync(cliPs1)) {
			await writeFile(cliPs1, buildBackupForwarder(".ps1", directCommand), "utf8");
		}
		await writeFile(ps1, [
			`# ${REDIRECT_MARKER}`,
			`if ($args.Count -eq 0 -and -not $MyInvocation.ExpectingInput) { Start-Process -FilePath "wscript.exe" -ArgumentList '"${launcher}"' -WindowStyle Hidden; exit 0 }`,
			`& "${cliPs1}" @args`,
			"exit $LASTEXITCODE",
			"",
		].join("\r\n"), "utf8");
	}
	await writeLog("info", "redirect.installed", { npmDir });
}

async function uninstallSelf({ api, uninstallPlugin }) {
	const { removed, redirectRestored } = await uninstallPlugin();

	if (!removed.length && !redirectRestored) {
		api.ui.toast({
			variant: "warning",
			title: "History Browser",
			message: "Plugin entry was not found. OpenCode itself was not changed.",
			duration: 6000,
		});
		return;
	}

	api.ui.toast({
		variant: "success",
		title: "History Browser uninstalled",
		message: "Restart OpenCode to finish removing it. The original opencode command stays available.",
		duration: 8000,
	});
}

async function uninstallPlugin() {
	const redirectRestored = await restoreCommandRedirect();
	const removed = [];
	for (const file of tuiConfigCandidates()) {
		if (await removePluginFromConfig(file)) removed.push(file);
	}
	for (const launcher of browserLauncherCandidates()) {
		if (!existsSync(launcher)) continue;
		await unlink(launcher);
		removed.push(launcher);
	}
	return {
		removed,
		redirectRestored,
		message: removed.length || redirectRestored
			? "Plugin removed. Restart OpenCode and the original opencode command will keep working."
			: "Plugin entry was not found. OpenCode itself was not modified.",
	};
}

function browserLauncherCandidates() {
	return [...new Set([
		LAUNCHER_FILE,
		join(homedir(), "Desktop", LAUNCHER_NAME),
		process.env.OneDrive ? join(process.env.OneDrive, "Desktop", LAUNCHER_NAME) : "",
	].filter(Boolean))];
}

function tuiConfigCandidates() {
	const home = homedir();
	const paths = [];
	if (process.env.XDG_CONFIG_HOME) paths.push(join(process.env.XDG_CONFIG_HOME, "opencode", "tui.json"));
	if (home) paths.push(join(home, ".config", "opencode", "tui.json"));
	if (process.env.APPDATA) paths.push(join(process.env.APPDATA, "opencode", "tui.json"));
	return [...new Set(paths)];
}

async function removePluginFromConfig(file) {
	if (!existsSync(file)) return false;
	const text = await readFile(file, "utf8");
	const config = JSON.parse(text || "{}");
	const plugins = Array.isArray(config.plugin) ? config.plugin : [];
	const next = plugins.filter((plugin) => !isThisPlugin(plugin));
	if (next.length === plugins.length) return false;
	config.plugin = next;
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return true;
}

function isThisPlugin(plugin) {
	return typeof plugin === "string" && (
		plugin === PLUGIN_ID ||
		plugin.startsWith(`${PLUGIN_ID}@`) ||
		plugin === REPOSITORY_SPEC ||
		plugin.startsWith(`${REPOSITORY_SPEC}#`)
	);
}

async function restoreCommandRedirect() {
	if (process.platform !== "win32") return false;
	const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
	const npmDir = join(appData, "npm");
	let restored = false;
	for (const extension of [".cmd", ".ps1"]) {
		const command = join(npmDir, `opencode${extension}`);
		const original = join(npmDir, `${REDIRECT_BACKUP_BASENAME}${extension}`);
		if (!existsSync(original) || !existsSync(command)) continue;
		const current = await readFile(command, "utf8");
		if (!ownsRedirect(current, REDIRECT_MARKER)) continue;
		await writeFile(command, await readFile(original, "utf8"), "utf8");
		await unlink(original).catch(() => {});
		restored = true;
	}
	return restored;
}

function resolveNodeExecutable() {
	if (process.platform !== "win32") return process.execPath;
	const candidates = [
		process.env.NODE,
		process.env.ProgramFiles ? join(process.env.ProgramFiles, "nodejs", "node.exe") : "",
		process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "nodejs", "node.exe") : "",
	].filter(Boolean);
	return candidates.find((candidate) => existsSync(candidate)) || "node.exe";
}

async function firstAvailableCommand(candidates) {
	for (const candidate of [...new Set(candidates)]) {
		if (await commandExists(candidate)) return candidate;
	}
	return "";
}

export {
	ensureBrowserLauncher,
	ensureCommandRedirect,
	firstAvailableCommand,
	uninstallPlugin,
	uninstallSelf,
};

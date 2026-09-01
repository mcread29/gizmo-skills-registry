#!/usr/bin/env node

import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(repoRoot, 'upstream-lock.json');
const sources = {
	pstack: { destination: 'extensions/pstack/skills' },
	'matt-pocock-skills': {
		destination: 'extensions/matt-pocock-skills/skills',
	},
};

const options = parseArguments(process.argv.slice(2));
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const selected = options.only ? [options.only] : Object.keys(sources);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'gizmo-skills-sync-'));

try {
	const updates = [];
	for (const id of selected) {
		const entry = lock[id];
		const source = sources[id];
		if (!entry || !source) throw new Error(`Unknown upstream: ${id}`);
		validateEntry(id, entry);

		const checkout = join(temporaryRoot, id, 'repository');
		run('git', [
			'clone',
			'--depth',
			'1',
			'--filter=blob:none',
			'--sparse',
			'--no-tags',
			entry.repository,
			checkout,
		]);
		run('git', ['-C', checkout, 'sparse-checkout', 'set', entry.path]);

		const commit = capture('git', ['-C', checkout, 'rev-parse', 'HEAD']);
		const sourceDirectory = safeInside(checkout, entry.path);
		const stagedDirectory = join(temporaryRoot, id, 'skills');
		await cp(sourceDirectory, stagedDirectory, { recursive: true });
		const skillCount = await countSkillFiles(stagedDirectory);
		if (skillCount === 0) {
			throw new Error(`${id}: upstream path contains no SKILL.md files`);
		}
		updates.push({
			id,
			commit,
			previousCommit: entry.commit,
			skillCount,
			stagedDirectory,
			destination: safeInside(repoRoot, source.destination),
		});
	}

	for (const update of updates) {
		const state = update.commit === update.previousCommit ? 'current' : 'update';
		console.log(
			`${update.id}: ${state} ${short(update.previousCommit)} -> ${short(update.commit)} (${update.skillCount} skills)`,
		);
	}

	if (options.dryRun) process.exitCode = 0;
	else {
		for (const update of updates) {
			if (update.commit === update.previousCommit) continue;
			await rm(update.destination, { recursive: true, force: true });
			await cp(update.stagedDirectory, update.destination, { recursive: true });
			lock[update.id].commit = update.commit;
		}
		await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
	}
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}

function parseArguments(args) {
	const result = { dryRun: false, only: undefined };
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--dry-run') result.dryRun = true;
		else if (argument === '--only') result.only = args[++index];
		else throw new Error(`Unknown argument: ${argument}`);
	}
	if (args.includes('--only') && !result.only) {
		throw new Error('--only requires an upstream id');
	}
	return result;
}

function validateEntry(id, entry) {
	if (
		typeof entry.repository !== 'string' ||
		!entry.repository.startsWith('https://github.com/') ||
		typeof entry.path !== 'string' ||
		entry.path.startsWith('/') ||
		entry.path.includes('..') ||
		typeof entry.commit !== 'string' ||
		!/^[0-9a-f]{40}$/.test(entry.commit)
	) {
		throw new Error(`${id}: invalid upstream-lock.json entry`);
	}
}

function safeInside(parent, child) {
	const path = resolve(parent, child);
	if (path !== parent && !path.startsWith(`${resolve(parent)}${sep}`)) {
		throw new Error(`Path escapes its root: ${child}`);
	}
	return path;
}

async function countSkillFiles(path) {
	let count = 0;
	for (const entry of await readdir(path, { withFileTypes: true })) {
		if (entry.isDirectory()) count += await countSkillFiles(join(path, entry.name));
		else if (entry.isFile() && entry.name === 'SKILL.md') count += 1;
	}
	return count;
}

function run(command, args) {
	const result = spawnSync(command, args, { stdio: 'inherit', shell: false });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
	}
}

function capture(command, args) {
	const result = spawnSync(command, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		shell: false,
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
	}
	return result.stdout.trim();
}

function short(commit) {
	return commit.slice(0, 8);
}

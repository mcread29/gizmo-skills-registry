#!/usr/bin/env node
// Imports Pi and Claude Code transcripts for one repo into an append-only
// journal of markdown segments. Zero dependencies: it parses the session
// JSONL directly so it runs in any repo, whatever that repo is written in.
//
//   node backfill-journal.mjs [--workspace DIR] [--out DIR]
//                             [--source pi|claude|both] [--dry-run]
//
// Safe to re-run: segments are keyed by source entry ids, so a second run
// imports only what is new.

import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	rename,
	writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const LIMITS = { toolResult: 800, toolArguments: 600, reasoning: 1200 };
// Caps one segment so a long session becomes several citable chunks rather
// than a single multi-megabyte file.
const MAX_SEGMENT_MESSAGES = 300;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
	const args = { source: 'both', dryRun: false };
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === '--dry-run') args.dryRun = true;
		else if (flag === '--workspace') args.workspace = argv[++i];
		else if (flag === '--out') args.out = argv[++i];
		else if (flag === '--source') args.source = argv[++i];
		else if (flag === '--help' || flag === '-h') args.help = true;
	}
	return args;
}

// ------------------------------------------------------------- normalizing

const isRecord = (value) => Boolean(value && typeof value === 'object');

function textContent(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter(
			(b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string',
		)
		.map((b) => b.text)
		.join('');
}

function reasoningText(content) {
	if (!Array.isArray(content)) return '';
	return content
		.filter(
			(b) =>
				isRecord(b) && b.type === 'thinking' && typeof b.thinking === 'string',
		)
		.map((b) => b.thinking)
		.join('\n\n');
}

function toolCalls(content) {
	if (!Array.isArray(content)) return [];
	return content
		.filter((b) => isRecord(b) && b.type === 'toolCall')
		.map((b) => ({
			id: String(b.id ?? ''),
			name: String(b.name ?? 'tool'),
			// Pi has used each of these keys across transcript versions.
			args: b.args ?? b.arguments ?? b.input ?? b.parameters ?? {},
		}));
}

// Keeps both ends, where a result's shape and its tail both show.
function truncate(text, limit) {
	if (text.length <= limit) return text;
	const half = Math.floor((limit - 1) / 2);
	const dropped = text.length - half * 2;
	return `${text.slice(0, half)}\n…[truncated ${dropped} chars]…\n${text.slice(-half)}`;
}

function assistantSection(message) {
	const parts = ['## assistant'];
	const text = textContent(message.content).trim();
	if (text) parts.push(text);
	const reasoning = reasoningText(message.content).trim();
	if (reasoning) {
		parts.push(`### reasoning\n\n${truncate(reasoning, LIMITS.reasoning)}`);
	}
	for (const call of toolCalls(message.content)) {
		const args = JSON.stringify(call.args ?? {}, null, 2);
		parts.push(
			`### tool ${call.name}\n\n\`\`\`json\n${truncate(args, LIMITS.toolArguments)}\n\`\`\``,
		);
	}
	// An assistant turn can carry only a stop reason; skip the empty header.
	return parts.length > 1 ? parts.join('\n\n') : undefined;
}

/**
 * Renders message entries as markdown. User and assistant prose is never
 * trimmed — that is where decisions live. Tool output is trimmed hard, except
 * errors, which are short and usually explain a later decision.
 */
function normalizeSegment(entries) {
	const sections = [];
	const toolNames = new Map();
	let messages = 0;
	for (const entry of entries) {
		const message = entry.message;
		if (!message) continue;
		if (message.role === 'user') {
			messages += 1;
			sections.push(`## user\n\n${textContent(message.content).trim()}`);
		} else if (message.role === 'assistant') {
			for (const call of toolCalls(message.content)) {
				toolNames.set(call.id, call.name);
			}
			const section = assistantSection(message);
			if (section) {
				messages += 1;
				sections.push(section);
			}
		} else if (message.role === 'toolResult') {
			const name = toolNames.get(message.toolCallId) ?? 'tool';
			const text = textContent(message.content).trim();
			sections.push(
				message.isError
					? `#### ${name} → error\n\n\`\`\`\n${text}\n\`\`\``
					: `#### ${name} → ok\n\n\`\`\`\n${truncate(text, LIMITS.toolResult)}\n\`\`\``,
			);
		}
	}
	return { body: sections.join('\n\n'), messages };
}

// --------------------------------------------------------- source discovery

/**
 * Windows paths are case-insensitive, and a transcript records whatever case
 * the session was started with. Comparing exactly means a --workspace spelled
 * with different capitalisation silently matches nothing.
 */
const samePath = (left, right) =>
	process.platform === 'win32'
		? left.toLowerCase() === right.toLowerCase()
		: left === right;

/** Both tools nest sessions in a directory per project; a flat scan finds none. */
async function jsonlFiles(dir, depth = 2) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
		else if (entry.isDirectory() && depth > 0) {
			files.push(...(await jsonlFiles(path, depth - 1)));
		}
	}
	return files;
}

function readJsonl(raw) {
	const records = [];
	for (const line of raw.split('\n')) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			// A torn line loses one message, not the transcript.
		}
	}
	return records;
}

/**
 * Pi transcripts are already in the target shape. The file is a tree, not a
 * list: walking the parent chain back from the newest entry yields the
 * canonical branch. Reading it flat would import retried and abandoned
 * siblings as duplicated prose.
 */
function parsePiTranscript(raw, fallbackId) {
	const records = readJsonl(raw);
	const header = records.find((r) => r.type === 'session');
	const entries = records.filter((r) => r.id && r.type && r.type !== 'session');
	if (entries.length === 0) return undefined;

	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch = [];
	let cursor = entries[entries.length - 1];
	while (cursor) {
		branch.push(cursor);
		cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
	}
	branch.reverse();

	const messages = branch.filter(
		(entry) => entry.type === 'message' && entry.message,
	);
	if (messages.length === 0) return undefined;
	return {
		sessionId: header?.id ?? fallbackId,
		cwd: header?.cwd ?? '',
		startedAt: Date.parse(messages[0].timestamp) || 0,
		entries: messages,
	};
}

/**
 * Claude Code records slash-command plumbing as user messages — the caveat
 * banner, the `<command-name>` envelope, the command's own stdout. None of it
 * is something the user said. System reminders are injected context, not
 * speech, so they are stripped from otherwise real messages.
 */
function cleanUserText(text) {
	if (
		/<(?:local-command-|command-name>|command-message>|command-args>)/.test(text)
	) {
		return '';
	}
	return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

function claudeAssistantBlock(block) {
	if (!isRecord(block)) return undefined;
	if (block.type === 'text' && typeof block.text === 'string') {
		return { type: 'text', text: block.text };
	}
	if (block.type === 'thinking' && typeof block.thinking === 'string') {
		return { type: 'thinking', thinking: block.thinking };
	}
	if (block.type === 'tool_use') {
		return {
			type: 'toolCall',
			id: String(block.id ?? ''),
			name: String(block.name ?? 'tool'),
			input: block.input ?? {},
		};
	}
	return undefined;
}

function claudeResultText(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.filter(
			(b) => isRecord(b) && b.type === 'text' && typeof b.text === 'string',
		)
		.map((b) => b.text)
		.join('\n');
}

/**
 * The trap this adapter exists for: Claude Code delivers tool results inside
 * `user` messages. Imported naively they are journaled as things the user
 * said, burying real prose under thousands of tool payloads.
 */
function translateClaudeRecord(record) {
	const id = String(record.uuid ?? '');
	const parentId =
		typeof record.parentUuid === 'string' ? record.parentUuid : null;
	const timestamp = String(record.timestamp ?? new Date().toISOString());
	const content = record.message?.content;
	const wrap = (message, suffix = '') => ({
		type: 'message',
		id: suffix ? `${id}${suffix}` : id,
		parentId,
		timestamp,
		message,
	});

	if (record.type === 'assistant') {
		const blocks = (Array.isArray(content) ? content : [])
			.map(claudeAssistantBlock)
			.filter(Boolean);
		return blocks.length ? [wrap({ role: 'assistant', content: blocks })] : [];
	}

	if (typeof content === 'string') {
		const text = cleanUserText(content);
		return text
			? [wrap({ role: 'user', content: [{ type: 'text', text }] })]
			: [];
	}
	if (!Array.isArray(content)) return [];

	const results = [];
	const prose = [];
	let index = 0;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === 'tool_result') {
			results.push(
				wrap(
					{
						role: 'toolResult',
						toolCallId: String(block.tool_use_id ?? ''),
						content: [{ type: 'text', text: claudeResultText(block.content) }],
						isError: block.is_error === true,
					},
					`:r${index++}`,
				),
			);
		} else if (block.type === 'text' && typeof block.text === 'string') {
			const text = cleanUserText(block.text);
			if (text) prose.push({ type: 'text', text });
		}
	}
	if (prose.length) results.unshift(wrap({ role: 'user', content: prose }));
	return results;
}

function parseClaudeTranscript(raw, fallbackId) {
	const entries = [];
	let sessionId;
	let cwd = '';
	let startedAt = 0;
	for (const record of readJsonl(raw)) {
		if (record.type !== 'user' && record.type !== 'assistant') continue;
		// Sidechains are subagent transcripts; they interleave incoherently.
		if (record.isSidechain === true) continue;
		if (typeof record.sessionId === 'string') sessionId ??= record.sessionId;
		if (typeof record.cwd === 'string' && !cwd) cwd = record.cwd;
		const at = Date.parse(String(record.timestamp ?? ''));
		if (Number.isFinite(at) && (!startedAt || at < startedAt)) startedAt = at;
		entries.push(...translateClaudeRecord(record));
	}
	if (entries.length === 0) return undefined;
	return { sessionId: sessionId ?? fallbackId, cwd, startedAt, entries };
}

// ------------------------------------------------------------------- store

async function readIndex(indexFile) {
	try {
		return readJsonl(await readFile(indexFile, 'utf8'));
	} catch {
		return [];
	}
}

/**
 * The newest entry a segment already ends at. Matching is by entry id across
 * the whole journal rather than by session id: forking copies every entry into
 * a new session file while preserving entry ids, so a session-keyed lookup
 * would re-import the entire inherited history under the new id.
 */
function resumeAfter(entries, index) {
	const boundaries = new Set(index.map((meta) => meta.lastEntryId));
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		if (boundaries.has(entries[i].id)) return entries[i].id;
	}
	return undefined;
}

function chunk(entries, size) {
	const chunks = [];
	for (let i = 0; i < entries.length; i += size) {
		chunks.push(entries.slice(i, i + size));
	}
	return chunks;
}

const safeId = (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '') || 'session';

function renderSegment(meta, body) {
	return [
		'---',
		`id: "${meta.id}"`,
		`session: ${meta.session}`,
		`entries: [${meta.firstEntryId}, ${meta.lastEntryId}]`,
		`at: ${meta.at}`,
		`messages: ${meta.messages}`,
		'trigger: backfill',
		`source: ${meta.source}`,
		'---',
		'',
		body,
		'',
	].join('\n');
}

/**
 * Writes the segment file before its index line, so a crash mid-append leaves
 * an unreferenced segment rather than an index entry pointing at nothing.
 */
async function writeSegment(dir, meta, body) {
	await mkdir(dir, { recursive: true });
	const file = join(dir, `${meta.id}-${meta.session}.md`);
	const temporary = `${file}.tmp`;
	await writeFile(temporary, renderSegment(meta, body), 'utf8');
	await rename(temporary, file);
	await appendFile(join(dir, 'index.jsonl'), `${JSON.stringify(meta)}\n`, 'utf8');
}

// -------------------------------------------------------------------- main

async function collect(args, workspace) {
	const found = [];
	const want = (name) => args.source === 'both' || args.source === name;

	if (want('pi')) {
		const dirs = [
			join(homedir(), '.pi', 'agent', 'sessions'),
			join(homedir(), '.gizmo', 'sessions'),
		];
		for (const dir of dirs) {
			for (const file of await jsonlFiles(dir)) {
				const parsed = parsePiTranscript(
					await readFile(file, 'utf8'),
					basename(file, '.jsonl'),
				);
				// The directory name is a mangled path; cwd in the file is exact.
				if (parsed && samePath(resolve(parsed.cwd || ''), workspace)) {
					found.push({ ...parsed, source: 'pi-archive' });
				}
			}
		}
	}

	if (want('claude')) {
		const dir = join(homedir(), '.claude', 'projects');
		for (const file of await jsonlFiles(dir)) {
			const parsed = parseClaudeTranscript(
				await readFile(file, 'utf8'),
				basename(file, '.jsonl'),
			);
			if (parsed && samePath(resolve(parsed.cwd || ''), workspace)) {
				found.push({ ...parsed, source: 'claude-code' });
			}
		}
	}

	return found.sort((a, b) => a.startedAt - b.startedAt);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(
			'Usage: node backfill-journal.mjs [--workspace DIR] [--out DIR]\n' +
				'                                [--source pi|claude|both] [--dry-run]',
		);
		return;
	}

	const workspace = resolve(args.workspace ?? process.cwd());
	const out = args.dryRun
		? join(tmpdir(), `journal-dryrun-${Date.now()}`)
		: resolve(args.out ?? join(workspace, '.agent-journal'));

	const sessions = await collect(args, workspace);
	let index = await readIndex(join(out, 'index.jsonl'));
	let written = 0;
	let skipped = 0;
	let messages = 0;
	const bySource = {};

	for (const session of sessions) {
		const resume = resumeAfter(session.entries, index);
		const start = resume
			? session.entries.findIndex((e) => e.id === resume) + 1
			: 0;
		const pending = session.entries.slice(start);
		if (pending.length === 0) {
			skipped += 1;
			continue;
		}
		for (const part of chunk(pending, MAX_SEGMENT_MESSAGES)) {
			const segment = normalizeSegment(part);
			if (!segment.body.trim()) continue;
			const meta = {
				id: String(index.length + 1).padStart(4, '0'),
				session: safeId(session.sessionId),
				firstEntryId: part[0].id,
				lastEntryId: part[part.length - 1].id,
				at: new Date().toISOString(),
				messages: segment.messages,
				bytes: Buffer.byteLength(segment.body, 'utf8'),
				source: session.source,
			};
			await writeSegment(out, meta, segment.body);
			index = [...index, meta];
			written += 1;
			messages += segment.messages;
			bySource[session.source] = (bySource[session.source] ?? 0) + 1;
		}
	}

	console.log(`Workspace:        ${workspace}`);
	console.log(`Journal:          ${out}${args.dryRun ? '  (dry run)' : ''}`);
	console.log(`Sessions found:   ${sessions.length}`);
	console.log(`Segments written: ${written} (${messages} messages)`);
	for (const [source, count] of Object.entries(bySource)) {
		console.log(`  ${source}: ${count}`);
	}
	console.log(`Already imported: ${skipped}`);
	if (written && !args.dryRun) {
		console.log(
			`\nAdd "${basename(out)}/" to .gitignore unless you mean to commit transcripts.`,
		);
	}
}

await main();

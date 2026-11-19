import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HttpResult, JournalEntry } from './runtime.js';

/**
 * Append-only JSON Lines journal. Each line is one event:
 *   {"type":"write", "entry": {...}}           a journaled write and its resolved inverse
 *   {"type":"undo",  "seq": 3, "at": "...", "response": {...}}   that write was undone
 *
 * Appending (never rewriting) keeps the file safe to tail, ship to a log
 * pipeline, and read while an agent is still running.
 */
export type JournalEvent =
  | { type: 'write'; entry: JournalEntry }
  | { type: 'undo'; seq: number; at: string; response: HttpResult; forced?: boolean };

export async function appendJournalEvent(file: string, event: JournalEvent): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(event) + '\n', 'utf8');
}

/** Rebuild journal entries (with their undone state) from a journal file. Missing file = empty journal. */
export async function readJournal(file: string): Promise<JournalEntry[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const entries = new Map<number, JournalEntry>();
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let event: JournalEvent;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error(`${file}:${i + 1}: not valid JSON`);
    }
    if (event.type === 'write') entries.set(event.entry.seq, { ...event.entry });
    else if (event.type === 'undo') {
      const e = entries.get(event.seq);
      if (e) {
        e.undone = true;
        e.undoResponse = event.response;
      }
    }
  });
  return [...entries.values()].sort((a, b) => a.seq - b.seq);
}

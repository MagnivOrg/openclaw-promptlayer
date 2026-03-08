// SPDX-License-Identifier: MIT
/**
 * 将 OpenClaw hook 原始 payload 落盘，便于离线复现与调试。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { safeJsonStringify } from './util.js';

interface HookLogRecord {
  hook: string;
  capturedAt: string;
  event: unknown;
  ctx: unknown;
}

let ensuredLogDirectory = false;

function getHookLogDirectory(): string {
  return join(homedir(), '.openclaw', 'logs');
}

function ensureHookLogDirectory(): void {
  if (ensuredLogDirectory) return;
  mkdirSync(getHookLogDirectory(), { recursive: true });
  ensuredLogDirectory = true;
}

function getHookLogFilePath(now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return join(getHookLogDirectory(), `openclaw-logfire-hooks-${day}.jsonl`);
}

export function persistRawHookPayload(
  hook: string,
  event: unknown,
  ctx: unknown,
): void {
  try {
    ensureHookLogDirectory();
    const now = new Date();
    const record: HookLogRecord = {
      hook,
      capturedAt: now.toISOString(),
      event,
      ctx,
    };
    appendFileSync(
      getHookLogFilePath(now),
      `${safeJsonStringify(record)}\n`,
      'utf8',
    );
  } catch {
    // 调试日志不应影响主链路。
  }
}

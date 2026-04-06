/**
 * Single unified `lsp` tool registration.
 *
 * 11 operations routed to the right server by file extension.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { StringEnum } from '@mariozechner/pi-ai';

import type { LspClient } from './client';
import {
  formatCallHierarchy,
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatIncomingCalls,
  formatLocations,
  formatOutgoingCalls,
  formatWorkspaceSymbols,
} from './formatting';
import type { Diagnostic } from './types';
import {
  FILE_ONLY_OPERATIONS,
  LSP_OPERATIONS,
  type LspOperation,
  POSITION_OPERATIONS,
  QUERY_OPERATIONS,
} from './types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanPath(path: string): string {
  return path.replace(/^@/, '');
}

function toZeroIndexed(oneIndexed: number): number {
  return Math.max(0, oneIndexed - 1);
}

function validateParams(
  operation: LspOperation,
  filePath?: string,
  line?: number,
  character?: number,
  query?: string,
): string | null {
  if (POSITION_OPERATIONS.includes(operation)) {
    if (!filePath) return `Operation '${operation}' requires filePath`;
    if (line === undefined) return `Operation '${operation}' requires line`;
    if (character === undefined) return `Operation '${operation}' requires character`;
  }
  if (FILE_ONLY_OPERATIONS.includes(operation)) {
    if (!filePath) return `Operation '${operation}' requires filePath`;
  }
  if (QUERY_OPERATIONS.includes(operation)) {
    if (!query) return `Operation '${operation}' requires query`;
  }
  return null;
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface WorkspaceFileTarget {
  inputPath: string;
  absolutePath: string;
  workspaceRoot: string;
  workspaceFilePath: string;
}

export interface ServerManager {
  /** Resolve a file path into a workspace-relative target. */
  resolveFileTarget?: (filePath: string) => Promise<WorkspaceFileTarget>;
  /** Get all LSP clients that handle a given file extension. */
  clientsForFile: (target: WorkspaceFileTarget) => Promise<LspClient[]>;
  /** Get the first LSP client that handles a file and has a capability. */
  clientForFileWithCapability: (
    target: WorkspaceFileTarget,
    capability: string,
  ) => Promise<LspClient | null>;
  /** Get any initialized client (for workspace-wide ops). */
  anyClient: () => Promise<LspClient | null>;
  /** Current workspace root for status updates. */
  getWorkspaceRootForStatus?: (filePath?: string) => Promise<string>;
  /** Backward-compatible single-root fallback. */
  getRootPath?: () => string;
}

// ── Capability map ──────────────────────────────────────────────────────────

const CAPABILITY_MAP: Record<LspOperation, string> = {
  diagnostics: 'textDocumentSync',
  hover: 'hoverProvider',
  goToDefinition: 'definitionProvider',
  findReferences: 'referencesProvider',
  goToImplementation: 'implementationProvider',
  documentSymbol: 'documentSymbolProvider',
  workspaceSymbol: 'workspaceSymbolProvider',
  prepareCallHierarchy: 'callHierarchyProvider',
  incomingCalls: 'callHierarchyProvider',
  outgoingCalls: 'callHierarchyProvider',
  codeActions: 'codeActionProvider',
};

// ── Registration ────────────────────────────────────────────────────────────

function defaultTarget(filePath: string, mgr: ServerManager): WorkspaceFileTarget {
  const rootPath = mgr.getRootPath?.() ?? '';
  return {
    inputPath: filePath,
    absolutePath: filePath,
    workspaceRoot: rootPath,
    workspaceFilePath: filePath,
  };
}

export function registerLspTool(pi: ExtensionAPI, mgr: ServerManager) {
  pi.registerTool({
    name: 'lsp',
    label: 'LSP',
    description: [
      'Interact with Language Server Protocol servers for code intelligence.',
      '',
      'Supported operations:',
      '  goToDefinition    — find where a symbol is defined',
      '  findReferences    — find all references to a symbol',
      '  hover             — get type info and documentation for a symbol',
      '  diagnostics       — get type errors and lint warnings for a file',
      '  documentSymbol    — get all symbols in a file',
      '  workspaceSymbol   — search symbols across the workspace',
      '  goToImplementation — find implementations of an interface/abstract method',
      '  prepareCallHierarchy — get call hierarchy item at a position',
      '  incomingCalls     — find callers of a function/method',
      '  outgoingCalls     — find callees of a function/method',
      '  codeActions       — quick fixes and refactoring suggestions',
      '',
      'Parameters:',
      '  operation (required) — one of the operations above',
      '  filePath  — file path relative to project root (required for most operations)',
      '  line      — line number, 1-indexed (required for position-based operations)',
      '  character — column number, 1-indexed (required for position-based operations)',
      '  query     — search string (required for workspaceSymbol)',
    ].join('\n'),
    promptSnippet:
      'Interact with LSP servers for code intelligence: definitions, references, hover, diagnostics, symbols, call hierarchy, code actions',
    promptGuidelines: [
      'Use `diagnostics` after editing files to check for type errors and lint issues.',
      'Use `hover` to understand types, `goToDefinition` to navigate, `findReferences` before refactoring.',
      'Line and character are 1-indexed — use the line numbers shown by the read tool.',
      'LSP servers are auto-detected by file extension. Use /lsp to check status.',
    ],
    parameters: Type.Object({
      operation: StringEnum(LSP_OPERATIONS),
      filePath: Type.Optional(Type.String({ description: 'File path relative to project root' })),
      line: Type.Optional(Type.Number({ description: 'Line number (1-indexed)' })),
      character: Type.Optional(Type.Number({ description: 'Column number (1-indexed)' })),
      query: Type.Optional(Type.String({ description: 'Search query (for workspaceSymbol)' })),
    }),
    async execute(_toolCallId, params) {
      const operation = params.operation as LspOperation;
      const filePath = params.filePath ? cleanPath(params.filePath) : undefined;
      const line = params.line;
      const character = params.character;
      const query = params.query;

      const validationError = validateParams(operation, filePath, line, character, query);
      if (validationError) throw new Error(validationError);

      const target = filePath
        ? mgr.resolveFileTarget
          ? await mgr.resolveFileTarget(filePath)
          : defaultTarget(filePath, mgr)
        : null;

      if (operation === 'diagnostics') {
        return executeDiagnostics(mgr, target!);
      }

      if (operation === 'workspaceSymbol') {
        return executeWorkspaceSymbol(mgr, query!);
      }

      const capability = CAPABILITY_MAP[operation];
      const client = await mgr.clientForFileWithCapability(target!, capability);
      if (!client) {
        throw new Error(
          `No LSP server with '${operation}' capability found for ${target!.inputPath}. Check /lsp status.`,
        );
      }

      const pos = { line: toZeroIndexed(line!), character: toZeroIndexed(character!) };

      switch (operation) {
        case 'hover': {
          const result = await client.hover(target!.workspaceFilePath, pos);
          return ok(formatHover(result, target!.inputPath, pos.line, pos.character));
        }

        case 'goToDefinition': {
          const locs = await client.definition(target!.workspaceFilePath, pos);
          return ok(
            formatLocations(
              locs,
              'Definition',
              target!.inputPath,
              pos.line,
              pos.character,
              target!.workspaceRoot,
            ),
          );
        }

        case 'findReferences': {
          const locs = await client.references(target!.workspaceFilePath, pos);
          return ok(
            formatLocations(
              locs,
              'References',
              target!.inputPath,
              pos.line,
              pos.character,
              target!.workspaceRoot,
            ),
          );
        }

        case 'goToImplementation': {
          const locs = await client.implementation(target!.workspaceFilePath, pos);
          return ok(
            formatLocations(
              locs,
              'Implementation',
              target!.inputPath,
              pos.line,
              pos.character,
              target!.workspaceRoot,
            ),
          );
        }

        case 'documentSymbol': {
          const symbols = await client.documentSymbol(target!.workspaceFilePath);
          return ok(formatDocumentSymbols(symbols, target!.inputPath, target!.workspaceRoot));
        }

        case 'prepareCallHierarchy': {
          const items = await client.prepareCallHierarchy(target!.workspaceFilePath, pos);
          return ok(
            formatCallHierarchy(
              items,
              target!.inputPath,
              pos.line,
              pos.character,
              target!.workspaceRoot,
            ),
          );
        }

        case 'incomingCalls': {
          const items = await client.prepareCallHierarchy(target!.workspaceFilePath, pos);
          if (items.length === 0) {
            return ok(`No call hierarchy item at ${target!.inputPath}:${line}:${character}`);
          }
          const calls = await client.incomingCalls(items[0]);
          return ok(formatIncomingCalls(calls, items[0], target!.workspaceRoot));
        }

        case 'outgoingCalls': {
          const items = await client.prepareCallHierarchy(target!.workspaceFilePath, pos);
          if (items.length === 0) {
            return ok(`No call hierarchy item at ${target!.inputPath}:${line}:${character}`);
          }
          const calls = await client.outgoingCalls(items[0]);
          return ok(formatOutgoingCalls(calls, items[0], target!.workspaceRoot));
        }

        case 'codeActions': {
          const diagsForFile = await client.getDiagnostics(target!.workspaceFilePath);
          const zeroLine = toZeroIndexed(line!);
          const lineDiags = diagsForFile.filter(
            (d) => d.range.start.line <= zeroLine && d.range.end.line >= zeroLine,
          );
          const range = {
            start: { line: zeroLine, character: 0 },
            end: { line: zeroLine, character: Number.MAX_SAFE_INTEGER },
          };
          const actions = await client.codeActions(target!.workspaceFilePath, range, {
            diagnostics: lineDiags,
          });
          return ok(formatCodeActions(actions, target!.inputPath, zeroLine));
        }

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
  });
}

// ── Operation executors ─────────────────────────────────────────────────────

async function executeDiagnostics(mgr: ServerManager, target: WorkspaceFileTarget) {
  const groups: { source: string; diagnostics: Diagnostic[] }[] = [];
  const errors: string[] = [];

  const clients = await mgr.clientsForFile(target);
  for (const client of clients) {
    try {
      const diags = await client.getDiagnostics(target.workspaceFilePath);
      if (diags.length > 0) {
        groups.push({ source: client.config.name, diagnostics: diags });
      }
    } catch (err) {
      errors.push(`${client.config.name}: ${(err as Error).message}`);
    }
  }

  const text = formatDiagnostics(target.inputPath, groups);
  const errorNote = errors.length > 0 ? `\n\nNote: ${errors.join('; ')}` : '';

  return {
    content: [{ type: 'text' as const, text: text + errorNote }],
    details: {
      groups: groups.map((g) => ({ source: g.source, count: g.diagnostics.length })),
      errors,
    },
  };
}

async function executeWorkspaceSymbol(mgr: ServerManager, query: string) {
  const client = await mgr.anyClient();
  if (!client) throw new Error('No LSP server available for workspace symbol search.');

  return ok(formatWorkspaceSymbols(await client.workspaceSymbol(query), query, client.workspaceRoot));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function ok(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: {},
  };
}

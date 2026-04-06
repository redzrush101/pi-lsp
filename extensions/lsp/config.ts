/**
 * LSP server configuration loader.
 *
 * Purely config-driven — no built-in servers. Users define all servers
 * in their config files:
 *
 *   ~/.pi/agent/extensions/lsp/config.json  (global defaults)
 *   .pi/lsp.json                            (project overrides)
 *
 * Project config merges on top of global. `disabled: true` disables a server.
 * `lsp: false` disables all LSP functionality.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

import type { LspConfigFile, LspServerUserConfig, ResolvedServerConfig } from './types';

// ── Paths ───────────────────────────────────────────────────────────────────

function globalConfigPath(): string {
  return join(process.env.HOME ?? homedir(), '.pi', 'agent', 'extensions', 'lsp', 'config.json');
}

function projectConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.pi', 'lsp.json');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const STARTER_CONFIG = `{
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]
    }
  }
}
`;

const WORKSPACE_MARKERS = ['.pi/lsp.json', 'package.json', 'tsconfig.json', 'jsconfig.json', '.git'];

// ── Workspace discovery ─────────────────────────────────────────────────────

async function hasWorkspaceMarker(dir: string): Promise<boolean> {
  for (const marker of WORKSPACE_MARKERS) {
    if (await fileExists(join(dir, marker))) return true;
  }
  return false;
}

export async function findWorkspaceRoot(startPath: string): Promise<string> {
  let current = resolve(startPath);

  while (true) {
    if (await hasWorkspaceMarker(current)) return current;

    const parent = dirname(current);
    if (parent === current) return resolve(startPath);
    current = parent;
  }
}

/**
 * Scaffold a starter global config if neither global nor project config exists.
 * Returns true if a file was created.
 */
export async function scaffoldGlobalConfig(cwd: string): Promise<boolean> {
  const globalPath = globalConfigPath();
  const workspaceRoot = await findWorkspaceRoot(cwd);
  const projectPath = projectConfigPath(workspaceRoot);

  if (await fileExists(globalPath)) return false;
  if (await fileExists(projectPath)) return false;

  await mkdir(dirname(globalPath), { recursive: true });
  await writeFile(globalPath, STARTER_CONFIG, 'utf8');
  return true;
}

// ── Loading ─────────────────────────────────────────────────────────────────

async function loadJsonFile<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function commandAvailableVia(command: string, cwd: string): 'global' | 'npx' | null {
  try {
    execSync(`which ${command}`, { stdio: 'pipe', timeout: 5_000 });
    return 'global';
  } catch {
    // not global
  }
  try {
    execSync(`npx --yes ${command} --version`, { stdio: 'pipe', cwd, timeout: 15_000 });
    return 'npx';
  } catch {
    return null;
  }
}

// ── Resolving ───────────────────────────────────────────────────────────────

function resolveServer(
  name: string,
  config: LspServerUserConfig,
  workspaceRoot: string,
): ResolvedServerConfig | null {
  if (config.disabled) return null;
  if (!config.command || config.command.length === 0) return null;
  if (!config.extensions || config.extensions.length === 0) return null;

  let finalCommand = config.command[0];
  let finalArgs = config.command.slice(1);

  const via = commandAvailableVia(finalCommand, workspaceRoot);
  if (!via) return null;
  if (via === 'npx') {
    finalArgs = ['--yes', finalCommand, ...finalArgs];
    finalCommand = 'npx';
  }

  return {
    name,
    command: finalCommand,
    args: finalArgs,
    extensions: config.extensions,
    env: config.env ?? {},
    initializationOptions: config.initialization ?? {},
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface LoadedConfig {
  workspaceRoot: string;
  servers: ResolvedServerConfig[];
  globalDisabled: boolean;
  errors: string[];
}

export async function loadConfig(workspaceRoot: string): Promise<LoadedConfig> {
  const resolvedWorkspaceRoot = await findWorkspaceRoot(workspaceRoot);
  const errors: string[] = [];

  const globalConfig = await loadJsonFile<LspConfigFile>(globalConfigPath());
  const projectConfig = await loadJsonFile<LspConfigFile>(projectConfigPath(resolvedWorkspaceRoot));

  // Check if globally disabled
  if (globalConfig?.lsp === false || projectConfig?.lsp === false) {
    return { workspaceRoot: resolvedWorkspaceRoot, servers: [], globalDisabled: true, errors };
  }

  const globalServers = (typeof globalConfig?.lsp === 'object' ? globalConfig.lsp : {}) as Record<
    string,
    LspServerUserConfig
  >;
  const projectServers = (
    typeof projectConfig?.lsp === 'object' ? projectConfig.lsp : {}
  ) as Record<string, LspServerUserConfig>;

  // Merge: project overrides global
  const allNames = new Set([...Object.keys(globalServers), ...Object.keys(projectServers)]);
  const servers: ResolvedServerConfig[] = [];

  for (const name of allNames) {
    const userConfig: LspServerUserConfig = {
      ...globalServers[name],
      ...projectServers[name],
    };

    // Merge env maps properly
    if (globalServers[name]?.env || projectServers[name]?.env) {
      userConfig.env = { ...globalServers[name]?.env, ...projectServers[name]?.env };
    }

    const resolved = resolveServer(name, userConfig, resolvedWorkspaceRoot);
    if (resolved) {
      servers.push(resolved);
    }
  }

  return { workspaceRoot: resolvedWorkspaceRoot, servers, globalDisabled: false, errors };
}

/** Find all servers that handle a given file extension. */
export function serversForExtension(
  servers: ResolvedServerConfig[],
  filePath: string,
): ResolvedServerConfig[] {
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  return servers.filter((s) => s.extensions.includes(ext));
}

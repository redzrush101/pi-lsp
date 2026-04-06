/**
 * Pi LSP Extension
 *
 * Language-agnostic code intelligence via LSP.
 * Auto-detects servers by file extension, configurable via:
 *   - ~/.pi/agent/extensions/lsp/config.json  (global defaults)
 *   - .pi/lsp.json                            (project overrides)
 *
 * Any LSP server can be added via config.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { dirname, relative, resolve } from 'node:path';

import { LspClient } from './client';
import { findWorkspaceRoot, loadConfig, scaffoldGlobalConfig, serversForExtension, type LoadedConfig } from './config';
import { registerLspTool, type ServerManager, type WorkspaceFileTarget } from './tools';
import type { ResolvedServerConfig } from './types';

interface WorkspaceContext {
  rootPath: string;
  config: LoadedConfig;
}

export default function lspExtension(pi: ExtensionAPI) {
  let sessionRoot = '';
  const configs = new Map<string, LoadedConfig>();
  const clients = new Map<string, LspClient>();

  // ── Helpers ───────────────────────────────────────────────────────────

  function clientKey(workspaceRoot: string, serverName: string): string {
    return `${workspaceRoot}::${serverName}`;
  }

  async function getWorkspaceContext(workspaceRoot: string): Promise<WorkspaceContext> {
    const resolvedRoot = await findWorkspaceRoot(workspaceRoot);
    let config = configs.get(resolvedRoot);
    if (!config) {
      config = await loadConfig(resolvedRoot);
      configs.set(resolvedRoot, config);
    }
    return { rootPath: resolvedRoot, config };
  }

  async function resolveFileTarget(filePath: string): Promise<WorkspaceFileTarget> {
    const absolutePath = filePath.startsWith('/') ? filePath : resolve(sessionRoot, filePath);
    const workspaceRoot = await findWorkspaceRoot(dirname(absolutePath));
    const relativePath = relative(workspaceRoot, absolutePath);

    return {
      inputPath: filePath,
      absolutePath,
      workspaceRoot,
      workspaceFilePath: relativePath,
    };
  }

  function getOrCreateClient(serverConfig: ResolvedServerConfig, workspaceRoot: string): LspClient {
    const key = clientKey(workspaceRoot, serverConfig.name);
    const existing = clients.get(key);
    if (existing) return existing;

    const client = new LspClient(serverConfig, workspaceRoot);
    clients.set(key, client);
    return client;
  }

  async function shutdownAll(): Promise<void> {
    const shutdowns = [...clients.values()].map((c) => c.shutdown().catch(() => {}));
    await Promise.all(shutdowns);
    clients.clear();
    configs.clear();
  }

  function refreshStatus(
    ui: { setStatus: (key: string, value: string) => void },
    cfg: LoadedConfig | null,
    workspaceRoot?: string,
  ) {
    if (!cfg) {
      ui.setStatus('lsp', 'LSP: no servers detected');
      return;
    }

    if (cfg.globalDisabled) {
      ui.setStatus('lsp', 'LSP: disabled');
      return;
    }

    if (cfg.servers.length === 0) {
      ui.setStatus('lsp', 'LSP: no servers detected');
      return;
    }

    const root = workspaceRoot ?? cfg.workspaceRoot;
    const running = cfg.servers.filter((server) =>
      clients.get(clientKey(root, server.name))?.isInitialized,
    );
    if (running.length > 0) {
      ui.setStatus('lsp', `LSP: ${running.map((s) => s.name).join(', ')} (running)`);
      return;
    }

    ui.setStatus('lsp', `LSP: ${cfg.servers.map((s) => s.name).join(', ')}`);
  }

  // ── Server manager (passed to tool) ───────────────────────────────────

  const serverManager: ServerManager = {
    async resolveFileTarget(filePath: string): Promise<WorkspaceFileTarget> {
      return resolveFileTarget(filePath);
    },

    async clientsForFile(target: WorkspaceFileTarget): Promise<LspClient[]> {
      const ctx = await getWorkspaceContext(target.workspaceRoot);
      const matching = serversForExtension(ctx.config.servers, target.workspaceFilePath);
      return matching.map((s) => getOrCreateClient(s, ctx.rootPath));
    },

    async clientForFileWithCapability(
      target: WorkspaceFileTarget,
      capability: string,
    ): Promise<LspClient | null> {
      const ctx = await getWorkspaceContext(target.workspaceRoot);
      const matching = serversForExtension(ctx.config.servers, target.workspaceFilePath);
      for (const serverConfig of matching) {
        const client = getOrCreateClient(serverConfig, ctx.rootPath);
        if (!client.isInitialized) return client;
        if (client.hasCapability(capability)) return client;
      }
      return null;
    },

    async anyClient(): Promise<LspClient | null> {
      for (const client of clients.values()) {
        if (client.isInitialized) return client;
      }

      const ctx = await getWorkspaceContext(sessionRoot);
      if (ctx.config.servers.length > 0) {
        return getOrCreateClient(ctx.config.servers[0], ctx.rootPath);
      }
      return null;
    },

    async getWorkspaceRootForStatus(filePath?: string): Promise<string> {
      if (filePath) {
        const target = await resolveFileTarget(filePath);
        return target.workspaceRoot;
      }
      return findWorkspaceRoot(sessionRoot);
    },
  };

  // ── Register tool ─────────────────────────────────────────────────────

  registerLspTool(pi, serverManager);

  // ── Session lifecycle ─────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    sessionRoot = ctx.cwd;

    const scaffolded = await scaffoldGlobalConfig(sessionRoot);
    if (scaffolded) {
      ctx.ui.notify(
        'LSP: created starter config at ~/.pi/agent/extensions/lsp/config.json — edit it to add your servers.',
        'info',
      );
    }

    const initialConfig = await loadConfig(sessionRoot);
    configs.set(initialConfig.workspaceRoot, initialConfig);
    refreshStatus(ctx.ui, initialConfig, initialConfig.workspaceRoot);
  });

  pi.on('session_shutdown', async () => {
    await shutdownAll();
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    if (event.toolName !== 'lsp') return;
    const cfg = await loadConfig(sessionRoot);
    configs.set(cfg.workspaceRoot, cfg);
    refreshStatus(ctx.ui, cfg, cfg.workspaceRoot);
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand('lsp', {
    description: 'Show LSP server status',
    handler: async (_args, ctx) => {
      sessionRoot = ctx.cwd;
      const cfg = await loadConfig(sessionRoot);
      configs.set(cfg.workspaceRoot, cfg);
      refreshStatus(ctx.ui, cfg, cfg.workspaceRoot);
      const lines: string[] = ['LSP Status:', `  Workspace: ${cfg.workspaceRoot}`];

      if (cfg.globalDisabled) {
        lines.push('  All servers disabled via config.');
      } else if (cfg.servers.length === 0) {
        lines.push('  No servers configured.');
        lines.push('  Add servers to ~/.pi/agent/extensions/lsp/config.json or .pi/lsp.json');
      } else {
        for (const server of cfg.servers) {
          const client = clients.get(clientKey(cfg.workspaceRoot, server.name));
          const status = client?.isInitialized ? 'running' : 'available (lazy start)';
          const exts = server.extensions.join(', ');
          lines.push(`  ${server.name}: ${status} — handles ${exts}`);
        }
      }

      if (cfg.errors.length > 0) {
        lines.push('', 'Config errors:');
        for (const err of cfg.errors) lines.push(`  - ${err}`);
      }

      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });

  pi.registerCommand('lsp-restart', {
    description: 'Restart all LSP servers',
    handler: async (_args, ctx) => {
      await shutdownAll();
      sessionRoot = ctx.cwd;
      const cfg = await loadConfig(sessionRoot);
      configs.set(cfg.workspaceRoot, cfg);
      refreshStatus(ctx.ui, cfg, cfg.workspaceRoot);
      ctx.ui.notify('LSP servers stopped. Will reinitialize on next tool use.', 'info');
    },
  });
}

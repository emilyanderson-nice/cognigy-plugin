#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadRuntimeSettings } from "./runtimeSettings.js";
import { buildServerParts } from "./server/bootstrap.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { logger } from "./utils/logger.js";

async function main() {
  try {
    const settings = loadRuntimeSettings();
    logger.setLevel(settings.logLevel);
    logger.info("Starting NiCE Cognigy Plugin", {
      name: settings.serverName,
      version: settings.serverVersion,
    });

    const { dispatcher, rateLimiter, sessionState, startupNotices } =
      buildServerParts();
    for (const notice of startupNotices()) logger.warn(notice);

    const server = new Server(
      { name: settings.serverName, version: settings.serverVersion },
      {
        capabilities: { tools: {} },
        instructions: SERVER_INSTRUCTIONS,
      },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: dispatcher.listTools(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      return { ...(await dispatcher.callTool(name, args || {})) };
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("NiCE Cognigy Plugin started successfully");

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      // `finally` so a failing close can never strand the process: the guard
      // above means a later signal won't retry, and this runs as an event
      // listener, where a rejection would otherwise be unhandled.
      try {
        logger.info("Shutting down NiCE Cognigy Plugin");
        sessionState.remove();
        rateLimiter.destroy();
        await server.close();
      } catch (error: any) {
        logger.error("Error during shutdown", { error: error?.message });
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    // StdioServerTransport never listens for stdin ending — if the parent
    // (Claude Code, or an `npx` wrapper) tears down the connection by closing
    // the pipes instead of sending a signal, nothing here would otherwise
    // notice. Without this, the RateLimiter's setInterval keeps the event
    // loop alive forever, turning every such disconnect into an orphaned,
    // memory-holding process. Treat stdin ending as a disconnect too.
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
  } catch (error: any) {
    logger.error("Failed to start MCP Server", {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

main();

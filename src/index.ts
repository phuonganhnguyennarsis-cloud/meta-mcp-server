#!/usr/bin/env node
/**
 * meta-mcp-server
 *
 * MCP server for a business's own Meta App: publish/schedule Facebook Page posts,
 * publish Instagram posts (image/carousel/reel), and create & manage Meta Marketing
 * API (ads) campaigns, ad sets, creatives, and ads.
 *
 * Auth to Meta: a long-lived Page / System User access token (see README.md).
 *
 * Transport: this server supports two modes, chosen automatically:
 *   - HTTP (Streamable HTTP), when a PORT environment variable is set — this is how
 *     hosting platforms like Render/Railway run web services, and it's what a "Remote
 *     MCP server URL" connector in Claude talks to over https://.
 *   - stdio, otherwise — for running as a local MCP server (Claude Code, or a Claude
 *     Desktop app that supports local/stdio MCP servers).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { registerFacebookTools } from "./tools/facebook.js";
import { registerInstagramTools } from "./tools/instagram.js";
import { registerAdsTools } from "./tools/ads.js";

// Importing services/config here (indirectly, via the tool modules) validates
// META_ACCESS_TOKEN is set and exits with a clear error before we try to connect.

function buildServer(): McpServer {
  const server = new McpServer({
    name: "meta-mcp-server",
    version: "1.0.0",
  });
  registerFacebookTools(server);
  registerInstagramTools(server);
  registerAdsTools(server);
  return server;
}

async function runStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never log to stdout on a stdio server — it corrupts the protocol stream.
  console.error("meta-mcp-server running on stdio");
}

async function runHttp(port: number): Promise<void> {
  const sharedSecret = process.env.MCP_SHARED_SECRET;
  if (!sharedSecret) {
    console.error(
      "ERROR: MCP_SHARED_SECRET environment variable is required when running in HTTP mode. " +
        "This server is reachable over the public internet once deployed, so a shared secret " +
        "keeps strangers from using your Meta access token. Set MCP_SHARED_SECRET to any long " +
        "random string, then use it in the URL you give Claude, e.g. " +
        "https://your-app.onrender.com/mcp?key=<the-same-secret>."
    );
    process.exit(1);
  }

  const server = buildServer();
  // Stateless mode: no session tracking needed for a small single-tenant tool server.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // Plain health check for the hosting platform / uptime pings — no secret required.
    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("meta-mcp-server ok");
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const authHeader = req.headers.authorization;
    const providedKey =
      url.searchParams.get("key") ??
      (authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined);

    if (providedKey !== sharedSecret) {
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "Unauthorized: missing or invalid key" }));
      return;
    }

    let parsedBody: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
    }

    try {
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`meta-mcp-server listening on port ${port} (MCP endpoint at /mcp)`);
  });
}

async function main(): Promise<void> {
  const port = process.env.PORT ? Number(process.env.PORT) : undefined;
  if (port) {
    await runHttp(port);
  } else {
    await runStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error starting meta-mcp-server:", error);
  process.exit(1);
});

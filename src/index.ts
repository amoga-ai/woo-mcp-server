// src/index.ts: Read-only MCP server that exposes WooCommerce report endpoints over HTTP, guarded by a bearer token.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// Reads a required environment variable, or stops with a clear error.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const STORE_URL = required("WOO_STORE_URL").replace(/\/$/, "");
const CONSUMER_KEY = required("WOO_CONSUMER_KEY");
const CONSUMER_SECRET = required("WOO_CONSUMER_SECRET");
const MCP_TOKEN = required("MCP_TOKEN");
const PORT = Number(process.env.PORT ?? 3000);

// Calls one WooCommerce report endpoint with the store keys and returns its JSON.
async function wooReport(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${STORE_URL}/wp-json/wc/v3/reports/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`WooCommerce report ${path} returned ${res.status}`);
  return res.json();
}

// Wraps any result as MCP text content.
function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

// Builds a server with the report tools. Only read endpoints are registered.
function buildServer(): McpServer {
  const server = new McpServer({ name: "woocommerce-reports", version: "1.0.0" });

  // Sales totals by day for a period.
  server.registerTool(
    "get_sales_report",
    {
      description: "Sales totals grouped by day for a period: sales, orders, items, tax, shipping, discounts, refunds, and customers.",
      inputSchema: {
        period: z.enum(["day", "week", "month", "last_month", "year"]).default("month"),
      },
    },
    async ({ period }) => asText(await wooReport("sales", { period })),
  );

  // Order counts by status.
  server.registerTool(
    "get_orders_report",
    {
      description:
        "Order counts by status (pending, processing, completed, and so on), all time. Includes the total order count and each status's percent of all orders.",
    },
    async () => {
      const rows = (await wooReport("orders/totals")) as { slug: string; name: string; total: number }[];
      const allOrders = rows.reduce((sum, row) => sum + row.total, 0);
      const statuses = rows.map((row) => ({
        ...row,
        percent: allOrders ? Math.round((row.total / allOrders) * 1000) / 10 : 0,
      }));
      return asText({ all_orders: allOrders, statuses });
    },
  );

  // Product counts by type.
  server.registerTool(
    "get_products_report",
    { description: "Product counts by type (simple, variable, grouped, external), all time." },
    async () => asText(await wooReport("products/totals")),
  );

  // Customer counts by paying status.
  server.registerTool(
    "get_customers_report",
    { description: "Customer counts: paying and non-paying, all time." },
    async () => asText(await wooReport("customers/totals")),
  );

  // Coupon counts by discount type.
  server.registerTool(
    "get_coupons_report",
    { description: "Coupon counts by discount type (percent, fixed_cart, fixed_product), all time." },
    async () => asText(await wooReport("coupons/totals")),
  );

  return server;
}

// Reads a JSON request body, or returns undefined when there is none.
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

// Keeps one MCP session per client, identified by the session header.
const sessions = new Map<string, StreamableHTTPServerTransport>();

// Creates a new session transport and connects a fresh server to it.
async function newSession(): Promise<StreamableHTTPServerTransport> {
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id: string) => {
      sessions.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await buildServer().connect(transport);
  return transport;
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  console.log(`${req.method} ${req.url} session=${req.headers["mcp-session-id"] ?? "none"}`);
  try {
    const tokenOk = req.headers.authorization === `Bearer ${MCP_TOKEN}` || url.searchParams.get("token") === MCP_TOKEN;
    if (!tokenOk) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }

    // Reuses the client's session, or starts a new one.
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = (sessionId && sessions.get(sessionId)) || (await newSession());

    const body = req.method === "POST" ? await readJson(req) : undefined;
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("request failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "server error" }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`WooCommerce MCP server listening on port ${PORT}`);
});
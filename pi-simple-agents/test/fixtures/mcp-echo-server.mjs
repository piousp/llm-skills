// Zero-dependency stdio MCP fixture server for the hermetic e2e tests
// (test/e2e/mcp-grace.integration.test.ts). Speaks newline-delimited JSON-RPC
// over stdio; JSON goes to stdout only (anything else would corrupt the
// protocol), logs to stderr. FIXTURE_DELAY_MS delays the initialize response,
// simulating a slow background MCP connect.
import readline from "node:readline";

const delayMs = Number(process.env.FIXTURE_DELAY_MS ?? "0") || 0;

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function errorReply(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;

  switch (method) {
    case "initialize":
      // Delayed on purpose: the client's bind resolves before this response,
      // which is exactly what the tests exercise.
      setTimeout(() => {
        reply(id, {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          // The MCP client (extensions/mcp/runtime.js) only issues tools/list when
          // serverCapabilities.tools is advertised — without it the tool never registers.
          capabilities: { tools: { listChanged: false } },

          serverInfo: { name: "mcp-echo-server", version: "0.0.0" },
        });
      }, delayMs);
      break;
    case "notifications/initialized":
      // A notification: no id, nothing to answer.
      break;
    case "ping":
      reply(id, {});
      break;
    case "tools/list":
      reply(id, {
        tools: [
          {
            name: "echo",
            description: "Echoes its input back as text.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "Text to echo back" } },
              required: ["text"],
            },
          },
        ],
      });
      break;
    case "tools/call": {
      const text = params?.arguments?.text ?? JSON.stringify(params?.arguments ?? {});
      reply(id, { content: [{ type: "text", text: String(text) }] });
      break;
    }
    default:
      if (id !== undefined) errorReply(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  try {
    handleMessage(JSON.parse(line));
  } catch (error) {
    process.stderr.write(`mcp-echo-server: ${error}\n`);
  }
});
// Clean exit when the client closes its end (the MCP extension kills the
// process on session_shutdown; stdin close is the fallback).
rl.on("close", () => {
  process.exit(0);
});

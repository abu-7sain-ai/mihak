// ═══════════════════════════════════════════════════════════════════════════
//  موصّل MCP — عشان Claude (claude.ai → Connectors) يقرا ويتحكم بالمِحَك
//  Streamable HTTP بدون جلسات: كل طلب POST فيه رسالة JSON-RPC وترجع JSON.
//  الحماية: سر في الرابط نفسه (/mcp/<MCP_SECRET>) لأن claude.ai ما يرسل هيدرات.
// ═══════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// tools: [{ name, description, inputSchema, annotations?, run: async args => any }]
function createMcpHandler({ secret, tools, name = 'mihak', version = '1.0.0', instructions = '', log }) {
  const byName = Object.fromEntries(tools.map(t => [t.name, t]));

  async function handleOne(msg) {
    const { id, method, params = {} } = msg || {};
    const isNotification = id === undefined || id === null;
    const ok = result => (isNotification ? null : { jsonrpc: '2.0', id, result });
    const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

    if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(-32600, 'Invalid Request');
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return ok({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
          instructions,
        });
      }
      case 'ping': return ok({});
      case 'tools/list':
        return ok({ tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })) });
      case 'tools/call': {
        const tool = byName[params.name];
        if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
        try {
          const out = await tool.run(params.arguments || {});
          const isError = !!(out && out.error);
          return ok({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], isError });
        } catch (e) {
          log?.err?.(`mcp ${params.name}: ${e.message}`);
          return ok({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
        }
      }
      default:
        if (method.startsWith('notifications/')) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  }

  return async function mcpRoute(req, res) {
    if (!secret || !safeEqual(req.params.secret || '', secret)) return res.status(404).end();
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    const body = req.body;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(handleOne))).filter(Boolean);
      return out.length ? res.json(out) : res.status(202).end();
    }
    const out = await handleOne(body);
    return out ? res.json(out) : res.status(202).end();
  };
}

module.exports = { createMcpHandler };

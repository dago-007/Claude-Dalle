import express from "express";
import cors from "cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";

const app = express();
app.use(cors()); // Habilita permisos para conexiones externas de Claude
app.use(express.json());

const CLAUDE_AUTH_TOKEN = process.env.CLAUDE_AUTH_TOKEN;

// Validación de seguridad flexible
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  console.log(`Petición recibida en ${req.path}. Header de autorización: "${auth}"`);

  if (!CLAUDE_AUTH_TOKEN) {
    return next();
  }

  // Comprobar si la contraseña coincide con o sin la palabra 'Bearer'
  if (
    auth === `Bearer ${CLAUDE_AUTH_TOKEN}` || 
    auth === CLAUDE_AUTH_TOKEN ||
    auth === `bearer ${CLAUDE_AUTH_TOKEN}`
  ) {
    return next();
  }

  console.log(`[AUTH DENEGADA] Recibido: "${auth}" | Esperado: "${CLAUDE_AUTH_TOKEN}"`);
  return res.status(401).json({ error: "No autorizado" });
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const server = new Server({ name: "dalle-cloud", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "generar_imagen",
    description: "Genera una imagen usando DALL-E 3 a partir de un prompt.",
    inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] }
  }]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "generar_imagen") {
    const response = await openai.images.generate({
      model: "dall-e-3", prompt: String(request.params.arguments.prompt), n: 1, size: "1024x1024",
    });
    return { content: [{ type: "text", text: response.data[0].url }] };
  }
  throw new Error("Herramienta no encontrada");
});

let transport;

app.get("/sse", async (req, res) => {
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`Servidor iniciado en puerto ${PORT}`));

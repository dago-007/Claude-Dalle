import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const CLAUDE_AUTH_TOKEN = process.env.CLAUDE_AUTH_TOKEN;

app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (CLAUDE_AUTH_TOKEN && auth !== `Bearer ${CLAUDE_AUTH_TOKEN}`) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
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

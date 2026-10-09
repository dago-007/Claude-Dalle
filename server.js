// Puente MCP (Claude Teams) -> OpenAI Images
// v2.0 — Streamable HTTP sin estado, modelo gpt-image-2, imagen en base64 + enlace temporal
import express from "express";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import OpenAI from "openai";

// ---------- Configuración (variables de entorno en Render) ----------
const {
  OPENAI_API_KEY,
  CLAUDE_AUTH_TOKEN,
  IMAGE_MODEL = "gpt-image-2",       // si no está disponible en tu cuenta: gpt-image-1-mini
  IMAGE_QUALITY = "medium",          // low | medium | high | auto
  MAX_IMAGES_PER_HOUR = "30",        // tope global para proteger el saldo
  PORT = "10000",
} = process.env;

// Render define RENDER_EXTERNAL_URL automáticamente (https://tu-servicio.onrender.com)
const BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");

if (!OPENAI_API_KEY || !CLAUDE_AUTH_TOKEN) {
  console.error("Faltan variables de entorno: OPENAI_API_KEY y/o CLAUDE_AUTH_TOKEN");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- Salud (sin autenticación, para Render y para despertar el servicio) ----------
app.get("/health", (_req, res) => res.json({ ok: true, model: IMAGE_MODEL }));

// ---------- Almacén temporal de imágenes en memoria (1 hora, máx. 50) ----------
const images = new Map();
const TTL_MS = 60 * 60 * 1000;
const MAX_STORED = 50;

function saveImage(buf, mime) {
  const id = crypto.randomBytes(16).toString("hex"); // 128 bits, no adivinable
  images.set(id, { buf, mime, exp: Date.now() + TTL_MS });
  while (images.size > MAX_STORED) images.delete(images.keys().next().value);
  return id;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of images) if (v.exp < now) images.delete(k);
}, 10 * 60 * 1000).unref();

app.get("/img/:id", (req, res) => {
  const it = images.get(req.params.id);
  if (!it || it.exp < Date.now()) return res.status(404).send("Imagen no disponible o expirada");
  res.type(it.mime).set("Cache-Control", "private, max-age=3600").send(it.buf);
});

// ---------- Límite global de generación por hora ----------
const limit = Number(MAX_IMAGES_PER_HOUR) || 30;
let windowStart = Date.now();
let count = 0;
function allowRequest() {
  const now = Date.now();
  if (now - windowStart > 60 * 60 * 1000) { windowStart = now; count = 0; }
  if (count >= limit) return false;
  count++;
  return true;
}

// ---------- Autenticación Bearer (comparación en tiempo constante) ----------
const expected = Buffer.from(`Bearer ${CLAUDE_AUTH_TOKEN}`);
function requireAuth(req, res, next) {
  const got = Buffer.from(req.headers.authorization || "");
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

// ---------- Servidor MCP ----------
function buildServer() {
  const server = new McpServer({ name: "generador-imagenes", version: "2.0.0" });

  server.tool(
    "generar_imagen",
    "Genera una imagen a partir de una descripción en texto usando el modelo de imágenes de OpenAI. Devuelve la imagen y un enlace temporal válido por 1 hora.",
    {
      prompt: z.string().min(3).max(4000).describe("Descripción detallada de la imagen a generar"),
      size: z
        .enum(["1024x1024", "1024x1536", "1536x1024"])
        .optional()
        .describe("Tamaño: 1024x1024 (cuadrada), 1024x1536 (vertical), 1536x1024 (horizontal)"),
    },
    async ({ prompt, size }) => {
      if (!allowRequest()) {
        return {
          isError: true,
          content: [{ type: "text", text: `Se alcanzó el límite de ${limit} imágenes por hora. Intenta más tarde.` }],
        };
      }
      try {
        const r = await openai.images.generate({
          model: IMAGE_MODEL,
          prompt,
          n: 1,
          size: size || "1024x1024",
          quality: IMAGE_QUALITY,
          output_format: "jpeg",     // JPEG para reducir tamaño de la respuesta
          output_compression: 85,
        });

        const b64 = r.data?.[0]?.b64_json;
        if (!b64) throw new Error("La API no devolvió datos de imagen");

        const id = saveImage(Buffer.from(b64, "base64"), "image/jpeg");
        const link = BASE_URL ? `${BASE_URL}/img/${id}` : `/img/${id}`;
        console.log(`[OK] imagen ${id} generada (${IMAGE_MODEL})`);

        return {
          content: [
            { type: "image", data: b64, mimeType: "image/jpeg" },
            { type: "text", text: `Imagen generada. Enlace temporal (1 h): ${link}` },
          ],
        };
      } catch (err) {
        console.error("[ERROR] generar_imagen:", err?.status, err?.message);
        return {
          isError: true,
          content: [{ type: "text", text: `Error al generar la imagen: ${err?.message || err}` }],
        };
      }
    }
  );

  return server;
}

// ---------- Endpoint MCP (Streamable HTTP, sin estado: un servidor por petición) ----------
app.post("/mcp", requireAuth, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[ERROR] /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno" }, id: null });
    }
  }
});

const notAllowed = (_req, res) =>
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Método no permitido" },
    id: null,
  });
app.get("/mcp", requireAuth, notAllowed);
app.delete("/mcp", requireAuth, notAllowed);

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Servidor MCP en puerto ${PORT} — modelo ${IMAGE_MODEL} — base ${BASE_URL || "(sin URL pública)"}`);
});

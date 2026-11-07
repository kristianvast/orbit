import { createApp } from "./app";
import { createTokenResolver } from "./auth";
import type { CoreDb } from "./db";
import { createGoogleTokenProvider } from "./google-auth";
import { createMailer } from "./mailer";
import { createVoiceGateway, type VoiceConnection } from "./voice";

export function serveCore(db: CoreDb, defaultPort: number) {
  const google = process.env.LLM_UPSTREAM_AUTH === "google";
  const accessToken = createGoogleTokenProvider();
  const project = process.env.GCP_PROJECT;
  const upstreamUrl =
    process.env.LLM_UPSTREAM_URL ||
    (google && project
      ? `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/endpoints/openapi`
      : undefined);
  const app = createApp({
    db,
    resolveToken: createTokenResolver(db, process.env.CORE_STATIC_TOKENS),
    electricUrl: process.env.ELECTRIC_URL ?? "http://127.0.0.1:3001",
    electricSecret: process.env.ELECTRIC_SECRET,
    corsOrigins: process.env.CORE_CORS_ORIGINS?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    billing: {
      secretKey: process.env.STRIPE_SECRET_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      successUrl: process.env.BILLING_SUCCESS_URL,
      cancelUrl: process.env.BILLING_CANCEL_URL,
      automaticTax: process.env.STRIPE_AUTOMATIC_TAX === "true",
      ordersEmail: process.env.ORDERS_EMAIL || undefined,
    },
    mailer: createMailer({
      provider: process.env.MAIL_PROVIDER,
      apiKey: process.env.MAIL_API_KEY,
      from: process.env.MAIL_FROM,
    }),
    links: {
      ...(process.env.PUBLIC_SITE_URL ? { siteUrl: process.env.PUBLIC_SITE_URL } : {}),
      ...(process.env.ORBIT_DOWNLOAD_URL ? { downloadUrl: process.env.ORBIT_DOWNLOAD_URL } : {}),
    },
    termsVersion: process.env.TERMS_VERSION || undefined,
    llm: {
      upstreamUrl,
      upstreamApiKey: process.env.LLM_UPSTREAM_API_KEY,
      authHeader: process.env.LLM_UPSTREAM_AUTH === "x-api-key" ? "x-api-key" : "authorization",
      accessToken: google ? accessToken : undefined,
      stripPrefix: process.env.LLM_UPSTREAM_STRIP_PREFIX ?? (google ? "/v1" : undefined),
      defaultModel:
        process.env.LLM_DEFAULT_MODEL ?? (google ? "google/gemini-3.8-flash" : undefined),
      defaultMonthlyTokenBudget: Number(process.env.LLM_MONTHLY_TOKEN_BUDGET ?? 2_000_000),
    },
    version: process.env.CORE_VERSION,
  });
  const voice = createVoiceGateway(db, {
    project,
    model: process.env.VOICE_MODEL ?? "gemini-3.8-live",
    location: process.env.VOICE_LOCATION ?? "us-central1",
    accessToken,
  });
  const server = Bun.serve<VoiceConnection>({
    port: Number(process.env.PORT ?? defaultPort),
    idleTimeout: 120,
    fetch(request, server) {
      if (new URL(request.url).pathname === "/v1/voice/live") return voice.upgrade(request, server);
      return app.fetch(request);
    },
    websocket: voice.websocket,
  });
  console.log(`@core/api listening on :${server.port}`);
  return server;
}

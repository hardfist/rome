import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { createProgressRepository } from "../db/repositories/progress.js";
import { welcomeLocaleFromCode, type WelcomeLocale } from "../locale.js";

function requestLocale(request: RomeAppApiRequest): WelcomeLocale | undefined {
  if (!request.body || request.body.byteLength === 0) return undefined;
  try {
    const body = JSON.parse(new TextDecoder().decode(request.body));
    if (!body || typeof body !== "object" || !("locale" in body)) return undefined;
    return welcomeLocaleFromCode((body as { locale?: unknown }).locale);
  } catch {
    return undefined;
  }
}

/**
 * welcome-to-rome app API. The only real route is `POST /reset`, which the
 * landing screen (src/web/App.tsx) calls before starting a chat so every entry
 * from the welcome screen replays the flow from a clean slate. When supplied,
 * the locale is persisted as the guardian's language before the chat starts.
 * Reset scope otherwise stays intentionally narrow: no memory or transcript is
 * touched.
 */
class WelcomeApiHandler implements RomeAppApiHandler {
  constructor(private readonly ctx: RomeAppContext) {}

  async handle(request: RomeAppApiRequest): Promise<Response> {
    const route = request.path.join("/");

    if (request.method === "GET" && request.path.length === 0) {
      return Response.json({
        appId: this.ctx.app.id,
        version: this.ctx.app.version,
        agentName: await this.getAgentName(),
        status: "ok",
      });
    }

    if (request.method === "POST" && route === "reset") {
      const locale = requestLocale(request);
      if (locale) await this.ctx.repositories.settings.set("guardianLanguage", locale);
      const progress = createProgressRepository(this.ctx.db);
      progress.reset();
      return Response.json({ ok: true });
    }

    return Response.json(
      {
        error: "not_found",
        appId: this.ctx.app.id,
        message: `Unknown welcome-to-rome API route: /${route}`,
      },
      { status: 404 },
    );
  }

  private async getAgentName(): Promise<string> {
    try {
      const value = await this.ctx.repositories.settings.get<string>("agentName");
      return (typeof value === "string" && value.trim()) || "Rome";
    } catch {
      return "Rome";
    }
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new WelcomeApiHandler(ctx);
}

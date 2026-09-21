import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "node:http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    /* Default is 100kb, which rejects a template-asset upload: a 2 MB image
       becomes roughly 2.7 MB of base64. Sized to fit one asset at the cap
       enforced in the route, plus headroom, and no larger. */
    limit: "4mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

/* Response bodies are logged to aid debugging, but some endpoints return
   material that must never reach stdout: decrypted routing/account numbers from
   the reveal endpoints, and live bearer session tokens from the auth endpoints.
   Those paths log status and timing only, and any stray sensitive key elsewhere
   is redacted defensively. */
const NO_BODY_LOG: RegExp[] = [/\/reveal$/, /^\/api\/auth\//];
const SENSITIVE_KEYS = new Set([
  "routingNumber",
  "accountNumber",
  "ein",
  "sessionToken",
  "token",
  "password",
]);

function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactForLog(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k) ? "[redacted]" : redactForLog(v, depth + 1);
  }
  return out;
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse && !NO_BODY_LOG.some((re) => re.test(path))) {
        logLine += ` :: ${JSON.stringify(redactForLog(capturedJsonResponse))}`;
      }

      log(logLine);
    }
  });

  next();
});

export async function startServer(options: {
  port?: number;
  host?: string;
} = {}): Promise<{ port: number; host: string; close: () => Promise<void> }> {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  /* Loopback by default. This is a single-user desktop application handling
     bank account data; binding every interface would publish the check
     register to whatever network the laptop happens to join. Deployments that
     genuinely need to accept remote connections must opt in through HOST. */
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";

  /* Port 0 asks the OS for a free port. The desktop host uses this so a
     second copy of the app, or an unrelated process already on the usual
     port, cannot stop CheckWriter from starting. */
  const requestedPort =
    options.port ?? parseInt(process.env.PORT || "5000", 10);

  /* SO_REUSEPORT is a Linux socket option. Windows has no equivalent and
     Node rejects the listen call outright, so it is only requested where it
     actually exists. */
  const listenOptions: Record<string, unknown> = {
    port: requestedPort,
    host,
  };
  if (process.platform === "linux") {
    listenOptions.reusePort = true;
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      httpServer.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${requestedPort} is already in use. Another copy of ` +
              `CheckWriter may already be running.`,
          ),
        );
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      httpServer.removeListener("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(listenOptions);
  });

  const address = httpServer.address();
  const boundPort =
    typeof address === "object" && address ? address.port : requestedPort;

  log(`serving on ${host}:${boundPort}`);

  return {
    port: boundPort,
    host,
    close: () =>
      new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/* Started directly with `node dist/index.cjs`. When the desktop host requires
   this bundle instead, it calls startServer() itself with its own port. */
if (require.main === module) {
  startServer().catch((err) => {
    console.error("Failed to start CheckWriter:", err);
    process.exit(1);
  });
}

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const BACKEND_URL = "http://localhost:3000";

// The API is proxied in dev so the browser only ever talks to the Vite origin.
// This keeps requests same-origin and avoids needing CORS on the Express server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/chat": {
        target: BACKEND_URL,
        changeOrigin: true,
        // When the backend isn't running, Vite's default proxy error reply is
        // an empty-bodied 5xx, which the UI can only report as a generic
        // failure. Answer with the same { error } JSON shape the Express
        // error boundary uses, naming the target and the socket error, so the
        // chat shows why. Registered before Vite's own handler, which still
        // logs the error and skips replying once headers are sent.
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            if (!("writeHead" in res) || res.headersSent) return;
            const code = (err as NodeJS.ErrnoException).code ?? err.name;
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: `Could not reach the backend at ${BACKEND_URL} (${code}). Start it with "npm run dev" in the project root.`,
              })
            );
          });
        },
      },
    },
  },
});

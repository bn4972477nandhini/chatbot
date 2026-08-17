import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The API is proxied in dev so the browser only ever talks to the Vite origin.
// This keeps requests same-origin and avoids needing CORS on the Express server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/chat": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});

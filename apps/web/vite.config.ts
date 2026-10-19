import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const headers = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const proxy = {
  "/api": process.env.API_URL ?? "http://127.0.0.1:18081",
  "/aviso": process.env.API_URL ?? "http://127.0.0.1:18081",
  "/public": process.env.API_URL ?? "http://127.0.0.1:18081",
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 3000, strictPort: true, headers, proxy },
  preview: { host: "127.0.0.1", port: 3000, strictPort: true, headers, proxy },
  build: { outDir: "dist" },
});

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import execution from "./execution.config.json";

if (execution.mode !== "demo") {
  throw new Error("Este frontend independente executa o cenário demonstrativo. A integração de serviços ainda não foi configurada.");
}

const headers = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: { host: "0.0.0.0", port: 3000, strictPort: true, headers },
  preview: { host: "0.0.0.0", port: 3000, strictPort: true, headers },
  build: { outDir: "dist" },
});

import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { ADMIN_API_PATH, CONSOLE_PATH } from "../src/admin/paths.ts";

export default defineConfig({
  base: `${CONSOLE_PATH}/`,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Preserve Host so authentication redirects and mutation origins use Vite's URL.
    proxy: {
      [ADMIN_API_PATH]: { target: "http://127.0.0.1:8787" },
      [`${CONSOLE_PATH}/auth`]: { target: "http://127.0.0.1:8787" },
    },
  },
});

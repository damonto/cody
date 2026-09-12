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
    proxy: { [ADMIN_API_PATH]: { target: "http://localhost:8788" } },
  },
});

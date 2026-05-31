import { defineConfig } from "vite";
import { clientLibConfig } from "./vite.lib.shared";

export default defineConfig(clientLibConfig("src/host.tsx", "host", true));

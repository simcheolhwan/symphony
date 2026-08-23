import { lintConfig } from "@simcheolhwan/oxlint-config"
import { defineConfig } from "vite-plus"

export default defineConfig({
  fmt: { semi: false, sortImports: true, ignorePatterns: ["**/*.md"] },
  lint: {
    ...lintConfig,
    env: { node: true },
    rules: {
      ...lintConfig.rules,
      "import/no-nodejs-modules": "off",
      // Slack WebClient의 메서드를 브라우저 postMessage API로 오인하는 규칙이다.
      "unicorn/require-post-message-target-origin": "off",
    },
  },
  test: { globals: true, include: ["{launcher,notifier}/src/**/*.test.ts"] },
  staged: { "*": "vp check --fix" },
})

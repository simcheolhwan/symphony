import { lintConfig } from "@simcheolhwan/oxlint-config"
import { defineConfig } from "vite-plus"

// 커밋 훅이 업스트림 소유 파일을 포매팅하지 않도록 포크 소유 경로 중 포매팅 대상만 나열한다.
const forkOwnedPaths = [
  "AGENTS.md",
  "VISION.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "workflows/**",
  "issues/**",
  "launcher/**",
  "notifier/**",
]

export default defineConfig({
  fmt: { semi: false, sortImports: true },
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
  staged: { [`{${forkOwnedPaths.join(",")}}`]: "vp check --fix" },
})

import { REGISTRY_PATH } from "./constants.ts"
import { instancePath, parseProcessName, parseRegistry, processName } from "./registry.ts"

const valid = {
  myrepo: {
    repo: "acme/myrepo",
    project: "project-slug",
    workflows: {
      linear: { model: "gpt-5.6-terra", model_reasoning_effort: "max" },
      "pr-author": {},
    },
  },
}

describe("PM2 프로세스 이름", () => {
  it("워크플로와 하이픈이 포함된 별칭을 생성하고 복원한다", () => {
    const name = processName("my-repo", "pr-reviewer")
    expect(name).toBe("symphony:pr-reviewer:my-repo")
    expect(parseProcessName(name)).toEqual({ alias: "my-repo", workflow: "pr-reviewer" })
  })

  it.each(["symphony:notifier", "symphony:unknown:myrepo", "symphony:linear:myrepo:extra"])(
    "인스턴스 이름이 아닌 %s를 복원하지 않는다",
    (name) => {
      expect(parseProcessName(name)).toBeUndefined()
    },
  )
})

describe("인스턴스 경로", () => {
  it("별칭 아래에 워크플로 디렉터리를 둔다", () => {
    expect(instancePath("my-repo", "pr-author")).toBe("my-repo/pr-author")
  })
})

describe("parseRegistry", () => {
  it("targets.json을 도메인 인스턴스로 변환하고 기본값을 적용한다", () => {
    const registry = parseRegistry(JSON.stringify(valid))
    expect(registry.get("myrepo")).toEqual({
      alias: "myrepo",
      instances: new Map([
        [
          "linear",
          {
            alias: "myrepo",
            repo: "acme/myrepo",
            model: "gpt-5.6-terra",
            effort: "max",
            workflow: "linear",
            project: "project-slug",
          },
        ],
        [
          "pr-author",
          {
            alias: "myrepo",
            repo: "acme/myrepo",
            model: undefined,
            effort: "xhigh",
            workflow: "pr-author",
          },
        ],
      ]),
    })
  })

  it("문자열 설정의 양끝 공백을 제거한다", () => {
    const registry = parseRegistry(
      JSON.stringify({
        myrepo: {
          repo: " acme/myrepo ",
          workflows: { "pr-reviewer": { model: " model ", model_reasoning_effort: " high " } },
        },
      }),
    )
    expect(registry.get("myrepo")?.instances.get("pr-reviewer")).toMatchObject({
      repo: "acme/myrepo",
      model: "model",
      effort: "high",
    })
  })

  it("유효하지 않은 JSON과 최상위 형식의 기존 오류 문맥을 유지한다", () => {
    expect(() => parseRegistry("{invalid")).toThrow(`${REGISTRY_PATH}가 유효한 JSON이 아닙니다.`)
    expect(() => parseRegistry("[]")).toThrow(`${REGISTRY_PATH}의 최상위 값이 객체가 아닙니다.`)
  })

  it("target과 워크플로 경로를 포함해 스키마 오류를 보고한다", () => {
    expect(() => parseRegistry(JSON.stringify({ myrepo: { repo: "", workflows: {} } }))).toThrow(
      "myrepo target의 repo 값이 비어 있지 않은 문자열이어야 합니다.",
    )
    expect(() =>
      parseRegistry(JSON.stringify({ myrepo: { repo: "acme/myrepo", workflows: [] } })),
    ).toThrow("myrepo target의 workflows가 객체가 아닙니다.")
    expect(() =>
      parseRegistry(
        JSON.stringify({ myrepo: { repo: "acme/myrepo", workflows: { "pr-author": null } } }),
      ),
    ).toThrow("myrepo target의 pr-author 워크플로 설정이 객체가 아닙니다.")
  })

  it("알 수 없는 워크플로를 거부한다", () => {
    expect(() =>
      parseRegistry(JSON.stringify({ myrepo: { repo: "acme/myrepo", workflows: { deploy: {} } } })),
    ).toThrow("myrepo target에 알 수 없는 워크플로가 있습니다: deploy")
  })

  it("linear 워크플로에는 project를 요구한다", () => {
    expect(() =>
      parseRegistry(JSON.stringify({ myrepo: { repo: "acme/myrepo", workflows: { linear: {} } } })),
    ).toThrow("myrepo target은 linear 워크플로를 켰으므로 project가 필요합니다.")
  })
})

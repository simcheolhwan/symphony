defmodule SymphonyElixir.NotifierTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.Config
  alias SymphonyElixir.Notifier
  alias SymphonyElixir.Tracker.Issue

  import SymphonyElixir.TestSupport, only: [start_echo_server: 0]

  @issue %Issue{
    id: "a1b2c3d4-0000-0000-0000-000000000000",
    identifier: "SYM-42",
    title: "Add notification event emission",
    url: "https://linear.app/acme/issue/SYM-42",
    state: "In Progress"
  }

  @notification_env [
    "SYMPHONY_NOTIFY_URL",
    "SYMPHONY_INSTANCE_NAME",
    "SYMPHONY_WORKFLOW_LABEL",
    "SYMPHONY_TARGET_NAME"
  ]

  setup do
    original_env = Map.new(@notification_env, &{&1, System.get_env(&1)})

    on_exit(fn -> Enum.each(original_env, fn {name, value} -> restore_env(name, value) end) end)

    Enum.each(@notification_env, &System.delete_env/1)
    System.put_env("SYMPHONY_INSTANCE_NAME", "myrepo-linear")
    {:ok, port: start_echo_server()}
  end

  test "posts the full event contract to the configured endpoint", %{port: port} do
    System.put_env("SYMPHONY_NOTIFY_URL", "http://127.0.0.1:#{port}/symphony/events")

    assert :ok =
             Notifier.notify(
               :blocked,
               @issue,
               "codex turn requires operator input",
               "Implemented the retry policy but could not verify it."
             )

    assert_receive {:notification, "/symphony/events", payload}, 2_000

    assert payload == %{
             "instance" => "myrepo-linear",
             "event" => "blocked",
             "reason" => "codex turn requires operator input",
             "agent_message" => "Implemented the retry policy but could not verify it.",
             "issue" => %{
               "id" => "a1b2c3d4-0000-0000-0000-000000000000",
               "identifier" => "SYM-42",
               "title" => "Add notification event emission",
               "url" => "https://linear.app/acme/issue/SYM-42",
               "state" => "In Progress"
             }
           }
  end

  test "carries the workflow, target, dispatch reasons, and pull request author", %{port: port} do
    System.put_env("SYMPHONY_NOTIFY_URL", "http://127.0.0.1:#{port}/symphony/events")
    System.put_env("SYMPHONY_WORKFLOW_LABEL", "PR 저자")
    System.put_env("SYMPHONY_TARGET_NAME", "myrepo")

    issue = %Issue{
      @issue
      | native_ref: %{"author" => "octocat", "repo" => "acme/myrepo"},
        dispatch_reasons: ["unresolved_threads:3", "failing_checks:1"]
    }

    assert :ok = Notifier.notify(:started, issue)

    assert_receive {:notification, _path, payload}, 2_000

    assert payload["workflow"] == "PR 저자"
    assert payload["target"] == "myrepo"
    assert payload["dispatch_reasons"] == ["unresolved_threads:3", "failing_checks:1"]
    assert payload["issue"]["pr_author"] == "octocat"
  end

  test "omits optional fields instead of sending them as null", %{port: port} do
    System.put_env("SYMPHONY_NOTIFY_URL", "http://127.0.0.1:#{port}/symphony/events")

    assert :ok = Notifier.notify(:started, %{@issue | title: nil})

    assert_receive {:notification, _path, payload}, 2_000
    assert payload["event"] == "started"
    refute Map.has_key?(payload, "reason")
    refute Map.has_key?(payload, "agent_message")
    refute Map.has_key?(payload, "workflow")
    refute Map.has_key?(payload, "target")
    refute Map.has_key?(payload, "dispatch_reasons")
    refute Map.has_key?(payload["issue"], "title")
    refute Map.has_key?(payload["issue"], "pr_author")
  end

  test "drops an event that has no issue to describe", %{port: port} do
    System.put_env("SYMPHONY_NOTIFY_URL", "http://127.0.0.1:#{port}/symphony/events")

    assert :ok = Notifier.notify(:killed, nil, "issue no longer visible in tracker")

    refute_receive {:notification, _path, _payload}, 200
  end

  test "display names reject empty values and terminal control bytes" do
    for invalid_name <- ["", "PR\e[2Jspoofed"] do
      System.put_env("SYMPHONY_INSTANCE_NAME", invalid_name)

      assert Config.instance_name() == nil
    end
  end

  test "skips sending when the instance name is missing", %{port: port} do
    System.put_env("SYMPHONY_NOTIFY_URL", "http://127.0.0.1:#{port}/symphony/events")
    System.delete_env("SYMPHONY_INSTANCE_NAME")

    assert :ok = Notifier.notify(:completed, @issue)

    refute_receive {:notification, _path, _payload}, 200
  end

  test "sends nothing when no endpoint is configured" do
    System.delete_env("SYMPHONY_NOTIFY_URL")

    assert :ok = Notifier.notify(:completed, @issue)

    refute_receive {:notification, _path, _payload}, 200
  end

  test "accepts only endpoint URLs the receiver would boot with", %{port: port} do
    valid = "http://127.0.0.1:#{port}/symphony/events"
    System.put_env("SYMPHONY_NOTIFY_URL", valid)
    assert Config.notification_url() == valid

    for invalid <- [
          "https://127.0.0.1:#{port}/symphony/events",
          "http://localhost:#{port}/symphony/events",
          "http://127.0.0.1/symphony/events",
          "http://user@127.0.0.1:#{port}/symphony/events"
        ] do
      System.put_env("SYMPHONY_NOTIFY_URL", invalid)
      assert Config.notification_url() == nil
    end
  end

  test "skips a configured but invalid endpoint with a warning", %{port: port} do
    System.put_env("SYMPHONY_NOTIFY_URL", "https://127.0.0.1:#{port}/symphony/events")

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert :ok = Notifier.notify(:completed, @issue)
      end)

    assert log =~ "SYMPHONY_NOTIFY_URL"
    refute_receive {:notification, _path, _payload}, 200
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)
end

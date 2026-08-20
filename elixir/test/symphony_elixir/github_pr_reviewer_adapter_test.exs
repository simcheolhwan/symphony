defmodule SymphonyElixir.GitHub.PrReviewer.AdapterTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.GitHub.PrReviewer.Adapter
  alias SymphonyElixir.GitHub.PrReviewer.Client

  defmodule FakePrReviewerClient do
    def preflight(_settings) do
      Application.get_env(:symphony_elixir, :github_pr_reviewer_preflight_result, :ok)
    end

    def fetch_issues_by_states(states) do
      send(self(), {:github_pr_reviewer_states_called, states})
      {:ok, states}
    end

    def fetch_issues_by_ids(ids) do
      send(self(), {:github_pr_reviewer_ids_called, ids})
      {:ok, ids}
    end
  end

  setup do
    client_module =
      Application.get_env(:symphony_elixir, :github_pr_reviewer_client_module)

    preflight_result =
      Application.get_env(:symphony_elixir, :github_pr_reviewer_preflight_result)

    on_exit(fn ->
      if is_nil(client_module) do
        Application.delete_env(:symphony_elixir, :github_pr_reviewer_client_module)
      else
        Application.put_env(
          :symphony_elixir,
          :github_pr_reviewer_client_module,
          client_module
        )
      end

      if is_nil(preflight_result) do
        Application.delete_env(:symphony_elixir, :github_pr_reviewer_preflight_result)
      else
        Application.put_env(
          :symphony_elixir,
          :github_pr_reviewer_preflight_result,
          preflight_result
        )
      end
    end)

    :ok
  end

  test "adapter reuses GitHub config, tools, and secrets while delegating review request reads" do
    settings = tracker_settings()

    assert :ok = Adapter.validate_config(settings)

    assert :ok =
             Adapter.validate_config(%{
               settings
               | active_states: [" OPEN "],
                 terminal_states: [" CLOSED "]
             })

    assert {:error, :missing_github_active_states} =
             Adapter.validate_config(%{settings | active_states: nil})

    assert {:error, :missing_github_terminal_states} =
             Adapter.validate_config(%{settings | terminal_states: nil})

    assert {:error, :invalid_github_states} =
             Adapter.validate_config(%{settings | active_states: ["review_requested"]})

    assert {:error, :missing_github_repo} =
             Adapter.validate_config(tracker_settings(%{"repo" => nil}))

    Application.put_env(
      :symphony_elixir,
      :github_pr_reviewer_client_module,
      FakePrReviewerClient
    )

    assert :ok = Tracker.preflight(settings)

    assert {:ok, ["open"]} = Adapter.fetch_issues_by_states(["open"])
    assert_receive {:github_pr_reviewer_states_called, ["open"]}

    assert {:ok, ["42"]} = Adapter.fetch_issues_by_ids(["42"])
    assert_receive {:github_pr_reviewer_ids_called, ["42"]}

    assert [%{"name" => "github_api"}] = Adapter.agent_tool_specs()

    assert Adapter.execute_agent_tool(
             "github_api",
             %{"method" => "GET", "path" => "/user"},
             github_client: fn _method, _path, _params, _body, _opts ->
               {:ok, %{status: 200, body: %{"login" => "octocat"}}}
             end
           )["success"]

    assert Adapter.secret_environment_names(tracker_settings(%{"token" => "$SYMPHONY_GITHUB_REVIEW_TOKEN"})) == [
             "GITHUB_TOKEN",
             "GH_TOKEN",
             "GITHUB_ENTERPRISE_TOKEN",
             "GH_ENTERPRISE_TOKEN",
             "SYMPHONY_GITHUB_REVIEW_TOKEN"
           ]

    assert {:ok, Adapter} =
             SymphonyElixir.Tracker.adapter_for_kind("github_pr_reviewer")
  end

  test "workflow store init stops when the configured GitHub repository is inaccessible" do
    error = {:github_repo_inaccessible, "octo/repo", 404}

    Application.put_env(
      :symphony_elixir,
      :github_pr_reviewer_client_module,
      FakePrReviewerClient
    )

    Application.put_env(
      :symphony_elixir,
      :github_pr_reviewer_preflight_result,
      {:error, error}
    )

    write_pr_reviewer_workflow!(Workflow.workflow_file_path(), "Inaccessible repository")

    assert {:stop, ^error} = WorkflowStore.init([])
  end

  test "workflow reload keeps the last good settings when repository preflight fails" do
    assert {:ok, %{prompt: original_prompt}} = Workflow.current()
    original_settings = Config.settings!()
    error = {:github_repo_inaccessible, "octo/repo", 403}

    Application.put_env(
      :symphony_elixir,
      :github_pr_reviewer_client_module,
      FakePrReviewerClient
    )

    Application.put_env(
      :symphony_elixir,
      :github_pr_reviewer_preflight_result,
      {:error, error}
    )

    write_pr_reviewer_workflow!(Workflow.workflow_file_path(), "Rejected reload")

    assert {:error, ^error} = WorkflowStore.force_reload()
    assert {:ok, %{prompt: ^original_prompt}} = Workflow.current()
    assert Config.settings!().tracker.kind == original_settings.tracker.kind
  end

  test "candidate reads page open pull requests and enrich only direct review requests" do
    first_page =
      Enum.map(1..97, fn number ->
        Map.put(raw_pull_request(number), "requested_reviewers", [%{"login" => "someone-else"}])
      end) ++
        [
          Map.put(raw_pull_request(98), "draft", true),
          Map.put(raw_pull_request(99), "title", ""),
          Map.put(raw_pull_request(100), "state", "closed")
        ]

    request_fun = fn "GET", path, params, nil, settings ->
      send(self(), {:github_pr_reviewer_request, path, params, settings})

      case path do
        "/user" ->
          {:ok, %{status: 200, body: %{"login" => "OCTOCAT"}}}

        "/repos/octo/repo/pulls" ->
          body = if params["page"] == 1, do: first_page, else: [raw_pull_request(101)]
          {:ok, %{status: 200, body: body}}

        "/repos/octo/repo/issues/101/timeline" ->
          {:ok,
           %{
             status: 200,
             body: [review_request_event("octocat", "2026-01-03T00:00:00Z")]
           }}

        "/repos/octo/repo/pulls/101/reviews" ->
          {:ok, %{status: 200, body: []}}

        "/repos/octo/repo/commits/sha-101/check-runs" ->
          {:ok, %{status: 200, body: %{"check_runs" => []}}}
      end
    end

    log =
      capture_log(fn ->
        assert {:ok, issues} =
                 Client.fetch_issues_by_states_for_test(
                   [" OPEN "],
                   tracker_settings(),
                   request_fun
                 )

        assert Enum.map(issues, & &1.id) == ["98", "101"]

        draft = Enum.find(issues, &(&1.id == "98"))
        refute draft.dispatchable

        dispatchable = Enum.find(issues, &(&1.id == "101"))
        assert dispatchable.dispatchable
        assert dispatchable.identifier == "GH-101"

        assert dispatchable.native_ref == %{
                 "id" => 10_101,
                 "node_id" => "PR_101",
                 "number" => 101,
                 "repo" => "octo/repo",
                 "head_sha" => "sha-101"
               }

        assert dispatchable.labels == ["bug", "platform"]
        assert dispatchable.state == "open"
      end)

    assert log =~ "Dropping malformed GitHub pull request records count=1"

    assert_receive {:github_pr_reviewer_request, "/user", %{}, %{repo: "octo/repo"}}

    assert_receive {:github_pr_reviewer_request, "/repos/octo/repo/pulls",
                    %{
                      "state" => "open",
                      "per_page" => 100,
                      "page" => 1,
                      "sort" => "created",
                      "direction" => "asc"
                    }, %{repo: "octo/repo"}}

    assert_receive {:github_pr_reviewer_request, "/repos/octo/repo/pulls", %{"page" => 2}, %{repo: "octo/repo"}}

    refute_receive {:github_pr_reviewer_request, "/repos/octo/repo/issues/98/timeline", _params, _settings}
  end

  test "ID refresh keeps ineligible pull requests and compares reviews with the latest direct request" do
    request_fun = fn "GET", path, _params, nil, _settings ->
      send(self(), {:github_pr_reviewer_id_request, path})

      case path do
        "/user" ->
          {:ok, %{status: 200, body: %{"login" => "octocat"}}}

        "/repos/octo/repo/pulls/1" ->
          {:ok,
           %{
             status: 200,
             body: Map.put(raw_pull_request(1), "requested_reviewers", [])
           }}

        "/repos/octo/repo/pulls/2" ->
          {:ok, %{status: 200, body: Map.put(raw_pull_request(2), "state", "closed")}}

        "/repos/octo/repo/pulls/3" ->
          {:ok, %{status: 200, body: raw_pull_request(3)}}

        "/repos/octo/repo/issues/3/timeline" ->
          {:ok,
           %{
             status: 200,
             body: [
               review_request_event("octocat", "2026-01-01T00:00:00Z"),
               review_request_event("someone-else", "2026-01-04T00:00:00Z"),
               review_request_event("OCTOCAT", "2026-01-03T00:00:00Z")
             ]
           }}

        "/repos/octo/repo/pulls/3/reviews" ->
          {:ok,
           %{
             status: 200,
             body: [
               review("octocat", "2026-01-02T00:00:00Z"),
               review("octocat", "2026-01-03T00:00:00Z")
             ]
           }}

        "/repos/octo/repo/commits/sha-3/check-runs" ->
          {:ok,
           %{
             status: 200,
             body: %{
               "check_runs" => [
                 check_run("success"),
                 check_run("neutral"),
                 check_run("skipped")
               ]
             }
           }}

        "/repos/octo/repo/pulls/4" ->
          {:ok, %{status: 200, body: raw_pull_request(4)}}

        "/repos/octo/repo/issues/4/timeline" ->
          {:ok,
           %{
             status: 200,
             body: [review_request_event("octocat", "2026-01-03T00:00:00Z")]
           }}

        "/repos/octo/repo/pulls/4/reviews" ->
          {:ok,
           %{
             status: 200,
             body: [review("octocat", "2026-01-04T00:00:00Z")]
           }}

        "/repos/octo/repo/pulls/5" ->
          {:ok, %{status: 200, body: raw_pull_request(5)}}

        "/repos/octo/repo/issues/5/timeline" ->
          {:ok,
           %{
             status: 200,
             body: [review_request_event("octocat", "2026-01-03T00:00:00Z")]
           }}

        "/repos/octo/repo/pulls/5/reviews" ->
          {:ok,
           %{
             status: 200,
             body: [review("someone-else", "2026-01-04T00:00:00Z")]
           }}

        "/repos/octo/repo/commits/sha-5/check-runs" ->
          {:ok, %{status: 200, body: %{"check_runs" => []}}}

        "/repos/octo/repo/pulls/404" ->
          {:ok, %{status: 404, body: %{"message" => "Not Found"}}}
      end
    end

    assert {:ok, issues} =
             Client.fetch_issues_by_ids_for_test(
               ["1", "2", "3", "4", "5", "404", "3"],
               tracker_settings(),
               request_fun
             )

    assert Enum.map(issues, & &1.id) == ["1", "2", "3", "4", "5"]
    refute Enum.find(issues, &(&1.id == "1")).dispatchable
    refute Enum.find(issues, &(&1.id == "2")).dispatchable
    assert Enum.find(issues, &(&1.id == "2")).state == "closed"
    assert Enum.find(issues, &(&1.id == "3")).dispatchable
    refute Enum.find(issues, &(&1.id == "4")).dispatchable
    assert Enum.find(issues, &(&1.id == "5")).dispatchable

    refute_receive {:github_pr_reviewer_id_request, "/repos/octo/repo/commits/sha-4/check-runs"}

    assert_receive {:github_pr_reviewer_id_request, "/repos/octo/repo/pulls/3"}
    refute_receive {:github_pr_reviewer_id_request, "/repos/octo/repo/pulls/3"}
  end

  test "timeline, reviews, and latest Check Runs are paged before dispatch" do
    timeline_page =
      Enum.map(1..100, fn _index ->
        %{"event" => "commented", "created_at" => "2026-01-01T00:00:00Z"}
      end)

    review_page = Enum.map(1..100, fn _index -> review("someone-else", "2026-01-04T00:00:00Z") end)
    check_run_page = Enum.map(1..100, fn _index -> check_run("success") end)

    request_fun = fn "GET", path, params, nil, _settings ->
      case path do
        "/user" ->
          {:ok, %{status: 200, body: %{"login" => "octocat"}}}

        "/repos/octo/repo/pulls/6" ->
          {:ok, %{status: 200, body: raw_pull_request(6)}}

        "/repos/octo/repo/issues/6/timeline" ->
          body =
            if params["page"] == 1 do
              timeline_page
            else
              [review_request_event("octocat", "2026-01-03T00:00:00Z")]
            end

          {:ok, %{status: 200, body: body}}

        "/repos/octo/repo/pulls/6/reviews" ->
          body = if params["page"] == 1, do: review_page, else: []
          {:ok, %{status: 200, body: body}}

        "/repos/octo/repo/commits/sha-6/check-runs" ->
          assert params["filter"] == "latest"
          body = if params["page"] == 1, do: check_run_page, else: [check_run("neutral")]
          {:ok, %{status: 200, body: %{"check_runs" => body}}}
      end
    end

    assert {:ok, [issue]} =
             Client.fetch_issues_by_ids_for_test(["6"], tracker_settings(), request_fun)

    assert issue.dispatchable
  end

  test "non-completed or non-passing Check Runs block dispatch" do
    conclusions = %{
      10 => %{"status" => "queued", "conclusion" => nil},
      11 => check_run("failure"),
      12 => check_run("timed_out"),
      13 => check_run("future_conclusion")
    }

    request_fun = fn "GET", path, _params, nil, _settings ->
      cond do
        path == "/user" ->
          {:ok, %{status: 200, body: %{"login" => "octocat"}}}

        Regex.match?(~r{/pulls/\d+$}, path) ->
          [number] = Regex.run(~r{/pulls/(\d+)$}, path, capture: :all_but_first)
          {:ok, %{status: 200, body: raw_pull_request(String.to_integer(number))}}

        Regex.match?(~r{/issues/\d+/timeline$}, path) ->
          {:ok,
           %{
             status: 200,
             body: [review_request_event("octocat", "2026-01-03T00:00:00Z")]
           }}

        Regex.match?(~r{/pulls/\d+/reviews$}, path) ->
          {:ok, %{status: 200, body: []}}

        Regex.match?(~r{/commits/sha-\d+/check-runs$}, path) ->
          [number] = Regex.run(~r{/commits/sha-(\d+)/check-runs$}, path, capture: :all_but_first)
          check_run = Map.fetch!(conclusions, String.to_integer(number))
          {:ok, %{status: 200, body: %{"check_runs" => [check_run]}}}
      end
    end

    assert {:ok, issues} =
             Client.fetch_issues_by_ids_for_test(
               ["10", "11", "12", "13"],
               tracker_settings(),
               request_fun
             )

    refute Enum.any?(issues, & &1.dispatchable)
  end

  test "a pull request whose dispatch check fails is dropped from the poll" do
    request_fun = fn "GET", path, _params, nil, _settings ->
      case path do
        "/user" ->
          {:ok, %{status: 200, body: %{"login" => "octocat"}}}

        "/repos/octo/repo/pulls" ->
          {:ok, %{status: 200, body: [raw_pull_request(1), raw_pull_request(2)]}}

        "/repos/octo/repo/issues/1/timeline" ->
          {:ok, %{status: 200, body: [review_request_event("octocat", "2026-01-03T00:00:00Z")]}}

        "/repos/octo/repo/pulls/1/reviews" ->
          {:ok, %{status: 200, body: []}}

        "/repos/octo/repo/commits/sha-1/check-runs" ->
          {:ok, %{status: 200, body: %{"check_runs" => [check_run("success")]}}}

        "/repos/octo/repo/issues/2/timeline" ->
          {:error, :econnrefused}
      end
    end

    log =
      capture_log(fn ->
        assert {:ok, issues} =
                 Client.fetch_issues_by_states_for_test(["open"], tracker_settings(), request_fun)

        assert Enum.map(issues, & &1.id) == ["1"]
        assert Enum.map(issues, & &1.dispatchable) == [true]
      end)

    assert log =~ "Dropping pull request from candidate poll"
    assert log =~ "identifier=GH-2"
  end

  test "empty and unsupported reads avoid requests while malformed identity and IDs fail" do
    no_request = fn _method, _path, _params, _body, _settings ->
      flunk("empty or unsupported reads should not make a GitHub request")
    end

    assert {:ok, []} =
             Client.fetch_issues_by_states_for_test(
               ["closed"],
               tracker_settings(),
               no_request
             )

    assert {:ok, []} =
             Client.fetch_issues_by_ids_for_test([], tracker_settings(), no_request)

    assert {:error, :invalid_github_issue_id} =
             Client.fetch_issues_by_ids_for_test(
               ["not-a-number"],
               tracker_settings(),
               no_request
             )

    assert {:error, :github_unknown_payload} =
             Client.fetch_issues_by_states_for_test(
               ["open"],
               tracker_settings(),
               fn "GET", "/user", %{}, nil, _settings ->
                 {:ok, %{status: 200, body: %{"login" => " "}}}
               end
             )
  end

  test "GitHub failures and malformed eligibility payloads fail the read" do
    assert {:error, {:github_api_status, 401}} =
             Client.fetch_issues_by_states_for_test(
               ["open"],
               tracker_settings(),
               fn "GET", "/user", %{}, nil, _settings ->
                 {:ok, %{status: 401, body: %{"message" => "Bad credentials"}}}
               end
             )

    assert {:error, :github_unknown_payload} =
             Client.fetch_issues_by_ids_for_test(
               ["7"],
               tracker_settings(),
               fn "GET", path, _params, nil, _settings ->
                 case path do
                   "/user" ->
                     {:ok, %{status: 200, body: %{"login" => "octocat"}}}

                   "/repos/octo/repo/pulls/7" ->
                     {:ok, %{status: 200, body: raw_pull_request(7)}}

                   "/repos/octo/repo/issues/7/timeline" ->
                     {:ok, %{status: 200, body: []}}
                 end
               end
             )
  end

  defp tracker_settings(provider_overrides \\ %{}) do
    %{
      kind: "github_pr_reviewer",
      provider:
        Map.merge(
          %{
            "repo" => "octo/repo",
            "token" => "test-token"
          },
          provider_overrides
        ),
      active_states: ["open"],
      terminal_states: ["closed"]
    }
  end

  defp raw_pull_request(number) do
    %{
      "number" => number,
      "id" => 10_000 + number,
      "node_id" => "PR_#{number}",
      "title" => "Pull request #{number}",
      "body" => "Body #{number}",
      "state" => "open",
      "draft" => false,
      "html_url" => "https://github.test/octo/repo/pull/#{number}",
      "assignee" => %{"login" => "hubot"},
      "requested_reviewers" => [%{"login" => "octocat"}],
      "requested_teams" => [%{"slug" => "platform"}],
      "head" => %{"sha" => "sha-#{number}", "ref" => "feature-#{number}"},
      "labels" => [%{"name" => " Bug "}, %{"name" => "bug"}, %{"name" => "Platform"}],
      "created_at" => "2026-01-01T00:00:00Z",
      "updated_at" => "2026-01-02T00:00:00Z"
    }
  end

  defp review_request_event(login, created_at) do
    %{
      "event" => "review_requested",
      "requested_reviewer" => %{"login" => login},
      "created_at" => created_at
    }
  end

  defp review(login, submitted_at) do
    %{"user" => %{"login" => login}, "submitted_at" => submitted_at}
  end

  defp check_run(conclusion) do
    %{"status" => "completed", "conclusion" => conclusion}
  end

  defp write_pr_reviewer_workflow!(path, prompt) do
    File.write!(
      path,
      """
      ---
      tracker:
        kind: github_pr_reviewer
        provider:
          repo: "octo/repo"
          token: "test-token"
        active_states: ["open"]
        terminal_states: ["closed"]
      ---

      #{prompt}
      """
    )
  end

  test "adapter fetches issues by identifiers via numeric ids" do
    Application.put_env(:symphony_elixir, :github_pr_reviewer_client_module, FakePrReviewerClient)

    assert {:ok, ["123", "7"]} =
             Adapter.fetch_issues_by_identifiers(["GH-123", "GH-7", "GH-x", "OTHER-1", "GH-"])

    assert_receive {:github_pr_reviewer_ids_called, ["123", "7"]}

    assert Adapter.identifier_candidate?("GH-123")
    refute Adapter.identifier_candidate?("GH-x")
    refute Adapter.identifier_candidate?("OTHER-1")
  end
end

defmodule SymphonyElixir.GitHub.PrAuthor.AdapterTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.GitHub.PrAuthor.Adapter
  alias SymphonyElixir.GitHub.PrAuthor.Client

  defmodule FakePrAuthorClient do
    def preflight(_settings) do
      Application.get_env(:symphony_elixir, :github_pr_author_preflight_result, :ok)
    end

    def fetch_issues_by_states(states) do
      send(self(), {:github_pr_author_states_called, states})
      {:ok, states}
    end

    def fetch_issues_by_ids(ids) do
      send(self(), {:github_pr_author_ids_called, ids})
      {:ok, ids}
    end
  end

  setup do
    client_module = Application.get_env(:symphony_elixir, :github_pr_author_client_module)

    preflight_result =
      Application.get_env(:symphony_elixir, :github_pr_author_preflight_result)

    on_exit(fn ->
      if is_nil(client_module) do
        Application.delete_env(:symphony_elixir, :github_pr_author_client_module)
      else
        Application.put_env(:symphony_elixir, :github_pr_author_client_module, client_module)
      end

      if is_nil(preflight_result) do
        Application.delete_env(:symphony_elixir, :github_pr_author_preflight_result)
      else
        Application.put_env(
          :symphony_elixir,
          :github_pr_author_preflight_result,
          preflight_result
        )
      end
    end)

    :ok
  end

  test "adapter reuses GitHub config, tools, and secrets while delegating feedback reads" do
    settings = tracker_settings()

    assert :ok = Adapter.validate_config(settings)

    assert {:error, :missing_github_active_states} =
             Adapter.validate_config(%{settings | active_states: nil})

    assert {:error, :invalid_github_states} =
             Adapter.validate_config(%{settings | active_states: ["merged"]})

    assert {:error, :missing_github_repo} =
             Adapter.validate_config(tracker_settings(%{"repo" => nil}))

    Application.put_env(
      :symphony_elixir,
      :github_pr_author_client_module,
      FakePrAuthorClient
    )

    assert :ok = Tracker.preflight(settings)

    assert {:ok, ["open"]} = Adapter.fetch_issues_by_states(["open"])
    assert_receive {:github_pr_author_states_called, ["open"]}

    assert {:ok, ["42"]} = Adapter.fetch_issues_by_ids(["42"])
    assert_receive {:github_pr_author_ids_called, ["42"]}

    assert [%{"name" => "github_api"}] = Adapter.agent_tool_specs()

    assert Adapter.execute_agent_tool(
             "github_api",
             %{"method" => "GET", "path" => "/user"},
             github_client: fn _method, _path, _params, _body, _opts ->
               {:ok, %{status: 200, body: %{"login" => "octocat"}}}
             end
           )["success"]

    assert Adapter.secret_environment_names(tracker_settings(%{"token" => "$SYMPHONY_GITHUB_FEEDBACK_TOKEN"})) ==
             [
               "GITHUB_TOKEN",
               "GH_TOKEN",
               "GITHUB_ENTERPRISE_TOKEN",
               "GH_ENTERPRISE_TOKEN",
               "SYMPHONY_GITHUB_FEEDBACK_TOKEN"
             ]

    assert {:ok, Adapter} = SymphonyElixir.Tracker.adapter_for_kind("github_pr_author")
  end

  test "workflow reload accepts the github_pr_author kind" do
    Application.put_env(
      :symphony_elixir,
      :github_pr_author_client_module,
      FakePrAuthorClient
    )

    write_pr_author_workflow!(Workflow.workflow_file_path(), "Answer review feedback")

    assert :ok = WorkflowStore.force_reload()
    assert Config.settings!().tracker.kind == "github_pr_author"
  end

  test "candidate reads page authored open pull requests and gate on completed checks" do
    first_page =
      Enum.map(1..97, fn number ->
        Map.put(raw_pull_request(number), "user", %{"login" => "someone-else"})
      end) ++
        [
          Map.put(raw_pull_request(98), "draft", true),
          Map.put(raw_pull_request(99), "title", ""),
          Map.put(raw_pull_request(100), "state", "closed")
        ]

    request_fun = fn
      "GET", path, params, nil, settings ->
        send(self(), {:github_pr_author_request, path, params, settings})

        case path do
          "/user" ->
            {:ok, %{status: 200, body: %{"login" => "OCTOCAT"}}}

          "/repos/octo/repo/pulls" ->
            body = if params["page"] == 1, do: first_page, else: [raw_pull_request(101)]
            {:ok, %{status: 200, body: body}}

          "/repos/octo/repo/commits/sha-98/check-runs" ->
            {:ok, %{status: 200, body: %{"check_runs" => [check_run("success")]}}}

          "/repos/octo/repo/commits/sha-101/check-runs" ->
            {:ok,
             %{
               status: 200,
               body: %{"check_runs" => [%{"status" => "queued", "conclusion" => nil}]}
             }}
        end

      "POST", "/graphql", %{}, body, _settings ->
        send(self(), {:github_pr_author_graphql, body["variables"]["number"]})

        feedback_response(body, %{
          98 => feedback(threads: [thread(false, "coderabbitai[bot]")])
        })
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

        dispatchable = Enum.find(issues, &(&1.id == "98"))
        assert dispatchable.dispatchable
        assert dispatchable.identifier == "GH-98"
        assert dispatchable.branch_name == "feature-98"

        assert dispatchable.native_ref == %{
                 "id" => 10_098,
                 "node_id" => "PR_98",
                 "number" => 98,
                 "repo" => "octo/repo",
                 "author" => "octocat",
                 "head_sha" => "sha-98"
               }

        assert dispatchable.dispatch_reasons == ["unresolved_threads:1"]

        waiting = Enum.find(issues, &(&1.id == "101"))
        refute waiting.dispatchable
      end)

    assert log =~ "Dropping malformed GitHub pull request records count=1"

    assert_receive {:github_pr_author_request, "/user", %{}, %{repo: "octo/repo"}}

    assert_receive {:github_pr_author_request, "/repos/octo/repo/pulls",
                    %{
                      "state" => "open",
                      "per_page" => 100,
                      "page" => 1,
                      "sort" => "created",
                      "direction" => "asc"
                    }, %{repo: "octo/repo"}}

    assert_receive {:github_pr_author_request, "/repos/octo/repo/pulls", %{"page" => 2}, %{repo: "octo/repo"}}

    assert_receive {:github_pr_author_graphql, 98}
    refute_receive {:github_pr_author_graphql, 101}
    refute_receive {:github_pr_author_request, "/repos/octo/repo/commits/sha-1/check-runs", _params, _settings}
  end

  test "a pull request whose dispatch check fails is dropped from the poll" do
    request_fun = fn
      "GET", path, _params, nil, _settings ->
        case path do
          "/user" ->
            {:ok, %{status: 200, body: %{"login" => "octocat"}}}

          "/repos/octo/repo/pulls" ->
            {:ok, %{status: 200, body: [raw_pull_request(1), raw_pull_request(2)]}}

          "/repos/octo/repo/commits/sha-1/check-runs" ->
            {:ok, %{status: 200, body: %{"check_runs" => [check_run("failure")]}}}

          "/repos/octo/repo/commits/sha-2/check-runs" ->
            {:error, :econnrefused}
        end

      "POST", "/graphql", %{}, body, _settings ->
        feedback_response(body, %{})
    end

    log =
      capture_log(fn ->
        assert {:ok, issues} =
                 Client.fetch_issues_by_states_for_test(["open"], tracker_settings(), request_fun)

        assert Enum.map(issues, & &1.id) == ["1"]
        assert dispatchable_ids(issues) == ["1"]
      end)

    assert log =~ "Dropping pull request from candidate poll"
    assert log =~ "identifier=GH-2"
  end

  test "unresolved threads dispatch only when the last comment is not the viewer's" do
    feedback_by_number = %{
      1 => feedback(threads: [thread(true, "reviewer")]),
      2 => feedback(threads: [thread(false, "OCTOCAT")]),
      3 => feedback(threads: [thread(true, "reviewer"), thread(false, "reviewer")]),
      4 => feedback(threads: [thread(false, nil)])
    }

    assert {:ok, issues} =
             Client.fetch_issues_by_ids_for_test(
               ["1", "2", "3", "4"],
               tracker_settings(),
               ids_request_fun(feedback_by_number)
             )

    assert dispatchable_ids(issues) == ["3", "4"]
  end

  test "failing checks dispatch until viewer activity after their completion" do
    check_runs_by_number = %{
      1 => [check_run("failure")],
      2 => [check_run("failure")],
      3 => [check_run("timed_out")],
      4 => [check_run("failure")],
      5 => [check_run("failure")]
    }

    feedback_by_number = %{
      1 => feedback(),
      2 => feedback(comments: [issue_comment("octocat", "2026-01-03T00:00:00Z")]),
      3 => feedback(comments: [issue_comment("octocat", "2026-01-02T00:00:00Z")]),
      4 => feedback(comments: [issue_comment("someone-else", "2026-01-03T00:00:00Z")]),
      5 => feedback(reviews: [review("COMMENTED", "octocat", "2026-01-03T00:00:00Z", nil, 1)])
    }

    assert {:ok, issues} =
             Client.fetch_issues_by_ids_for_test(
               ["1", "2", "3", "4", "5"],
               tracker_settings(),
               ids_request_fun(feedback_by_number, check_runs_by_number)
             )

    assert dispatchable_ids(issues) == ["1", "3", "4"]
  end

  test "changes-requested reviews dispatch only without inline comments on the current head" do
    feedback_by_number = %{
      1 => feedback(reviews: [review("CHANGES_REQUESTED", "reviewer", "2026-01-02T00:00:00Z", "sha-1", 0)]),
      2 => feedback(reviews: [review("CHANGES_REQUESTED", "reviewer", "2026-01-02T00:00:00Z", "sha-2", 2)]),
      3 =>
        feedback(
          reviews: [review("CHANGES_REQUESTED", "reviewer", "2026-01-02T00:00:00Z", "old-sha", 0)],
          review_requests: [review_request("reviewer")]
        ),
      4 => feedback(reviews: [review("CHANGES_REQUESTED", "reviewer", "2026-01-02T00:00:00Z", nil, 0)]),
      5 => feedback(reviews: [review("CHANGES_REQUESTED", "OCTOCAT", "2026-01-02T00:00:00Z", "sha-5", 0)]),
      6 => feedback(reviews: [review("APPROVED", "reviewer", "2026-01-02T00:00:00Z", "sha-6", 0)]),
      7 =>
        feedback(
          reviews: [review("CHANGES_REQUESTED", "reviewer", "2026-01-02T00:00:00Z", "sha-7", 0)],
          comments: [issue_comment("octocat", "2026-01-03T00:00:00Z")]
        ),
      8 => feedback(reviews: [%{"state" => "PENDING"}])
    }

    assert {:ok, issues} =
             Client.fetch_issues_by_ids_for_test(
               ["1", "2", "3", "4", "5", "6", "7", "8"],
               tracker_settings(),
               ids_request_fun(feedback_by_number)
             )

    assert dispatchable_ids(issues) == ["1", "4"]
  end

  test "reviewers dispatch for re-request once their latest review no longer targets the head" do
    feedback_by_number = %{
      1 => feedback(reviews: [review("COMMENTED", "reviewer", "2026-01-02T00:00:00Z", "old-sha", 1)]),
      2 =>
        feedback(
          reviews: [review("COMMENTED", "reviewer", "2026-01-02T00:00:00Z", "old-sha", 1)],
          review_requests: [review_request("reviewer")]
        ),
      3 => feedback(reviews: [review("COMMENTED", "reviewer", "2026-01-02T00:00:00Z", "sha-3", 1)]),
      4 => feedback(reviews: [bot_review("COMMENTED", "coderabbitai", "2026-01-02T00:00:00Z", "old-sha", 1)]),
      5 => feedback(reviews: [review("COMMENTED", "reviewer", "2026-01-02T00:00:00Z", nil, 1)]),
      6 => feedback(reviews: [review("COMMENTED", "OCTOCAT", "2026-01-02T00:00:00Z", "old-sha", 1)]),
      7 =>
        feedback(
          reviews: [
            review("COMMENTED", "reviewer", "2026-01-02T00:00:00Z", "old-sha", 1),
            review("COMMENTED", "reviewer", "2026-01-03T00:00:00Z", "sha-7", 1)
          ]
        )
    }

    assert {:ok, issues} =
             Client.fetch_issues_by_ids_for_test(
               ["1", "2", "3", "4", "5", "6", "7"],
               tracker_settings(),
               ids_request_fun(feedback_by_number)
             )

    assert dispatchable_ids(issues) == ["1"]
  end

  test "dispatch reasons report every holding reason with its count" do
    check_runs_by_number = %{1 => [check_run("failure"), check_run("timed_out"), check_run("success")]}

    feedback_by_number = %{
      1 =>
        feedback(
          threads: [thread(false, "reviewer"), thread(false, "reviewer"), thread(true, "reviewer")],
          reviews: [review("CHANGES_REQUESTED", "reviewer", "2026-01-02T00:00:00Z", "sha-1", 0)]
        )
    }

    assert {:ok, [issue]} =
             Client.fetch_issues_by_ids_for_test(
               ["1"],
               tracker_settings(),
               ids_request_fun(feedback_by_number, check_runs_by_number)
             )

    assert issue.dispatchable

    assert issue.dispatch_reasons == [
             "unresolved_threads:2",
             "failing_checks:2",
             "changes_requested"
           ]
  end

  test "convergence needs a human approval of the head with nothing else pending" do
    check_runs_by_number = %{5 => [check_run("failure")]}

    feedback_by_number = %{
      1 => feedback(reviews: [review("APPROVED", "reviewer", "2026-01-02T00:00:00Z", "sha-1", 0)]),
      2 => feedback(reviews: [bot_review("APPROVED", "coderabbitai", "2026-01-02T00:00:00Z", "sha-2", 0)]),
      3 => feedback(reviews: [review("APPROVED", "reviewer", "2026-01-02T00:00:00Z", "old-sha", 0)]),
      4 =>
        feedback(
          threads: [thread(false, "OCTOCAT")],
          reviews: [review("APPROVED", "reviewer", "2026-01-02T00:00:00Z", "sha-4", 0)]
        ),
      5 =>
        feedback(
          reviews: [review("APPROVED", "reviewer", "2026-01-02T00:00:00Z", "sha-5", 0)],
          comments: [issue_comment("octocat", "2026-01-04T00:00:00Z")]
        )
    }

    assert {:ok, issues} =
             Client.fetch_issues_by_ids_for_test(
               ["1", "2", "3", "4", "5"],
               tracker_settings(),
               ids_request_fun(feedback_by_number, check_runs_by_number)
             )

    assert converged_ids(issues) == ["1"]
    assert Enum.find(issues, &(&1.id == "1")).native_ref["head_sha"] == "sha-1"
    assert dispatchable_ids(issues) == ["3"]
  end

  test "feedback fetches first pages in one query and pages only incomplete connections" do
    all_fields = ["reviewThreads", "reviews", "comments", "reviewRequests"]

    request_fun = fn
      "GET", path, _params, nil, _settings ->
        case path do
          "/user" -> {:ok, %{status: 200, body: %{"login" => "octocat"}}}
          "/repos/octo/repo/pulls/1" -> {:ok, %{status: 200, body: raw_pull_request(1)}}
          "/repos/octo/repo/commits/sha-1/check-runs" -> {:ok, %{status: 200, body: %{"check_runs" => []}}}
        end

      "POST", "/graphql", %{}, body, _settings ->
        fields = graphql_fields(body)
        cursor = body["variables"]["cursor"]
        send(self(), {:github_pr_author_graphql, fields, cursor})

        response_body =
          case {fields, cursor} do
            {^all_fields, nil} ->
              %{
                "data" => %{
                  "repository" => %{
                    "pullRequest" => %{
                      "reviewThreads" => page([thread(true, "reviewer")], "thread-cursor"),
                      "reviews" => page([], "review-cursor"),
                      "comments" => page([]),
                      "reviewRequests" => page([])
                    }
                  }
                }
              }

            {["reviewThreads"], "thread-cursor"} ->
              graphql_body("reviewThreads", page([thread(false, "reviewer")]))

            {["reviews"], "review-cursor"} ->
              graphql_body("reviews", page([]))
          end

        {:ok, %{status: 200, body: response_body}}
    end

    assert {:ok, [issue]} =
             Client.fetch_issues_by_ids_for_test(["1"], tracker_settings(), request_fun)

    assert issue.dispatchable

    assert_receive {:github_pr_author_graphql, ^all_fields, nil}
    assert_receive {:github_pr_author_graphql, ["reviewThreads"], "thread-cursor"}
    assert_receive {:github_pr_author_graphql, ["reviews"], "review-cursor"}
    refute_receive {:github_pr_author_graphql, ["comments"], _cursor}
    refute_receive {:github_pr_author_graphql, ["reviewRequests"], _cursor}
  end

  test "GraphQL failures and malformed payloads fail the read" do
    graphql_results = [
      {:ok, %{status: 200, body: %{"errors" => [%{"message" => "boom"}], "data" => nil}}},
      {:ok, %{status: 200, body: %{"data" => %{"repository" => nil}}}},
      {:ok, %{status: 500, body: %{"message" => "oops"}}},
      {:ok, %{status: 200, body: graphql_body("reviewThreads", %{"nodes" => []})}},
      {:ok, %{status: 200, body: graphql_body("reviewThreads", page([%{"isResolved" => "yes"}]))}}
    ]

    expected_errors = [
      :github_unknown_payload,
      :github_unknown_payload,
      {:github_api_status, 500},
      :github_unknown_payload,
      :github_unknown_payload
    ]

    capture_log(fn ->
      for {graphql_result, expected_error} <- Enum.zip(graphql_results, expected_errors) do
        request_fun = fn
          "GET", path, _params, nil, _settings ->
            case path do
              "/user" ->
                {:ok, %{status: 200, body: %{"login" => "octocat"}}}

              "/repos/octo/repo/pulls/1" ->
                {:ok, %{status: 200, body: raw_pull_request(1)}}

              "/repos/octo/repo/commits/sha-1/check-runs" ->
                {:ok, %{status: 200, body: %{"check_runs" => []}}}
            end

          "POST", "/graphql", %{}, _body, _settings ->
            graphql_result
        end

        assert {:error, ^expected_error} =
                 Client.fetch_issues_by_ids_for_test(["1"], tracker_settings(), request_fun)
      end
    end)
  end

  test "ID refresh keeps ineligible pull requests and skips missing ones" do
    request_fun = fn
      "GET", path, _params, nil, _settings ->
        send(self(), {:github_pr_author_id_request, path})

        case path do
          "/user" ->
            {:ok, %{status: 200, body: %{"login" => "octocat"}}}

          "/repos/octo/repo/pulls/1" ->
            {:ok, %{status: 200, body: raw_pull_request(1)}}

          "/repos/octo/repo/pulls/2" ->
            {:ok, %{status: 200, body: Map.put(raw_pull_request(2), "state", "closed")}}

          "/repos/octo/repo/pulls/3" ->
            {:ok, %{status: 200, body: Map.put(raw_pull_request(3), "user", %{"login" => "someone-else"})}}

          "/repos/octo/repo/pulls/404" ->
            {:ok, %{status: 404, body: %{"message" => "Not Found"}}}

          "/repos/octo/repo/commits/sha-1/check-runs" ->
            {:ok, %{status: 200, body: %{"check_runs" => []}}}
        end

      "POST", "/graphql", %{}, body, _settings ->
        feedback_response(body, %{1 => feedback()})
    end

    assert {:ok, issues} =
             Client.fetch_issues_by_ids_for_test(
               ["1", "2", "3", "404", "1"],
               tracker_settings(),
               request_fun
             )

    assert Enum.map(issues, & &1.id) == ["1", "2", "3"]
    assert dispatchable_ids(issues) == []
    assert Enum.find(issues, &(&1.id == "2")).state == "closed"

    assert_receive {:github_pr_author_id_request, "/repos/octo/repo/pulls/1"}
    refute_receive {:github_pr_author_id_request, "/repos/octo/repo/pulls/1"}
    refute_receive {:github_pr_author_id_request, "/repos/octo/repo/commits/sha-2/check-runs"}
    refute_receive {:github_pr_author_id_request, "/repos/octo/repo/commits/sha-3/check-runs"}
  end

  test "empty and unsupported reads avoid requests while malformed identity and IDs fail" do
    no_request = fn _method, _path, _params, _body, _settings ->
      flunk("empty or unsupported reads should not make a GitHub request")
    end

    assert {:ok, []} =
             Client.fetch_issues_by_states_for_test(["closed"], tracker_settings(), no_request)

    assert {:ok, []} = Client.fetch_issues_by_ids_for_test([], tracker_settings(), no_request)

    assert {:error, :invalid_github_issue_id} =
             Client.fetch_issues_by_ids_for_test(["not-a-number"], tracker_settings(), no_request)

    assert {:error, :github_unknown_payload} =
             Client.fetch_issues_by_states_for_test(
               ["open"],
               tracker_settings(),
               fn "GET", "/user", %{}, nil, _settings ->
                 {:ok, %{status: 200, body: %{"login" => " "}}}
               end
             )
  end

  test "GitHub failures and malformed pull request payloads fail the read" do
    assert {:error, {:github_api_status, 401}} =
             Client.fetch_issues_by_states_for_test(
               ["open"],
               tracker_settings(),
               fn "GET", "/user", %{}, nil, _settings ->
                 {:ok, %{status: 401, body: %{"message" => "Bad credentials"}}}
               end
             )

    malformed_pull_request = fn
      "GET", "/user", _params, nil, _settings ->
        {:ok, %{status: 200, body: %{"login" => "octocat"}}}

      "GET", "/repos/octo/repo/pulls/7", _params, nil, _settings ->
        {:ok, %{status: 200, body: Map.put(raw_pull_request(7), "title", "")}}
    end

    assert {:error, :github_unknown_payload} =
             Client.fetch_issues_by_ids_for_test(["7"], tracker_settings(), malformed_pull_request)

    missing_completion = fn
      "GET", "/user", _params, nil, _settings ->
        {:ok, %{status: 200, body: %{"login" => "octocat"}}}

      "GET", "/repos/octo/repo/pulls/8", _params, nil, _settings ->
        {:ok, %{status: 200, body: raw_pull_request(8)}}

      "GET", "/repos/octo/repo/commits/sha-8/check-runs", _params, nil, _settings ->
        {:ok,
         %{
           status: 200,
           body: %{
             "check_runs" => [%{"status" => "completed", "conclusion" => "failure", "completed_at" => nil}]
           }
         }}
    end

    assert {:error, :github_unknown_payload} =
             Client.fetch_issues_by_ids_for_test(["8"], tracker_settings(), missing_completion)
  end

  defp ids_request_fun(feedback_by_number, check_runs_by_number \\ %{}) do
    fn
      "GET", path, _params, nil, _settings ->
        cond do
          path == "/user" ->
            {:ok, %{status: 200, body: %{"login" => "OCTOCAT"}}}

          Regex.match?(~r{/pulls/\d+$}, path) ->
            [number] = Regex.run(~r{/pulls/(\d+)$}, path, capture: :all_but_first)
            {:ok, %{status: 200, body: raw_pull_request(String.to_integer(number))}}

          Regex.match?(~r{/commits/sha-\d+/check-runs$}, path) ->
            [number] = Regex.run(~r{/commits/sha-(\d+)/check-runs$}, path, capture: :all_but_first)
            check_runs = Map.get(check_runs_by_number, String.to_integer(number), [])
            {:ok, %{status: 200, body: %{"check_runs" => check_runs}}}
        end

      "POST", "/graphql", %{}, body, _settings ->
        feedback_response(body, feedback_by_number)
    end
  end

  defp feedback_response(body, feedback_by_number) do
    number = body["variables"]["number"]
    feedback = Map.get(feedback_by_number, number, feedback())

    case graphql_fields(body) do
      [field] ->
        {:ok, %{status: 200, body: graphql_body(field, Map.fetch!(feedback, field))}}

      _all_fields ->
        {:ok, %{status: 200, body: %{"data" => %{"repository" => %{"pullRequest" => feedback}}}}}
    end
  end

  # 중첩 필드(스레드의 comments(last: 1), 리뷰의 comments(first: 1))와 겹치지
  # 않도록 최상위 connection의 인자까지 시그니처로 삼는다.
  defp graphql_fields(%{"query" => query}) do
    for {field, signature} <- [
          {"reviewThreads", "reviewThreads("},
          {"reviews", "reviews(first: 100"},
          {"comments", "comments(first: 100"},
          {"reviewRequests", "reviewRequests("}
        ],
        String.contains?(query, signature),
        do: field
  end

  defp graphql_body(field, connection) do
    %{"data" => %{"repository" => %{"pullRequest" => %{field => connection}}}}
  end

  defp feedback(connections \\ []) do
    %{
      "reviewThreads" => page(Keyword.get(connections, :threads, [])),
      "reviews" => page(Keyword.get(connections, :reviews, [])),
      "comments" => page(Keyword.get(connections, :comments, [])),
      "reviewRequests" => page(Keyword.get(connections, :review_requests, []))
    }
  end

  defp page(nodes, end_cursor \\ nil) do
    %{
      "pageInfo" => %{"hasNextPage" => is_binary(end_cursor), "endCursor" => end_cursor},
      "nodes" => nodes
    }
  end

  defp thread(resolved, last_author) do
    %{"isResolved" => resolved, "comments" => %{"nodes" => [%{"author" => author_ref(last_author)}]}}
  end

  defp review(state, login, submitted_at, commit_oid, inline_comment_count) do
    %{
      "state" => state,
      "submittedAt" => submitted_at,
      "author" => author_ref(login),
      "commit" => if(is_nil(commit_oid), do: nil, else: %{"oid" => commit_oid}),
      "comments" => %{"totalCount" => inline_comment_count}
    }
  end

  defp review_request(login) do
    %{"requestedReviewer" => %{"__typename" => "User", "login" => login}}
  end

  defp bot_review(state, login, submitted_at, commit_oid, inline_comment_count) do
    state
    |> review(login, submitted_at, commit_oid, inline_comment_count)
    |> put_in(["author", "__typename"], "Bot")
  end

  defp issue_comment(login, created_at) do
    %{"author" => author_ref(login), "createdAt" => created_at}
  end

  defp author_ref(nil), do: nil
  defp author_ref(login), do: %{"login" => login}

  defp check_run(conclusion) do
    %{"status" => "completed", "conclusion" => conclusion, "completed_at" => "2026-01-02T00:00:00Z"}
  end

  defp dispatchable_ids(issues) do
    for issue <- issues, issue.dispatchable, do: issue.id
  end

  defp converged_ids(issues) do
    for issue <- issues, issue.native_ref["converged"] == true, do: issue.id
  end

  defp tracker_settings(provider_overrides \\ %{}) do
    %{
      kind: "github_pr_author",
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
      "user" => %{"login" => "octocat"},
      "html_url" => "https://github.test/octo/repo/pull/#{number}",
      "head" => %{"sha" => "sha-#{number}", "ref" => "feature-#{number}"},
      "labels" => [%{"name" => "bug"}],
      "created_at" => "2026-01-01T00:00:00Z",
      "updated_at" => "2026-01-02T00:00:00Z"
    }
  end

  defp write_pr_author_workflow!(path, prompt) do
    File.write!(
      path,
      """
      ---
      tracker:
        kind: github_pr_author
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
    Application.put_env(:symphony_elixir, :github_pr_author_client_module, FakePrAuthorClient)

    assert {:ok, ["123", "7"]} =
             Adapter.fetch_issues_by_identifiers(["GH-123", "GH-7", "GH-x", "OTHER-1", "GH-"])

    assert_receive {:github_pr_author_ids_called, ["123", "7"]}

    assert Adapter.identifier_candidate?("GH-123")
    refute Adapter.identifier_candidate?("GH-x")
    refute Adapter.identifier_candidate?("OTHER-1")
  end
end

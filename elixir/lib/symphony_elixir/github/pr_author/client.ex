defmodule SymphonyElixir.GitHub.PrAuthor.Client do
  @moduledoc """
  GitHub client for open pull requests authored by the authenticated user that
  carry unanswered review feedback or failing checks.

  A pull request becomes dispatchable only when every Check Run on its head is
  completed and at least one dispatch reason holds:

  1. an unresolved review thread whose last comment is not by the viewer;
  2. a failing Check Run with no viewer activity after its completion;
  3. a `CHANGES_REQUESTED` review without inline comments that still targets
     the current head and has no viewer activity after its submission;
  4. a human reviewer whose latest review no longer targets the current head
     and who is absent from the current review requests.

  Viewer activity is observed as issue comments and submitted reviews (thread
  replies always create a viewer review). A push erases reason 2 by changing
  the head and reason 3 through the review-commit comparison. Reason 4 is
  erased by requesting that reviewer again, or by their review of the new head.

  Each holding reason is also recorded on the issue as a code, and a pull request
  with no reason left, every check passing, no unresolved thread, and a human
  approval of the current head is marked converged on that head: only a human
  merge remains.
  """

  require Logger

  alias SymphonyElixir.Config
  alias SymphonyElixir.GitHub.Client
  alias SymphonyElixir.GitHub.PullRequests
  alias SymphonyElixir.Tracker.Issue

  @open_state "open"
  @passing_check_run_conclusions ["neutral", "skipped", "success"]

  @feedback_fields %{
    "reviewThreads" => """
    reviewThreads(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        isResolved
        comments(last: 1) { nodes { author { login } } }
      }
    }
    """,
    "reviews" => """
    reviews(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        state
        submittedAt
        author { __typename login }
        commit { oid }
        comments(first: 1) { totalCount }
      }
    }
    """,
    "reviewRequests" => """
    reviewRequests(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { requestedReviewer { __typename ... on User { login } } }
    }
    """,
    "comments" => """
    comments(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { author { login } createdAt }
    }
    """
  }

  @spec preflight(map()) :: :ok | {:error, term()}
  def preflight(tracker_settings) when is_map(tracker_settings) do
    Client.preflight(tracker_settings)
  end

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states(state_names) when is_list(state_names) do
    fetch_issues_by_states(state_names, Config.settings!().tracker, nil)
  end

  @spec fetch_issues_by_ids([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_ids(issue_ids) when is_list(issue_ids) do
    fetch_issues_by_ids(issue_ids, Config.settings!().tracker, nil)
  end

  @doc false
  @spec fetch_issues_by_states_for_test([String.t()], map(), function()) ::
          {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states_for_test(state_names, tracker_settings, request_fun)
      when is_list(state_names) and is_map(tracker_settings) and is_function(request_fun, 5) do
    fetch_issues_by_states(state_names, tracker_settings, request_fun)
  end

  @doc false
  @spec fetch_issues_by_ids_for_test([String.t()], map(), function()) ::
          {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_ids_for_test(issue_ids, tracker_settings, request_fun)
      when is_list(issue_ids) and is_map(tracker_settings) and is_function(request_fun, 5) do
    fetch_issues_by_ids(issue_ids, tracker_settings, request_fun)
  end

  defp fetch_issues_by_states(state_names, tracker_settings, request_fun) do
    requested_states = state_names |> Enum.map(&PullRequests.normalize_state/1) |> MapSet.new()

    if MapSet.member?(requested_states, @open_state) do
      fetch_open_authored_issues(tracker_settings, request_fun)
    else
      {:ok, []}
    end
  end

  defp fetch_open_authored_issues(tracker_settings, request_fun) do
    with {:ok, settings} <- Client.resolve_settings(tracker_settings),
         {:ok, viewer_login} <- PullRequests.fetch_viewer_login(settings, request_fun),
         {:ok, payload} <- PullRequests.fetch_open_pull_requests(settings, request_fun) do
      payload
      |> PullRequests.normalize_pull_requests(settings.repo)
      |> Enum.filter(fn {pull_request, issue} ->
        PullRequests.open_state?(issue.state) and authored?(pull_request, viewer_login)
      end)
      |> attach_dispatchability(settings, viewer_login, request_fun, [])
    end
  end

  defp fetch_issues_by_ids(issue_ids, tracker_settings, request_fun) do
    ids = Enum.uniq(issue_ids)

    case ids do
      [] ->
        {:ok, []}

      ids ->
        with {:ok, pull_request_numbers} <- PullRequests.parse_pull_request_numbers(ids),
             {:ok, settings} <- Client.resolve_settings(tracker_settings),
             {:ok, viewer_login} <- PullRequests.fetch_viewer_login(settings, request_fun) do
          fetch_pull_request_ids(pull_request_numbers, settings, viewer_login, request_fun, [])
        end
    end
  end

  # A per-pull-request read failure here would fail the whole candidate poll
  # and starve every other pull request until the broken one changes, so the
  # poll drops just that pull request and reports it. The id-based fetch keeps
  # propagating errors: its callers read omission from a success as "no longer
  # exists", so a partial success there would be wrong.
  defp attach_dispatchability([], _settings, _viewer_login, _request_fun, acc) do
    {:ok, Enum.reverse(acc)}
  end

  defp attach_dispatchability(
         [{pull_request, issue} | rest],
         settings,
         viewer_login,
         request_fun,
         acc
       ) do
    case maybe_mark_dispatchable(issue, pull_request, settings, viewer_login, request_fun) do
      {:ok, issue} ->
        attach_dispatchability(rest, settings, viewer_login, request_fun, [issue | acc])

      {:error, reason} ->
        Logger.warning("Dropping pull request from candidate poll; dispatch check failed identifier=#{issue.identifier} reason=#{inspect(reason)}")

        attach_dispatchability(rest, settings, viewer_login, request_fun, acc)
    end
  end

  defp fetch_pull_request_ids([], _settings, _viewer_login, _request_fun, acc) do
    {:ok, Enum.reverse(acc)}
  end

  defp fetch_pull_request_ids(
         [pull_request_number | rest],
         settings,
         viewer_login,
         request_fun,
         acc
       ) do
    case PullRequests.fetch_pull_request(pull_request_number, settings, request_fun) do
      {:ok, :not_found} ->
        fetch_pull_request_ids(rest, settings, viewer_login, request_fun, acc)

      {:ok, pull_request} ->
        continue_pull_request_id_fetch(
          pull_request,
          rest,
          settings,
          viewer_login,
          request_fun,
          acc
        )

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp continue_pull_request_id_fetch(
         pull_request,
         rest,
         settings,
         viewer_login,
         request_fun,
         acc
       ) do
    case PullRequests.normalize_pull_request(pull_request, settings.repo) do
      %Issue{} = issue ->
        with {:ok, issue} <-
               maybe_mark_dispatchable(
                 issue,
                 pull_request,
                 settings,
                 viewer_login,
                 request_fun
               ) do
          fetch_pull_request_ids(rest, settings, viewer_login, request_fun, [issue | acc])
        end

      nil ->
        {:error, :github_unknown_payload}
    end
  end

  defp maybe_mark_dispatchable(issue, pull_request, settings, viewer_login, request_fun) do
    if dispatch_candidate?(issue, pull_request, viewer_login) do
      mark_dispatchable(issue, pull_request, settings, viewer_login, request_fun)
    else
      {:ok, issue}
    end
  end

  defp mark_dispatchable(issue, pull_request, settings, viewer_login, request_fun) do
    with {:ok, head_sha} <- PullRequests.head_sha(pull_request),
         {:ok, check_runs} <- PullRequests.fetch_check_runs(head_sha, settings, request_fun) do
      if Enum.all?(check_runs, &completed_check_run?/1) do
        mark_dispatchable_from_feedback(
          issue,
          pull_request,
          head_sha,
          check_runs,
          settings,
          viewer_login,
          request_fun
        )
      else
        {:ok, issue}
      end
    end
  end

  defp mark_dispatchable_from_feedback(
         issue,
         pull_request,
         head_sha,
         check_runs,
         settings,
         viewer_login,
         request_fun
       ) do
    with {:ok, failing_check_completions} <- failing_check_run_completions(check_runs),
         {:ok, feedback} <- fetch_feedback(pull_request["number"], settings, request_fun) do
      latest_viewer_activity = latest_viewer_activity(feedback, viewer_login)

      reasons =
        [
          counted_reason(
            "unresolved_threads",
            count_unresolved_threads_awaiting_viewer(feedback.threads, viewer_login)
          ),
          counted_reason(
            "failing_checks",
            count_unanswered_failing_checks(failing_check_completions, latest_viewer_activity)
          ),
          flagged_reason(
            "changes_requested",
            unanswered_changes_requested?(feedback.reviews, head_sha, viewer_login, latest_viewer_activity)
          ),
          flagged_reason(
            "review_rerequest_pending",
            awaiting_review_rerequest?(feedback.reviews, feedback.review_requests, head_sha, viewer_login)
          )
        ]
        |> Enum.reject(&is_nil/1)

      issue = %{issue | dispatchable: reasons != [], dispatch_reasons: reasons}

      {:ok, mark_converged(issue, reasons, feedback, failing_check_completions, head_sha)}
    end
  end

  # The dispatch reason codes are the notification contract: a bare code, or a
  # code with the count that produced it.
  defp counted_reason(_code, 0), do: nil
  defp counted_reason(code, count), do: "#{code}:#{count}"

  defp flagged_reason(code, true), do: code
  defp flagged_reason(_code, false), do: nil

  # Convergence is the state where only a human merge is left, so it is recorded
  # against the head it was observed on: a push invalidates it.
  defp mark_converged(issue, reasons, feedback, failing_check_completions, head_sha) do
    converged? =
      reasons == [] and failing_check_completions == [] and
        not Enum.any?(feedback.threads, &(not &1.resolved)) and
        Enum.any?(feedback.reviews, &approval_of_head?(&1, head_sha))

    if converged? do
      %{issue | native_ref: Map.merge(issue.native_ref || %{}, %{"converged" => true, "head_sha" => head_sha})}
    else
      issue
    end
  end

  # A bot approval is a policy check, not the human sign-off a merge waits for.
  defp approval_of_head?(review, head_sha) do
    review.state == "APPROVED" and not review.bot and not is_nil(review.author) and
      review_targets_head?(review, head_sha)
  end

  defp dispatch_candidate?(issue, pull_request, viewer_login) do
    PullRequests.open_state?(issue.state) and authored?(pull_request, viewer_login)
  end

  defp authored?(%{"user" => %{"login" => login}}, viewer_login) do
    PullRequests.login_matches?(login, viewer_login)
  end

  defp authored?(_pull_request, _viewer_login), do: false

  defp completed_check_run?(%{"status" => status}) when is_binary(status) do
    PullRequests.normalize_state(status) == "completed"
  end

  defp completed_check_run?(_check_run), do: false

  defp failing_check_run_completions(check_runs) do
    check_runs
    |> Enum.reject(&passing_check_run?/1)
    |> Enum.reduce_while({:ok, []}, fn check_run, {:ok, acc} ->
      case PullRequests.parse_datetime(check_run["completed_at"]) do
        {:ok, completed_at} -> {:cont, {:ok, [completed_at | acc]}}
        :error -> {:halt, {:error, :github_unknown_payload}}
      end
    end)
  end

  defp passing_check_run?(%{"conclusion" => conclusion}) when is_binary(conclusion) do
    PullRequests.normalize_state(conclusion) in @passing_check_run_conclusions
  end

  defp passing_check_run?(_check_run), do: false

  defp count_unresolved_threads_awaiting_viewer(threads, viewer_login) do
    Enum.count(threads, fn thread ->
      not thread.resolved and
        not PullRequests.login_matches?(thread.last_comment_author, viewer_login)
    end)
  end

  defp count_unanswered_failing_checks(failing_check_completions, latest_viewer_activity) do
    Enum.count(failing_check_completions, fn completed_at ->
      not activity_after?(latest_viewer_activity, completed_at)
    end)
  end

  defp unanswered_changes_requested?(reviews, head_sha, viewer_login, latest_viewer_activity) do
    Enum.any?(reviews, fn review ->
      review.state == "CHANGES_REQUESTED" and
        review.inline_comment_count == 0 and
        not PullRequests.login_matches?(review.author, viewer_login) and
        review_targets_head?(review, head_sha) and
        not activity_after?(latest_viewer_activity, review.submitted_at)
    end)
  end

  defp awaiting_review_rerequest?(reviews, review_requests, head_sha, viewer_login) do
    reviews
    |> Enum.reject(fn review ->
      review.bot or is_nil(review.author) or
        PullRequests.login_matches?(review.author, viewer_login)
    end)
    |> Enum.group_by(& &1.author)
    |> Enum.any?(fn {author, author_reviews} ->
      latest = Enum.max_by(author_reviews, & &1.submitted_at, DateTime)

      not review_targets_head?(latest, head_sha) and
        not Enum.any?(review_requests, &PullRequests.login_matches?(&1, author))
    end)
  end

  # commit이 없는 리뷰는 head 변경 여부를 관측할 수 없으므로 소거하지 않는다.
  defp review_targets_head?(%{commit_oid: nil}, _head_sha), do: true
  defp review_targets_head?(%{commit_oid: commit_oid}, head_sha), do: commit_oid == head_sha

  defp latest_viewer_activity(feedback, viewer_login) do
    comment_times =
      for comment <- feedback.comments,
          PullRequests.login_matches?(comment.author, viewer_login),
          do: comment.created_at

    review_times =
      for review <- feedback.reviews,
          PullRequests.login_matches?(review.author, viewer_login),
          do: review.submitted_at

    case comment_times ++ review_times do
      [] -> nil
      times -> Enum.max(times, DateTime)
    end
  end

  defp activity_after?(nil, _reference_at), do: false

  defp activity_after?(latest_viewer_activity, reference_at) do
    DateTime.compare(latest_viewer_activity, reference_at) == :gt
  end

  # The four connections share one $cursor variable, which is only safe while
  # it is null: the first request fetches every first page in a single query,
  # and just the connections with more pages continue with per-field queries.
  # Most pull requests fit in one page, so polling costs one request per pull
  # request instead of four.
  defp fetch_feedback(pull_request_number, settings, request_fun) do
    variables = feedback_variables(pull_request_number, settings)

    with {:ok, pull_request} <-
           graphql_pull_request(
             Map.keys(@feedback_fields),
             Map.put(variables, "cursor", nil),
             settings,
             request_fun
           ),
         {:ok, threads} <-
           finish_connection("reviewThreads", &decode_thread/1, pull_request, variables, settings, request_fun),
         {:ok, reviews} <-
           finish_connection("reviews", &decode_review/1, pull_request, variables, settings, request_fun),
         {:ok, comments} <-
           finish_connection("comments", &decode_issue_comment/1, pull_request, variables, settings, request_fun),
         {:ok, review_requests} <-
           finish_connection(
             "reviewRequests",
             &decode_review_request/1,
             pull_request,
             variables,
             settings,
             request_fun
           ) do
      {:ok,
       %{
         threads: threads,
         reviews: reviews,
         comments: comments,
         review_requests: review_requests
       }}
    end
  end

  defp finish_connection(field, decoder, pull_request, variables, settings, request_fun) do
    case decode_connection(pull_request[field], decoder) do
      {:ok, items, nil} ->
        {:ok, items}

      {:ok, items, next_cursor} ->
        fetch_connection_pages(field, decoder, variables, next_cursor, settings, request_fun, [items])

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp feedback_variables(pull_request_number, settings) do
    [owner, name] = String.split(settings.repo, "/", parts: 2)
    %{"owner" => owner, "name" => name, "number" => pull_request_number}
  end

  defp fetch_connection_pages(field, decoder, variables, cursor, settings, request_fun, acc) do
    with {:ok, pull_request} <-
           graphql_pull_request([field], Map.put(variables, "cursor", cursor), settings, request_fun),
         {:ok, items, next_cursor} <- decode_connection(pull_request[field], decoder) do
      updated_acc = [items | acc]

      case next_cursor do
        nil ->
          {:ok, updated_acc |> Enum.reverse() |> List.flatten()}

        next_cursor ->
          fetch_connection_pages(
            field,
            decoder,
            variables,
            next_cursor,
            settings,
            request_fun,
            updated_acc
          )
      end
    end
  end

  defp graphql_pull_request(fields, variables, settings, request_fun) when is_list(fields) do
    body = %{"query" => feedback_query(fields), "variables" => variables}

    case Client.post("/graphql", body, settings, request_options(request_fun)) do
      {:ok, %{"errors" => errors}} when is_list(errors) and errors != [] ->
        Logger.error("GitHub GraphQL request failed errors=#{inspect(errors)}")
        {:error, :github_unknown_payload}

      {:ok, %{"data" => %{"repository" => %{"pullRequest" => %{} = pull_request}}}} ->
        {:ok, pull_request}

      {:ok, _payload} ->
        {:error, :github_unknown_payload}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp feedback_query(fields) when is_list(fields) do
    """
    query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          #{Enum.map_join(fields, "\n", &Map.fetch!(@feedback_fields, &1))}
        }
      }
    }
    """
  end

  defp decode_connection(
         %{
           "pageInfo" => %{"hasNextPage" => has_next_page, "endCursor" => end_cursor},
           "nodes" => nodes
         },
         decoder
       )
       when is_boolean(has_next_page) and is_list(nodes) do
    nodes
    |> Enum.reduce_while({:ok, []}, fn node, {:ok, acc} ->
      case decoder.(node) do
        {:ok, items} -> {:cont, {:ok, Enum.reverse(items) ++ acc}}
        :error -> {:halt, :error}
      end
    end)
    |> continue_decode_connection(has_next_page, end_cursor)
  end

  defp decode_connection(_connection, _decoder), do: {:error, :github_unknown_payload}

  defp continue_decode_connection({:ok, items}, false, _end_cursor) do
    {:ok, Enum.reverse(items), nil}
  end

  defp continue_decode_connection({:ok, items}, true, end_cursor) when is_binary(end_cursor) do
    {:ok, Enum.reverse(items), end_cursor}
  end

  defp continue_decode_connection(_result, _has_next_page, _end_cursor) do
    {:error, :github_unknown_payload}
  end

  defp decode_thread(%{"isResolved" => resolved, "comments" => %{"nodes" => [comment]}})
       when is_boolean(resolved) do
    with {:ok, author} <- decode_author(comment) do
      {:ok, [%{resolved: resolved, last_comment_author: author}]}
    end
  end

  defp decode_thread(_node), do: :error

  defp decode_review(%{"state" => state} = node) when is_binary(state) do
    if PullRequests.normalize_state(state) == "pending" do
      {:ok, []}
    else
      decode_submitted_review(node, state)
    end
  end

  defp decode_review(_node), do: :error

  defp decode_submitted_review(node, state) do
    with {:ok, author} <- decode_author(node),
         {:ok, submitted_at} <- PullRequests.parse_datetime(node["submittedAt"]),
         {:ok, commit_oid} <- decode_commit_oid(node),
         {:ok, inline_comment_count} <- decode_inline_comment_count(node) do
      {:ok,
       [
         %{
           state: state |> String.trim() |> String.upcase(),
           author: author,
           bot: bot_author?(node),
           submitted_at: submitted_at,
           commit_oid: commit_oid,
           inline_comment_count: inline_comment_count
         }
       ]}
    else
      _malformed -> :error
    end
  end

  defp decode_issue_comment(node) do
    with {:ok, author} <- decode_author(node),
         {:ok, created_at} <- PullRequests.parse_datetime(node["createdAt"]) do
      {:ok, [%{author: author, created_at: created_at}]}
    else
      _malformed -> :error
    end
  end

  defp decode_review_request(%{
         "requestedReviewer" => %{"__typename" => "User", "login" => login}
       })
       when is_binary(login) do
    {:ok, [login]}
  end

  # 팀, 봇, mannequin 리뷰어는 개인 리뷰 요청이 아니므로 버린다.
  defp decode_review_request(%{"requestedReviewer" => _reviewer}), do: {:ok, []}
  defp decode_review_request(_node), do: :error

  defp bot_author?(%{"author" => %{"__typename" => "Bot"}}), do: true
  defp bot_author?(_node), do: false

  defp decode_author(%{"author" => %{"login" => login}}) when is_binary(login), do: {:ok, login}
  defp decode_author(%{"author" => nil}), do: {:ok, nil}
  defp decode_author(_node), do: :error

  defp decode_commit_oid(%{"commit" => nil}), do: {:ok, nil}
  defp decode_commit_oid(%{"commit" => %{"oid" => oid}}) when is_binary(oid), do: {:ok, oid}
  defp decode_commit_oid(_node), do: :error

  defp decode_inline_comment_count(%{"comments" => %{"totalCount" => count}})
       when is_integer(count) and count >= 0 do
    {:ok, count}
  end

  defp decode_inline_comment_count(_node), do: :error

  defp request_options(nil), do: []
  defp request_options(request_fun), do: [request_fun: request_fun]
end

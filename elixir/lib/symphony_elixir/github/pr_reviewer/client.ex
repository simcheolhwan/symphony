defmodule SymphonyElixir.GitHub.PrReviewer.Client do
  @moduledoc """
  GitHub REST client for pull requests directly awaiting review from the authenticated user.
  """

  require Logger

  alias SymphonyElixir.Config
  alias SymphonyElixir.GitHub.Client
  alias SymphonyElixir.GitHub.PullRequests
  alias SymphonyElixir.Tracker.Issue

  @open_state "open"
  @passing_check_run_conclusions ["neutral", "skipped", "success"]

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
      fetch_open_requested_issues(tracker_settings, request_fun)
    else
      {:ok, []}
    end
  end

  defp fetch_open_requested_issues(tracker_settings, request_fun) do
    with {:ok, settings} <- Client.resolve_settings(tracker_settings),
         {:ok, viewer_login} <- PullRequests.fetch_viewer_login(settings, request_fun),
         {:ok, payload} <- PullRequests.fetch_open_pull_requests(settings, request_fun) do
      payload
      |> PullRequests.normalize_pull_requests(settings.repo)
      |> Enum.filter(fn {pull_request, issue} ->
        PullRequests.open_state?(issue.state) and directly_requested?(pull_request, viewer_login)
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
      with {:ok, head_sha} <- PullRequests.head_sha(pull_request),
           {:ok, latest_request_at} <-
             fetch_latest_direct_review_request(
               issue.id,
               settings,
               viewer_login,
               request_fun
             ),
           {:ok, reviewed_after_request?} <-
             reviewed_after_request?(
               issue.id,
               latest_request_at,
               settings,
               viewer_login,
               request_fun
             ) do
        mark_dispatchable_from_review_state(
          issue,
          reviewed_after_request?,
          head_sha,
          settings,
          request_fun
        )
      end
    else
      {:ok, issue}
    end
  end

  defp mark_dispatchable_from_review_state(
         issue,
         true,
         _head_sha,
         _settings,
         _request_fun
       ) do
    {:ok, issue}
  end

  defp mark_dispatchable_from_review_state(
         issue,
         false,
         head_sha,
         settings,
         request_fun
       ) do
    with {:ok, check_runs} <- PullRequests.fetch_check_runs(head_sha, settings, request_fun) do
      {:ok, %{issue | dispatchable: Enum.all?(check_runs, &passing_check_run?/1)}}
    end
  end

  defp dispatch_candidate?(issue, pull_request, viewer_login) do
    PullRequests.open_state?(issue.state) and
      pull_request["draft"] == false and
      directly_requested?(pull_request, viewer_login)
  end

  defp fetch_latest_direct_review_request(
         pull_request_id,
         settings,
         viewer_login,
         request_fun
       ) do
    path = "#{Client.repository_path(settings.repo)}/issues/#{pull_request_id}/timeline"
    fetch_timeline_pages(path, settings, viewer_login, request_fun, 1, nil)
  end

  defp fetch_timeline_pages(path, settings, viewer_login, request_fun, page, latest_request_at) do
    params = %{"per_page" => PullRequests.page_size(), "page" => page}

    case PullRequests.read(path, params, settings, request_fun) do
      {:ok, events} when is_list(events) ->
        with {:ok, latest_request_at} <-
               update_latest_direct_review_request(events, viewer_login, latest_request_at) do
          continue_timeline_pages(
            events,
            path,
            settings,
            viewer_login,
            request_fun,
            page,
            latest_request_at
          )
        end

      {:ok, _payload} ->
        {:error, :github_unknown_payload}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp continue_timeline_pages(
         events,
         path,
         settings,
         viewer_login,
         request_fun,
         page,
         latest_request_at
       ) do
    if length(events) < PullRequests.page_size() do
      case latest_request_at do
        %DateTime{} -> {:ok, latest_request_at}
        nil -> {:error, :github_unknown_payload}
      end
    else
      fetch_timeline_pages(
        path,
        settings,
        viewer_login,
        request_fun,
        page + 1,
        latest_request_at
      )
    end
  end

  defp update_latest_direct_review_request(events, viewer_login, latest_request_at) do
    Enum.reduce_while(events, {:ok, latest_request_at}, fn event, {:ok, latest} ->
      case direct_review_request_time(event, viewer_login) do
        {:ok, requested_at} -> {:cont, {:ok, later_datetime(latest, requested_at)}}
        :not_direct -> {:cont, {:ok, latest}}
        :error -> {:halt, {:error, :github_unknown_payload}}
      end
    end)
  end

  defp direct_review_request_time(event, viewer_login) do
    if direct_review_request_event?(event, viewer_login) do
      PullRequests.parse_datetime(event["created_at"])
    else
      :not_direct
    end
  end

  defp direct_review_request_event?(
         %{"event" => "review_requested", "requested_reviewer" => %{"login" => login}},
         viewer_login
       ) do
    PullRequests.login_matches?(login, viewer_login)
  end

  defp direct_review_request_event?(_event, _viewer_login), do: false

  defp later_datetime(nil, right), do: right

  defp later_datetime(left, right) do
    case DateTime.compare(left, right) do
      :lt -> right
      _not_earlier -> left
    end
  end

  defp reviewed_after_request?(
         pull_request_id,
         latest_request_at,
         settings,
         viewer_login,
         request_fun
       ) do
    path = "#{PullRequests.repository_pull_path(settings, pull_request_id)}/reviews"

    fetch_review_pages(
      path,
      latest_request_at,
      settings,
      viewer_login,
      request_fun,
      1
    )
  end

  defp fetch_review_pages(
         path,
         latest_request_at,
         settings,
         viewer_login,
         request_fun,
         page
       ) do
    params = %{"per_page" => PullRequests.page_size(), "page" => page}

    case PullRequests.read(path, params, settings, request_fun) do
      {:ok, reviews} when is_list(reviews) ->
        with {:ok, reviewed_after_request?} <-
               review_page_has_newer_submission?(reviews, viewer_login, latest_request_at) do
          continue_review_pages(
            reviews,
            reviewed_after_request?,
            path,
            latest_request_at,
            settings,
            viewer_login,
            request_fun,
            page
          )
        end

      {:ok, _payload} ->
        {:error, :github_unknown_payload}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp continue_review_pages(
         _reviews,
         true,
         _path,
         _latest_request_at,
         _settings,
         _viewer_login,
         _request_fun,
         _page
       ) do
    {:ok, true}
  end

  defp continue_review_pages(
         reviews,
         false,
         path,
         latest_request_at,
         settings,
         viewer_login,
         request_fun,
         page
       ) do
    if length(reviews) < PullRequests.page_size() do
      {:ok, false}
    else
      fetch_review_pages(
        path,
        latest_request_at,
        settings,
        viewer_login,
        request_fun,
        page + 1
      )
    end
  end

  defp review_page_has_newer_submission?(reviews, viewer_login, latest_request_at) do
    Enum.reduce_while(reviews, {:ok, false}, fn review, {:ok, false} ->
      case review_submitted_after?(review, viewer_login, latest_request_at) do
        {:ok, true} -> {:halt, {:ok, true}}
        {:ok, false} -> {:cont, {:ok, false}}
        :error -> {:halt, {:error, :github_unknown_payload}}
      end
    end)
  end

  defp review_submitted_after?(%{"user" => %{"login" => login}} = review, viewer_login, requested_at)
       when is_binary(login) do
    if PullRequests.login_matches?(login, viewer_login) do
      compare_review_submission(Map.get(review, "submitted_at"), requested_at)
    else
      {:ok, false}
    end
  end

  defp review_submitted_after?(_review, _viewer_login, _requested_at), do: {:ok, false}

  defp compare_review_submission(nil, _latest_request_at), do: {:ok, false}

  defp compare_review_submission(submitted_at, latest_request_at) do
    case PullRequests.parse_datetime(submitted_at) do
      {:ok, submitted_at} ->
        {:ok, DateTime.compare(submitted_at, latest_request_at) == :gt}

      :error ->
        :error
    end
  end

  defp passing_check_run?(%{"status" => status, "conclusion" => conclusion})
       when is_binary(status) and is_binary(conclusion) do
    PullRequests.normalize_state(status) == "completed" and
      PullRequests.normalize_state(conclusion) in @passing_check_run_conclusions
  end

  defp passing_check_run?(_check_run), do: false

  defp directly_requested?(%{"requested_reviewers" => reviewers}, viewer_login)
       when is_list(reviewers) do
    Enum.any?(reviewers, fn
      %{"login" => login} -> PullRequests.login_matches?(login, viewer_login)
      _reviewer -> false
    end)
  end

  defp directly_requested?(_pull_request, _viewer_login), do: false
end

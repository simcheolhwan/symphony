defmodule SymphonyElixir.GitHub.PullRequests do
  @moduledoc """
  Shared GitHub REST read primitives for pull-request-scoped tracker clients.

  Owns the mechanical reads (open pull request paging, single pull request
  lookup, Check Runs paging, viewer identity) and pull request normalization.
  Dispatchability policy stays in each tracker client.
  """

  require Logger

  alias SymphonyElixir.GitHub.Client
  alias SymphonyElixir.Tracker.Issue

  @open_state "open"
  @page_size 100

  @spec page_size() :: pos_integer()
  def page_size, do: @page_size

  @spec fetch_viewer_login(map(), function() | nil) :: {:ok, String.t()} | {:error, term()}
  def fetch_viewer_login(settings, request_fun) do
    case read("/user", %{}, settings, request_fun) do
      {:ok, %{"login" => login}} when is_binary(login) ->
        case String.trim(login) do
          "" -> {:error, :github_unknown_payload}
          normalized -> {:ok, normalized}
        end

      {:ok, _payload} ->
        {:error, :github_unknown_payload}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @spec fetch_open_pull_requests(map(), function() | nil) :: {:ok, [map()]} | {:error, term()}
  def fetch_open_pull_requests(settings, request_fun) do
    fetch_open_pull_request_pages(settings, request_fun, 1, [])
  end

  @spec fetch_pull_request(pos_integer(), map(), function() | nil) ::
          {:ok, map() | :not_found} | {:error, term()}
  def fetch_pull_request(pull_request_number, settings, request_fun) do
    path = repository_pull_path(settings, pull_request_number)

    case read(path, %{}, settings, request_fun, allow_not_found: true) do
      {:ok, :not_found} -> {:ok, :not_found}
      {:ok, %{} = pull_request} -> {:ok, pull_request}
      {:ok, _payload} -> {:error, :github_unknown_payload}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec fetch_check_runs(String.t(), map(), function() | nil) :: {:ok, [map()]} | {:error, term()}
  def fetch_check_runs(head_sha, settings, request_fun) do
    encoded_head_sha = URI.encode(head_sha, &URI.char_unreserved?/1)
    path = "#{Client.repository_path(settings.repo)}/commits/#{encoded_head_sha}/check-runs"
    fetch_check_run_pages(path, settings, request_fun, 1, [])
  end

  @spec normalize_pull_requests([map()], String.t()) :: [{map(), Issue.t()}]
  def normalize_pull_requests(payload, repo) do
    normalized =
      Enum.map(payload, fn pull_request ->
        {pull_request, normalize_pull_request(pull_request, repo)}
      end)

    malformed_count = Enum.count(normalized, fn {_pull_request, issue} -> is_nil(issue) end)

    if malformed_count > 0 do
      Logger.warning("Dropping malformed GitHub pull request records count=#{malformed_count}")
    end

    Enum.reject(normalized, fn {_pull_request, issue} -> is_nil(issue) end)
  end

  @spec normalize_pull_request(map(), String.t()) :: Issue.t() | nil
  def normalize_pull_request(pull_request, repo) do
    case Client.normalize_issue(pull_request, repo) do
      %Issue{} = issue ->
        %{
          issue
          | dispatchable: false,
            branch_name: head_ref(pull_request),
            native_ref: merge_pull_request_ref(issue.native_ref, pull_request)
        }

      nil ->
        nil
    end
  end

  @spec head_sha(map()) :: {:ok, String.t()} | {:error, term()}
  def head_sha(%{"head" => %{"sha" => head_sha}}) when is_binary(head_sha) do
    case String.trim(head_sha) do
      "" -> {:error, :github_unknown_payload}
      normalized -> {:ok, normalized}
    end
  end

  def head_sha(_pull_request), do: {:error, :github_unknown_payload}

  @spec parse_pull_request_numbers([term()]) :: {:ok, [pos_integer()]} | {:error, term()}
  def parse_pull_request_numbers(ids) do
    ids
    |> Enum.reduce_while({:ok, []}, fn id, {:ok, acc} ->
      case parse_pull_request_number(id) do
        {:ok, pull_request_number} -> {:cont, {:ok, [pull_request_number | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, pull_request_numbers} -> {:ok, Enum.reverse(pull_request_numbers)}
      {:error, reason} -> {:error, reason}
    end
  end

  @spec login_matches?(term(), term()) :: boolean()
  def login_matches?(left, right) when is_binary(left) and is_binary(right) do
    normalize_login(left) == normalize_login(right)
  end

  def login_matches?(_left, _right), do: false

  @spec normalize_state(term()) :: String.t()
  def normalize_state(value) when is_binary(value), do: value |> String.trim() |> String.downcase()
  def normalize_state(_value), do: ""

  @spec open_state?(term()) :: boolean()
  def open_state?(value), do: normalize_state(value) == @open_state

  @spec parse_datetime(term()) :: {:ok, DateTime.t()} | :error
  def parse_datetime(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, datetime, _offset} -> {:ok, datetime}
      _invalid -> :error
    end
  end

  def parse_datetime(_value), do: :error

  @spec read(String.t(), map(), map(), function() | nil, keyword()) ::
          {:ok, term()} | {:error, term()}
  def read(path, params, settings, request_fun, opts \\ []) do
    Client.read(path, params, settings, request_options(request_fun, opts))
  end

  @spec repository_pulls_path(map()) :: String.t()
  def repository_pulls_path(settings), do: "#{Client.repository_path(settings.repo)}/pulls"

  @spec repository_pull_path(map(), pos_integer()) :: String.t()
  def repository_pull_path(settings, pull_request_number) do
    "#{repository_pulls_path(settings)}/#{pull_request_number}"
  end

  defp fetch_open_pull_request_pages(settings, request_fun, page, acc) do
    params = %{
      "state" => @open_state,
      "per_page" => @page_size,
      "page" => page,
      "sort" => "created",
      "direction" => "asc"
    }

    with {:ok, payload} <- read(repository_pulls_path(settings), params, settings, request_fun),
         true <- is_list(payload) or {:error, :github_unknown_payload} do
      updated_acc = [payload | acc]

      if length(payload) < @page_size do
        {:ok, updated_acc |> Enum.reverse() |> List.flatten()}
      else
        fetch_open_pull_request_pages(settings, request_fun, page + 1, updated_acc)
      end
    end
  end

  defp fetch_check_run_pages(path, settings, request_fun, page, acc) do
    params = %{"filter" => "latest", "per_page" => @page_size, "page" => page}

    case read(path, params, settings, request_fun) do
      {:ok, %{"check_runs" => check_runs}} when is_list(check_runs) ->
        updated_acc = [check_runs | acc]

        if length(check_runs) < @page_size do
          {:ok, updated_acc |> Enum.reverse() |> List.flatten()}
        else
          fetch_check_run_pages(path, settings, request_fun, page + 1, updated_acc)
        end

      {:ok, _payload} ->
        {:error, :github_unknown_payload}

      {:error, reason} ->
        {:error, reason}
    end
  end

  # Merge state, author, and head are already in the pull request payload, and
  # callers that classify a closed pull request or address its author would
  # otherwise have to read it again.
  defp merge_pull_request_ref(native_ref, pull_request) do
    %{
      "merged" => merged_flag(pull_request),
      "author" => author_login(pull_request),
      "head_sha" => head_sha_value(pull_request)
    }
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
    |> case do
      empty when map_size(empty) == 0 -> native_ref
      extra -> Map.merge(native_ref || %{}, extra)
    end
  end

  defp merged_flag(%{"merged" => merged}) when is_boolean(merged), do: merged
  defp merged_flag(_pull_request), do: nil

  defp author_login(%{"user" => %{"login" => login}}) when is_binary(login) do
    case String.trim(login) do
      "" -> nil
      normalized -> normalized
    end
  end

  defp author_login(_pull_request), do: nil

  defp head_sha_value(pull_request) do
    case head_sha(pull_request) do
      {:ok, sha} -> sha
      {:error, _reason} -> nil
    end
  end

  defp head_ref(%{"head" => %{"ref" => ref}}) when is_binary(ref) do
    case String.trim(ref) do
      "" -> nil
      normalized -> normalized
    end
  end

  defp head_ref(_pull_request), do: nil

  defp parse_pull_request_number(value) when is_binary(value) do
    case Integer.parse(value) do
      {number, ""} when number > 0 -> {:ok, number}
      _invalid -> {:error, :invalid_github_issue_id}
    end
  end

  defp parse_pull_request_number(_value), do: {:error, :invalid_github_issue_id}

  defp request_options(nil, opts), do: opts
  defp request_options(request_fun, opts), do: Keyword.put(opts, :request_fun, request_fun)

  defp normalize_login(value), do: value |> String.trim() |> String.downcase()
end

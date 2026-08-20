defmodule SymphonyElixir.Tracker do
  @moduledoc """
  Adapter boundary for issue tracker reads and provider-native agent tools.

  The orchestrator only depends on the read callbacks. Agent-side mutations stay
  behind optional provider-native tools so tracker-specific capabilities do not
  leak into scheduler policy.
  """

  alias SymphonyElixir.Config
  alias SymphonyElixir.Tracker.Issue

  @adapters %{
    "asana" => SymphonyElixir.Asana.Adapter,
    "github" => SymphonyElixir.GitHub.Adapter,
    "github_pr_author" => SymphonyElixir.GitHub.PrAuthor.Adapter,
    "github_pr_reviewer" => SymphonyElixir.GitHub.PrReviewer.Adapter,
    "gitlab" => SymphonyElixir.GitLab.Adapter,
    "jira" => SymphonyElixir.Jira.Adapter,
    "linear" => SymphonyElixir.Linear.Adapter,
    "memory" => SymphonyElixir.Tracker.Memory
  }

  @callback fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  @callback fetch_issues_by_ids([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  @callback fetch_issues_by_identifiers([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  @callback identifier_candidate?(String.t()) :: boolean()
  @callback agent_tool_specs() :: [map()]
  @callback execute_agent_tool(String.t(), term(), keyword()) :: map()
  @callback secret_environment_names(map()) :: [String.t()]
  @callback validate_config(map()) :: :ok | {:error, term()}
  @callback preflight(map()) :: :ok | {:error, term()}

  @optional_callbacks agent_tool_specs: 0,
                      execute_agent_tool: 3,
                      validate_config: 1,
                      preflight: 1

  @spec fetch_issues_by_states([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_states(states) do
    adapter().fetch_issues_by_states(states)
  end

  @spec fetch_issues_by_ids([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_ids(issue_ids) do
    adapter().fetch_issues_by_ids(issue_ids)
  end

  @doc """
  Fetches issues by their human-readable identifiers (e.g. `EXP-1157`, `GH-123`).

  A successful result contains only issues the tracker knows; identifiers absent
  from the result are authoritatively missing. Adapters that cannot guarantee
  that semantics must return `{:error, reason}` instead of a partial success.
  """
  @spec fetch_issues_by_identifiers([String.t()]) :: {:ok, [Issue.t()]} | {:error, term()}
  def fetch_issues_by_identifiers(identifiers) do
    adapter().fetch_issues_by_identifiers(identifiers)
  end

  @doc """
  Tells whether a string is shaped like one of this tracker's identifiers.

  `fetch_issues_by_identifiers/1` silently skips other strings, so callers use
  this to distinguish "queried and authoritatively missing" from "never
  queried".
  """
  @spec identifier_candidate?(String.t()) :: boolean()
  def identifier_candidate?(identifier) do
    adapter().identifier_candidate?(identifier)
  end

  @doc """
  Maps identifiers to numeric tracker ids by stripping a fixed prefix (e.g. `GH-`).

  Identifiers without the prefix or without a purely numeric remainder are
  dropped so they can never poison an id fetch; callers treat them as unknown
  and leave any associated state untouched.
  """
  @spec strip_identifier_prefix([String.t()], String.t()) :: [String.t()]
  def strip_identifier_prefix(identifiers, prefix)
      when is_list(identifiers) and is_binary(prefix) do
    Enum.flat_map(identifiers, fn identifier ->
      stripped = String.replace_prefix(identifier, prefix, "")

      if stripped != identifier and Regex.match?(~r/^[0-9]+$/, stripped) do
        [stripped]
      else
        []
      end
    end)
  end

  @doc """
  Tells whether an identifier survives `strip_identifier_prefix/2` for a prefix.
  """
  @spec prefix_identifier?(String.t(), String.t()) :: boolean()
  def prefix_identifier?(identifier, prefix) when is_binary(identifier) and is_binary(prefix) do
    strip_identifier_prefix([identifier], prefix) != []
  end

  @doc """
  Captures the selected adapter and effective tracker settings for one
  app-server session so tool advertisement and execution cannot drift across a
  workflow reload.
  """
  @spec bind_agent_tools() :: map()
  def bind_agent_tools do
    tracker_settings = Config.settings!().tracker
    adapter = adapter_for_settings!(tracker_settings)

    %{
      adapter: adapter,
      tracker_settings: tracker_settings,
      tool_specs: adapter_agent_tool_specs(adapter),
      secret_environment_names: adapter_secret_environment_names(adapter, tracker_settings)
    }
  end

  @spec execute_bound_agent_tool(map(), String.t(), term(), keyword()) :: map()
  def execute_bound_agent_tool(
        %{adapter: adapter, tracker_settings: tracker_settings},
        tool,
        arguments,
        opts \\ []
      ) do
    execute_agent_tool_with_adapter(
      adapter,
      tool,
      arguments,
      Keyword.put(opts, :tracker_settings, tracker_settings)
    )
  end

  @spec validate_config(map()) :: :ok | {:error, term()}
  def validate_config(%{kind: kind} = tracker_settings) do
    with {:ok, adapter} <- adapter_for_kind(kind) do
      if Code.ensure_loaded?(adapter) and function_exported?(adapter, :validate_config, 1) do
        adapter.validate_config(tracker_settings)
      else
        :ok
      end
    end
  end

  @spec preflight(map()) :: :ok | {:error, term()}
  def preflight(%{kind: kind} = tracker_settings) do
    with {:ok, adapter} <- adapter_for_kind(kind) do
      if Code.ensure_loaded?(adapter) and function_exported?(adapter, :preflight, 1) do
        adapter.preflight(tracker_settings)
      else
        :ok
      end
    end
  end

  @spec adapter() :: module()
  def adapter do
    Config.settings!().tracker
    |> adapter_for_settings!()
  end

  @spec adapter_for_kind(String.t()) :: {:ok, module()} | {:error, term()}
  def adapter_for_kind(kind) do
    case Map.fetch(@adapters, kind) do
      {:ok, adapter} -> {:ok, adapter}
      :error -> {:error, {:unsupported_tracker_kind, kind}}
    end
  end

  defp adapter_for_settings!(%{kind: kind}) do
    {:ok, adapter} = adapter_for_kind(kind)
    adapter
  end

  defp adapter_agent_tool_specs(adapter) do
    if Code.ensure_loaded?(adapter) and function_exported?(adapter, :agent_tool_specs, 0) do
      adapter.agent_tool_specs()
    else
      []
    end
  end

  defp execute_agent_tool_with_adapter(adapter, tool, arguments, opts) do
    if Code.ensure_loaded?(adapter) and function_exported?(adapter, :execute_agent_tool, 3) do
      adapter.execute_agent_tool(tool, arguments, opts)
    else
      unsupported_agent_tool_response(tool)
    end
  end

  defp adapter_secret_environment_names(adapter, tracker_settings) do
    adapter.secret_environment_names(tracker_settings)
  end

  defp unsupported_agent_tool_response(tool) do
    output =
      Jason.encode!(%{
        "error" => %{
          "message" => "Unsupported dynamic tool: #{inspect(tool)}.",
          "supportedTools" => []
        }
      })

    %{
      "success" => false,
      "output" => output,
      "contentItems" => [%{"type" => "inputText", "text" => output}]
    }
  end
end

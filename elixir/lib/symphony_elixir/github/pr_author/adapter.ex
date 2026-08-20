defmodule SymphonyElixir.GitHub.PrAuthor.Adapter do
  @moduledoc """
  GitHub PR Author tracker adapter for pull requests authored by the authenticated user.
  """

  @behaviour SymphonyElixir.Tracker

  alias SymphonyElixir.GitHub.Adapter, as: GitHubAdapter
  alias SymphonyElixir.GitHub.PrAuthor.Client

  @impl true
  def validate_config(tracker_settings), do: GitHubAdapter.validate_config(tracker_settings)

  @impl true
  def fetch_issues_by_states(states), do: client_module().fetch_issues_by_states(states)

  @impl true
  def preflight(tracker_settings), do: client_module().preflight(tracker_settings)

  @impl true
  def fetch_issues_by_ids(issue_ids), do: client_module().fetch_issues_by_ids(issue_ids)

  @impl true
  def fetch_issues_by_identifiers(identifiers) do
    identifiers
    |> SymphonyElixir.Tracker.strip_identifier_prefix("GH-")
    |> client_module().fetch_issues_by_ids()
  end

  @impl true
  def identifier_candidate?(identifier),
    do: SymphonyElixir.Tracker.prefix_identifier?(identifier, "GH-")

  @impl true
  def agent_tool_specs, do: GitHubAdapter.agent_tool_specs()

  @impl true
  def execute_agent_tool(tool, arguments, opts) do
    GitHubAdapter.execute_agent_tool(tool, arguments, opts)
  end

  @impl true
  def secret_environment_names(tracker_settings) do
    GitHubAdapter.secret_environment_names(tracker_settings)
  end

  defp client_module do
    Application.get_env(
      :symphony_elixir,
      :github_pr_author_client_module,
      Client
    )
  end
end

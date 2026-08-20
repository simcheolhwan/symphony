defmodule SymphonyElixir.Notifier do
  @moduledoc """
  Posts issue lifecycle events to the configured notification endpoint.

  Delivery is fire-and-forget: every event is sent from a short-lived unlinked
  task and failures are only logged, so a notification problem can never stall
  or crash the orchestrator. Notifications are disabled entirely when no
  endpoint is configured.

  Each event carries the tracker issue's immutable id, which is the only key
  that identifies the same work across retries, Codex sessions, and process
  restarts.
  """

  require Logger

  alias SymphonyElixir.Config
  alias SymphonyElixir.Tracker.Issue

  @request_timeout_ms 5_000

  @type event ::
          :started | :retried | :blocked | :killed | :completed | :finished | :settled | :mergeable

  @doc """
  Sends a lifecycle event that needs no explanation.
  """
  @spec notify(event(), Issue.t() | nil) :: :ok
  def notify(event, issue), do: notify(event, issue, nil)

  @doc """
  Sends a lifecycle event for `issue`, where `reason` explains why a retry,
  block, or kill happened.
  """
  @spec notify(event(), Issue.t() | nil, String.t() | nil) :: :ok
  def notify(event, issue, reason), do: notify(event, issue, reason, nil)

  @doc """
  Sends a lifecycle event that also carries `agent_message`, the agent's own
  account of the session it just ended.

  Callers reach this from orchestrator transitions that read the issue out of a
  running entry, so an event without a usable issue is dropped rather than
  raised: notification problems must never interrupt the transition itself.
  """
  @spec notify(event(), Issue.t() | nil, String.t() | nil, String.t() | nil) :: :ok
  def notify(event, issue, reason, agent_message) when is_atom(event) do
    notify_in_order([{event, issue, reason, agent_message}])
  end

  @doc """
  Sends several lifecycle events from one task so the receiver observes them in
  the given order.

  Each event otherwise posts from its own task, and two tasks racing to reach
  the endpoint arrive in either order. That is invisible for events separated by
  real time, but a transition that reports two things at once would shuffle the
  Slack thread it is read in.
  """
  @spec notify_in_order([{event(), Issue.t() | nil, String.t() | nil, String.t() | nil}]) :: :ok
  def notify_in_order(events) when is_list(events) do
    case {Config.notification_url(), Config.instance_name()} do
      {url, instance} when is_binary(url) and is_binary(instance) ->
        payloads =
          for {event, %Issue{} = issue, reason, agent_message} <- events,
              do: payload(instance, event, issue, reason, agent_message)

        Task.start(fn -> Enum.each(payloads, &post(url, &1)) end)
        :ok

      {url, _instance} when is_binary(url) ->
        # The receiver keys its Slack thread on the instance name and rejects a
        # payload without one, so sending would only produce a silent 400. Skip
        # loudly instead: the endpoint is configured, so a missing name is a
        # setup mistake worth surfacing on every event.
        for {event, %Issue{} = issue, _reason, _agent_message} <- events do
          Logger.warning("Notification skipped: SYMPHONY_INSTANCE_NAME is missing or invalid; event=#{event} issue_id=#{issue.id}")
        end

        :ok

      _ ->
        warn_invalid_endpoint(events)
        :ok
    end
  end

  # An endpoint that is configured but not in the exact form the receiver
  # boots with would otherwise disable notifications without a trace, so it is
  # skipped as loudly as a missing instance name.
  defp warn_invalid_endpoint(events) do
    case System.get_env("SYMPHONY_NOTIFY_URL") do
      value when is_binary(value) ->
        for {event, %Issue{} = issue, _reason, _agent_message} <- events do
          Logger.warning("Notification skipped: SYMPHONY_NOTIFY_URL must be http://127.0.0.1:<port>[/path] with an explicit port; event=#{event} issue_id=#{issue.id}")
        end

        :ok

      _ ->
        :ok
    end
  end

  defp payload(instance, event, %Issue{} = issue, reason, agent_message) do
    %{
      instance: instance,
      event: Atom.to_string(event),
      issue:
        %{
          id: issue.id,
          identifier: issue.identifier,
          url: issue.url,
          state: issue.state
        }
        |> put_optional(:title, issue.title)
        |> put_optional(:pr_author, pull_request_author(issue))
    }
    |> put_optional(:reason, reason)
    |> put_optional(:agent_message, agent_message)
    |> put_optional(:workflow, Config.workflow_label())
    |> put_optional(:target, Config.target_name())
    |> put_dispatch_reasons(issue.dispatch_reasons)
  end

  defp pull_request_author(%Issue{native_ref: %{"author" => author}}), do: author
  defp pull_request_author(%Issue{}), do: nil

  # The receiver reads an absent list as "no reasons", so an empty list carries
  # nothing and is left out.
  defp put_dispatch_reasons(payload, [_ | _] = reasons) do
    Map.put(payload, :dispatch_reasons, reasons)
  end

  defp put_dispatch_reasons(payload, _reasons), do: payload

  # The receiver validates `reason` and `title` as optional strings, which
  # rejects an explicit null, so an empty value is left out of the payload.
  defp put_optional(payload, key, value) when is_binary(value) do
    case String.trim(value) do
      "" -> payload
      trimmed -> Map.put(payload, key, trimmed)
    end
  end

  defp put_optional(payload, _key, _value), do: payload

  defp post(url, payload) do
    case Req.post(url,
           json: payload,
           retry: false,
           connect_options: [timeout: @request_timeout_ms],
           receive_timeout: @request_timeout_ms
         ) do
      {:ok, %{status: status}} when status in 200..299 ->
        :ok

      {:ok, %{status: status}} ->
        Logger.warning("Notification rejected: event=#{payload.event} issue_id=#{payload.issue.id} status=#{status}")

      {:error, reason} ->
        Logger.warning("Notification delivery failed: event=#{payload.event} issue_id=#{payload.issue.id} error=#{inspect(reason)}")
    end
  end
end

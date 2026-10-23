# Changelog

What changed in each version of this extension, newest first.

## 0.2.0

- One place for filters: **Only this pod**, **Only this container**, **Hide this pod**, an alarm's **Lines** and a click on a pattern now write their filter into the search box and tick it in the facets, instead of a chip of their own. Only this pod, Only this container and an alarm's Lines also narrow the top bar (Clusters, Namespaces, Resources) to that resource, and tick its cluster, namespace, workload and pod in the facets. Untick it or edit the box to change it.
- Histogram: a click on a bar shows the logs of its stretch of time (a drag still zooms across several). The tooltip sits above the bar it is about. A legend says what each colour is, and the bottom edge drags to make the chart taller or shorter.
- No **Previous run** button in the line details and in Alarms. Containers that crashed still have their run before the restart read, marked `prev`.
- Renamed to **Live Log Aggregation** (package `live-log-aggregation`), with a README section on what live means and how far back Kubernetes keeps logs.
- Over 6h and 24h, a workload or pod is read up to 30,000 lines per container, so a whole day usually shows. The histogram shades the stretch that was not read and says why, instead of looking empty.
- Live can read again every 10s, 30s, 1m or 5m: the caret on the play button picks it under **Logs capture resolution**, per tab. The footer and the tooltip say the interval in use.
- kubectl's own messages ("unable to retrieve container logs for …", for a run whose logs are gone) are no longer shown as log lines dated "unable": the container counts as unreadable instead.
- Shorter README with full-window screenshots and GIFs of the setup; banner redrawn to read on the marketplace card.
- Opening a resource or event in Lens shows a spinner while Lens loads the cluster, and says so when Lens does not open it (some clusters added by other extensions never answer).
- No "Logs Aggregator" item under each cluster in the navigator any more: open it from the command palette, or with **Aggregate logs** on a workload or pod.
- Resizable columns (drag the edge of a header; double click for the default), in the order Date, Cluster, Namespace, Pod, Content.
- Every cluster Lens can open is read, with the kubectl and access Lens keeps for it: no more matching clusters to kubectl contexts, or picking one when the names differ.
- A click on the histogram no longer zooms into one bar (and hid the logs); drag across it to zoom. When a zoom leaves nothing, the list offers to show the whole time range.
- Terminal colour codes are taken out of log lines.
- New layout: Cluster / Namespaces / Resources dropdowns, level buttons with their counts, a "Past 5 minutes" time picker and Live / Refresh in one top bar; a full-width search with **Aa** (match case) and **.\*** (regular expression); the histogram with time ticks; "N logs found · errors · warnings"; an Insights strip (the alarms, folded until opened); a table with Date (newest first, click to flip), Pod, Namespace and Content; a footer saying whether the list is live.
- Open in Lens from every log (its pod, workload, or the event behind it) and from every insight (Open <kind>, Event).
- Download as CSV, and an Options menu: patterns, every insight, facets (now hidden until asked for), copy the logs shown, Ask AI.
- Keys: `/` goes to the search, ↑ ↓ step through the logs, Esc closes the details.
- Log explorer in the style of Datadog: a volume histogram stacked by level (drag to zoom into a time range), a facet panel with counts (level, cluster, namespace, workload, pod, container and the fields of JSON and logfmt lines), and a detail panel for the line clicked, with its fields, pretty JSON and the lines around it in the same container.
- Patterns: the lines grouped by what they say, with count, share and trend; click one to see its lines.
- Structured lines show their message, and their level comes from their own `level` field; debug lines are recognised.
- Filters, facets, time window and view are kept per tab across restarts.
- The list renders only the rows on screen, so every line read can be scrolled.
- Darker, compact toolbar on one row, lined up with the Lens navigator.
- Search language in the style of Datadog: `level:error -ns:kube-system pod:api-* pod:(a OR b) @application:guestbook @ms:>100 @trace_id:* "exact phrase"`, coloured as you type, with completion of keys, fields and their values. The facets read their selection from the query and write it back, so the box always says what is filtered. The regular expression mode stays one click away.
- Stack traces and other multi-line messages (Java, Python, Go) are one line with a `+N lines` badge; the detail panel shows them whole. A trace read in two halves across refreshes is not repeated.
- The run before a crash: containers in CrashLoopBackOff or that ended OOMKilled or Error have their previous run read too (up to 5 per cluster, once per restart), marked `prev`, with a Run facet. **Previous run** in the line details and in Alarms reads it for any container that restarted; alarms say how often and why the container last restarted.
- 6h and 24h windows, with more lines per container; the tab says that Warning events are only kept for about an hour.

## 0.1.0

- Read every log and Warning event of a cluster without picking anything; narrow down to one or more clusters, namespaces and resources, or go back to everything.
- Alarms: errors and Warning events grouped by resource, each with Resource, Event, Lines and Ask AI.
- Refresh now and "Updated … ago"; Live reads only what is new.
- When reading everything, pods in trouble are read first and the tab says when it is not reading every pod.
- Search, level filter, time window, and "only this pod / container", "hide this pod", open resource or event, Ask AI from any line.
- "Logs Aggregator" under every cluster in the navigator, "Aggregate logs" in the menu of workloads and pods, and "Logs Aggregator: Open" in the command palette.

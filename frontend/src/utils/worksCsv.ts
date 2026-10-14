/**
 * CSV downloads for the prior/derivative work lists.
 */

import type { ClusterWork, WebWork } from "../api";
import { workUrl } from "./webWorkSources";

function escape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function download(title: string, lines: string[]) {
  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = `${title.toLowerCase().replace(/\s+/g, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadClusterCsv(
  title: string,
  works: ClusterWork[]
) {
  download(title, [
    "work_id,label,doi,mentions,graph_paper_ids",
    ...works.map((work) =>
      [
        work.work_id,
        escape(work.label),
        work.doi ?? "",
        work.count,
        work.graph_paper_ids.join(" "),
      ].join(",")
    ),
  ]);
}

export function downloadWebWorksCsv(
  title: string,
  works: WebWork[]
) {
  download(title, [
    // `sources` and `work_url` are in the export because the list is a
    // union now: a row without them cannot be traced back to the graph
    // that produced it, which is the one thing a downloaded copy of
    // this data has to preserve.
    "work_id,sources,title,doi,year,cited_by_count,author,work_url",
    ...works.map((work) =>
      [
        work.work_id,
        escape((work.sources ?? ["openalex"]).join(" ")),
        escape(work.title ?? ""),
        work.doi ?? "",
        work.publication_year ?? "",
        work.cited_by_count ?? "",
        escape(work.author ?? ""),
        workUrl(work) ?? "",
      ].join(",")
    ),
  ]);
}

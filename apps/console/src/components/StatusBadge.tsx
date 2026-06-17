import type { EndpointHealthStatus } from "@relayradar/shared";

export function StatusBadge({ status }: { status: EndpointHealthStatus }) {
  return <span className={`status-badge status-${status.toLowerCase().replace(/\s+/g, "-")}`}>{status}</span>;
}

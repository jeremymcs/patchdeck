export function formatActivityLabel(label: string): string {
  return label.replace(/^Babysitting PR\b/, "Working PR");
}

export function formatActivityDetail(detail: string | null): string | null {
  return detail?.replace("Refilling babysitter queue", "Refilling PR work queue") ?? null;
}
